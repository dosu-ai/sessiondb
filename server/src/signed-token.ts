/** Tokens the server did not have to be told about: a JWT signed with a secret it shares with
 * whoever issues them (`SESSIONDB_TOKEN_SECRET`), naming an owner. A hosted server has one
 * tenant per user and cannot carry them as a list in its environment; the issuer (Dosu's
 * backend, for its users) mints one per person, and the server checks the signature and the
 * expiry and reads the owner off the claims. A self-hosted team keeps the static list and never
 * sets the secret; a server may have both.
 *
 * HS256 only, `sub` is the owner, `exp` is required: a token that cannot expire is one a lost
 * laptop keeps forever. */

import { createHmac, timingSafeEqual } from "node:crypto";
import { assertOwner } from "@dosu/sessiondb";

const HEADER = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/** The least a secret may be: an HMAC key shorter than its hash is a guessable one. */
export const MIN_SECRET_LENGTH = 32;

export interface SignedTokenClaims {
  /** The owner the token acts as (`sub`). */
  owner: string;
  /** Expiry, seconds since the epoch (`exp`). */
  exp: number;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(secret: string, signingInput: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

/** Mint a token for `claims`; what an issuer does, and what the tests use. */
export function signToken(secret: string, claims: SignedTokenClaims): string {
  const payload = base64url(
    JSON.stringify({ sub: assertOwner(claims.owner), exp: Math.floor(claims.exp) }),
  );
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${base64url(hmac(secret, signingInput))}`;
}

/** The owner a token names, when its signature is `secret`'s and it has not expired;
 * undefined for anything else, with no reason given (the caller answers 401 either way). */
export function verifyToken(secret: string, token: string, now: Date): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  let claims: Record<string, unknown>;
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (parsedHeader?.alg !== "HS256") return undefined;
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const expected = hmac(secret, `${header}.${payload}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  if (typeof claims !== "object" || claims === null) return undefined;
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  if (exp * 1000 <= now.getTime()) return undefined;
  if (typeof claims.sub !== "string") return undefined;
  try {
    return assertOwner(claims.sub);
  } catch {
    return undefined;
  }
}
