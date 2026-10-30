/** The prefix hash of a session's records, grown a chunk at a time.
 *
 * `prefix_sha256` is the sha256 of the canonical JSON of a session's records, and every answer
 * carries it for the whole session so far. A whole upload has the records in hand and hashes
 * them; a chunk does not have the ones before it, so the hash is carried between chunks as
 * state instead: the sha256 mid-stream, after the records so far, saved in `metadata.json` and
 * resumed for the next chunk. `node:crypto` cannot export a hash mid-stream, so this is its own
 * SHA-256 (FIPS 180-4), checked against `node:crypto` in its tests. The result is the same
 * `prefixSha256` a whole upload computes, so a client can go from chunks to a whole upload with
 * `shipped` and still be continued. */

import { canonicalJson } from "./continuation";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 whose state can be saved and resumed. */
export class ResumableSha256 {
  private h = new Uint32Array(H0);
  private readonly block = new Uint8Array(64);
  private pending = 0;
  /** Bytes hashed so far, pending ones included. */
  private total = 0;
  private readonly w = new Uint32Array(64);

  update(data: Uint8Array): this {
    let i = 0;
    while (i < data.length) {
      const take = Math.min(64 - this.pending, data.length - i);
      this.block.set(data.subarray(i, i + take), this.pending);
      this.pending += take;
      i += take;
      if (this.pending === 64) {
        this.compress(this.block);
        this.pending = 0;
      }
    }
    this.total += data.length;
    return this;
  }

  /** The digest of everything so far, in hex; hashing can go on after. */
  digest(): string {
    const copy = this.clone();
    const bits = BigInt(copy.total) * 8n;
    const tail = new Uint8Array(copy.pending <= 55 ? 64 - copy.pending : 128 - copy.pending);
    tail[0] = 0x80;
    new DataView(tail.buffer).setBigUint64(tail.length - 8, bits);
    copy.update(tail);
    return Array.from(copy.h, (v) => v.toString(16).padStart(8, "0")).join("");
  }

  /** The state, as one string for `resume`. */
  export(): string {
    const h = Array.from(this.h, (v) => v.toString(16).padStart(8, "0")).join("");
    const pending = Array.from(this.block.subarray(0, this.pending), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return `${h}:${this.total}:${pending}`;
  }

  static resume(state: string): ResumableSha256 {
    const match = /^([0-9a-f]{64}):(\d+):((?:[0-9a-f]{2}){0,63})$/.exec(state);
    if (!match) throw new Error("invalid sha256 state");
    const hash = new ResumableSha256();
    for (let i = 0; i < 8; i++) hash.h[i] = Number.parseInt(match[1].slice(i * 8, i * 8 + 8), 16);
    hash.total = Number(match[2]);
    const pending = match[3];
    hash.pending = pending.length / 2;
    for (let i = 0; i < hash.pending; i++) {
      hash.block[i] = Number.parseInt(pending.slice(i * 2, i * 2 + 2), 16);
    }
    if (hash.total % 64 !== hash.pending) throw new Error("invalid sha256 state");
    return hash;
  }

  private clone(): ResumableSha256 {
    const copy = new ResumableSha256();
    copy.h.set(this.h);
    copy.block.set(this.block);
    copy.pending = this.pending;
    copy.total = this.total;
    return copy;
  }

  private compress(block: Uint8Array): void {
    const { w, h } = this;
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
}

const encoder = new TextEncoder();

/** `prefixSha256` of a record list, one record at a time, resumable between chunks. The digest
 * after `n` records equals `prefixSha256(records, n)`. */
export class PrefixHash {
  private constructor(
    private readonly hash: ResumableSha256,
    private count: number,
  ) {}

  static empty(): PrefixHash {
    return new PrefixHash(new ResumableSha256(), 0);
  }

  /** The hash after `records`. */
  static of(records: readonly unknown[]): PrefixHash {
    const hash = PrefixHash.empty();
    for (const record of records) hash.append(record);
    return hash;
  }

  /** Resume from `export()`. */
  static resume(state: string): PrefixHash {
    const count = state.slice(0, Math.max(state.indexOf(":"), 0));
    if (!/^\d+$/.test(count)) throw new Error("invalid prefix hash state");
    return new PrefixHash(ResumableSha256.resume(state.slice(count.length + 1)), Number(count));
  }

  get records(): number {
    return this.count;
  }

  append(record: unknown): void {
    this.hash.update(encoder.encode(`${this.count === 0 ? "[" : ","}${canonicalJson(record)}`));
    this.count += 1;
  }

  digest(): string {
    const copy = ResumableSha256.resume(this.hash.export());
    return copy.update(encoder.encode(this.count === 0 ? "[]" : "]")).digest();
  }

  export(): string {
    return `${this.count}:${this.hash.export()}`;
  }
}
