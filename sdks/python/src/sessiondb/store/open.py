"""A store from a URL, the way every sessiondb program resolves one: ``file:///path`` (or a bare
absolute path) is a directory, ``s3://bucket/prefix`` and ``r2://bucket/prefix`` a bucket."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

from sessiondb.errors import StoreError
from sessiondb.models import StorageView
from sessiondb.store.base import ObjectStore
from sessiondb.store.fs import FsStore
from sessiondb.store.s3 import S3Credentials, S3Store

_BUCKET_URL = re.compile(r"^(s3|r2)://")


def is_store_url(url: str) -> bool:
    return url.startswith(("file://", "/")) or bool(_BUCKET_URL.match(url))


@dataclass(frozen=True)
class OpenedStore:
    store: ObjectStore
    # Where this is, as a reader would need to know it; what a server reports from ``me()``.
    storage: StorageView


def open_store(
    url: str,
    *,
    region: str | None = None,
    account_id: str | None = None,
    endpoint: str | None = None,
    credentials: S3Credentials | None = None,
    env: Mapping[str, str] | None = None,
) -> OpenedStore:
    """Open ``url``. For a bucket, ``region``, ``account_id`` and ``endpoint`` fall back to
    ``AWS_REGION``/``S3_REGION``, ``R2_ACCOUNT_ID`` and ``S3_ENDPOINT``; credentials omitted
    are boto3's to find."""
    if url.startswith(("file://", "/")):
        store = FsStore(url)
        return OpenedStore(store, StorageView(url=store.url))
    if _BUCKET_URL.match(url):
        env = os.environ if env is None else env
        region = region or env.get("AWS_REGION") or env.get("S3_REGION")
        account_id = account_id or env.get("R2_ACCOUNT_ID")
        endpoint = endpoint or env.get("S3_ENDPOINT")
        if url.startswith("r2://") and not account_id and not endpoint:
            raise StoreError("r2:// needs an account id (R2_ACCOUNT_ID) or an endpoint")
        s3 = S3Store.from_url(
            url, region=region, account_id=account_id, endpoint=endpoint, credentials=credentials
        )
        return OpenedStore(
            s3, StorageView(url=url, region=region, account_id=account_id, endpoint=endpoint)
        )
    raise StoreError(f"a store URL is s3://, r2:// or file://, got {url}")
