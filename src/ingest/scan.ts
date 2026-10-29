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
 * A session's file only grows while it runs (the daemon appends an event per line), and the
 * scan reads only what grew: the session's `metadata.json` says how many of the file's bytes
 * were normalized, and the bytes past that are read with a range request and sent through the
 * pipeline as a chunk, which ships them as a continuation of the session's trace. So a running
 * session is in the archive as it goes, a scan costs what was appended since the last one, and
 * a restart picks up where the archive says, not from the start. A file that shrank was
 * rewritten and is read whole again; its content dedupes. The key and ETag of each file are
 * remembered in memory, so an unchanged file costs a `stat`. */

import {
  DATADOG_TRAJECTORY,
  DatadogTrajectoryError,
  describeStream,
  type StreamSummary,
} from "../normalize/datadog-trajectory";
import { keys } from "../store/layout";
import type { Store } from "../store/store";
import { getSession, IngestRejected } from "./ingest";
import { OffsetMismatch, SessionRejected, type StoreSessionResult, storeSession } from "./session";

/** A Trajectory session file anywhere in an owner's folder, by the daemon's own naming. */
const STREAM_KEY = /^owners\/([^/]+)\/.+\/session-[^/]+\.jsonl$/;

/** How much of a file's head is read to identify its session: the `session_start` is its first
 * line. */
const HEAD_BYTES = 64 * 1024;

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
  /** Files that matched the name and had new bytes read this scan. */
  read: number;
  stored: number;
  duplicate: number;
  trivial: number;
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

const decoder = new TextDecoder();

/** The text through its last line break: whole lines only. */
function wholeLines(text: string): string {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}

/** Which session a file is of, from its head. Throws `DatadogTrajectoryError` when there is no
 * `session_start` there. */
async function identify(store: Store, key: string, size: number): Promise<StreamSummary | null> {
  const head = await store.get(key, { range: { start: 0, end: HEAD_BYTES } });
  if (head === null) return null;
  const lines = size > HEAD_BYTES ? wholeLines(decoder.decode(head)) : decoder.decode(head);
  return describeStream(lines);
}

export function createScanner(options: ScanOptions): Scanner {
  const { store } = options;
  const seen = new Map<string, string>();

  async function one(owner: string, key: string, summary: ScanSummary): Promise<void> {
    const stat = await store.stat(key);
    if (stat === null) return;
    const version = stat.etag ?? `size:${stat.size}`;
    if (seen.get(key) === version) return;

    const report = (entry: Omit<ScanReport, "owner" | "key">): void => {
      summary[entry.outcome]++;
      options.onFile?.({ owner, key, ...entry });
    };

    let stream: StreamSummary | null;
    try {
      stream = await identify(store, key, stat.size);
    } catch (err) {
      if (err instanceof DatadogTrajectoryError) {
        seen.set(key, version);
        report({ outcome: "rejected", detail: `normalize_${err.code}` });
        return;
      }
      throw err;
    }
    if (stream === null) return;

    // Where the archive's copy of the log ends: what grew since is a chunk from there. A file
    // shorter than that was rewritten and starts over.
    const session = await getSession(store, owner, DATADOG_TRAJECTORY, stream.session_id);
    let from = session?.normalized?.bytes ?? 0;
    if (from > stat.size) from = 0;
    if (from === stat.size) {
      seen.set(key, version);
      return;
    }
    const grown = await store.get(key, { range: { start: from } });
    if (grown === null) return;
    // A line still being written waits for the next sync to complete it.
    const transcript = wholeLines(decoder.decode(grown));
    if (transcript === "") {
      seen.set(key, version);
      return;
    }
    summary.read++;

    try {
      const result = await storeSession(
        {
          owner,
          agent: DATADOG_TRAJECTORY,
          session_id: stream.session_id,
          transcript,
          format: "jsonl",
          offset: from,
          parent_session_id: stream.parent_session_id,
        },
        { store, client: options.client, now: options.now },
      );
      seen.set(key, version);
      report({ outcome: result.status, session_id: stream.session_id });
    } catch (err) {
      if (
        err instanceof SessionRejected ||
        err instanceof IngestRejected ||
        err instanceof OffsetMismatch
      ) {
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
      const summary: ScanSummary = { read: 0, stored: 0, duplicate: 0, trivial: 0, rejected: 0 };
      for (const owner of options.owners) {
        for await (const key of streamKeys(store, owner)) await one(owner, key, summary);
      }
      return summary;
    },
  };
}
