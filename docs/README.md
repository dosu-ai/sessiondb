# seshi docs

seshi is one binary: the server, the CLI, and the hooks that capture coding-agent sessions.
Start with the [README](../README.md) for what it is, the
[agents it supports](../README.md#supported-agents) and a quick start; these pages go further.

## Using it

| Page | For |
|---|---|
| [install.md](install.md) | Installing `seshi`: the install scripts, npm, release archives, checksums, platforms |
| [capture.md](capture.md) | Capturing sessions from Claude Code, Codex, Cursor, pi and OpenCode: hooks, the uploader, the status line, turning capture off, retraction |
| [cli.md](cli.md) | Every command, its flags and exit codes; signing in; serverless mode |
| [serverless.md](serverless.md) | Running with no server: each laptop writes the shared bucket; setup, permissions, example policies, switching modes |
| [search.md](search.md) | `seshi search` and `GET /v1/search`: queries, filters, the index |

## Running a server

| Page | For |
|---|---|
| [architecture.svg](architecture.svg) | One diagram of the whole system: laptop capture, the server, the bucket and its readers |
| [server.md](server.md) | Running `seshi serve`: roles and background jobs, sources, deploying, who may call it and who sees what, the HTTP API |
| [config.md](config.md) | Every setting, for the server (`seshi.toml`, `SESHI_*`) and for the CLI |
| [redaction.md](redaction.md) | The built-in rules, writing your own rule packs, trying them, applying them to stored sessions |
| [model-review.md](model-review.md) | The optional model stage that drops or redacts what regular expressions miss |
| [otlp.md](otlp.md) | OpenTelemetry traces: Claude Console destinations and other OTLP/HTTP exporters |
| [datadog.md](datadog.md) | Polling Datadog LLM Observability for Datadog Trajectory's sessions |
| [s3-sync.md](s3-sync.md) | Polling a bucket other systems write transcripts to |
| [cursor-cloud.md](cursor-cloud.md) | Polling Cursor's Cloud Agents API for Cursor Cloud agents' sessions |
| [../SECURITY.md](../SECURITY.md) | What seshi protects and what it does not, and how to report a vulnerability |

## Building on it

| Page | For |
|---|---|
| [formats.md](formats.md) | The transcript formats seshi reads, and the trace formats it writes and renders |
| [client.md](client.md) | `@dosu/seshi-client`, `@dosu/seshi-model`, the Python client (`seshi`), and the contract for other languages |
| [`spec/openapi.yaml`](../spec/openapi.yaml) | The HTTP API, route by route |
| [`spec/layout.md`](../spec/layout.md) | The object layout in the bucket: what readers may rely on |

## Working on seshi

| Page | For |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | The repository layout, the checks, the goldens, commits |
| [releasing.md](releasing.md) | What a release does, and trying one locally |
| [seshi/design-decisions.html](seshi/design-decisions.html) | Every agreed decision; the IDs in these pages (X4.3, F9.7, B1.5) point into it |
| [seshi/build/](seshi/build/README.md) | How the decisions were built, branch by branch |
| [seshi/decision-models.md](seshi/decision-models.md) | Scope: Jev and OpenAI Decisions as the review decision step |
| [../brand/](../brand/README.md) | The Threadling brand: glyph, lockups, poses, colour tokens |

## History

[understanding/session-store-field-guide.html](understanding/session-store-field-guide.html) is
an onboarding guide to sessiondb v0.9.0, the code seshi was rebuilt from. It describes the old
SDK, server and layout, and is kept as a record, not as documentation of seshi.
