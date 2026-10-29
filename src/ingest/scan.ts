/** The bucket as a source: Datadog Trajectory streams that were synced into an owner's folder.
 *
 * The daemon keeps every session it captures at
 * `~/.trajectory/trajectories/sessions/<date>/session-<id>.jsonl`. Someone who syncs that
 * directory into the bucket under their own folder (`aws s3 sync ~/.trajectory
 * s3://bucket/prefix/owners/alice/.trajectory`) has put the sessions where this server can
 * read them, and that is all they have to do: the server scans each owner's folder at boot and
 * on an interval, and every `session-<id>.jsonl` it finds there goes through the same
 * store → normalize pipeline a POST does (a redacted copy as the session's raw part, then the
 * trace from it), filed under `agent: datadog-trajectory` in the owner's archive. The synced
 * files are left where they are, so the sync keeps working.
 *
 * A scan reads a file once per version of it: the key and its ETag are remembered in memory,
 * so an unchanged file costs a `stat` on later scans and a file the sync rewrote (a session
 * that was still running the last time) is read again. The content hash dedupes across
 * restarts, so a fresh process re-reading everything writes nothing new. A stream with no
 * `session_end` yet is a running session and is left for a later scan. */

import {
  DATADOG_TRAJECTORY,
  DatadogTrajectoryError,
  describeStream,
} from "../normalize/datadog-trajectory";
import { keys } from "../store/layout";
import type { Store } from "../store/store";
import { IngestRejected } from "./ingest";
import { SessionRejected, type StoreSessionResult, storeSession } from "./session";

/** A Trajectory session file anywhere in an owner's folder, by the daemon's own naming. */
const STREAM_KEY = /^owners\/([^/]+)\/.+\/session-[^/]+\.jsonl$/;

export interface ScanOptions {
  store: Store;
  /** Whose folders to scan: the owners the server has tokens for. */
  owners: readonly string[];
  client?: string;
  now?: () => Date;
  /** Called for each file that was read, with what became of it. */
  onFile?: (report: ScanReport) => void;
}

export type ScanOutcome =
  | StoreSessionResult["status"]
  /** No `session_end` yet; left for a later scan. */
  | "live"
  /** Not a stream this server reads; `detail` has the code. Not retried until the file changes. */
  | "rejected";

export interface ScanReport {
  owner: string;
  key: string;
  outcome: ScanOutcome;
  session_id?: string;
  detail?: string;
}

export interface ScanSummary {
  /** Files that matched the name and were read this scan (unchanged ones are not). */
  read: number;
  stored: number;
  duplicate: number;
  trivial: number;
  live: number;
  rejected: number;
}

export interface Scanner {
  /** One pass over every owner's folder. Never throws for a file; a store failure does. */
  scan(): Promise<ScanSummary>;
  /** What the scanner has seen, by key: the ETag (or size) it last read. */
  readonly seen: ReadonlyMap<string, string>;
}

async function* streamKeys(store: Store, owner: string): AsyncGenerator<string> {
  const prefix = `${keys.owner(owner)}/`;
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000 });
    for (const key of page.keys) if (STREAM_KEY.test(key)) yield key;
    if (!page.truncated || page.keys.length === 0) return;
    after = page.keys.at(-1);
  }
}

export function createScanner(options: ScanOptions): Scanner {
  const { store } = options;
  const seen = new Map<string, string>();

  async function one(owner: string, key: string, summary: ScanSummary): Promise<void> {
    const stat = await store.stat(key);
    if (stat === null) return;
    const version = stat.etag ?? `size:${stat.size}`;
    if (seen.get(key) === version) return;
    const bytes = await store.get(key);
    if (bytes === null) return;
    summary.read++;
    const transcript = new TextDecoder().decode(bytes);

    const report = (entry: Omit<ScanReport, "owner" | "key">): void => {
      summary[entry.outcome]++;
      options.onFile?.({ owner, key, ...entry });
    };

    let stream: ReturnType<typeof describeStream>;
    try {
      stream = describeStream(transcript);
    } catch (err) {
      if (err instanceof DatadogTrajectoryError) {
        seen.set(key, version);
        report({ outcome: "rejected", detail: `normalize_${err.code}` });
        return;
      }
      throw err;
    }
    if (!stream.finished) {
      // Still running when it was synced; the next sync rewrites the file.
      seen.set(key, version);
      report({ outcome: "live", session_id: stream.session_id });
      return;
    }
    try {
      const result = await storeSession(
        {
          owner,
          agent: DATADOG_TRAJECTORY,
          session_id: stream.session_id,
          transcript,
          format: "jsonl",
          parent_session_id: stream.parent_session_id,
        },
        { store, client: options.client, now: options.now },
      );
      seen.set(key, version);
      report({ outcome: result.status, session_id: stream.session_id });
    } catch (err) {
      if (err instanceof SessionRejected || err instanceof IngestRejected) {
        seen.set(key, version);
        report({ outcome: "rejected", session_id: stream.session_id, detail: err.code });
        return;
      }
      throw err;
    }
  }

  return {
    seen,
    async scan() {
      const summary: ScanSummary = {
        read: 0,
        stored: 0,
        duplicate: 0,
        trivial: 0,
        live: 0,
        rejected: 0,
      };
      for (const owner of options.owners) {
        for await (const key of streamKeys(store, owner)) await one(owner, key, summary);
      }
      return summary;
    },
  };
}
