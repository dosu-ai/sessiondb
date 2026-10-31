"""What the SDK raises. Every error is a ``SessionDBError``, so a caller that does not care
which can catch one thing; the subclasses say whether to retry (``StoreError``: the bucket or
the server failed), fix the setup (``LayoutError``: this is not a layout we read) or give up on
the upload (``SessionRejected``, ``OffsetMismatch``: the same bytes cannot succeed)."""

from __future__ import annotations


class SessionDBError(Exception):
    """Base class of everything this package raises on purpose."""


class StoreError(SessionDBError):
    """The store (a bucket, a directory, a server) failed or refused: retryable in general."""

    def __init__(self, message: str, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.__cause__ = cause


class LayoutError(SessionDBError, ValueError):
    """The bytes are not (or no longer) a sessionstorage layout this version reads: an
    unknown ``schema``, a malformed object, a key that is not where the layout puts it."""


class SessionRejected(SessionDBError):
    """The server refused the transcript for good (HTTP 422): resending the same bytes cannot
    succeed. ``code`` is the server's (``unsupported_agent``, ``too_large``, ``empty``,
    ``bad_chunk``, ``redacted``, ``normalize_<code>``, ``invalid``)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


class OffsetMismatch(SessionDBError):
    """A chunk that does not start where the server's copy of the log ends (HTTP 409). Resend
    from ``expected``, or from 0 (the whole log) when the client no longer has that."""

    def __init__(self, expected: int, got: int, message: str | None = None) -> None:
        super().__init__(message or f"offset mismatch: expected {expected}, got {got}")
        self.expected = expected
        self.got = got


class Unauthorized(SessionDBError):
    """The server did not accept the token (HTTP 401)."""
