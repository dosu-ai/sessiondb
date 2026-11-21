import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BaseLayer, ConfigError, parseConfigToml } from "./load";
import { DEFAULT_BASE_URLS } from "./server/review";

/** The bucket's shared settings live under this prefix (F11.6): what serverless laptops read,
 * and a server's runtime config when `server.runtime_config` is `store`. */
export const SHARED_PREFIX = "config/";
export const SHARED_CONFIG = "seshi.toml";

/** The providers' own endpoints: the only ones a shared config may send a key to. */
const PROVIDER_ENDPOINTS = new Set(Object.values(DEFAULT_BASE_URLS));

const SAFE_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** A name under `config/` a laptop, a server or `seshi admin config` will read or write: a
 * relative path of plain names, none of them `.` or `..`, so it stays inside the folder it
 * lands in. */
export function safeSharedName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.split("/").some((part) => part === ".." || part === ".");
}

/** A secret read from a file names a path on each machine: a shared config may not name one. */
function fileSecrets(value: unknown, path: string[], found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      fileSecrets(v, [...path, String(i)], found);
    });
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "file") found.push(path.join("."));
    else for (const [k, v] of Object.entries(value)) fileSecrets(v, [...path, k], found);
  }
}

/** `config/seshi.toml` from a copy of the folder, with the paths it names relative to
 * `config/` (redaction packs, review prompt files) made absolute into that copy. A path must
 * stay inside the copy, no secret may be read from a file (a shared config names nothing on
 * the machine that reads it), and a policy with a key may name no endpoint but its
 * provider's (a key from a machine's environment goes nowhere the shared config chose). */
export function baseLayerIn(dir: string, origin: string): BaseLayer | undefined {
  const file = join(dir, SHARED_CONFIG);
  if (!existsSync(file)) return undefined;
  return baseLayerOf(dir, origin, parseConfigToml(origin, readFileSync(file, "utf8")));
}

/** `baseLayerIn` for a config already parsed (`tree`, changed in place): a candidate the
 * admin API checks before it writes it. */
export function baseLayerOf(dir: string, origin: string, tree: Record<string, unknown>): BaseLayer {
  const problems: string[] = [];
  const local = (path: unknown, where: string) => {
    if (typeof path !== "string") return path;
    const inside = resolve(dir, path);
    const rel = relative(resolve(dir), inside);
    if (
      isAbsolute(path) ||
      path.startsWith("~") ||
      rel.startsWith("..") ||
      rel.split(sep)[0] === ".."
    ) {
      problems.push(`${where}: ${JSON.stringify(path)} is outside config/; name a file in it`);
      return path;
    }
    return inside;
  };
  const named: string[] = [];
  fileSecrets(tree, [], named);
  for (const where of named) {
    problems.push(
      `${where}: a secret read from a file names a path on each machine; use { env = "NAME" }`,
    );
  }
  const redaction = tree.redaction as { packs?: unknown } | undefined;
  if (redaction && Array.isArray(redaction.packs)) {
    redaction.packs = redaction.packs.map((p, i) => local(p, `redaction.packs.${i}`));
  }
  const review = tree.review as { policies?: unknown } | undefined;
  if (review && Array.isArray(review.policies)) {
    (review.policies as Record<string, Record<string, unknown>>[]).forEach((policy, i) => {
      const keyed = ["decision", "redactor"].some((step) => {
        const s = policy?.[step];
        return !!s && typeof s === "object" && "api_key" in s;
      });
      for (const step of ["decision", "redactor"]) {
        const s = policy?.[step];
        if (!s || typeof s !== "object") continue;
        if ("prompt_file" in s) {
          s.prompt_file = local(s.prompt_file, `review.policies.${i}.${step}.prompt_file`);
        }
        if (keyed && typeof s.base_url === "string" && !PROVIDER_ENDPOINTS.has(s.base_url)) {
          problems.push(
            `review.policies.${i}.${step}.base_url: a shared config may not send each machine's key to an endpoint it names; leave base_url unset, or set this policy in each machine's own config`,
          );
        }
      }
    });
  }
  if (problems.length > 0) throw new ConfigError(problems.map((p) => `${origin}: ${p}`));
  return { path: origin, tree };
}
