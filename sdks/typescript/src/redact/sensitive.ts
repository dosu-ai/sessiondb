/** Sensitive tool calls: what a tool returned is never stored when the call touched a secrets
 * file or ran a command whose job is to print a secret.
 *
 * Secret patterns catch credentials that look like credentials. A `.env`, a private key or a
 * cloud credentials file is mostly values no pattern recognizes, and `printenv`, `gh auth token`
 * or `kubectl get secret` print exactly what no pattern can tell from an ordinary string. So
 * when a call names such a file, as a path in its input (`Read .env`) or a word of a command
 * (`cat ~/.aws/credentials`), or runs such a command, the call is kept, so the session still says
 * the agent looked, and its result is replaced: `[redacted:sensitive-file]` or
 * `[redacted:secret-output]`. In a file call's own input, a string that names the file is kept
 * and any other string (what an edit wrote into it, say) is replaced, as is any line of a
 * multi-line string that does not name it (a heredoc's body, a patch's lines). A command call's
 * input is kept as it is; the secret patterns still run over it.
 *
 * Agents link a result to its call by id: Claude Code's `tool_use_id`, Codex's `call_id`, Pi's
 * `toolCallId`. OpenCode and Gemini keep a call's input and output in one object. The pass reads
 * every object of a transcript in order, so it needs no agent's format: an object with an input
 * (`input`, `arguments`, `args`, `parameters`, or a `state` holding one) is a call; one with a
 * call's id and no input is its result. A call comes before its result, so the same prefix of a
 * transcript always redacts to the same text, and a line with nothing to replace keeps its
 * bytes. A result can arrive in a later chunk than its call: the pass returns the ids of the
 * calls it took out, and the next chunk's pass starts from them.
 *
 * File globs follow `.gitignore`: one without a `/` matches a file's name in any directory, one
 * with a `/` matches the end of its path; `*` stays within a directory, `**` crosses them, and a
 * glob starting `!` makes an exception. Commands are regular expressions matched at the start of
 * each command in a shell line (after `;`, `&&`, `|`, `$(`, a newline; past `sudo` and leading
 * `VAR=value` assignments). Both lists are the format Dosu's CLI takes for an org's own. */

import type { RawFormat } from "../schemas/store";

export type WithheldKind = "sensitive-file" | "secret-output";

/** Calls taken out so far, by id, with what their results are replaced by. */
export type WithheldCalls = Record<string, WithheldKind>;

/** Files that hold secrets in nearly every project and machine. */
export const BUILTIN_SENSITIVE_FILES: readonly string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "!.env.dist",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".dockercfg",
  ".docker/config.json",
  ".aws/credentials",
  ".azure/accessTokens.json",
  ".config/gcloud/**/*credentials*.json",
  "application_default_credentials.json",
  "service-account*.json",
  ".kube/config",
  "*.tfvars",
  "*.tfstate",
  "secrets.yml",
  "secrets.yaml",
  ".vault-token",
];

/** Commands whose output is a secret, or the environment that holds them. */
export const BUILTIN_SECRET_COMMANDS: readonly string[] = [
  String.raw`printenv\b`,
  String.raw`env(?:\s+-0)?\s*$`,
  String.raw`set\s*$`,
  String.raw`export\s+-p\s*$`,
  String.raw`gh\s+auth\s+token\b`,
  String.raw`(?:gh|glab)\s+auth\s+status\b.*(?:--show-token|\s-t\b)`,
  String.raw`git\s+credential\s+fill\b`,
  String.raw`aws\s+configure\s+(?:get|export-credentials)\b`,
  String.raw`aws\s+sts\s+(?:get-session-token|get-federation-token|assume-role\S*)\b`,
  String.raw`aws\s+ecr(?:-public)?\s+get-login-password\b`,
  String.raw`aws\s+secretsmanager\s+get-secret-value\b`,
  String.raw`aws\s+ssm\s+get-parameters?(?:-by-path)?\b.*--with-decryption`,
  String.raw`gcloud\s+auth\s+(?:application-default\s+)?print-(?:access|identity)-token\b`,
  String.raw`gcloud\s+secrets\s+versions\s+access\b`,
  String.raw`az\s+(?:account\s+get-access-token|keyvault\s+secret\s+show)\b`,
  String.raw`kubectl\s+get\s+secrets?\b`,
  String.raw`kubectl\s+config\s+view\b.*--raw`,
  String.raw`vault\s+(?:kv\s+get|read|token\s+create|print\s+token)\b`,
  String.raw`op\s+(?:read|inject|item\s+get)\b`,
  String.raw`security\s+find-(?:generic|internet)-password\b`,
  String.raw`doppler\s+secrets\b`,
  String.raw`heroku\s+(?:auth:token|config)\b`,
  String.raw`fly(?:ctl)?\s+auth\s+token\b`,
  String.raw`sops\s+(?:-d|--decrypt|decrypt)\b`,
  String.raw`ansible-vault\s+(?:view|decrypt)\b`,
  String.raw`pass\s+show\b`,
];

export interface SensitiveFiles {
  include: RegExp[];
  exclude: RegExp[];
}

export interface SensitiveRules {
  files: SensitiveFiles;
  commands: RegExp[];
}

function globRegExp(raw: string): RegExp {
  const glob = raw.replace(/^\/+/, "");
  let body = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` is any number of directories, none included; `**` alone, anything.
      if (glob[i + 2] === "/") {
        body += "(?:.*/)?";
        i += 2;
      } else {
        body += ".*";
        i += 1;
      }
    } else if (c === "*") {
      body += "[^/]*";
    } else if (c === "?") {
      body += "[^/]";
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // Without a slash, a file's name in any directory; with one, the end of its path.
  return new RegExp(`(?:^|/)${body}$`, "i");
}

/** The built-in globs, then `extra`, as one set. Blank lines and `#` comments are skipped. */
export function sensitiveFiles(extra: readonly string[] = []): SensitiveFiles {
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const raw of [...BUILTIN_SENSITIVE_FILES, ...extra]) {
    const glob = raw.trim();
    if (!glob || glob.startsWith("#")) continue;
    if (glob.startsWith("!")) {
      if (glob.length > 1) exclude.push(globRegExp(glob.slice(1)));
    } else {
      include.push(globRegExp(glob));
    }
  }
  return { include, exclude };
}

export interface CompiledCommands {
  commands: RegExp[];
  invalid: { pattern: string; reason: string }[];
}

/** The built-in commands, then `extra`; one in `extra` that does not compile, or that matches
 * an empty command, is left out and reported. */
export function secretCommands(extra: readonly string[] = []): CompiledCommands {
  const commands: RegExp[] = [];
  const invalid: CompiledCommands["invalid"] = [];
  for (const raw of [...BUILTIN_SECRET_COMMANDS, ...extra]) {
    const source = raw.trim();
    if (!source || source.startsWith("#")) continue;
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${source})`);
    } catch (err) {
      invalid.push({ pattern: raw, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (re.test("")) {
      invalid.push({ pattern: raw, reason: "matches an empty command" });
      continue;
    }
    commands.push(re);
  }
  return { commands, invalid };
}

/** The built-in rules, with `files` and `commands` added. Throws on a command that is not a
 * usable regular expression; `secretCommands` reports them instead. */
export function sensitiveRules(
  options: { files?: readonly string[]; commands?: readonly string[] } = {},
): SensitiveRules {
  const { commands, invalid } = secretCommands(options.commands);
  if (invalid.length > 0) {
    throw new Error(`secret command '${invalid[0].pattern}': ${invalid[0].reason}`);
  }
  return { files: sensitiveFiles(options.files), commands };
}

/** Whether `path` is one of `files`. */
export function isSensitivePath(path: string, files: SensitiveFiles): boolean {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p) return false;
  return files.include.some((re) => re.test(p)) && !files.exclude.some((re) => re.test(p));
}

/** The words of `text` that could be paths: split on space and shell punctuation. */
function words(text: string): string[] {
  return text.split(/[\s'"`;|&<>(),=:]+/).filter((w) => w.length > 0);
}

/** Whether `text` names one of `files` anywhere in it. */
export function namesSensitiveFile(text: string, files: SensitiveFiles): boolean {
  return words(text).some((w) => isSensitivePath(w, files));
}

/** What precedes a command's name without being it: `sudo` and its flags, `VAR=value`, and the
 * builtins that run what follows them. */
const COMMAND_PREFIX =
  /^(?:sudo(?:\s+-\S+)*\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|(?:command|exec|time|nohup)\s+)/;

/** Whether a shell line runs one of `commands` as any of its commands. */
export function runsSecretCommand(text: string, commands: readonly RegExp[]): boolean {
  if (commands.length === 0) return false;
  for (const raw of text.split(/\r?\n|;|&&|\|\||\||\$\(|`|\(|\)/)) {
    let segment = raw.trim();
    for (let m = COMMAND_PREFIX.exec(segment); m; m = COMMAND_PREFIX.exec(segment)) {
      segment = segment.slice(m[0].length).trimStart();
    }
    if (segment && commands.some((re) => re.test(segment))) return true;
  }
  return false;
}

type Json = unknown;
type JsonObject = Record<string, Json>;

const INPUT_KEYS = ["input", "arguments", "args", "parameters"];
const ID_KEYS = ["id", "call_id", "callID", "tool_call_id", "toolCallId", "tool_use_id"];
const REF_KEYS = ["tool_use_id", "call_id", "callID", "tool_call_id", "toolCallId"];
/** Where a call's input holds a shell line. */
const COMMAND_KEYS = new Set(["command", "cmd", "script", "commands"]);
/** Where a call's input names a file it reads or writes. */
const PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "path",
  "paths",
  "file",
  "files",
  "filename",
  "notebook_path",
  "target_file",
  "absolute_path",
  "absolutePath",
]);
const OUTPUT_KEYS = [
  "output",
  "result",
  "resultDisplay",
  "content",
  "stdout",
  "stderr",
  "aggregated_output",
];
/** What a result keeps: how it is linked and labelled, never what it says. */
const KEEP_KEYS = new Set([
  ...ID_KEYS,
  "type",
  "name",
  "toolName",
  "tool",
  "is_error",
  "isError",
  "status",
  "role",
]);

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The call's input: its own, or the one in its `state` (OpenCode). */
function inputOf(obj: JsonObject): { holder: JsonObject; key: string } | null {
  for (const key of INPUT_KEYS) if (key in obj) return { holder: obj, key };
  if (isObject(obj.state)) {
    for (const key of INPUT_KEYS) if (key in obj.state) return { holder: obj.state, key };
  }
  return null;
}

function strings(value: Json, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (isObject(value)) for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** A patch (Codex's `apply_patch`) names its files in headers; the rest is code. */
const PATCH_START = "*** Begin Patch";
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

function patchPaths(text: string): string[] {
  return [...text.matchAll(PATCH_FILE)].map((m) => m[1].trim());
}

/** The paths a call's input names: strings under a path-ish key, and a patch's file headers.
 * What a call writes into a file (`content`, `new_string`) is not one, so a source file whose
 * text mentions `.env` is not taken for a secrets file. */
function pathValues(value: Json, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trimStart().startsWith(PATCH_START)) out.push(...patchPaths(value));
  } else if (Array.isArray(value)) {
    for (const v of value) pathValues(v, out);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (PATH_KEYS.has(k)) {
        for (const s of strings(v)) out.push(s);
      } else {
        pathValues(v, out);
      }
    }
  }
  return out;
}

/** The shell lines in a call's input: the input itself when it is a string (and not a patch),
 * else every string under a command-ish key. Prose a call carries (a message, a report) is
 * neither, so mentioning `.env` there takes nothing out. */
function commandLines(value: Json, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!value.trimStart().startsWith(PATCH_START)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) commandLines(v, out);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (COMMAND_KEYS.has(k)) strings(v, out);
      else if (isObject(v) || Array.isArray(v)) commandLines(v, out);
    }
  }
  return out;
}

/** Every string in `value` replaced with `marker`, except under KEEP_KEYS. */
function blank(value: Json, marker: string): Json {
  if (typeof value === "string") return value ? marker : value;
  if (Array.isArray(value)) return value.map((v) => blank(v, marker));
  if (isObject(value)) {
    const next: JsonObject = {};
    for (const [k, v] of Object.entries(value)) next[k] = KEEP_KEYS.has(k) ? v : blank(v, marker);
    return next;
  }
  return value;
}

const FILE_MARKER = "[redacted:sensitive-file]";

/** A file call's input with what does not name the file replaced. */
function trimInput(value: Json, files: SensitiveFiles): Json {
  if (typeof value === "string") {
    if (!value) return value;
    const lines = value.split("\n");
    if (lines.length === 1) {
      return namesSensitiveFile(value, files) ? value : FILE_MARKER;
    }
    const kept: string[] = [];
    for (const line of lines) {
      if (namesSensitiveFile(line, files)) kept.push(line);
      else if (kept.at(-1) !== FILE_MARKER) kept.push(FILE_MARKER);
    }
    return kept.join("\n");
  }
  if (Array.isArray(value)) return value.map((v) => trimInput(v, files));
  if (isObject(value)) {
    const next: JsonObject = {};
    for (const [k, v] of Object.entries(value)) next[k] = trimInput(v, files);
    return next;
  }
  return value;
}

/** A JSON-encoded input (Codex's `arguments`) is read as the object it encodes. */
function parsedInput(value: Json): Json {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

/** One pass over a transcript's objects, in order, keeping the ids of the calls it took out. */
class Pass {
  readonly withheld: WithheldCalls;

  constructor(
    readonly rules: SensitiveRules,
    carried: Readonly<WithheldCalls>,
  ) {
    this.withheld = { ...carried };
  }

  private classify(input: Json): WithheldKind | null {
    const { files } = this.rules;
    if (
      pathValues(input).some((p) => isSensitivePath(p, files)) ||
      commandLines(input).some((s) => namesSensitiveFile(s, files))
    ) {
      return "sensitive-file";
    }
    if (commandLines(input).some((s) => runsSecretCommand(s, this.rules.commands))) {
      return "secret-output";
    }
    return null;
  }

  /** `value` with what sensitive calls returned replaced; the same value when nothing was. */
  visit(value: Json): Json {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((v) => {
        const r = this.visit(v);
        changed ||= r !== v;
        return r;
      });
      return changed ? next : value;
    }
    if (!isObject(value)) return value;

    const input = inputOf(value);
    if (input) {
      const kind = this.classify(parsedInput(input.holder[input.key]));
      if (kind) {
        for (const key of ID_KEYS) {
          const id = value[key];
          if (typeof id === "string" && id) this.withheld[id] = kind;
        }
        return this.redactCall(value, input, kind);
      }
    } else {
      for (const key of REF_KEYS) {
        const ref = value[key];
        if (typeof ref === "string" && Object.hasOwn(this.withheld, ref)) {
          return blank(value, `[redacted:${this.withheld[ref]}]`);
        }
      }
    }

    let changed = false;
    const next: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const r = this.visit(v);
      changed ||= r !== v;
      next[k] = r;
    }
    if (!changed) return value;
    // Claude Code repeats a tool's result beside its message, in the row's `toolUseResult`.
    if ("toolUseResult" in next) {
      const marker = this.blankedMarkerIn(next);
      if (marker) next.toolUseResult = blank(next.toolUseResult, marker);
    }
    return next;
  }

  private blankedMarkerIn(row: JsonObject): string | null {
    const found = strings(row.message ?? {});
    for (const kind of ["sensitive-file", "secret-output"] as const) {
      if (found.includes(`[redacted:${kind}]`)) return `[redacted:${kind}]`;
    }
    return null;
  }

  private redactCall(
    call: JsonObject,
    input: { holder: JsonObject; key: string },
    kind: WithheldKind,
  ): JsonObject {
    const marker = `[redacted:${kind}]`;
    const raw = input.holder[input.key];
    let holder = input.holder;
    if (kind === "sensitive-file") {
      const parsed = parsedInput(raw);
      const trimmed = trimInput(parsed, this.rules.files);
      holder = { ...holder, [input.key]: parsed !== raw ? JSON.stringify(trimmed) : trimmed };
    } else {
      holder = { ...holder };
    }
    // A call that carries its own output (OpenCode's parts): that goes too.
    for (const key of OUTPUT_KEYS) {
      if (key in holder && key !== input.key) holder[key] = blank(holder[key], marker);
    }
    if (holder.metadata !== undefined && input.holder !== call) {
      holder.metadata = blank(holder.metadata, marker);
    }
    if (input.holder === call) return holder;
    return { ...call, state: holder };
  }
}

function redactDocument(text: string, pass: Pass): string {
  let parsed: Json;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const next = pass.visit(parsed);
  return next === parsed ? text : JSON.stringify(next);
}

export interface SensitiveResult {
  text: string;
  /** `carried` and every call this pass took out: what the next chunk's pass starts from. */
  withheld: WithheldCalls;
}

/** `transcript` with what sensitive calls returned replaced (see above). `carried` is what the
 * pass over the chunks before this one returned. */
export function redactSensitive(
  transcript: string,
  format: RawFormat,
  rules: SensitiveRules,
  carried: Readonly<WithheldCalls> = {},
): SensitiveResult {
  const pass = new Pass(rules, carried);
  const text =
    format === "json"
      ? redactDocument(transcript, pass)
      : transcript
          .split("\n")
          .map((line) => (line.trim() ? redactDocument(line, pass) : line))
          .join("\n");
  return { text, withheld: pass.withheld };
}
