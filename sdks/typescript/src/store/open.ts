/** A `Store` from a URL, the way every sessiondb program resolves one: `file:///path` (or a
 * bare absolute path) is a folder, `s3://bucket/prefix` and `r2://bucket/prefix` a bucket. The
 * bucket's region, account and endpoint come from `options`, falling back to the environment
 * variables the server documents (`AWS_REGION`, `R2_ACCOUNT_ID`, `S3_ENDPOINT`); credentials
 * are resolved by `S3Store` (`AWS_*` / `S3_*` / `R2_*`), or passed explicitly. */

import { FsStore } from "./fs";
import type { S3Credentials } from "./s3";
import { S3Store } from "./s3";
import { type Store, StoreError } from "./store";

/** Where a store is, as a reader would need to know it: never a secret. */
export interface StorageView {
  url: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
}

export interface OpenStoreOptions {
  region?: string;
  accountId?: string;
  endpoint?: string;
  credentials?: S3Credentials;
  /** Where to read the per-scheme extras from when not given; `process.env` by default. */
  env?: Record<string, string | undefined>;
}

export function isStoreUrl(url: string): boolean {
  return url.startsWith("file://") || url.startsWith("/") || /^(s3|r2):\/\//.test(url);
}

export function openStore(
  url: string,
  options: OpenStoreOptions = {},
): { store: Store; storage: StorageView } {
  if (url.startsWith("file://") || url.startsWith("/")) {
    const store = new FsStore(url);
    return { store, storage: { url: store.url } };
  }
  if (/^(s3|r2):\/\//.test(url)) {
    const env = options.env ?? process.env;
    const region = options.region ?? env.AWS_REGION ?? env.S3_REGION;
    const accountId = options.accountId ?? env.R2_ACCOUNT_ID;
    const endpoint = options.endpoint ?? env.S3_ENDPOINT;
    if (url.startsWith("r2://") && !accountId && !endpoint) {
      throw new StoreError("r2:// needs an account id (R2_ACCOUNT_ID) or an endpoint");
    }
    const store = S3Store.fromUrl(url, {
      region,
      accountId,
      endpoint,
      credentials: options.credentials,
    });
    return {
      store,
      storage: {
        url,
        ...(region ? { region } : {}),
        ...(accountId ? { account_id: accountId } : {}),
        ...(endpoint ? { endpoint } : {}),
      },
    };
  }
  throw new StoreError(`a store URL is s3://, r2:// or file://, got ${url}`);
}
