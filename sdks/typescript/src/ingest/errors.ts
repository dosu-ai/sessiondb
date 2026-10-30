/** What the write path refuses, as one vocabulary whichever backend raised it: the pipeline
 * over a store throws these directly, and the HTTP backend turns the server's responses back
 * into them, so a caller's `catch` reads the same either way. The server does the reverse:
 * `SessionRejected` is a 422 with its `code`, `OffsetMismatch` a 409 with `expected`. */

/** A transcript the pipeline refuses: nothing in it, not readable by the adapter, a chunk that
 * is not whole lines, over a cap, or a session that was redacted. Final for that upload:
 * resending the same bytes cannot succeed. `code` is what the server reports. */
export class SessionRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionRejected";
  }
}

/** The store's own refusals, a subset of `SessionRejected` with a closed set of codes. */
export class IngestRejected extends SessionRejected {
  constructor(
    override readonly code: "too_large" | "invalid" | "redacted",
    message: string,
  ) {
    super(code, message);
    this.name = "IngestRejected";
  }
}

/** A chunk that does not start where the session's log ends: nothing is stored. The client
 * resumes from `expected` (0 when the session has no chunk state: it sends the whole log). */
export class OffsetMismatch extends Error {
  readonly code = "offset_mismatch";
  constructor(
    readonly offset: number,
    readonly expected: number,
  ) {
    super(`chunk starts at byte ${offset}; the session's log ends at ${expected}`);
    this.name = "OffsetMismatch";
  }
}
