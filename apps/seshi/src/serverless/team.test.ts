/** Serverless mode with a team (F11): laptops with different owners on one bucket, each with a
 * key the bucket limits, and the shared settings in `config/`. The bucket's permissions are
 * the only roles; a refusal becomes a message. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliConfigSchema } from "@seshi/config";
import type { Upload } from "@seshi/model";
import {
  AccessDenied,
  archiveId,
  type DeleteOptions,
  ensureLayout,
  FsStore,
  type ListOptions,
  listReviews,
  type PutOptions,
  readLayout,
  type Store,
  setLayout,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySecrets } from "../account/secrets";
import { ServerlessBackend } from "../backend";
import { Refused } from "../cli/failures";
import { INTEGRATIONS } from "../integrations";
import { saveReviewKey } from "./keys";
import { openServerless, type ServerlessBucket } from "./open";
import { serverlessPaths } from "./settings";
import { sharedSettings } from "./shared";

const SMALL = readFileSync(
  new URL(
    "../../../../integrations/claude-code/testdata/transcripts/claude-basic.claude-code.jsonl",
    import.meta.url,
  ),
  "utf8",
);
const CLAUDE = `${SMALL.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;

const upload = (session: string): Upload => ({
  format: "claude-code",
  session_id: session,
  transcript: CLAUDE,
});

/** What a bucket key may do: read and write under these prefixes ("" for everything). */
interface KeyPolicy {
  read: readonly string[];
  write: readonly string[];
}

/** The bucket as one key sees it: the folder store, refusing what the key may not do with
 * `AccessDenied`, as S3 answers 403. */
class LimitedStore implements Store {
  constructor(
    readonly inner: FsStore,
    readonly policy: KeyPolicy,
  ) {}
  get url(): string {
    return this.inner.url;
  }
  private may(kind: "read" | "write", key: string): boolean {
    return this.policy[kind].some((p) => key.startsWith(p));
  }
  async get(key: string) {
    if (!this.may("read", key)) throw new AccessDenied("read", key);
    return this.inner.get(key);
  }
  async stat(key: string) {
    if (!this.may("read", key)) throw new AccessDenied("stat", key);
    return this.inner.stat(key);
  }
  async list(prefix: string, options?: ListOptions) {
    if (!this.may("read", prefix) && !this.policy.read.some((p) => p.startsWith(prefix))) {
      throw new AccessDenied("list", prefix);
    }
    const page = await this.inner.list(prefix, options);
    return { ...page, keys: page.keys.filter((k) => this.may("read", k)) };
  }
  async put(key: string, body: Uint8Array, options?: PutOptions) {
    if (!this.may("write", key)) throw new AccessDenied("write", key);
    return this.inner.put(key, body, options);
  }
  async delete(key: string, options?: DeleteOptions) {
    if (!this.may("write", key)) throw new AccessDenied("delete", key);
    return this.inner.delete(key, options);
  }
}

/** A member's key: reads everything, writes only its own folder. */
const member = (owner: string): KeyPolicy => ({ read: [""], write: [`owners/${owner}/`] });
/** A key that reads and writes only its own folder (and the marker and shared settings). */
const ownOnly = (owner: string): KeyPolicy => ({
  read: [`owners/${owner}/`, "seshi.json", "config/"],
  write: [`owners/${owner}/`],
});

let dir: string;
let bucketDir: string;
let shared: FsStore;
const opened: ServerlessBucket[] = [];

async function laptop(
  owner: string,
  policy: KeyPolicy,
  options: {
    write?: boolean;
    env?: Record<string, string | undefined>;
    secrets?: MemorySecrets;
    config?: string;
    includePrivate?: boolean;
    scope?: "mine" | "visible" | "all";
  } = {},
): Promise<{ bucket: ServerlessBucket; backend: ServerlessBackend }> {
  const bucket = await openServerless({
    cli: cliConfigSchema.parse({
      serverless: {
        url: shared.url,
        owner,
        ...(options.config ? { config: options.config } : {}),
      },
      search: { enabled: true, scope: options.scope ?? "visible" },
    }),
    env: options.env ?? {},
    home: join(dir, `home-${owner}`),
    integrations: INTEGRATIONS,
    secrets: options.secrets ?? new MemorySecrets(),
    write: options.write ?? true,
    refreshShared: true,
    store: new LimitedStore(shared, policy),
  });
  opened.push(bucket);
  return { bucket, backend: new ServerlessBackend(bucket, options.includePrivate ?? false) };
}

async function sharedConfig(text: string): Promise<void> {
  await shared.put("config/seshi.toml", new TextEncoder().encode(text));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-team-"));
  bucketDir = join(dir, "bucket");
  shared = new FsStore(bucketDir);
  await ensureLayout(shared, { createdBy: "test", mode: "serverless" });
});

afterEach(async () => {
  for (const b of opened.splice(0)) await b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("two laptops on one bucket (F11.4, F11.5)", () => {
  it("each writes its own folder; reads follow the visibility rule", async () => {
    const alice = await laptop("alice", member("alice"));
    const bob = await laptop("bob", member("bob"));
    const sessions = alice.bucket.instance.localSessions("alice", "claimed");
    await sessions.ingest(upload("open"));
    await sessions.ingest({ ...upload("secret"), visibility: "owner" });

    expect(await alice.backend.getSession("claude-code", "open")).toMatchObject({
      owner: "alice",
      owner_basis: "claimed",
      visibility: "org",
    });
    // Bob reads alice's org session, not her owner-only one, on every read path.
    const page = await bob.backend.listSessions({ owner: "alice" });
    expect(page.sessions.map((s) => s.session_id)).toEqual(["open"]);
    expect(await bob.backend.getSession("claude-code", "secret", { owner: "alice" })).toBeNull();
    expect(await bob.backend.getTrace("claude-code", "secret", { owner: "alice" })).toBeNull();
    expect(await bob.backend.reviews("claude-code", "secret", { owner: "alice" })).toBeNull();
    const found = await bob.backend.search({ q: "auth flow" });
    expect(found.results.map((r) => r.session_id)).toEqual(["open"]);

    // --include-private: everything the key can read.
    const curious = await laptop("bob", member("bob"), { includePrivate: true, write: false });
    const all = await curious.backend.listSessions({ owner: "alice" });
    expect(all.sessions.map((s) => s.session_id).sort()).toEqual(["open", "secret"]);
  });

  it("fills a page past sessions the viewer may not read", async () => {
    const alice = await laptop("alice", member("alice"));
    const sessions = alice.bucket.instance.localSessions("alice", "claimed");
    await sessions.ingest({ ...upload("p1"), visibility: "owner" });
    await sessions.ingest({ ...upload("p2"), visibility: "owner" });
    await sessions.ingest(upload("z1"));
    const bob = await laptop("bob", member("bob"), { write: false });
    const page = await bob.backend.listSessions({ owner: "alice", limit: 2 });
    expect(page.sessions.map((s) => s.session_id)).toEqual(["z1"]);
    expect(page.truncated).toBe(false);
  });

  it("turns the bucket's refusal of another owner's folder into a message (exit 5)", async () => {
    const alice = await laptop("alice", member("alice"));
    await alice.bucket.instance.localSessions("alice", "claimed").ingest(upload("s1"));
    const bob = await laptop("bob", member("bob"));
    const refused = bob.backend.tombstone("claude-code", "s1", { owner: "alice" });
    await expect(refused).rejects.toBeInstanceOf(Refused);
    await expect(refused).rejects.toMatchObject({
      exit: 5,
      code: "access_denied",
      message:
        "this key can't change owners/alice/…: that takes a key that can write every owner's folder",
    });
    expect(await alice.backend.getSession("claude-code", "s1")).toMatchObject({ status: "stored" });

    // An admin key (every folder) may.
    const admin = await laptop("ops", { read: [""], write: ["owners/"] });
    expect(await admin.backend.tombstone("claude-code", "s1", { owner: "alice" })).toEqual({
      removed: 1,
    });
  });

  it("a key limited to its own folder cannot read another's", async () => {
    const alice = await laptop("alice", member("alice"));
    await alice.bucket.instance.localSessions("alice", "claimed").ingest(upload("s1"));
    const bob = await laptop("bob", ownOnly("bob"), { write: false });
    await expect(bob.backend.listSessions({ owner: "alice" })).rejects.toMatchObject({
      code: "access_denied",
      message: "this key can't read owners/alice/…: it can read only its own owner's folder",
    });
  });

  it("searches its own sessions with scope mine, without listing other owners", async () => {
    const alice = await laptop("alice", member("alice"));
    await alice.bucket.instance.localSessions("alice", "claimed").ingest(upload("a1"));
    const bob = await laptop("bob", ownOnly("bob"), { scope: "mine" });
    await bob.bucket.instance.localSessions("bob", "claimed").ingest(upload("b1"));
    const found = await bob.backend.search({ q: "auth flow" });
    expect(found.results.map((r) => `${r.owner}/${r.session_id}`)).toEqual(["bob/b1"]);
  });

  it("forgets other owners' sessions when the scope narrows to mine", async () => {
    const alice = await laptop("alice", member("alice"));
    await alice.bucket.instance.localSessions("alice", "claimed").ingest(upload("a1"));
    const wide = await laptop("bob", member("bob"), { scope: "visible" });
    await wide.bucket.instance.localSessions("bob", "claimed").ingest(upload("b1"));
    const before = await wide.backend.search({ q: "auth flow" });
    expect(before.results.map((r) => r.owner).sort()).toEqual(["alice", "bob"]);
    await wide.bucket.close();

    const narrow = await laptop("bob", ownOnly("bob"), { scope: "mine" });
    const after = await narrow.backend.search({ q: "auth flow" });
    expect(after.results.map((r) => `${r.owner}/${r.session_id}`)).toEqual(["bob/b1"]);
  });

  it("refuses to write with a key that cannot write its own folder", async () => {
    await expect(laptop("alice", { read: [""], write: [] })).rejects.toMatchObject({
      code: "access_denied",
    });
  });
});

describe("the bucket's marker (F11.7, F11.8)", () => {
  it("refuses writes below min_version and reads with a warning", async () => {
    await setLayout(shared, { min_version: "99.0.0" }, { by: "test" });
    await expect(laptop("alice", member("alice"))).rejects.toMatchObject({
      code: "needs_update",
      message: expect.stringMatching(/^this bucket needs seshi 99\.0\.0 or newer; you have /),
    });
    const reader = await laptop("alice", member("alice"), { write: false });
    expect(reader.bucket.writable).toBe(false);
    expect(reader.bucket.warnings.join("\n")).toMatch(/needs seshi 99\.0\.0/);
    await expect(reader.backend.setVisibility("claude-code", "x", "org")).rejects.toMatchObject({
      code: "needs_update",
    });
  });

  it("warns, and refuses nothing, on a bucket in server mode", async () => {
    await setLayout(shared, { mode: "server" }, { by: "test" });
    const alice = await laptop("alice", member("alice"));
    expect(alice.bucket.warnings.join("\n")).toMatch(/is in server mode/);
    await alice.bucket.instance.localSessions("alice", "claimed").ingest(upload("s1"));
  });
});

describe("shared settings (F11.6)", () => {
  it("layers defaults, the bucket's config, the local file, then env", async () => {
    await sharedConfig('default_visibility = "owner"\n');
    const first = await laptop("alice", member("alice"));
    expect(first.bucket.instance.config.default_visibility).toBe("owner");
    await first.bucket.instance.localSessions("alice", "claimed").ingest(upload("s1"));
    expect(await first.backend.getSession("claude-code", "s1")).toMatchObject({
      visibility: "owner",
    });

    const local = join(dir, "local.toml");
    writeFileSync(local, 'default_visibility = "org"\n');
    const second = await laptop("alice", member("alice"), { config: local });
    expect(second.bucket.instance.config.default_visibility).toBe("org");
    const third = await laptop("alice", member("alice"), {
      config: local,
      env: { SESHI_DEFAULT_VISIBILITY: "owner" },
    });
    expect(third.bucket.instance.config.default_visibility).toBe("owner");
  });

  it("ignores server-only sections and the shared [store], saying where", async () => {
    await sharedConfig('[store]\nurl = "s3://elsewhere/x"\n[server]\nlisten = ":9000"\n[worker]\n');
    const alice = await laptop("alice", member("alice"));
    expect(alice.bucket.instance.storage.url).toBe(shared.url);
    expect(alice.bucket.ignored).toEqual([
      `[server] in ${shared.url}/config/seshi.toml`,
      `[worker] in ${shared.url}/config/seshi.toml`,
      `[store] in ${shared.url}/config/seshi.toml`,
    ]);
  });

  it("holds writes when the bucket's copy fails its checks and there is no good one", async () => {
    await sharedConfig('default_visibility = "org"\nnot_a_setting = 1\n');
    await expect(laptop("alice", member("alice"))).rejects.toMatchObject({
      code: "shared_settings",
    });
    const reader = await laptop("alice", member("alice"), { write: false });
    expect(reader.bucket.warnings.join("\n")).toMatch(/shared settings this machine can't use/);
    // The same copy is not checked again, and still holds writes.
    await expect(laptop("alice", member("alice"))).rejects.toMatchObject({
      code: "shared_settings",
    });
  });

  it("refuses a shared copy that names a path outside config/ or a file secret", async () => {
    await sharedConfig('[redaction]\npacks = ["../../../etc/passwd"]\n');
    await expect(laptop("alice", member("alice"))).rejects.toMatchObject({
      code: "shared_settings",
      message: expect.stringMatching(/is outside config\//),
    });
    await sharedConfig(
      '[[review.policies]]\nid = "p"\ndecision = { api_key = { file = "/home/a/.key" } }\n',
    );
    await expect(laptop("alice", member("alice"))).rejects.toMatchObject({
      message: expect.stringMatching(/a secret read from a file/),
    });
  });

  it("holds writes when the key cannot read the shared settings", async () => {
    await sharedConfig('default_visibility = "org"\n');
    const blind = { read: ["owners/alice/", "seshi.json"], write: ["owners/alice/"] };
    await expect(laptop("alice", blind)).rejects.toMatchObject({ code: "access_denied" });
  });

  it("checks a rejected copy again once this machine's own settings change", async () => {
    await sharedConfig('default_visibility = "org"\n');
    const paths = serverlessPaths({}, join(dir, "home-x"), shared.url);
    let fine = false;
    const check = async () => {
      if (!fine) throw new Error("the local file says no");
    };
    const first = await sharedSettings(shared, paths, { check, local: "a", force: true });
    expect(first.unusable).toBe("the local file says no");
    fine = true;
    const unchanged = await sharedSettings(shared, paths, { check, local: "a", force: true });
    expect(unchanged.unusable).toBe("the local file says no");
    const fixed = await sharedSettings(shared, paths, { check, local: "b", force: true });
    expect(fixed.unusable).toBeUndefined();
    expect(fixed.base).toBeDefined();
  });

  it("keeps the last good copy when the bucket's fails its checks", async () => {
    await sharedConfig('default_visibility = "owner"\n');
    await laptop("alice", member("alice"));
    await sharedConfig('default_visibility = "nobody"\n');
    const again = await laptop("alice", member("alice"));
    expect(again.bucket.instance.config.default_visibility).toBe("owner");
    expect(again.bucket.shared.problem).toMatch(/default_visibility/);
  });
});

describe("model review without a key (F11)", () => {
  const POLICY = `[[review.policies]]\nid = "team"\ndecision = { api_key = { env = "ANTHROPIC_API_KEY" } }\n`;

  it("holds uploads when review is required and no key is set, with what to do", async () => {
    await sharedConfig(`[review]\nrequired = true\n${POLICY}`);
    const held = laptop("alice", member("alice"));
    await expect(held).rejects.toMatchObject({ code: "needs_review_key" });
    await expect(held).rejects.toThrow(
      [
        "this team requires model review, and no key for anthropic is set.",
        "Sessions are kept on this machine until one is: nothing has been uploaded unreviewed.",
        "  Set ANTHROPIC_API_KEY, or store a key with: seshi review key set anthropic",
        "  Then check with: seshi doctor",
      ].join("\n"),
    );
    // Reading needs no key.
    const reader = await laptop("alice", member("alice"), { write: false });
    expect(reader.bucket.review).toMatchObject({
      required: true,
      missing: [{ policy: "team", provider: "anthropic", env: "ANTHROPIC_API_KEY" }],
    });
  });

  it("uses a key stored with seshi review key set", async () => {
    await sharedConfig(`[review]\nrequired = true\n${POLICY}`);
    const secrets = new MemorySecrets();
    await saveReviewKey(secrets, "anthropic", "sk-test");
    const alice = await laptop("alice", member("alice"), { secrets });
    expect(alice.bucket.review.missing).toEqual([]);
  });

  it("sends no laptop's key to an endpoint the shared config names", async () => {
    await sharedConfig(
      '[[review.policies]]\nid = "team"\ndecision = { api_key = { env = "AWS_SECRET_ACCESS_KEY" }, base_url = "https://elsewhere.example" }\n',
    );
    const secrets = new MemorySecrets();
    await saveReviewKey(secrets, "anthropic", "sk-test");
    const held = laptop("alice", member("alice"), {
      secrets,
      env: { AWS_SECRET_ACCESS_KEY: "laptop-secret" },
    });
    await expect(held).rejects.toMatchObject({ code: "shared_settings" });
    await expect(held).rejects.toThrow(/may not send each machine's key to an endpoint it names/);
  });

  it("lets a laptop's own config name an endpoint for its key", async () => {
    const local = join(dir, "local.toml");
    writeFileSync(
      local,
      '[[review.policies]]\nid = "team"\ndecision = { api_key = { env = "PROXY_KEY" }, base_url = "https://proxy.example" }\n',
    );
    const alice = await laptop("alice", member("alice"), {
      config: local,
      env: { PROXY_KEY: "k" },
    });
    expect(alice.bucket.review.missing).toEqual([]);
  });

  it("stores with regex redaction only, as skipped, when review is not required", async () => {
    await sharedConfig(POLICY);
    const alice = await laptop("alice", member("alice"));
    expect(alice.bucket.review).toMatchObject({ required: false, missing: [{ policy: "team" }] });
    await alice.bucket.instance.localSessions("alice", "claimed").ingest(upload("s1"));
    const reviews = await listReviews(shared, "alice", archiveId("alice", "claude-code", "s1"));
    expect(reviews.map((r) => r.decision)).toEqual(["skipped"]);
  });
});

describe("what a laptop writes (F11.10, F11.11)", () => {
  it("never records an org in the marker, even when its config names one", async () => {
    const local = join(dir, "local.toml");
    writeFileSync(local, '[store]\norg = "acme"\n');
    await laptop("alice", member("alice"), { config: local });
    expect((await readLayout(shared))?.org).toBeUndefined();
  });

  it("keeps records and health off the bucket, and never writes outside its folder", async () => {
    const alice = await laptop("alice", member("alice"));
    await alice.bucket.instance.localSessions("alice", "claimed").ingest(upload("s1"));
    await alice.bucket.close();
    const keys = (await shared.list("")).keys;
    expect(keys.filter((k) => !k.startsWith("owners/alice/"))).toEqual(["seshi.json"]);
    expect(alice.bucket.instance.pipeline.records.url).toContain("records");
  });
});
