import { describe, expect, it } from "vitest";
import { Keyring, SealingError, sealContext, secretFields } from "./sealed";

const K1 = "k1-0123456789abcdef0123456789abcdef";
const K2 = "k2-0123456789abcdef0123456789abcdef";

describe("Keyring", () => {
  it("seals and unseals a value bound to its source and field", () => {
    const ring = new Keyring({ k1: K1 });
    const sealed = ring.seal("cursor-key", sealContext("cursor-a", "api_key"));
    expect(sealed.sealed).toMatch(/^v1\.k1\./);
    expect(sealed.sealed).not.toContain("cursor-key");
    expect(ring.unseal(sealed, sealContext("cursor-a", "api_key"))).toBe("cursor-key");
    expect(() => ring.unseal(sealed, sealContext("cursor-b", "api_key"))).toThrow(SealingError);
  });

  it("unseals with an old key and seals with the current one", () => {
    const old = new Keyring({ k1: K1 });
    const sealed = old.seal("v", "c");
    const ring = new Keyring({ k1: K1, k2: K2 }, "k2");
    expect(ring.unseal(sealed, "c")).toBe("v");
    expect(ring.keyOf(ring.seal("v", "c"))).toBe("k2");
    expect(() => new Keyring({ k2: K2 }).unseal(sealed, "c")).toThrow(/key 'k1'/);
  });

  it("refuses short keys and sealing without a current key", () => {
    expect(() => new Keyring({ k1: "short" })).toThrow(/32\+ characters/);
    expect(() => new Keyring({}).seal("v", "c")).toThrow(/no sealing key/);
    expect(() => new Keyring({ k1: K1, k2: K2 }).seal("v", "c")).toThrow(/no sealing key/);
  });

  it("fingerprints without showing the value", () => {
    const ring = new Keyring({ k1: K1 });
    const a = ring.fingerprint("secret", "k1");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(ring.fingerprint("secret", "k1")).toBe(a);
    expect(ring.fingerprint("other", "k1")).not.toBe(a);
  });
});

describe("secretFields", () => {
  it("finds a source's secret settings by type", () => {
    expect(secretFields({ id: "c", type: "cursor-cloud", api_key: "x" })).toEqual(["api_key"]);
    expect(
      secretFields({
        id: "r",
        type: "s3",
        url: "s3://b/p",
        credentials: { access_key_id: "a", secret_access_key: { env: "S" } },
      }),
    ).toEqual(["credentials.access_key_id", "credentials.secret_access_key"]);
    expect(
      secretFields({ id: "d", type: "datadog", api_key: { sealed: "v1.k1.a.b" }, app_key: "y" }),
    ).toEqual(["api_key", "app_key"]);
    expect(secretFields({ id: "o", type: "otlp" })).toEqual([]);
  });
});
