import { posix } from "node:path";
import * as z from "zod";
import { authSection } from "./auth";
import { captureSection } from "./capture";
import { type Visibility, visibility } from "./common";
import { filterSection } from "./filter";
import { limitsSection } from "./limits";
import { recordsSection } from "./records";
import { redactionSection } from "./redaction";
import { reviewSection } from "./review";
import { searchSection } from "./search";
import { secretsSection } from "./secrets";
import { serverSection } from "./server";
import { sourcesSection, UPLOAD_SOURCE_ID } from "./sources";
import { storeSection } from "./store";
import { workerSection } from "./worker";

const sections = z.strictObject({
  server: serverSection,
  store: storeSection,
  auth: authSection,
  default_visibility: visibility
    .default("org")
    .describe("Visibility of a session nothing else sets (X5.10): org or owner."),
  filter: filterSection,
  limits: limitsSection,
  records: recordsSection,
  redaction: redactionSection,
  review: reviewSection,
  sources: sourcesSection,
  search: searchSection,
  worker: workerSection,
  capture: captureSection,
  secrets: secretsSection,
});

/** The sections that may also live in the bucket's `config/seshi.toml` when
 * `server.runtime_config` is `store` (the data policy, which an admin changes now and then).
 * The rest describe the process, its bucket and who may call it, and stay in files, env and
 * flags. Sources live in the bucket too, one object each (`runtime/sources/`). */
export const RUNTIME_SECTIONS = [
  "default_visibility",
  "filter",
  "redaction",
  "review",
  "records",
  "capture",
] as const satisfies readonly (keyof z.output<typeof sections>)[];

function bucketOf(url: string, extra = ""): { at: string; prefix: string } | undefined {
  const folder = /^(?:file:\/\/)?(\/.*)$/.exec(url);
  const match = folder
    ? ["", "file", "", posix.normalize(folder[1] as string)]
    : /^(s3|r2|az|gs):\/\/([^/]+)\/?(.*)$/.exec(url);
  if (!match) return undefined;
  const prefix = [match[3], extra]
    .map((p) => (p ?? "").replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
  return { at: `${match[1]}://${match[2]}`, prefix };
}

function overlaps(a: string, b: string): boolean {
  const inside = (outer: string, inner: string) =>
    outer === "" || inner === outer || inner.startsWith(`${outer}/`);
  return inside(a, b) || inside(b, a);
}

type Sections = z.output<typeof sections>;

/** The checks that span sections: unique source ids, a source reading seshi's own bucket,
 * session keys, review policies naming sources. The schema runs them; a reload runs them again
 * on the config it would apply, whose restart-only sections are the running ones. */
function crossCheck(
  config: Sections,
  issue: (path: (string | number)[], message: string) => void,
): void {
  const seen = new Set<string>();
  config.sources.forEach((source, i) => {
    if (seen.has(source.id)) issue(["sources", i, "id"], `id '${source.id}' is used twice`);
    seen.add(source.id);
    if (source.type === "s3") {
      const own = bucketOf(config.store.url);
      const read = bucketOf(source.url, source.prefix);
      if (own && read && own.at === read.at && overlaps(own.prefix, read.prefix)) {
        issue(
          ["sources", i, "url"],
          "reads seshi's own bucket and prefix (store.url); a source must point elsewhere (F6.4)",
        );
      }
    }
  });
  const keys = Object.keys(config.auth.session_keys);
  const keyId = config.auth.session_key_id;
  if (keyId !== undefined && !keys.includes(keyId)) {
    issue(
      ["auth", "session_key_id"],
      `names no key in auth.session_keys (${keys.join(", ") || "none"})`,
    );
  }
  if (config.auth.oidc !== undefined && keys.length === 0) {
    issue(["auth", "session_keys"], "auth.oidc needs a key here to sign session tokens (X5.9)");
  }
  if (keyId === undefined && keys.length > 1) {
    issue(
      ["auth", "session_key_id"],
      "required when auth.session_keys holds more than one key: which one signs",
    );
  }
  const sealing = Object.keys(config.secrets.keys);
  if (config.secrets.key_id !== undefined && !sealing.includes(config.secrets.key_id)) {
    issue(["secrets", "key_id"], `names no key in secrets.keys (${sealing.join(", ") || "none"})`);
  }
  if (config.secrets.key_id === undefined && sealing.length > 1) {
    issue(
      ["secrets", "key_id"],
      "required when secrets.keys holds more than one key: which one seals",
    );
  }
  const policies = new Set<string>();
  config.review.policies.forEach((policy, i) => {
    if (policies.has(policy.id)) {
      issue(["review", "policies", i, "id"], `id '${policy.id}' is used twice`);
    }
    policies.add(policy.id);
    policy.sources.forEach((id, j) => {
      if (id !== UPLOAD_SOURCE_ID && !seen.has(id)) {
        issue(
          ["review", "policies", i, "sources", j],
          `no source with id '${id}' (or '${UPLOAD_SOURCE_ID}' for uploads)`,
        );
      }
    });
  });
}

/** What `crossCheck` finds in a parsed config, as `path: message` lines. */
export function serverConfigProblems(config: ServerConfig): string[] {
  const problems: string[] = [];
  crossCheck(config, (path, message) => problems.push(`${path.join(".")}: ${message}`));
  return problems;
}

export const serverConfigSchema = sections
  .superRefine((config, ctx) =>
    crossCheck(config, (path, message) => ctx.addIssue({ code: "custom", path, message })),
  )
  .describe(
    "seshi server configuration (seshi.toml). Precedence: flags, then SESHI_* env, then this file, then defaults.",
  );

export type ServerConfig = z.output<typeof serverConfigSchema>;

export function filterFor(config: ServerConfig, sourceId: string): ServerConfig["filter"] {
  const source = config.sources.find((s) => s.id === sourceId);
  const override = Object.fromEntries(
    Object.entries(source?.filter ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...config.filter, ...override };
}

export function visibilityFor(config: ServerConfig, sourceId: string): Visibility {
  return config.sources.find((s) => s.id === sourceId)?.visibility ?? config.default_visibility;
}

export function signingKeyId(config: ServerConfig): string | undefined {
  return config.auth.session_key_id ?? Object.keys(config.auth.session_keys)[0];
}

export { type AuthSection, authSection, type OidcSection, oidcSection } from "./auth";
export { type CaptureSection, captureSection } from "./capture";
export { STORE_URL, sourceId, VISIBILITIES, type Visibility } from "./common";
export { type FilterOverride, type FilterSection, filterSection } from "./filter";
export { type LimitsSection, limitsSection } from "./limits";
export { type RecordsSection, recordsSection } from "./records";
export { type RedactionSection, redactionSection } from "./redaction";
export {
  BUILT_PROVIDERS,
  DEFAULT_BASE_URLS,
  DEFAULT_DECISION_MAX_TOKENS,
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_REDACTOR_MAX_TOKENS,
  DEFAULT_REVIEW_MODEL,
  DEFAULT_REVIEW_TIMEOUT_MS,
  EFFORTS,
  PROVIDERS,
  type ResolvedStep,
  type ReviewCategory,
  type ReviewPolicy,
  type ReviewProvider,
  type ReviewSection,
  type ReviewStepConfig,
  resolveSteps,
  reviewPromptFiles,
  reviewSection,
} from "./review";
export { type SearchSection, searchSection } from "./search";
export {
  MIN_SEALING_KEY_LENGTH,
  type SecretsSection,
  sealingKeyId,
  secretsSection,
} from "./secrets";
export { parseListen, ROLES, type ServerSection, serverSection } from "./server";
export {
  S3_PATH_PLACEHOLDERS,
  type SourceConfig,
  type SourceType,
  sourcesSection,
  UPLOAD_SOURCE_ID,
} from "./sources";
export {
  type BucketCredentials,
  bucketCredentials,
  credentialsMismatch,
  type RevealedBucketCredentials,
  revealBucketCredentials,
  type StoreSection,
  storeSection,
} from "./store";
export { type WorkerSection, workerSection } from "./worker";
