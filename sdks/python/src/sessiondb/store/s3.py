"""AWS S3 and Cloudflare R2 as a store, over boto3. ``s3://`` and ``r2://`` are two URL schemes
over this one class; the scheme only decides how the endpoint is resolved (R2 is an account
endpoint and region ``auto``). Anything S3-compatible (MinIO, RustFS, Garage) works through
``s3://`` with an explicit ``endpoint``, which also switches to path-style addressing, since
those serve buckets by path and not by hostname. Needs the ``s3`` extra (``boto3``)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from sessiondb.errors import StoreError
from sessiondb.store.base import PAGE_LIMIT, ListPage, check_key

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

Scheme = Literal["s3", "r2"]

_URL = re.compile(r"^(s3|r2)://([^/]+)(?:/(.*))?$")


@dataclass(frozen=True)
class S3Credentials:
    access_key_id: str
    secret_access_key: str
    session_token: str | None = None


@dataclass(frozen=True)
class S3Url:
    scheme: Scheme
    bucket: str
    prefix: str

    def __str__(self) -> str:
        return f"{self.scheme}://{self.bucket}" + (f"/{self.prefix}" if self.prefix else "")


def parse_s3_url(url: str) -> S3Url:
    """``s3://bucket/prefix`` or ``r2://bucket/prefix``; the prefix has no leading or trailing
    slash and may be empty."""
    m = _URL.match(url)
    if not m:
        raise StoreError(f"not an s3:// or r2:// URL: {url}")
    scheme, bucket, prefix = m.group(1), m.group(2), (m.group(3) or "").strip("/")
    return S3Url(scheme="r2" if scheme == "r2" else "s3", bucket=bucket, prefix=prefix)


class S3Store:
    def __init__(
        self,
        bucket: str,
        prefix: str = "",
        *,
        scheme: Scheme = "s3",
        region: str | None = None,
        account_id: str | None = None,
        endpoint: str | None = None,
        credentials: S3Credentials | None = None,
        client: S3Client | None = None,
        connect_timeout: float = 5,
        read_timeout: float = 30,
    ) -> None:
        """Omit ``credentials`` to use boto3's resolution (``AWS_*`` variables, profiles,
        instance roles). Pass ``client`` to bring a configured boto3 client; then the endpoint,
        region and credentials here are ignored."""
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.scheme = scheme
        self.url = str(S3Url(scheme, bucket, self.prefix))
        if client is not None:
            self._client = client
            return
        try:
            import boto3
            from botocore.config import Config
        except ImportError as e:  # pragma: no cover - import guard
            raise StoreError(
                "S3Store needs boto3: pip install 'dosu-sessiondb[s3]'", cause=e
            ) from e
        addressing: Literal["virtual", "path"] = "virtual"
        if scheme == "r2":
            if not account_id and not endpoint:
                raise StoreError("r2:// needs an account id or an endpoint")
            endpoint = endpoint or f"https://{account_id}.r2.cloudflarestorage.com"
            region = region or "auto"
        elif endpoint:
            addressing = "path"
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=credentials.access_key_id if credentials else None,
            aws_secret_access_key=credentials.secret_access_key if credentials else None,
            aws_session_token=credentials.session_token if credentials else None,
            config=Config(
                s3={"addressing_style": addressing},
                retries={"max_attempts": 4, "mode": "standard"},
                connect_timeout=connect_timeout,
                read_timeout=read_timeout,
            ),
        )

    @classmethod
    def from_url(cls, url: str, **options: Any) -> S3Store:
        parsed = parse_s3_url(url)
        return cls(parsed.bucket, parsed.prefix, scheme=parsed.scheme, **options)

    def _key(self, key: str) -> str:
        check_key(key)
        return f"{self.prefix}/{key}" if self.prefix else key

    def get(self, key: str) -> bytes | None:
        try:
            response = self._client.get_object(Bucket=self.bucket, Key=self._key(key))
        except self._client.exceptions.NoSuchKey:
            return None
        except Exception as e:
            raise StoreError(f"get {key}: {e}", cause=e) from e
        return response["Body"].read()

    def list(
        self, prefix: str, *, start_after: str | None = None, limit: int = PAGE_LIMIT
    ) -> ListPage:
        params: dict[str, Any] = {
            "Bucket": self.bucket,
            "Prefix": self._key(prefix) if prefix else (f"{self.prefix}/" if self.prefix else ""),
            "MaxKeys": max(1, min(limit, PAGE_LIMIT)),
        }
        if start_after:
            params["StartAfter"] = self._key(start_after)
        try:
            page = self._client.list_objects_v2(**params)
        except Exception as e:
            raise StoreError(f"list {prefix}: {e}", cause=e) from e
        strip = len(self.prefix) + 1 if self.prefix else 0
        return ListPage(
            keys=[obj["Key"][strip:] for obj in page.get("Contents", [])],
            truncated=bool(page.get("IsTruncated")),
        )
