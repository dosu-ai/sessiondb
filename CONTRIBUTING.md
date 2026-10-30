# Contributing

## Setup

[Bun](https://bun.sh) 1.3 or later (`.bun-version` pins what CI uses). No build step: Bun runs
the TypeScript directly.

```sh
bun install
bun run test
bun run typecheck
bun run check
```

The repository is a Bun workspace:

| Path | What |
|---|---|
| `spec/` | The contract: `layout.md` (the object layout), `openapi.yaml` (the HTTP API), and `testdata/` (fixtures and goldens) |
| `sdks/typescript/` | `@dosu-ai/sessiondb`: redact, normalize, store, read. Everything that is not HTTP |
| `server/` | `sessiondb-server`: the HTTP routes and `main.ts`, over the SDK. The `Dockerfile` is here, built from the repository root |
| `docs/` | `server.md`, the API and configuration reference |

Every root script (`test`, `typecheck`, `check`, `start`, `goldens`, `fixtures`) runs across
the workspace.

CI runs those three plus the S3 store test against a live S3-compatible endpoint
([RustFS](https://github.com/rustfs/rustfs)). To run it locally, point
`SESSIONDB_TEST_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY` and `_SECRET_KEY` at any S3-compatible
service; without them the test skips.

## What a change needs

- Tests beside the code (`*.test.ts`). Behaviour that readers of the bucket depend on
  (`spec/layout.md`) needs a test that would fail if it changed.
- `bun run check` clean. Biome formats and lints; `bun run format` fixes what it can.
- Documentation in the same change. `docs/server.md` is the API and configuration reference;
  `spec/layout.md` is the object layout; `.env.example` lists every variable. A change to any
  of those is incomplete without the matching doc edit.
- A route change is a `spec/openapi.yaml` change. `server/src/openapi.test.ts` validates every
  response the server gives against the document and fails on a documented status it never
  observed, so a new status, field or route needs the document and a request in that test.

## The goldens

`spec/testdata/goldens/` pins what every fixture transcript normalizes to and what each record
set parses to: `content_hash`, events, and the trace fields. `content_hash` is part of the
layout contract, so the goldens test (`sdks/typescript/src/trace/goldens.test.ts`) fails on any
change to the hash or event derivation.

If a change is meant to alter them, run `bun run goldens` and commit the regenerated files; the
diff is the review. If it is not, the failure is a bug in the change.

Fixture transcripts are produced by `bun run fixtures` (`sdks/typescript/scripts/fixtures.ts`)
and contain nothing real. Do not add a transcript from an actual session to `spec/testdata/`,
redacted or not.

## Redaction rules

A new pattern in `sdks/typescript/src/redact/secrets.ts` needs a test for what it catches and a test for the
ordinary text it must leave alone. Over-redaction is the preferred failure, but a rule that
eats common prose (`password is wrong`, a UUID, a git SHA) makes the archive useless, and the
existing tests encode those cases for a reason.

## Commits and pull requests

One change per pull request, described in terms of what a user or reader of the bucket sees.
A commit message says what changed and why; the diff already says how.
