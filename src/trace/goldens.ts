/** The part of a `Trace` the goldens pin: everything `parseTrajectory` derives from the
 * records. Shared by `scripts/goldens.ts`, which writes it, and `goldens.test.ts`, which
 * checks it. */

import type { Trace } from "../schemas/trace";

export type Expected =
  | { rejected: true; error: string }
  | ({ rejected: false } & Pick<
      Trace,
      "content_hash" | "source" | "started_at" | "ended_at" | "metadata" | "events"
    >);

export function expectedOf(trace: Trace): Expected & { rejected: false } {
  const { content_hash, source, started_at, ended_at, metadata, events } = trace;
  return { rejected: false, content_hash, source, started_at, ended_at, metadata, events };
}
