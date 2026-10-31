"""The storage interface the reader goes through: the few bucket operations it needs. Keys are
relative to the store's root (a directory, or a bucket prefix) and use ``/``. ``list`` has S3's
semantics: lexicographic order, ``start_after`` exclusive, a page at most ``limit`` long."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

# One listing page; S3 caps a page at 1000 keys anyway.
PAGE_LIMIT = 1000


@dataclass(frozen=True)
class ListPage:
    keys: list[str]
    truncated: bool


@runtime_checkable
class ObjectStore(Protocol):
    """What a reader needs of a store: list keys under a prefix, get an object."""

    @property
    def url(self) -> str:
        """``file:///…``, ``s3://bucket/prefix``, ``r2://bucket/prefix``: how a reader names
        this store to someone else."""
        ...

    def list(
        self, prefix: str, *, start_after: str | None = None, limit: int = PAGE_LIMIT
    ) -> ListPage: ...

    def get(self, key: str) -> bytes | None: ...


def check_key(key: str) -> str:
    if key.startswith("/") or ".." in key.split("/"):
        raise ValueError(f"invalid key: {key!r}")
    return key
