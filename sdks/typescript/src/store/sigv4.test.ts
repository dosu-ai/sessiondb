import { describe, expect, it } from "vitest";
import { encodeKeyPath, sha256Hex, signRequest } from "./sigv4";

// The worked examples in AWS's "Signature Version 4 for Amazon S3: header-based auth" docs.
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const date = new Date("2013-05-24T00:00:00Z");

describe("signRequest", () => {
  it("signs AWS's GET Object example", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      region: "us-east-1",
      credentials,
      date,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });

  it("signs AWS's list example, sorting the query", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2"),
      region: "us-east-1",
      credentials,
      date,
    });
    expect(headers.authorization).toContain(
      "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });

  it("signs the session token when there is one", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://b.s3.amazonaws.com/k"),
      region: "us-east-1",
      credentials: { ...credentials, sessionToken: "tok" },
      date,
    });
    expect(headers["x-amz-security-token"]).toBe("tok");
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,",
    );
  });
});

describe("encodeKeyPath", () => {
  it("encodes each segment and keeps the slashes", () => {
    expect(encodeKeyPath("owners/a b/x+y(1)*.json")).toBe("owners/a%20b/x%2By%281%29%2A.json");
  });
});

describe("sha256Hex", () => {
  it("hashes the empty body", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
