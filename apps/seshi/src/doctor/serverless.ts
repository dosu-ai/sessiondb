import { SHARED_PREFIX } from "@seshi/config";
import { VERSION } from "@seshi/model";
import { accessDeniedIn, keys, listOwners, probe, versionAtLeast } from "@seshi/store";
import type { ServerlessBucket } from "../serverless/open";
import { missingKeyMessage, refusalOf, runStorageTest } from "../serverless/open";
import type { CheckResult } from "./types";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const HOUR_MS = 60 * 60 * 1000;

function ago(iso: string | undefined, now: Date): string {
  if (!iso) return "never";
  const ms = now.getTime() - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 48 * HOUR_MS) return `${Math.round(ms / HOUR_MS)} h ago`;
  return `${Math.round(ms / (24 * HOUR_MS))} days ago`;
}

function markerCheck(bucket: ServerlessBucket): CheckResult {
  const { marker } = bucket;
  const detail = [
    `schema ${marker.schema}`,
    `mode ${marker.mode ?? "not set"}`,
    `minimum version ${marker.min_version ?? "none"} (this is ${VERSION})`,
  ];
  if (marker.min_version && !versionAtLeast(VERSION, marker.min_version)) {
    return {
      id: "marker",
      title: "Bucket",
      status: "fail",
      summary: `needs seshi ${marker.min_version} or newer to write; this is ${VERSION}`,
      detail,
      hint: "update seshi",
    };
  }
  if (marker.mode === "server") {
    return {
      id: "marker",
      title: "Bucket",
      status: "warn",
      summary: "in server mode: laptops should upload through the server",
      detail,
      hint: "seshi login --server <url>, or seshi admin mode serverless if the server is gone",
    };
  }
  return {
    id: "marker",
    title: "Bucket",
    status: "ok",
    summary: bucket.instance.storage.url,
    detail,
  };
}

async function ownerCheck(bucket: ServerlessBucket): Promise<CheckResult> {
  const { owner } = bucket;
  try {
    await probe(bucket.instance.store, owner);
    return {
      id: "owner",
      title: "Owner",
      status: "ok",
      summary: `${owner} (claimed): this key can write owners/${owner}/`,
    };
  } catch (err) {
    return {
      id: "owner",
      title: "Owner",
      status: "fail",
      summary: `${owner}: ${message(refusalOf(err, owner))}`,
      hint: "check serverless.owner (seshi whoami) and the key's permissions",
    };
  }
}

async function storageCheck(bucket: ServerlessBucket): Promise<CheckResult> {
  let result: Awaited<ReturnType<typeof runStorageTest>>;
  try {
    result = await runStorageTest(bucket.instance.store, bucket.owner, bucket.paths);
  } catch (err) {
    return {
      id: "storage",
      title: "Storage test",
      status: "fail",
      summary: message(refusalOf(err, bucket.owner)),
    };
  }
  const detail = result.steps.map(
    (s) => `${s.ok ? "ok  " : "FAIL"} ${s.step}. ${s.what}${s.detail ? `: ${s.detail}` : ""}`,
  );
  if (!result.conditionalWrites) {
    return {
      id: "storage",
      title: "Storage test",
      status: "fail",
      summary: `${result.missing}; seshi can't use this store`,
      detail,
      hint: "use a store with conditional writes: AWS S3, Cloudflare R2, Azure Blob Storage, Google Cloud Storage (gs://), MinIO, RustFS",
    };
  }
  if (!result.conditionalDelete) {
    return {
      id: "storage",
      title: "Storage test",
      status: "warn",
      summary: `${result.missing}: the daemon will not sweep this bucket`,
      detail,
    };
  }
  return {
    id: "storage",
    title: "Storage test",
    status: "ok",
    summary: "conditional uploads and deletes work",
    detail,
  };
}

/** Whether the key can read other owners' folders: read-all or read-own (F11.5). */
async function readCheck(bucket: ServerlessBucket): Promise<CheckResult> {
  const store = bucket.instance.store;
  try {
    const page = await listOwners(store, { limit: 50 });
    const other = page.owners.find((o) => o !== bucket.owner);
    if (other === undefined) {
      return {
        id: "read",
        title: "Read access",
        status: "ok",
        summary: "no other owner's folder yet to try",
      };
    }
    await store.list(keys.sessions(other), { limit: 1 });
    return {
      id: "read",
      title: "Read access",
      status: "ok",
      summary: `this key reads every owner's folder (it read owners/${other}/); the CLI shows others' sessions only when visible to the org`,
    };
  } catch (err) {
    if (accessDeniedIn(err)) {
      return {
        id: "read",
        title: "Read access",
        status: "ok",
        summary:
          "this key reads only its own folder: others' sessions and the shared index are not visible",
      };
    }
    return { id: "read", title: "Read access", status: "warn", summary: message(err) };
  }
}

function sharedCheck(bucket: ServerlessBucket, now: Date): CheckResult {
  const { shared } = bucket;
  const detail = [
    shared.files.length > 0
      ? `${SHARED_PREFIX}: ${shared.files.join(", ")}`
      : `${SHARED_PREFIX}: none (built-in defaults)`,
    `last read from the bucket ${ago(shared.checkedAt, now)}`,
    ...bucket.ignored
      .filter((i) => i.includes(SHARED_PREFIX))
      .map((i) => `ignored here: ${i} (needs a server)`),
  ];
  if (shared.problem) {
    return {
      id: "shared",
      title: "Shared settings",
      status: "warn",
      summary: `the bucket's copy fails its checks; using the last good one: ${shared.problem}`,
      detail,
      hint: "seshi admin config pull, fix, seshi admin config push",
    };
  }
  if (shared.unreachable) {
    return {
      id: "shared",
      title: "Shared settings",
      status: "warn",
      summary: `could not read them; using the cached copy: ${shared.unreachable}`,
      detail,
    };
  }
  return {
    id: "shared",
    title: "Shared settings",
    status: "ok",
    summary: shared.files.length > 0 ? "read and checked" : "none: defaults apply",
    detail,
  };
}

function reviewCheck(bucket: ServerlessBucket): CheckResult {
  const { required, missing } = bucket.review;
  const policies = bucket.instance.config.review.policies;
  if (policies.length === 0) {
    return { id: "review", title: "Model review", status: "ok", summary: "no review policies" };
  }
  const detail = [
    `review.required = ${required}`,
    ...missing.map(
      (m) => `policy ${m.policy}: no ${m.provider} key${m.env ? ` (${m.env} is unset)` : ""}`,
    ),
  ];
  if (missing.length === 0) {
    return {
      id: "review",
      title: "Model review",
      status: "ok",
      summary: `every policy's key is set (${policies.length} polic${policies.length === 1 ? "y" : "ies"})`,
      detail,
    };
  }
  return required
    ? {
        id: "review",
        title: "Model review",
        status: "fail",
        summary: missingKeyMessage(missing).split("\n")[0] as string,
        detail,
        hint: `seshi review key set ${missing[0]?.provider}`,
      }
    : {
        id: "review",
        title: "Model review",
        status: "warn",
        summary:
          "sessions under a policy with no key here are stored with regex redaction only (skipped)",
        detail,
        hint: `seshi review key set ${missing[0]?.provider}`,
      };
}

function searchCheck(bucket: ServerlessBucket, scope: string, now: Date): CheckResult {
  const search = bucket.instance.search;
  if (!search) {
    return { id: "search", title: "Search", status: "ok", summary: "off on this machine" };
  }
  const status = search.status();
  return {
    id: "search",
    title: "Search",
    status: "ok",
    summary: status.ready
      ? `scope ${scope}; ${status.sessions} sessions indexed, caught up ${ago(status.caught_up_at, now)}`
      : `scope ${scope}; not built yet (the next search or the daemon builds it)`,
    detail: [`index ${status.path}`],
  };
}

function serverOnlyCheck(bucket: ServerlessBucket): CheckResult | undefined {
  const local = bucket.ignored.filter((i) => !i.includes(SHARED_PREFIX));
  if (local.length === 0) return undefined;
  return {
    id: "server-only",
    title: "Server settings",
    status: "fail",
    summary: `${local.join(", ")}: needs a server; serverless mode ignores it`,
    hint: "remove it from the local config, or use a server (seshi login --server)",
  };
}

/** `seshi doctor`'s checks of a serverless bucket and this machine's access to it (F11). */
export async function serverlessChecks(
  bucket: ServerlessBucket,
  scope: string,
  now = new Date(),
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [markerCheck(bucket)];
  checks.push(await ownerCheck(bucket));
  checks.push(await storageCheck(bucket));
  checks.push(await readCheck(bucket));
  checks.push(sharedCheck(bucket, now));
  checks.push(reviewCheck(bucket));
  checks.push(searchCheck(bucket, scope, now));
  const serverOnly = serverOnlyCheck(bucket);
  if (serverOnly) checks.push(serverOnly);
  for (const warning of bucket.warnings.filter((w) => w.startsWith("[local]"))) {
    checks.push({ id: "config", title: "CLI config", status: "warn", summary: warning });
  }
  return checks;
}
