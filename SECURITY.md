# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/dosu-ai/sessiondb/security/advisories/new)
on GitHub. Do not open a public issue for anything that could expose a session transcript or a
credential.

## What the server protects, and what it does not

**Transcripts arrive unredacted.** The client posts the native log verbatim; redaction happens
on the server before anything is written. The server process and the network path to it see
secrets. Run it behind TLS (a reverse proxy or a load balancer that terminates HTTPS) and keep
the host as locked down as anything else that handles credentials.

**Redaction is best-effort.** The pass (`sdks/typescript/src/redact/secrets.ts`) is biased toward
over-redaction and covers the shapes secrets usually take: provider token prefixes, key/value
credential assignments, bearer headers, JWTs, connection URLs, private-key blocks, and a
Shannon-entropy pass for anything long and random in a secret-shaped position. A secret in a
shape none of those recognise reaches the bucket. Before it, a pass withholds what tool calls
returned when they touched a secrets file or ran a command that prints a secret
(`sdks/typescript/src/redact/sensitive.ts`), since those are mostly values no pattern
recognises; an operator can add patterns, files and commands of their own
(`SESSIONDB_REDACTION_FILE`), never remove a built-in one. Treat the bucket as sensitive data with a
narrow audience, not as a public artifact. If you find a secret shape the pass misses, report
it as a vulnerability.

**A token scopes one person.** Every request is confined to `owners/<name>/` for the name the
token is bound to. A leaked token exposes that person's archive and lets its holder upload
under their name; rotate it in `SESSIONDB_TOKENS` and restart. Tokens are compared in
constant time and must be at least 16 characters. A signed token (`SESSIONDB_TOKEN_SECRET`)
is scoped the same way, by the owner in its `sub`; it cannot be struck from a list, so it
is good until its `exp`, and rotating the secret invalidates every one at once.

**The bucket credential lives only on the server.** Clients never receive it. `GET /v1/me`
reports the bucket URL and region so a client can tell a reader where to look; it never
reports a key.

**Readers are outside this server's control.** Anything with a read key on the bucket reads
every owner's folder. Scope reader credentials to the prefix you intend to share.

**Tombstones delete objects, not history.** `DELETE /v1/sessions/…` removes the trace and raw
objects and appends a tombstone to the change feed; a reader that already copied the trace
still has it. Object versioning or replication on the bucket, if enabled, keeps the deleted
bytes under the bucket's own retention rules.
