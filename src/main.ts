/** `bun start`: the sessiondb server from the environment (Bun reads `.env` on its own).
 *
 * - `SESSIONDB_TOKENS`     who may use the server: `name:token` pairs separated by commas, one
 *                          per person (`alice:…,bob:…`). Each person's sessions are
 *                          filed under `owners/<name>/` and a token reads only its own. 16+ chars
 * - `SESSIONDB_TOKEN`      one token for a one-person install; its sessions file under
 *                          `owners/default/`
 * - `SESSIONDB_STORE_URL`  where sessions go: `s3://bucket/prefix`, `r2://bucket/prefix`, or
 *                          `file:///path` for one box
 * - bucket credentials     `s3://`: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or `S3_*`),
 *                          `AWS_REGION`; `r2://`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
 *                          `R2_SECRET_ACCESS_KEY`; S3-compatible: `S3_ENDPOINT` with the `AWS_*` keys
 * - `SESSIONDB_SCAN_INTERVAL`
 *                          seconds between scans of each owner's folder for Datadog Trajectory
 *                          session files synced into the bucket; default 300, `0` to never scan
 * - `PORT`                 default 7200
 */

import { createApp, type StorageView, type TokenGrant } from "./app";
import { createScanner } from "./ingest/scan";
import { FsStore } from "./store/fs";
import { assertOwner } from "./store/layout";
import { ensureLayout, probe } from "./store/publish";
import { S3Store } from "./store/s3";
import type { Store } from "./store/store";
import { VERSION } from "./version";

function fail(message: string): never {
  console.error(`sessiondb: ${message}`);
  process.exit(1);
}

const tokens: TokenGrant[] = [];
const single = process.env.SESSIONDB_TOKEN?.trim();
if (single) tokens.push({ token: single, owner: "default" });
for (const entry of (process.env.SESSIONDB_TOKENS ?? "").split(",")) {
  const pair = entry.trim();
  if (!pair) continue;
  const at = pair.indexOf(":");
  if (at < 1) fail(`SESSIONDB_TOKENS entries are name:token, got '${pair.slice(0, 8)}…'`);
  const owner = pair.slice(0, at).trim();
  try {
    assertOwner(owner);
  } catch {
    fail(`'${owner}' is not a valid name: letters, digits, . _ - (up to 128)`);
  }
  tokens.push({ token: pair.slice(at + 1).trim(), owner });
}
if (tokens.length === 0) fail("SESSIONDB_TOKENS (name:token,…) or SESSIONDB_TOKEN is required");
for (const { token } of tokens) {
  if (token.length < 16) fail("every token must be 16+ characters (try: openssl rand -hex 24)");
}
if (new Set(tokens.map((t) => t.token)).size !== tokens.length) {
  fail("the same token is listed twice");
}
const owners = [...new Set(tokens.map((t) => t.owner))];

const url = process.env.SESSIONDB_STORE_URL;
if (!url)
  fail("SESSIONDB_STORE_URL is required (s3://bucket/prefix, r2://bucket/prefix, file:///path)");

const client = `sessiondb-server/${VERSION}`;

let store: Store;
let storage: StorageView;
if (url.startsWith("file://") || url.startsWith("/")) {
  store = new FsStore(url);
  storage = { url: store.url };
} else if (/^(s3|r2):\/\//.test(url)) {
  const region = process.env.AWS_REGION ?? process.env.S3_REGION;
  const accountId = process.env.R2_ACCOUNT_ID;
  const endpoint = process.env.S3_ENDPOINT;
  if (url.startsWith("r2://") && !accountId && !endpoint) {
    fail("r2:// needs R2_ACCOUNT_ID (or S3_ENDPOINT)");
  }
  store = S3Store.fromUrl(url, { region, accountId, endpoint });
  storage = {
    url,
    ...(region ? { region } : {}),
    ...(accountId ? { account_id: accountId } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
} else {
  fail(`SESSIONDB_STORE_URL must be s3://, r2:// or file://, got ${url}`);
}

// Fail at boot, not on the first session, when the bucket or its keys are wrong.
try {
  await ensureLayout(store, client);
  for (const owner of owners) await probe(store, owner);
} catch (err) {
  fail(`cannot write to ${url}: ${err instanceof Error ? err.message : String(err)}`);
}

const app = createApp({ store, storage, tokens, client });
const port = Number.parseInt(process.env.PORT ?? "7200", 10);

const server = Bun.serve({
  port,
  // A raw transcript can be large; gzipped uploads are decoded after this check.
  maxRequestBodySize: 256 * 1024 * 1024,
  // A large upload or a long list against a bucket can take more than Bun's 10s default.
  idleTimeout: 120,
  fetch: app.fetch,
});

console.log(
  `sessiondb-server ${VERSION} listening on http://localhost:${server.port}, writing ${url} for ${owners.join(", ")}`,
);

// Datadog Trajectory session files synced into an owner's folder: scanned at boot and on an
// interval, in the background, never in the way of a request.
const scanInterval = Number.parseInt(process.env.SESSIONDB_SCAN_INTERVAL ?? "300", 10);
if (!Number.isInteger(scanInterval) || scanInterval < 0) {
  fail("SESSIONDB_SCAN_INTERVAL must be a number of seconds (0 to disable)");
}
let scanTimer: ReturnType<typeof setInterval> | undefined;
if (scanInterval > 0) {
  const scanner = createScanner({
    store,
    owners,
    client,
    onFile: (r) => {
      if (r.outcome === "duplicate") return;
      console.log(`[sessiondb] scan ${r.outcome} ${r.key}${r.detail ? ` (${r.detail})` : ""}`);
    },
  });
  let scanning = false;
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      const s = await scanner.scan();
      if (s.read > 0) {
        console.log(
          `[sessiondb] scan: ${s.read} read, ${s.stored} stored, ${s.duplicate} duplicate, ${s.trivial} trivial, ${s.rejected} rejected`,
        );
      }
    } catch (err) {
      console.error(`[sessiondb] scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      scanning = false;
    }
  };
  void scan();
  scanTimer = setInterval(scan, scanInterval * 1000);
}

function shutdown(): void {
  if (scanTimer) clearInterval(scanTimer);
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
