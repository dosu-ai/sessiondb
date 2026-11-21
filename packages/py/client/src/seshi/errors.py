"""What the server refuses, as the errors the pipeline would have raised.

The same vocabulary as `@dosu/seshi-client` (docs/client.md#errors): `409 offset_mismatch` is
`OffsetMismatch`, `409 conflict` is `SessionConflict`, `403 forbidden` is `Forbidden`, `422` is
`SessionRejected`, `502` (and a server that cannot be reached) is `StoreError`; every other
answer is a `ServerError` with its status and code. The runtime config calls (`put_source`,
`patch_runtime_config`…) raise `PreconditionFailed` for `412` and `ConfigRejected` for `422`.
All of them are `SeshiError`s.
"""

from __future__ import annotations


class SeshiError(Exception):
    """Every error this client raises."""

    code: str = "error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class SessionRejected(SeshiError):
    """A transcript that cannot be stored: `unsupported_agent`, `too_large`, `empty`,
    `bad_chunk`, `redacted` (the session was tombstoned), `normalize_<code>` or `invalid`.
    Final for that upload: resending the same bytes cannot succeed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class OffsetMismatch(SeshiError):
    """A chunk that does not start where the server's copy of the log ends: nothing is stored.
    Resend from `expected` (0 while the session has no trace: the whole log)."""

    code = "offset_mismatch"

    def __init__(self, offset: int, expected: int) -> None:
        super().__init__(f"chunk starts at byte {offset}; the session's log ends at {expected}")
        self.offset = offset
        self.expected = expected


class SessionConflict(SeshiError):
    """A whole upload that does not extend the stored session (X4.6). Nothing is stored; its
    original writer, or an admin, can send it again with `replace`."""

    code = "conflict"


class Forbidden(SeshiError):
    """The credential may not do this."""

    code = "forbidden"


class StoreError(SeshiError):
    """The server's bucket failed, or the server could not be reached: a fault to retry, not a
    refusal."""

    code = "storage_error"


class ServerError(SeshiError):
    """Any other answer: unauthorized (401), a bad request (400), a route that is not there
    (404), the search index still building (503 `index_building`), an internal error."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code

    def __repr__(self) -> str:
        return f"ServerError(status={self.status}, code={self.code!r}, message={self.message!r})"


class PreconditionFailed(SeshiError):
    """A conditional write whose condition did not hold: the object changed since its ETag was
    read (`if_match`), or exists (`create=True`). Read it again and redo the change."""

    code = "precondition_failed"


class ConfigRejected(SeshiError):
    """A runtime config change the server refused before writing anything: it would not load
    or check (`invalid`), or a secret cannot be sealed (`sealing`). `problems` lists each
    thing wrong."""

    def __init__(self, code: str, message: str, problems: list[str]) -> None:
        super().__init__(message)
        self.code = code
        self.problems = problems
