/** A directory as a `Store`: the local target, and what tests use. Writes are temp + rename so a
 * reader never sees a partial object. The ETag is the file's size and mtime, not an MD5, so a
 * `stat` never reads the file; `publish` verifies a write here by reading it back. */

import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type GetOptions,
  type ListOptions,
  type ListResult,
  type ObjectStat,
  type PutOptions,
  type Store,
  StoreError,
} from "./store";

function isNotFound(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT";
}

export class FsStore implements Store {
  readonly root: string;
  readonly url: string;

  /** `dir` may be a path or a `file://` URL. */
  constructor(dir: string) {
    this.root = resolve(dir.startsWith("file://") ? fileURLToPath(dir) : dir);
    this.url = pathToFileURL(this.root).href;
  }

  private pathOf(key: string): string {
    if (key.startsWith("/") || key.split("/").includes("..")) {
      throw new StoreError(`invalid key: ${key}`);
    }
    return join(this.root, ...key.split("/"));
  }

  async get(key: string, options: GetOptions = {}): Promise<Uint8Array | null> {
    const { range } = options;
    try {
      if (!range) return new Uint8Array(await readFile(this.pathOf(key)));
      const file = await open(this.pathOf(key), "r");
      try {
        const size = (await file.stat()).size;
        const start = Math.min(range.start, size);
        const end = Math.min(range.end ?? size, size);
        const out = new Uint8Array(Math.max(end - start, 0));
        let read = 0;
        while (read < out.length) {
          const { bytesRead } = await file.read(out, read, out.length - read, start + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return out.subarray(0, read);
      } finally {
        await file.close();
      }
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new StoreError(`read ${key}`, err);
    }
  }

  async put(key: string, body: Uint8Array, _options: PutOptions = {}): Promise<void> {
    const path = this.pathOf(key);
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, body);
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw new StoreError(`write ${key}`, err);
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const path = this.pathOf(key);
    try {
      const info = await stat(path, { bigint: true });
      if (!info.isFile()) return null;
      return { size: Number(info.size), etag: `${info.size}-${info.mtimeNs}` };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new StoreError(`stat ${key}`, err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathOf(key));
    } catch (err) {
      if (!isNotFound(err)) throw new StoreError(`delete ${key}`, err);
    }
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    const limit = options.limit ?? 1000;
    // The deepest directory the prefix fully names; walk from there and filter.
    const cut = prefix.lastIndexOf("/");
    const dir = cut < 0 ? this.root : this.pathOf(prefix.slice(0, cut));
    let keys: string[];
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      keys = entries
        .filter((e) => e.isFile() && !e.name.endsWith(".tmp"))
        .map((e) => relative(this.root, join(e.parentPath, e.name)).split(sep).join("/"))
        .filter((k) => k.startsWith(prefix))
        .sort();
    } catch (err) {
      if (isNotFound(err)) return { keys: [], truncated: false };
      throw new StoreError(`list ${prefix}`, err);
    }
    if (options.startAfter !== undefined) {
      const after = options.startAfter;
      keys = keys.filter((k) => k > after);
    }
    return { keys: keys.slice(0, limit), truncated: keys.length > limit };
  }
}
