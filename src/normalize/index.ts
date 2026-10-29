/** Native transcript → redacted trajectory-v1 records. Normalization is `@letta-ai/trajectory`'s
 * job; this module applies the fixups its adapters need (Claude Code's background-task input,
 * Codex's inherited history and subagent reports), runs the adapter, and redacts. The one
 * source it has no adapter for, a Datadog Trajectory session stream, has its own here. String
 * in, records out. */

import {
  normalizeTranscript as letta,
  type TranscriptTrajectorySource,
} from "@letta-ai/trajectory";
import trajectoryPackage from "@letta-ai/trajectory/package.json";
import { redactRecords } from "../redact/records";
import type { NormalizedRecord } from "../schemas/trajectory";
import { VERSION } from "../version";
import { markClaudeInputs, markedAsObservations } from "./claude-inputs";
import { subagentReportsAsObservations, withoutInheritedHistory } from "./codex-rollout";
import { DATADOG_TRAJECTORY, normalizeDatadogTrajectory } from "./datadog-trajectory";

/** What a stored trace records as its normalizer: this server's release plus the
 * `@letta-ai/trajectory` it ran, as semver build metadata. Either changing can change the
 * records a transcript normalizes to, so a re-normalization pass selects by both. */
export const NORMALIZER = {
  name: "sessiondb-server",
  version: `${VERSION}+trajectory.${trajectoryPackage.version}`,
} as const;

/** The native logs `@letta-ai/trajectory` reads, by their trajectory source name. */
const LETTA_SOURCES = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
  "pi",
  "gemini-cli",
] as const satisfies readonly TranscriptTrajectorySource[];

/** The transcript formats this server accepts: the native logs, and a Datadog Trajectory
 * session stream. The name is also the `agent` a client sends and what the archive id is
 * derived from. */
export const SOURCES = [...LETTA_SOURCES, DATADOG_TRAJECTORY] as const;

export type Source = (typeof SOURCES)[number];

type LettaSource = (typeof LETTA_SOURCES)[number];

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

/** The adapter's refusals that only mean "no conversation here": the session is trivial, not
 * unsupported. */
const EMPTY_CONVERSATION_CODES = new Set(["missing_user_records", "missing_assistant_records"]);

export type NormalizeOutcome =
  | { records: NormalizedRecord[]; empty?: false }
  /** A log with no conversation in it. */
  | { records: []; empty: true };

/** Thrown when a transcript cannot be normalized (unsupported source, unparseable transcript). */
export class NormalizeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NormalizeError";
    this.code = code;
  }
}

/** The per-source rewrite the adapter needs to see. */
function prepare(source: LettaSource, transcript: string): string {
  switch (source) {
    case "codex":
      return withoutInheritedHistory(transcript);
    case "claude-code":
      return markClaudeInputs(transcript);
    default:
      return transcript;
  }
}

/** The records of one transcript before redaction: the Datadog stream through its own adapter,
 * every native log through `@letta-ai/trajectory` with its fixups around it. */
function recordsOf(source: Source, transcript: string): NormalizedRecord[] {
  if (source === DATADOG_TRAJECTORY) return normalizeDatadogTrajectory(transcript);
  const { records } = letta({ source, transcript: prepare(source, transcript) });
  switch (source) {
    case "codex":
      return subagentReportsAsObservations(records);
    case "claude-code":
      return markedAsObservations(records);
    default:
      return records;
  }
}

/** Normalize one transcript to redacted trajectory-v1 records. `empty` for a transcript the
 * adapter reads but finds no conversation in; throws `NormalizeError` for one it cannot read. */
export function normalizeTranscript(input: {
  source: Source;
  transcript: string;
}): NormalizeOutcome {
  const { source, transcript } = input;
  if (transcript.trim() === "") return { records: [], empty: true };
  try {
    return { records: redactRecords(recordsOf(source, transcript)) };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && EMPTY_CONVERSATION_CODES.has(code)) {
      return { records: [], empty: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new NormalizeError(typeof code === "string" ? code : "normalize_failed", message);
  }
}
