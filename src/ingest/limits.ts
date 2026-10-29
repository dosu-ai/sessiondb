/** Size caps on what one upload may become. Past them the session is refused with a 422, which
 * is final: the same bytes cannot succeed on a retry. */

export const LIMITS = {
  /** JSON bytes of the records array. */
  maxRecordsBytes: 32 * 1024 * 1024,
  maxRecords: 50_000,
  /** Gzipped bytes of one raw part. */
  maxRawPartBytes: 64 * 1024 * 1024,
} as const;
