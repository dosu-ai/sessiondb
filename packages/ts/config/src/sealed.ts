import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import * as z from "zod";
import { shapeOf } from "./load";
import type { SecretsSection } from "./server/secrets";
import { MIN_SEALING_KEY_LENGTH, sealingKeyId } from "./server/secrets";
import { source as sourceSchema } from "./server/sources";
import { isPlainObject, isSecret, nodeAt, type PlainObject } from "./shape";

/** A sealed secret as a stored source holds it: `{ sealed = "v1.<key id>.<iv>.<box>" }`. */
export interface SealedValue {
  sealed: string;
}

/** What may be said about a stored secret: never its value. */
export interface SecretView {
  set: true;
  /** An HMAC of the value under the sealing key, 12 hex digits: the same value shows the same
   * fingerprint until the next `reseal`, and the value cannot be guessed from it. */
  fingerprint: string;
  key_id: string;
  updated_at: string;
}

export class SealingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealingError";
  }
}

const VERSION = "v1";

function derive(key: string, purpose: string, kid: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, "seshi/sealed/1", `${purpose}:${kid}`, 32));
}

/** The keys in `[secrets]`: seals with the current one, unseals with whichever sealed. */
export class Keyring {
  readonly current: string | undefined;
  readonly #keys: Map<string, string>;

  constructor(keys: Readonly<Record<string, string>>, current?: string) {
    this.#keys = new Map(Object.entries(keys));
    for (const [kid, value] of this.#keys) {
      if (value.length < MIN_SEALING_KEY_LENGTH) {
        throw new SealingError(
          `secrets.keys.${kid} must be ${MIN_SEALING_KEY_LENGTH}+ characters (try: openssl rand -hex 32)`,
        );
      }
    }
    this.current = current ?? (this.#keys.size === 1 ? [...this.#keys.keys()][0] : undefined);
  }

  static fromConfig(section: SecretsSection): Keyring {
    return new Keyring(
      Object.fromEntries(Object.entries(section.keys).map(([kid, s]) => [kid, s.reveal()])),
      sealingKeyId(section),
    );
  }

  get ids(): string[] {
    return [...this.#keys.keys()];
  }

  /** `value` sealed with the current key, bound to `context` (a source id and field). */
  seal(value: string, context: string): SealedValue {
    const kid = this.current;
    const key = kid === undefined ? undefined : this.#keys.get(kid);
    if (kid === undefined || key === undefined) {
      throw new SealingError(
        "no sealing key: set secrets.keys (and secrets.key_id when there are several) to store a source with secrets",
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", derive(key, "seal", kid), iv);
    cipher.setAAD(Buffer.from(context));
    const box = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return {
      sealed: [VERSION, kid, iv.toString("base64url"), box.toString("base64url")].join("."),
    };
  }

  /** The key id `sealed` was sealed with. */
  keyOf(sealed: SealedValue): string {
    return sealed.sealed.split(".")[1] ?? "";
  }

  unseal(sealed: SealedValue, context: string): string {
    const [version, kid, iv, box] = sealed.sealed.split(".");
    if (version !== VERSION || !kid || !iv || !box) {
      throw new SealingError("not a sealed value seshi can read");
    }
    const key = this.#keys.get(kid);
    if (key === undefined) {
      throw new SealingError(`sealed with key '${kid}', which secrets.keys does not hold`);
    }
    const bytes = Buffer.from(box, "base64url");
    if (bytes.length < 16) throw new SealingError("a sealed value is cut short");
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        derive(key, "seal", kid),
        Buffer.from(iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      return Buffer.concat([
        decipher.update(bytes.subarray(0, bytes.length - 16)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new SealingError(
        `cannot unseal with key '${kid}': the key changed, or the value was moved or altered`,
      );
    }
  }

  fingerprint(value: string, kid: string): string {
    const key = this.#keys.get(kid);
    if (key === undefined) throw new SealingError(`no key '${kid}' in secrets.keys`);
    return createHmac("sha256", derive(key, "fingerprint", kid))
      .update(value)
      .digest("hex")
      .slice(0, 12);
  }
}

export function isSealed(value: unknown): value is SealedValue {
  return (
    isPlainObject(value) && typeof value.sealed === "string" && Object.keys(value).length === 1
  );
}

const sourceShape = shapeOf(z.strictObject({ sources: z.array(sourceSchema) }));

/** The paths of the secret settings in a source (`api_key`, `credentials.secret_access_key`)
 * that `source` sets, dotted. */
export function secretFields(source: PlainObject): string[] {
  const tree = { sources: [source] };
  const found: string[] = [];
  const visit = (value: unknown, path: string[]): void => {
    const node = nodeAt(sourceShape, tree, ["sources", 0, ...path]);
    if (path.length > 0 && isSecret(node)) {
      found.push(path.join("."));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  };
  visit(source, []);
  return found;
}

export function getField(tree: PlainObject, dotted: string): unknown {
  let at: unknown = tree;
  for (const key of dotted.split(".")) {
    if (!isPlainObject(at)) return undefined;
    at = at[key];
  }
  return at;
}

export function setField(tree: PlainObject, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let at = tree;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(at[key])) at[key] = {};
    at = at[key] as PlainObject;
  }
  at[keys.at(-1) as string] = value;
}

/** What a source's sealed secret is bound to: it cannot be moved to another source or field. */
export function sealContext(sourceId: string, field: string): string {
  return `source:${sourceId}:${field}`;
}
