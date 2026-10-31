"""The golden bucket: ``fixtures/bucket``, written by the TypeScript SDK
(``scripts/golden-bucket.ts`` at the repository root) from the parity transcripts under owner
``acme``, with ``fixtures/manifest.json`` saying what it put in. Every test reads it through
the same code an S3 bucket goes through; ``bucket`` is a fresh copy, so a test may write."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from sessiondb import FsStore, StoreSessionDB

FIXTURES = Path(__file__).parent / "fixtures"
OWNER = "acme"

# What the manifest's sessions are called.
AUTH = "sess-auth"  # stored, then grown: two traces, the second a continuation
REFACTOR = "sess-refactor"  # published, then tombstoned
PERF = "sess-perf"  # stored once
RAW_ONLY = "sess-claude-basic"  # too short for a trace: raw part, no head
RAW_ONLY_JSON = "sess-opencode-export"  # the same, as a `json` document


@pytest.fixture
def manifest() -> dict[str, Any]:
    with (FIXTURES / "manifest.json").open() as f:
        data: dict[str, Any] = json.load(f)
        return data


@pytest.fixture
def bucket(tmp_path: Path) -> FsStore:
    root = tmp_path / "bucket"
    shutil.copytree(FIXTURES / "bucket", root)
    return FsStore(root)


@pytest.fixture
def db(bucket: FsStore) -> StoreSessionDB:
    return StoreSessionDB(bucket, OWNER)
