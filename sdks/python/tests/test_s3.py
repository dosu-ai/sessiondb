"""``S3Store``: URL parsing always; the store itself against a live S3-compatible endpoint when
``SESSIONDB_TEST_S3_*`` are set (CI runs RustFS; locally, MinIO or RustFS on :9000). The golden
bucket is uploaded under a fresh prefix and read back through the same reader the fs tests use,
so what passes on a directory passes on a bucket."""

import os
import uuid
from pathlib import Path

import pytest

from sessiondb import (
    S3Credentials,
    S3Store,
    StoreError,
    StoreSessionDB,
    open_store,
    parse_s3_url,
)
from tests.conftest import AUTH, FIXTURES, OWNER

ENDPOINT = os.environ.get("SESSIONDB_TEST_S3_ENDPOINT")
BUCKET = os.environ.get("SESSIONDB_TEST_S3_BUCKET")
ACCESS_KEY = os.environ.get("SESSIONDB_TEST_S3_ACCESS_KEY")
SECRET_KEY = os.environ.get("SESSIONDB_TEST_S3_SECRET_KEY")
configured = all((ENDPOINT, BUCKET, ACCESS_KEY, SECRET_KEY))


def test_parse_s3_url():
    assert parse_s3_url("s3://bucket/some/prefix/") == parse_s3_url("s3://bucket/some/prefix")
    parsed = parse_s3_url("r2://bucket")
    assert (parsed.scheme, parsed.bucket, parsed.prefix) == ("r2", "bucket", "")
    assert str(parse_s3_url("s3://b/p")) == "s3://b/p"
    with pytest.raises(StoreError):
        parse_s3_url("gs://bucket")


def test_open_store_resolves_a_bucket_from_the_environment():
    opened = open_store(
        "r2://bucket/prefix",
        credentials=S3Credentials("k", "s"),
        env={"R2_ACCOUNT_ID": "acct"},
    )
    assert isinstance(opened.store, S3Store)
    assert opened.store.url == "r2://bucket/prefix"
    assert opened.storage.account_id == "acct"
    with pytest.raises(StoreError, match="r2:// needs an account id"):
        open_store("r2://bucket", credentials=S3Credentials("k", "s"), env={})
    with pytest.raises(StoreError, match="a store URL is"):
        open_store("gs://bucket")


def test_open_store_resolves_a_directory(tmp_path: Path):
    opened = open_store(str(tmp_path))
    assert opened.storage.url == tmp_path.resolve().as_uri()
    assert open_store(tmp_path.as_uri()).storage.url == opened.storage.url


@pytest.mark.skipif(not configured, reason="SESSIONDB_TEST_S3_* not set")
def test_the_golden_bucket_reads_back_from_s3():
    assert ENDPOINT and BUCKET and ACCESS_KEY and SECRET_KEY
    prefix = f"sessiondb-python-test/{uuid.uuid4()}"
    store = S3Store(
        BUCKET,
        prefix,
        endpoint=ENDPOINT,
        region="us-east-1",
        credentials=S3Credentials(ACCESS_KEY, SECRET_KEY),
    )
    root = FIXTURES / "bucket"
    client = store._client
    keys = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    for key in keys:
        client.put_object(Bucket=BUCKET, Key=f"{prefix}/{key}", Body=(root / key).read_bytes())
    try:
        db = StoreSessionDB(store, OWNER)
        assert db.check() is not None
        # Keys come back relative to the prefix, in order, paged with start_after.
        listed = store.list("owners/acme/changes/", limit=2)
        assert listed.truncated and len(listed.keys) == 2
        rest = store.list("owners/acme/changes/", start_after=listed.keys[-1])
        assert listed.keys + rest.keys == [k for k in keys if k.startswith("owners/acme/changes/")]
        assert store.get("owners/acme/nope") is None
        # The same reads as from the directory.
        fs = StoreSessionDB(open_store(str(root)).store, OWNER)
        assert db.changes() == fs.changes()
        assert db.list_sessions() == fs.list_sessions()
        assert db.get_trace("claude-code", AUTH) == fs.get_trace("claude-code", AUTH)
    finally:
        for key in keys:
            client.delete_object(Bucket=BUCKET, Key=f"{prefix}/{key}")
