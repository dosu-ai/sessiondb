"""A directory as a store: what the TypeScript ``FsStore`` writes, read back; and a writable one
for tests and fixtures. Writes are temp + rename, so a reader never sees a partial object."""

from __future__ import annotations

import os
from pathlib import Path

from sessiondb.store.base import PAGE_LIMIT, ListPage, check_key


class FsStore:
    def __init__(self, root: str | os.PathLike[str]) -> None:
        text = os.fspath(root)
        if text.startswith("file://"):
            text = text.removeprefix("file://")
        self.root = Path(text).resolve()

    @property
    def url(self) -> str:
        return self.root.as_uri()

    def _path(self, key: str) -> Path:
        return self.root.joinpath(*check_key(key).split("/"))

    def get(self, key: str) -> bytes | None:
        path = self._path(key)
        try:
            return path.read_bytes()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            return None

    def list(
        self, prefix: str, *, start_after: str | None = None, limit: int = PAGE_LIMIT
    ) -> ListPage:
        # The whole tree under the deepest directory the prefix names, sorted: small trees
        # here, and S3's semantics exactly (a prefix is a string, not a directory).
        head, _, _ = prefix.rpartition("/")
        base = self.root.joinpath(*head.split("/")) if head else self.root
        if not base.is_dir():
            return ListPage(keys=[], truncated=False)
        keys = sorted(
            p.relative_to(self.root).as_posix()
            for p in base.rglob("*")
            if p.is_file() and p.relative_to(self.root).as_posix().startswith(prefix)
        )
        if start_after:
            keys = [k for k in keys if k > start_after]
        limit = max(1, limit)
        return ListPage(keys=keys[:limit], truncated=len(keys) > limit)

    def put(self, key: str, body: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_bytes(body)
        tmp.replace(path)

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)
