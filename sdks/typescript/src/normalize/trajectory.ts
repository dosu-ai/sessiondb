/** A transcript that is already Letta trajectory-v1: one record per line, as `validateRecords`
 * accepts them. Nothing to normalize, so the records pass through as they are, checked; a chunk's
 * records lose any meta record, as a Letta chunk's do. Redaction is the caller's, as for every
 * other source. */

import { type NormalizedRecord, validateRecords } from "../schemas/trajectory";

/** The `agent` these sessions are filed under. */
export const TRAJECTORY = "trajectory" as const;

/** Thrown for a line that is not JSON or a record that is not trajectory-v1. */
class TrajectoryInputError extends Error {
  readonly code = "invalid_input";
  constructor(message: string) {
    super(message);
    this.name = "TrajectoryInputError";
  }
}

/** The records of a trajectory-v1 JSONL transcript, or of a chunk of one (`partial`). */
export function trajectoryRecords(
  transcript: string,
  options: { partial: boolean },
): NormalizedRecord[] {
  const rows: unknown[] = [];
  transcript.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new TrajectoryInputError(`line ${index + 1} is not JSON`);
    }
  });
  let records: NormalizedRecord[];
  try {
    records = validateRecords(rows);
  } catch (err) {
    throw new TrajectoryInputError(err instanceof Error ? err.message : String(err));
  }
  return options.partial ? records.filter((record) => record.role !== "meta") : records;
}
