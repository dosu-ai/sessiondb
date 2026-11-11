/** What an operator adds to redaction: their own patterns, files and commands. Every list is
 * added to the built-in ones and none can take a built-in away, so the store still never holds
 * what the built-ins would have redacted.
 *
 * The JSON shape is the one Dosu's CLI writes for an org's rules (`redaction.json`):
 *
 * ```json
 * { "patterns": ["ACME-[0-9A-F]{32}", "internal-key: (?<secret>\\S+)"],
 *   "sensitive_files": ["config/master.key", "secrets/**", "!secrets/README.md"],
 *   "secret_commands": ["acme-cli\\s+token\\b"] }
 * ```
 *
 * A transcript goes through, in order: sensitive calls (`sensitive.ts`), the custom patterns
 * (`patterns.ts`), then the built-in secret patterns (`raw.ts`). The sensitive pass is first
 * because the ones after it may redact the ids it links a result to its call by. */

import type { RawFormat } from "../schemas/store";
import { compilePatterns, redactTranscriptPatterns } from "./patterns";
import {
  redactSensitive,
  type SensitiveRules,
  secretCommands,
  sensitiveFiles,
  type WithheldCalls,
} from "./sensitive";

export interface RedactionConfig {
  /** Regular expressions; a match, or its `secret` group, becomes `[redacted:custom-pattern]`. */
  patterns?: string[];
  /** Globs added to the built-in sensitive files; `!` for an exception. */
  sensitive_files?: string[];
  /** Regular expressions for commands whose output is a secret, added to the built-in ones. */
  secret_commands?: string[];
}

export interface RedactionRules {
  patterns: RegExp[];
  sensitive: SensitiveRules;
}

export class RedactionConfigError extends Error {
  constructor(readonly problems: { field: string; pattern: string; reason: string }[]) {
    super(
      `redaction rules are not usable: ${problems
        .map((p) => `${p.field} '${p.pattern}' (${p.reason})`)
        .join("; ")}`,
    );
    this.name = "RedactionConfigError";
  }
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new RedactionConfigError([{ field, pattern: "", reason: "must be a list of strings" }]);
  }
  return value as string[];
}

/** The built-in rules with `config` added. Throws `RedactionConfigError` naming every pattern
 * or command that is not a usable regular expression: an operator who wrote one expects it to
 * apply, so it is refused rather than skipped. */
export function redactionRules(config: RedactionConfig = {}): RedactionRules {
  const patterns = compilePatterns(stringList(config.patterns, "patterns"));
  const commands = secretCommands(stringList(config.secret_commands, "secret_commands"));
  const problems = [
    ...patterns.invalid.map((p) => ({ field: "patterns", ...p })),
    ...commands.invalid.map((p) => ({ field: "secret_commands", ...p })),
  ];
  if (problems.length > 0) throw new RedactionConfigError(problems);
  return {
    patterns: patterns.patterns,
    sensitive: {
      files: sensitiveFiles(stringList(config.sensitive_files, "sensitive_files")),
      commands: commands.commands,
    },
  };
}

/** `redactionRules` over a JSON document of that shape. */
export function parseRedactionConfig(json: string): RedactionRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new RedactionConfigError([
      { field: "file", pattern: "", reason: err instanceof Error ? err.message : String(err) },
    ]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RedactionConfigError([{ field: "file", pattern: "", reason: "must be an object" }]);
  }
  // The last three are what Dosu's CLI also keeps in the file (where an org's sessions do not
  // ship, and when the file was fetched): about the client's machine, nothing a server applies.
  const known = new Set([
    "patterns",
    "sensitive_files",
    "secret_commands",
    "excluded",
    "names_only",
    "fetched_at",
  ]);
  const unknown = Object.keys(parsed).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new RedactionConfigError(
      unknown.map((k) => ({ field: k, pattern: "", reason: "is not a known field" })),
    );
  }
  return redactionRules(parsed as RedactionConfig);
}

/** The passes that come before the built-in secret patterns: sensitive calls, then the custom
 * patterns. `carried` is what the pass over the session's earlier chunks took out. */
export function applyRules(
  transcript: string,
  format: RawFormat,
  rules: RedactionRules,
  carried: Readonly<WithheldCalls> = {},
): { text: string; withheld: WithheldCalls } {
  const sensitive = redactSensitive(transcript, format, rules.sensitive, carried);
  return {
    text: redactTranscriptPatterns(sensitive.text, format, rules.patterns),
    withheld: sensitive.withheld,
  };
}
