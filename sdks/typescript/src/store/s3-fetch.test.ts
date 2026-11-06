import { describe, expect, it } from "vitest";
import { S3Store } from "./s3";
import { StoreError } from "./store";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A fetch that records each request and answers from `respond`. */
function fakeFetch(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const request = {
      method: init?.method ?? "GET",
      url: input,
      headers: init?.headers as Record<string, string>,
    };
    seen.push(request);
    return respond(request);
  };
  return { fetch, seen };
}

const credentials = { accessKeyId: "AKID", secretAccessKey: "secret" };

describe("S3Store over fetch", () => {
  it("addresses AWS virtual-hosted, signed for the region", async () => {
    const { fetch, seen } = fakeFetch(() => new Response("hi"));
    const store = S3Store.fromUrl("s3://acme/archive", { region: "eu-west-1", credentials, fetch });
    expect(await store.get("owners/a/x.json")).toEqual(new TextEncoder().encode("hi"));
    expect(seen[0]?.url).toBe("https://acme.s3.eu-west-1.amazonaws.com/archive/owners/a/x.json");
    expect(seen[0]?.headers.authorization).toContain("/eu-west-1/s3/aws4_request");
  });

  it("addresses R2 path-style on the account's endpoint, signed for region auto", async () => {
    const { fetch, seen } = fakeFetch(() => new Response(null, { status: 200 }));
    const store = S3Store.fromUrl("r2://acme/p", { accountId: "abc123", credentials, fetch });
    await store.put("k.json", new TextEncoder().encode("{}"), { contentType: "application/json" });
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.url).toBe("https://abc123.r2.cloudflarestorage.com/acme/p/k.json");
    expect(seen[0]?.headers.authorization).toContain("/auto/s3/aws4_request");
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
  });

  it("addresses an explicit endpoint path-style", async () => {
    const { fetch, seen } = fakeFetch(() => new Response(null, { status: 404 }));
    const store = S3Store.fromUrl("s3://b", {
      endpoint: "http://127.0.0.1:9000/",
      credentials,
      fetch,
    });
    expect(await store.get("missing")).toBeNull();
    expect(seen[0]?.url).toBe("http://127.0.0.1:9000/b/missing");
  });

  it("stats with the unquoted etag, null when absent", async () => {
    const { fetch } = fakeFetch(({ url }) =>
      url.endsWith("/there")
        ? new Response(null, { headers: { etag: '"abc"', "content-length": "5" } })
        : new Response(null, { status: 404 }),
    );
    const store = S3Store.fromUrl("s3://b", { credentials, fetch });
    expect(await store.stat("there")).toEqual({ size: 5, etag: "abc" });
    expect(await store.stat("gone")).toBeNull();
  });

  it("lists with ListObjectsV2, strips the prefix and decodes keys", async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>p/owners/a/1&amp;2.json</Key></Contents>
      <Contents><Key>p/owners/a/3.json</Key></Contents></ListBucketResult>`;
    const { fetch, seen } = fakeFetch(() => new Response(xml));
    const store = S3Store.fromUrl("s3://b/p", { credentials, fetch });
    expect(await store.list("owners/a/", { startAfter: "owners/a/0.json", limit: 2 })).toEqual({
      keys: ["owners/a/1&2.json", "owners/a/3.json"],
      truncated: true,
    });
    const url = new URL(seen[0]?.url as string);
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(url.searchParams.get("prefix")).toBe("p/owners/a/");
    expect(url.searchParams.get("start-after")).toBe("p/owners/a/0.json");
    expect(url.searchParams.get("max-keys")).toBe("2");
  });

  it("treats a missing object on delete as done", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 404 }));
    await expect(S3Store.fromUrl("s3://b", { credentials, fetch }).delete("x")).resolves.toBe(
      undefined,
    );
  });

  it("reports S3's error code as a StoreError", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response("<Error><Code>AccessDenied</Code><Message>nope</Message></Error>", {
          status: 403,
        }),
    );
    const err = await S3Store.fromUrl("s3://b", { credentials, fetch })
      .put("k", new Uint8Array())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(String((err as StoreError).cause)).toContain("403 AccessDenied: nope");
  });

  it("refuses to start without credentials", () => {
    const saved = { ...process.env };
    for (const k of ["S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"]) {
      delete process.env[k];
    }
    try {
      expect(() =>
        S3Store.fromUrl("r2://b", { accountId: "a", fetch: async () => new Response() }),
      ).toThrow(/R2_ACCESS_KEY_ID/);
    } finally {
      process.env = saved;
    }
  });
});
