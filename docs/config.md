# Configuration

`seshi serve` reads one config, built from four layers (F1.1). A higher layer wins:

1. **Flags**: `--listen`, `--roles`, and `--set path=value` for any setting.
2. **Environment**: `SESHI_*` variables. Only `bun start` from a checkout also reads `.env`
   from the working directory (Bun loads it), and `docker compose` passes `.env` to the
   container; the installed `seshi` binary never reads `.env`, so export the variables or use
   the TOML file there.
3. **The TOML file**: `--config <file>`, else `SESHI_CONFIG`, else `./seshi.toml` (for
   `seshi serve` only), else `/etc/seshi/seshi.toml`. A file named by `--config` or
   `SESHI_CONFIG` must exist; the other two are used when present. With no file, the config
   is env and defaults. Every other command (`config check`, `admin`, `workers`, `sync`,
   `reprocess`, `review`, `search`, `redact`) never reads `./seshi.toml` unless it is named:
   the folder you run them in may be a checkout someone else wrote, and its secret references
   (`{ env = … }`, `{ file = … }`) would send your variables or files to the bucket it names.
   When one is there, they print a hint to pass `--config ./seshi.toml`.
   Beside the file, a `seshi.d/` folder may hold drop-ins ([below](#drop-ins-seshid)).
4. **Defaults**: today's values, listed below.

The schema is strict: an unknown key, in the file or as a `SESHI_*` name, stops the server
from starting, and every problem is reported at once with where its value came from. Sources,
rule packs and the other live settings apply without a restart when the server reloads
([below](#reloading)); the rest apply on restart (F1.5). The config is the operator's: nothing
in it can be set over the API (a reload only reads the files again), and a server never reads
it from the bucket. (In serverless mode, laptops read shared settings
in this same format from the bucket's `config/`; see [serverless.md](serverless.md#shared-settings).)

[`seshi.example.toml`](../seshi.example.toml) is a commented example.
`spec/config.schema.json` is the JSON Schema for editors (Taplo / Even Better TOML: add
`#:schema ./spec/config.schema.json` at the top of the file, or map it in the editor's
settings).

## Checking and showing it

```sh
seshi config check --config seshi.toml   # validate, read every secret reference, print warnings
seshi config show                  # every value, secrets masked
seshi config show --origin         # ... and where each came from: flag, env, file, default
seshi config show --json [--origin]
```

`check` exits 0 when `seshi serve` could start with the config, 3 (`config`) when not. It runs
the same checks `serve` does (tokens long enough, a way to call the server), warns about
settings that do less than they say (a literal secret in a file others can read, `owner`
visibility without an IdP, `server.public_url`), and names every provider a review policy sends
data to. `show` does not read secret references, so it works where those files or variables are
not present. Both take `--config` and `--set`, and `--cli` for the CLI's own config (below).

## Reloading

A running `seshi serve` reads its config again, without a restart, on any of (F1.5):

- `SIGHUP` (`kill -HUP <pid>`, `docker kill --signal HUP <container>`);
- `POST /v1/admin/reload` (`sources:admin`), which answers with the result;
- a change to the file, a drop-in, a rule pack or a review policy's `prompt_file`, when
  `server.watch_config = true` (off by default; a second after the last change).

All three do the same thing, one reload at a time:

1. **All or nothing.** The file, its drop-ins, `SESHI_*` env and the flags the server started
   with are loaded and checked, every secret reference is read, the rule packs are compiled
   and their test strings run, and the review policies are loaded again (their `prompt_file`s
   read), before anything changes. A prompt file that cannot be read is an error like any
   other, as it would be at start-up. On any error the running config stays; the reason is logged, in
   the API's answer (`422 reload_rejected`) and in `GET /v1/admin/reload`.
2. **Sources are compared by id.** An added source starts polling; a removed one stops (a
   run that is going is aborted and waited for); a changed one (any setting, a secret's value
   included) stops and starts again; an unchanged one keeps running. Checkpoints live in the
   bucket and are never reset by a reload: a source removed and added back reads on from where
   it was. Use `seshi sync rewind` to read again on purpose.
3. **Review follows its prompts.** A review policy whose `prompt_file` changed is a new
   policy even when `[review]` did not: its `policy_hash` (recorded with every review
   decision) changes, and new writes are judged with it; a write already going finishes with
   the review it started with. `GET /v1/admin/reload` shows it as a new `review_set` (the
   `config_hash` covers the file's path, not its text).
4. **Rule packs swap atomically.** New writes redact with the new rule set; a write already
   going finishes with the rules it started with. `GET /v1/redaction/rules` serves the new
   packs (a new `ETag`) at once. Stored sessions keep the rules they were stored with until
   `seshi redact backfill`.
5. **Some settings need a restart.** `[server]`, `[store]`, `[auth]`, `[limits]`, `[search]`,
   `[worker]` and `[secrets]` are read once at start-up (the listener, the bucket, identity, request
   caps, the index and the worker's own intervals). A reload that changes one of them applies
   everything else and lists the changed settings in `restart_required` (and logs a warning
   for each); they keep their running values until the server restarts. Live:
   `[[sources]]`, `[redaction]`, `[review]`, `[filter]`, `default_visibility`, `[records]`,
   `[capture]`.

`GET /v1/admin/reload` shows the running config's `generation` (1 at start-up, one more for
each reload that changed something), a hash of it (secrets hashed), the rule set's hash,
when it was loaded, `restart_required`, and the last reload's trigger, outcome, errors and
which sources were added, removed or changed. A program that writes the config confirms its
change took effect by reading it after the reload.

### Drop-ins (`seshi.d/`)

`*.toml` files in a `seshi.d/` folder beside the config file (`/etc/seshi/seshi.d/` for
`/etc/seshi/seshi.toml`) are read after it, in file-name order. A drop-in may only add
`[[sources]]`, `redaction.packs`, `capture.exclude` and `capture.redact_tool_calls` entries,
appended after the file's; any other key in one is an error. This lets another program (an admin
UI that connects buckets, or that keeps the org's capture lists, say) add a source or entries as
a file of its own and reload,
without rewriting the operator's file. Ids must still be unique
across all of them. Files whose names start with `.` and files not ending in `.toml` are
skipped, so write a drop-in under a temporary name and rename it into place. `seshi config
show --origin` names the drop-in each value came from.

## Runtime config in the bucket (`server.runtime_config = "store"`)

By default (`runtime_config = "file"`) the files are the whole config: one `seshi.toml`, its
drop-ins, env and flags, and a reload reaches the one process that gets it. That is the setup
for one host, development and tests, and nothing below applies to it: the admin API's write
routes answer `409 runtime_config_off`.

With several instances on one bucket (Cloud Run, Kubernetes, Container Apps) there is no disk
they share and no reload that reaches them all. Set `server.runtime_config = "store"`, and the
settings that change at runtime live in the bucket as well, where every instance reads them:

| Kind | Where | Changed by |
|---|---|---|
| The process: `[server]`, `[store]`, `[search]`, `[worker]`, `[limits]` | files, env, flags only | a deploy |
| Identity and trust: `[auth]`, `[secrets]`, review keys (`{ env = … }`) | files, env, flags only | a deploy |
| The data policy: `default_visibility`, `[filter]`, `[redaction]`, `[review]`, `[records]`, `[capture]` | files, or `config/seshi.toml` and the files it names (`config/packs/…`) | `PATCH /v1/admin/config`, `PUT /v1/admin/config/files/…`, `seshi admin config push` |
| Sources | files, or `runtime/sources/<id>.json`, one object each | `PUT` and `DELETE /v1/admin/sources/<id>` |

`config/` is the prefix serverless laptops read their shared settings from (F11.6), in the same
format; sources and their sealed secrets are kept apart, under `runtime/`, which laptops never
read.

**The files win.** The bucket is the lowest layer: `config/seshi.toml`, then `seshi.toml`, its
drop-ins, `SESHI_*` env and flags. A setting the files set is locked: the API refuses to change
it (`409 locked`), and `GET /v1/admin/config` lists them. Lists (`redaction.packs`,
`capture.exclude`, `capture.redact_tool_calls`) add the bucket's entries after the files', as
drop-ins do, so an entry set at deploy time cannot be taken out at runtime. A source whose id is
in a file belongs to the file: the API will not write or remove it, and a stored source with
the same id is not used (with a warning). Any other section in `config/seshi.toml` is ignored
on a server, with a warning. `seshi config show --origin` names the layer each value came from.

**Every change is checked before it is written**, as a reload would check it: the candidate is
merged under the files, and the schema, the cross-section rules, the rule packs (their test
strings run) and the review policies must all pass (`422` with each problem in
`error.problems`). Then it is written with the caller's condition: `If-Match` the `ETag` it read
(`412` when it changed since), `If-None-Match: *` to create only. So a version seshi would
refuse never lands in the bucket.

**Every instance applies it.** The one that took the write applies it at once; the others read
the bucket every `server.config_poll` (10 s): one listing of `config/` and of
`runtime/sources/`, then only what changed. Before a request, an instance whose last read is
older than two polls reads again first (at most 2 s), so one whose CPU was held between
requests does not serve with old rules; an OTLP token for a source this instance does not know
yet reads again before it is refused. A version that does not load is not applied: the last
good one keeps running, and the instance reports why. Each instance writes what it runs to
`runtime/instances/<process>.json`; `GET /v1/admin/config` shows the bucket's version and which
live instances run it (`?wait=30s` waits for them, for tests and scripts). Writes do not wait:
laptops fetch the rules on their own schedule, so no barrier could close that gap.

**Secrets are sealed.** A source's secrets (`api_key`, `credentials.*`) sent as values are
sealed with AES-256-GCM under a key from [`[secrets]`](#secrets), bound to the source and field
they belong to, and are never returned: a read shows `{ set, fingerprint, key_id, updated_at }`
in their place. A `PUT` that leaves a secret out keeps the sealed one when the source keeps its
type. Only values are taken: `{ env = "NAME" }` and `{ file = … }` are refused (and a stored
source holding one is left out), since they would let an admin token make the server send its
own environment or files, the sealing keys among them, to an endpoint the caller picks. A
source that needs one belongs in `seshi.toml`. To rotate: add a key to `secrets.keys`, point
`secrets.key_id` at it, deploy, `POST /v1/admin/secrets/reseal`, then remove the old key. A
stored source whose key is gone is left out (with a warning), so one lost key stops one
source, not the server.

The server does not start when it cannot read the bucket's runtime config: the files alone
may be missing the org's rules.

### Why files by default

The files were the only way for a long time, on purpose: one writable copy that `config check`,
`config show --origin`, version control and configuration management all read, which a restart
cannot lose or resurrect. That still holds for one host, and is why the bucket is opt-in. It
stops holding once several instances share a bucket and nothing else, which is when the
bucket's runtime config is the one copy every instance sees.

## Environment names

`SESHI_` plus the TOML path in upper case, with `__` between levels (F1.2):

| TOML | Env |
|---|---|
| `[store] url` | `SESHI_STORE__URL` |
| `[auth.oidc] issuer` | `SESHI_AUTH__OIDC__ISSUER` |
| `[auth.tokens] alice` | `SESHI_AUTH__TOKENS__ALICE` |
| `[[sources]] id = "datadog-prod"`, `api_key` | `SESHI_SOURCES__DATADOG_PROD__API_KEY` |

- Values are read as the field's type: numbers, `true`/`false`, durations (`30d`), sizes
  (`32MiB`), and lists as comma-separated text (`SESHI_SERVER__ROLES=api,worker`) or JSON.
- An empty value counts as unset.
- A key in a table of your own names (`[auth.tokens]`, `[auth.owner_aliases]`,
  `[auth.session_keys]`) matches the file's key written the env way (upper case, anything but
  letters and digits as `_`: `alice.smith@acme.com` is `ALICE_SMITH_ACME_COM`), or is added in
  lower case.
- `[[sources]]` are defined in the file only, each with an `id`; env can override a field of
  one by its id (upper case, `-` as `_`).
- A secret can be given as a reference from env too: `SESHI_AUTH__SESSION_KEYS__K1__FILE=/run/secrets/session-key`.
- A `SESHI_*` name that is not a setting stops the server, except the ones below and a
  variable a secret reads (`{ env = "SESHI_DD_KEY" }`, or the value of a `…__ENV` variable),
  which holds a value, not a setting.
- `SESHI_CONFIG` names the file and is not a setting. Names that belong to the CLI's config
  (`SESHI_USER`, `SESHI_THEME`, `SESHI_SERVER`) are skipped by the server, and the server's by
  the CLI.

## Secrets

Any secret field takes a literal, `{ env = "NAME" }`, or `{ file = "/path" }` (F1.3), so the
file can be committed:

```toml
[store.credentials]
access_key_id = { env = "AWS_ACCESS_KEY_ID" }
secret_access_key = { file = "/run/secrets/bucket-key" }
```

References are read at start-up: a missing variable or file stops the server and names the
setting. A file's trailing newline is dropped. The server warns when the config file holds a
literal secret and group or others can read it. `config show` prints secrets as
`<secret: env NAME>`, `<secret: file /path>` or `<secret>`, never their values. The config file
and the environment hold connector credentials: protect them like the bucket keys.

## Durations and sizes

Durations are `<n><unit>` with `ms`, `s`, `m`, `h`, `d` or `w` (`"30d"`), or an integer of
milliseconds. Sizes are `<n><unit>` with `B`, `KB`, `MB`, `GB`, `KiB`, `MiB` or `GiB`
(`"32MiB"`), or an integer of bytes.

## Settings

### `[server]`

| Key | Default | |
|---|---|---|
| `listen` | `":7200"` | `host:port`, `:port` (every interface) or `port`; `[::1]:7200` for IPv6. Flag `--listen` |
| `public_url` | | The URL clients reach the server at, behind any proxy. Accepted but unused: sign-in goes from the CLI to the IdP directly (X5.7), so nothing reads it, and `config check` warns when it is set |
| `roles` | `["api", "worker"]` | What this instance runs (X7.1). Flag `--roles`. `api` serves the HTTP API; `worker` runs the background jobs (pollers, retention, the heartbeat). Run exactly one worker (X7.2); an instance without `api` answers `/healthz` only |
| `instance_id` | the host name | This instance's stable name: its source health shard and the heartbeat's `host` (letters, digits, `_`, `-`, up to 64) |
| `runtime_config` | `"file"` | Where the settings that change at runtime live: `file` (the files are the whole config) or `store` (the bucket too: [Runtime config in the bucket](#runtime-config-in-the-bucket-serverruntime_config--store)) |
| `config_poll` | `"10s"` | With `runtime_config = "store"`: how often each instance reads the bucket's runtime config |
| `watch_config` | `false` | Reload when the config file, a drop-in in `seshi.d/`, a rule pack or a review `prompt_file` changes, a second after the last change ([Reloading](#reloading)). Off by default: an editor saving half a change would be applied or refused at once, and `SIGHUP` or `POST /v1/admin/reload` say when, and report the result |

### `[store]`

| Key | Default | |
|---|---|---|
| `url` | required | `s3://bucket/prefix`, `r2://bucket/prefix`, `az://container/prefix` (Azure Blob Storage), `gs://bucket/prefix` (Google Cloud Storage), or `file:///path` for one machine |
| `credentials` | | Secrets. For `s3://` and `r2://`: `access_key_id`, `secret_access_key`, `session_token`; without them the bucket client falls back to the standard `AWS_*` / `S3_*` variables (`R2_*` for `r2://`), like any S3 tool. For `az://`: `account_key` (the storage account's shared key) or `sas_token` (a shared access signature); without them, the standard Azure variables, then workload identity ([Azure Blob Storage](#azure-blob-storage-az)). For `gs://`: `service_account_key` (a service account's JSON key); without it, Application Default Credentials ([Google Cloud Storage](#google-cloud-storage-gs)). Keys for another kind of bucket are refused |
| `region` | | `s3://`. Falls back to `AWS_REGION` |
| `endpoint` | | S3-compatible services (MinIO, Backblaze, Wasabi). Falls back to `S3_ENDPOINT`. For `az://`, the blob endpoint when it is not `https://<account>.blob.core.windows.net`: a sovereign cloud, a private endpoint, or Azurite (`http://127.0.0.1:10000/devstoreaccount1`). For `gs://`, the JSON API root when it is not `https://storage.googleapis.com` (a private endpoint); falls back to `STORAGE_EMULATOR_HOST` |
| `account_id` | | Cloudflare account for `r2://`. Falls back to `R2_ACCOUNT_ID` |
| `account_name` | | Azure storage account for `az://`. Falls back to `AZURE_STORAGE_ACCOUNT`, then `AZURE_STORAGE_CONNECTION_STRING`'s `AccountName` |
| `deployment_id` | generated | This deployment's id, recorded in the layout marker `seshi.json` the first time a server uses the bucket. A server whose `deployment_id` differs from the marker's refuses to start (X1.4). Without it, the first server generates one and later servers accept whatever the marker says |
| `org` | | The organization the deployment serves (X1.1). Recorded in the marker the first time a config names it; a server naming another org refuses to start (X1.4) |

#### Azure Blob Storage (`az://`)

`az://<container>/<prefix>` stores sessions in a container of an Azure storage account, with
the same operations and conditional writes as S3 (seshi talks to the Blob service's REST API
itself, version 2023-11-03). The container must exist. seshi finds its way in, first match
wins:

1. `credentials.account_key` or `credentials.sas_token` in this table.
2. `AZURE_STORAGE_KEY`, then `AZURE_STORAGE_SAS_TOKEN`.
3. `AZURE_STORAGE_CONNECTION_STRING`: its `AccountKey` or `SharedAccessSignature`, and its
   `AccountName` and `BlobEndpoint` (or `EndpointSuffix`) when `account_name` and `endpoint`
   are not set. A connection string for another account than `account_name` is ignored;
   `UseDevelopmentStorage=true` is Azurite on its default port.
4. Workload identity: `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`, as
   AKS sets them on a pod whose service account names a managed identity
   (`AZURE_AUTHORITY_HOST` for a sovereign cloud). seshi exchanges the token file for a Storage
   token and renews it before it expires. Give the identity the **Storage Blob Data
   Contributor** role on the container.

```toml
[store]
url = "az://sessions/seshi"
account_name = "acmeseshi"
credentials = { sas_token = { env = "SESHI_SAS" } }   # or account_key; or neither, for workload identity
```

A SAS token needs read, add, create, write, delete and list on the container (`sp=racwdl`), and
must outlive the server's run: seshi does not renew it. Azure's ETags are not an MD5 of the
body, so seshi checks each trace it writes by reading it back, which S3 spares it.

#### Google Cloud Storage (`gs://`)

`gs://<bucket>/<prefix>` stores sessions in a Cloud Storage bucket, with the same operations
and conditional writes as S3. seshi talks to the JSON API itself, and its conditions are
generation preconditions (`ifGenerationMatch`): GCS's S3-compatible XML API takes `If-Match`
and `If-None-Match` only on reads, so an `s3://` URL with `endpoint =
"https://storage.googleapis.com"` cannot hold a seshi bucket. The bucket must exist. seshi
finds its way in, first match wins:

1. `credentials.service_account_key` in this table: the contents of a service account's JSON
   key file, usually `{ file = "/var/run/secrets/gcp/key.json" }`.
2. `STORAGE_EMULATOR_HOST` (an emulator such as fake-gcs-server): requests go there with no
   credentials.
3. Application Default Credentials, as Google's client libraries find them: the file
   `GOOGLE_APPLICATION_CREDENTIALS` names (a service account key, or gcloud's user
   credentials), then gcloud's `application_default_credentials.json` (from `gcloud auth
   application-default login`), then the metadata server. On GKE with Workload Identity, the
   metadata server answers for the Google service account the pod's Kubernetes service account
   is bound to; on Compute Engine and Cloud Run, for the instance's (`GCE_METADATA_HOST`
   overrides its host). seshi renews the token before it expires.

Give the service account **Storage Object User** (`roles/storage.objectUser`) on the bucket;
seshi never reads the bucket's own metadata. Workload Identity Federation (`external_account`
credentials) and service account impersonation are not supported yet.

```toml
[store]
url = "gs://acme-seshi/prod"
# credentials = { service_account_key = { file = "/run/secrets/seshi-gcs.json" } }   # or none: ADC
```

seshi gives an object's generation as its ETag. A generation is not an MD5 of the body, so, as
on Azure, seshi checks each trace it writes by reading it back.

Traces are always stored in seshi's one canonical format (`seshi/trace/1`, X6.2) and rendered as Letta, OTLP or ATIF on read (`GET …/trace?render=`).

### `[auth]`

| Key | Default | |
|---|---|---|
| `tokens` | `{}` | Static tokens: `owner = token` (secrets, 16+ characters; `.env.example`'s `replace-with-…` placeholders are refused), each everything for that owner. For one person and development (X5.12). `owners/<owner>/` is where their sessions go |
| `org_key.enabled` | `true` | Accept the trusted org key (X5.12): members write as the username they state in `X-Seshi-User`, lowercased, and read org-wide; it cannot delete. `seshi admin init` makes the key; `false` turns trust off once everyone signs in through the IdP |
| `oidc.issuer` | | The IdP (X5.2). Its keys are read from its discovery document. Setting `oidc` needs a key in `session_keys` |
| `oidc.client_id` | | The CLI's client id, registered as a public client (X5.7) |
| `oidc.audience` | `client_id` | The ID token audience required, specific to this deployment (X1.4) |
| `oidc.owner_claim` | `"sub"` | The claim owner IDs come from (X5.8): `sub`, `oid` on Entra, or `email` (lowercased) to match org-key usernames; an ID token whose email the IdP marks unverified is then refused |
| `oidc.admin_group` | | Members of this IdP group are admins (X5.3) |
| `oidc.groups_claim` | `"groups"` | The ID token claim listing the person's groups |
| `admins` | `[]` | Emails of admins (X5.3), for IdPs whose ID tokens carry no groups (Google). An email the IdP marks unverified does not count |
| `owner_aliases` | `{}` | `old = "new"` owner IDs (X5.8), applied when reading: sessions stored under the old ID are read and listed as the new one's |
| `session_keys` | `{}` | Keys that sign session tokens, by id (secrets, 32+ characters each). Session tokens last an hour; an old key stays to verify until its tokens expire (X5.9) |
| `session_key_id` | | The key in `session_keys` that signs; required with more than one |

There is no shared HS256 secret any more (X5.2): seshi signs its own session tokens, and every
other token is a seshi token stored hashed in the bucket (`tokens/<id>.json`). Without static
tokens, run `seshi admin init` once where this config is: it prints the first admin token and
the org key, each shown once. `seshi serve` warns when no token can call it yet.

### `[secrets]`

| Key | Default | |
|---|---|---|
| `keys` | `{}` | Keys that seal the secrets of sources stored in the bucket (`runtime_config = "store"`), by id (secrets, 32+ characters each; `openssl rand -hex 32`). Keep them in a secret manager and give them as `{ env = … }` or `{ file = … }`. An old key stays to unseal until `POST /v1/admin/secrets/reseal` has run |
| `key_id` | the only key | The key in `keys` that seals new secrets; required with more than one |

Without a key, a source with secrets cannot be stored (`422 sealing`); one with none (`otlp`)
can.

### `default_visibility`

`"org"` (default) or `"owner"` (X5.10): the visibility of a new session when neither the
upload (`visibility`) nor the token's default sets one; a source's own `visibility` comes
before it. Members read their own sessions and every `org` session; admins and service
readers read everything. Anyone holding the org key can state any username, so `owner` keeps
nothing from them: without an IdP that is every member, and with one, every member still on
the key. `config check` warns in both cases, until `auth.org_key.enabled = false`.

### `[filter]`

The session filter (X4.10), once called worthiness. It judges a session's first trace only:
once a session has a trace, every chunk and every whole-upload tail that continues it is
stored. A filtered session is not stored at all (the upload answers `filtered`); it is only
counted in the source's health counters, so a source that sends too little shows up there.

| Key | Default | |
|---|---|---|
| `enabled` | `true` | `false` stores every session that can be a trace |
| `min_chars` | `2000` | Characters of text, tool arguments and tool results, the meta record aside |
| `require_user` | `true` | At least one user record |
| `require_reply` | `true` | At least one assistant or tool record |

A source can override any rule in `[sources.filter]`; uploads use `[filter]` itself. Today's trace format needs a user record
and a reply, so `require_user = false` and `require_reply = false` have no effect yet (and
`config check` says so); a session without them is not stored either way.

### `[limits]`

| Key | Default | |
|---|---|---|
| `max_records` | `50000` | Records in one trace |
| `max_records_bytes` | `"32MiB"` | JSON bytes of one trace's records |
| `max_upload_bytes` | `"256MiB"` | Bytes of one upload's transcript as sent (before any gzip of the request); nothing of it is stored. A request body, decoded, is refused (`413`) past twice this plus 1 MiB |
| `max_otlp_bytes` | `"64MiB"` | Bytes of one `POST /otlp/v1/traces` body as sent, gzipped or not (F4.1). A larger `Content-Length` is refused before the body is read; a chunked body is refused at the first chunk past it |
| `max_otlp_inflated_bytes` | `"256MiB"` | Bytes of a gzipped OTLP body once inflated. Inflating stops at the cap, so a small body that would inflate to far more is refused at this size |

Past a limit the session is refused with 422 `too_large`. Past an OTLP cap the request is
answered `413` with a message naming the key, and nothing of it is stored; exporters should send
small batches (see [otlp.md](otlp.md#batch-size)).

### `[records]`

`dropped_retention` and `failed_retention`, both `"30d"`: how long drop and failure records
are kept (X6.4). `health_retention`, `"90d"`: how many days of source health counters are kept
(X4.8). The worker's `retention` job prunes all three every six hours.

### `[redaction]`

`packs`, default `[]`: rule pack files, in order, on top of the built-in pack, which always
runs (F2.1). A `.toml` file is a rule pack (`id`, `rules`, `sensitive_files`,
`secret_commands`, `disable`); a `.json` file is a plain rule file (`patterns`,
`sensitive_files`, `secret_commands`), and every JSON file loads together as the pack `legacy`.
See [redaction.md](redaction.md). Your patterns run under RE2 (F2.2). The server
refuses to start on a pack it cannot use, a pattern RE2 cannot run, a rule id used twice, a
`disable` of something that is not a built-in rule, or a rule that fails its own test strings,
naming the file; `seshi config check` reports the same problems, and a reload with such a pack
is refused and keeps the running rules. A change applies on the next [reload](#reloading) (or
restart) to sessions stored from then on; `seshi redact backfill` applies it to stored
sessions.

### `[review]`

`[[review.policies]]`: model review (F3), none by default, so review is off and nothing is sent
anywhere. A policy has two steps: the decision model labels each envelope `allow`, `redact` or
`drop`, and for `redact` the redactor LLM finds the text to remove (see
[model-review.md](model-review.md)). The smallest policy is an id and a key; everything else
has a default:

```toml
[[review.policies]]
id = "default"
decision = { api_key = { env = "ANTHROPIC_API_KEY" } }
```

The first policy whose scope names an envelope reviews it.

| Key | Default | |
|---|---|---|
| `id` | | The policy's name; recorded with every decision |
| `sources` | `[]` (all) | Source ids it applies to (`upload` for hooks and uploads) |
| `agents` | `[]` (all) | Agents (formats) it applies to |
| `repos` | `[]` (all) | Globs over the session's project; a session without one matches only a policy with no `repos` |
| `on_failure` | `"drop"` | After the last retry: `drop` the envelope (a drop record, `review_failed`), or `skip` (store it with regex redaction only, recorded as `skipped`) (F3.4) |
| `retries` | `3` | Retries of a failed call, or of an answer that does not fit, with backoff (up to 10) |
| `max_input_chars` | `100000` | Record text per model call; a longer envelope is split by turn (F3.7) |
| `decision`, `redactor` | | The two steps (below) |

Each step takes:

| Key | Default | |
|---|---|---|
| `provider` | `anthropic`; the redactor takes the decision step's | `anthropic` or `openai-compatible`. `bedrock` and `vertex` are refused until built; reach them through an OpenAI-compatible gateway |
| `model` | `claude-haiku-5-5` on `anthropic` | Required for `openai-compatible` |
| `api_key` | | Secret. Required for `anthropic`, and for `openai-compatible` without a `base_url` |
| `base_url` | `https://api.anthropic.com`, `https://api.openai.com/v1` | A proxy, an OpenAI-compatible server, or a local model |
| `prompt`, `prompt_file` | seshi's default prompt | One or the other; the file is read at start and again on every reload ([Reloading](#reloading)) |
| `max_tokens` | `4096` (decision), `16000` (redactor) | Output cap of one call, the model's thinking included |
| `effort` | the model's own | `anthropic` only: `low`, `medium`, `high`, `xhigh` or `max` |
| `timeout` | `"60s"` | How long one call may take |

The redactor also takes `categories` (`name`, `description`, `examples`): what it looks for, and
the name redacted text is marked with (`[redacted:<name>]`). Seshi's defaults are `secret`,
`personal` and `customer-data`.

A redactor that names no `provider`, or the decision step's, inherits the decision step's
`provider`, `model`, `base_url`, `effort` and `timeout`, and its `api_key` too unless the
redactor sets a `base_url` of its own (a key only goes to the endpoint it was given for); one
that names another provider inherits none of them. A policy that could not send (no key) or names a provider this
binary lacks stops start-up rather than drop every envelope. `seshi config check` names every
provider and endpoint a policy sends envelopes to, and `seshi review eval` measures a policy on
labelled fixtures before you change it.

`review.required`, default `false`, applies in serverless mode only
([serverless.md](serverless.md#model-review-keys)), where a laptop runs review with its own
key. When a policy's key can't be found on a laptop (its variable is unset and no key was
stored with `seshi review key set <provider>`): `true` keeps that laptop's sessions there until
one is set, so nothing is uploaded unreviewed, and the status line says `needs review key`;
`false` stores them with regex redaction only, recorded as `skipped`, and `seshi doctor` warns.
In the bucket's shared config (`config/seshi.toml`), a policy with a key may name no `base_url`
but its provider's own, so no laptop's key is sent where the shared file chooses; set such a
policy in each laptop's `serverless.config` instead
([serverless.md](serverless.md#shared-settings)).
A server never starts without its policies' keys, so it ignores this.

### `[[sources]]`

What the server ingests from on its own (F4–F7). Each has an `id` (lower-case letters and
digits, words joined by single `-`; not `upload`, which uploads use), a `type`, `enabled` (`true`), `visibility`, `filter`
overrides, and `labels`: a table of strings put on every session the source stores
(`labels = { "dosu.member" = "alice" }`; keys and values as [labels](#labels) are, at most 32),
winning over labels the data itself carries. Each writes as its service account `svc:<id>` (X5.4). The worker polls a source on
its `interval` once a connector for its type is in the binary (`seshi sync status` says which
are polled). The binary polls `datadog` sources ([docs/datadog.md](datadog.md)) through the
datadog-trajectory integration, `cursor-cloud` sources through the cursor integration
([cursor-cloud.md](cursor-cloud.md)), and `s3` sources with its built-in S3 poller
([s3-sync.md](s3-sync.md)); `otlp` sources are not polled, their
destination posts to them. What a poller cannot turn into a session (an object it cannot read,
a Datadog span it cannot parse, a Cursor run whose events expired) is recorded under `sources/<id>/failed/` and listed by
`seshi sync failed <id>`.

| Type | Fields |
|---|---|
| `otlp` | `quiet_period` (`"10m"`): a session is published once its spans have been quiet this long (F4.4). The destination posts to `POST /otlp/v1/traces` with a service token for this source ([docs/otlp.md](otlp.md)) |
| `datadog` | `site` (`"datadoghq.com"`), `api_url` (instead of `https://api.<site>`: a proxy; `https`, or `http` to localhost only), `api_key`, `app_key` (secrets), `ml_app`, `tags` (each `key:value`; a span must carry all), `interval` (`"5m"`), `overlap` (`"10m"`), `lag` (`"2m"`), `backfill` (`"7d"`), `page_size` (`500`, at most 5000), `quiet_period` (`"10m"`): polls Datadog LLM Observability ([docs/datadog.md](datadog.md)) |
| `cursor-cloud` | `api_key` (secret), `api_url` (instead of `https://api.cursor.com`: a test server; `https`, or `http` to localhost only), `interval` (`"5m"`), `lookback` (`"25h"`, how far back Cursor still has a run's events), `max_streams` (`25`, at most 60), `usage` (`true`): polls Cursor's Cloud Agents API ([docs/cursor-cloud.md](cursor-cloud.md)) |
| `s3` | `url`, `prefix`, `credentials` or `role` (`arn`, `external_id`), `region`, `endpoint`, `account_id`, `account_name`, `include` globs, `format` (`"auto"`), `ordered_keys` (`false`), `interval` (`"5m"`), `path` |

Ids are unique, and an `s3` source may not read seshi's own bucket and prefix, or its own
folder (F6.4). Sources can also come from drop-ins in `seshi.d/`, and are added, changed and
removed by a [reload](#reloading) without a restart; a reload never resets a checkpoint.

An `s3` source is polled by the built-in S3 poller ([s3-sync.md](s3-sync.md)).
Its `url` is `s3://`, `r2://`, `az://` (an Azure Blob Storage container, reached as `[store]`
reaches one: `account_name`, `endpoint`, `credentials.account_key` or `sas_token`, else the
Azure variables or workload identity), `gs://` (a Cloud Storage bucket, reached as `[store]`
reaches one: `endpoint`, `credentials.service_account_key`, else Application Default
Credentials; `role` is for `s3://` only) or a folder
(`file:///path`, for one machine). `include` globs
(Bun's glob syntax) and `path` match the key under the URL's prefix plus `prefix` (both
name folders: `prefix = "runs"` lists `runs/`, and a partial name such as `"runs/2026-"` is
not a key prefix; use `include` for that). `path` is a
template such as `"{username}/{session}.jsonl"`: `{session}` names the session (else the key
is), `{format}` its format, `{project}` and `{branch}` its work, and `{email}`, `{name}`,
`{username}`, `{git_email}`, `{git_name}` identity claims recorded in metadata, never the owner
(X5.4); `*` matches within a segment, `**` across segments, and a key that does not match is
skipped. An object's `x-amz-meta-seshi-<field>` metadata (`-` for `_`) wins over its key.

### `[search]`, `[worker]`, `[capture]`

| Key | Default | |
|---|---|---|
| `search.enabled` | `true` | Serve `GET /v1/search` and `seshi search` from a local index built from the change feed (F10). Off: the route answers 404 `search_disabled` and no indexer runs |
| `search.backend` | `"sqlite"` | SQLite FTS5 through Bun's built-in SQLite (F10.3) |
| `search.path` | user cache folder | The index file on local disk: `seshi/search/<deployment>.sqlite` under `$XDG_CACHE_HOME` (else `~/.cache`) on Linux, `~/Library/Caches` on macOS, `%LOCALAPPDATA%\seshi\cache` on Windows; in the image, `/data/.cache/…`. `":memory:"` keeps it in memory (rebuilt on every start). It is derived data: deleting it only costs a rebuild |
| `search.interval` | `"15s"` | How long the indexer waits after catching up before it reads the change feed again: about how long a new session takes to become searchable |
| `search.events` | `["user", "assistant", "tool_call"]` | Which trace events are indexed, by role: prompts, assistant text, and tool calls (names and inputs, so file paths and commands). Add `tool_result` to search tool output too (a bigger index). Changing it rebuilds the index |
| `worker.heartbeat_interval` | `"1m"` | How often the worker writes `worker/heartbeat.json` (X7.5); status calls a heartbeat older than three intervals stopped |
| `worker.assembly_interval` | `"30s"` | How often the span assembler looks for sessions whose spans have gone quiet (F4.4, X7.4) |
| `capture.allow_retract` | `true` | Let the machine that uploaded a session retract it with its per-session secret (F9.7). With `false`, a retraction is refused (`403 retract_disabled`) and only an admin or the owner's fresh sign-in can delete |
| `capture.exclude` | `[]` | The org's exclude list: repositories and folders whose sessions are never stored, from any source ([below](#the-orgs-exclude-list-capture-exclude)) |
| `capture.redact_tool_calls` | `[]` | The org's tool-call redaction list: repositories and folders whose sessions are stored with every tool call's input and output replaced by `[redacted:tool-call]` ([below](#the-orgs-tool-call-redaction-list-capture-redact_tool_calls)) |

### The org's exclude list (`[capture] exclude`)

One list, held by the server, names the repositories and folders whose sessions never enter
seshi. The server applies it to its own sources and serves it to every laptop, which applies it
before anything is uploaded; an admin's change reaches everyone without rewriting a config file
on any machine.

```toml
# /etc/seshi/seshi.toml
[capture]
exclude = ["acme/payroll", "github.com/acme/hr-*", "~/clients/**"]
```

```toml
# /etc/seshi/seshi.d/50-adx.toml: a program that keeps the list writes a drop-in of its own
[capture]
exclude = ["acme/legal"]
```

- **Entries** read as the CLI's `capture.exclude` does ([below](#the-clis-config)): a
  repository (`owner/name` on any host, `host/owner/name` on one, or a remote URL, matched
  ignoring case), or a folder (starting with `/`, `~`, a drive or `\\server`); `*` within a
  path segment, `**` across any number; blank entries and `#` comments skipped. Folder entries
  are laptops' paths: laptops apply them, the server never matches one.
- **Every file's entries are one list**: the main file's, then each drop-in's, in file-name
  order. `SESHI_CAPTURE__EXCLUDE` (comma-separated) is the same setting.
- **A reload applies a changed list at once** (`POST /v1/admin/reload`, `SIGHUP`, or
  `watch_config`): the next poll of a source and the next fetch by a laptop see it. A list with
  an entry that could never match (a URL with a credential in it, a repository with a space, a
  control character) is refused with the rest of the config, by `seshi config check` too, and
  the running list stays. The refusal shows the entry with any credential in it masked
  (`capture.exclude[2]: "https://***@github.com/acme/x" names a credential…`; the index counts
  every file's entries). The CLI's `capture.exclude` refuses the same entries.
- **Laptops download it** (`GET /v1/capture/rules`, [server.md](server.md#api)) and
  apply it with their own `capture.exclude`, which can only add entries: an entry in either
  keeps a session on the machine. A laptop holds a server's uploads until it has a copy of that
  server's list ([capture.md](capture.md#the-orgs-exclude-list-on-a-laptop)).
- **The server's own sources apply it**: a Cursor Cloud agent working in a listed repository is
  never read ([cursor-cloud.md](cursor-cloud.md#the-orgs-exclude-list)). An entry added stops
  what comes next; it deletes nothing already stored. An entry removed does not send what it
  kept out, on a laptop or from Cursor Cloud: it applies to what comes after.
- **Ingest refuses what slips past**: a session whose `repo` the list names is refused with
  `403 excluded` ([server.md](server.md#post-v1sessions)), whoever sends it: a laptop with an
  old copy of the list or an older seshi, any source that sets `repo`. It counts as `excluded`
  in the source's health.

### The org's tool-call redaction list (`[capture] redact_tool_calls`)

The org's middle ground between capturing a place and excluding it: a session in a repository
or folder it names is still stored, but with every tool call's input and output replaced by
`[redacted:tool-call]`. What the person asked, what the agent said and thought, which tools ran,
their ids, their order and whether each failed are kept; code, file contents and command output
are not ([capture.md](capture.md#tool-calls-redacted)).

```toml
# /etc/seshi/seshi.toml
[capture]
redact_tool_calls = ["acme/research", "github.com/acme/ml-*"]
```

```toml
# /etc/seshi/seshi.d/50-adx.toml: the same program's drop-in may hold both lists
[capture]
exclude = ["acme/legal"]
redact_tool_calls = ["acme/data-science"]
```

It is held, combined, validated, reloaded and served exactly as the exclude list above is:
the same entries, every file's entries one list (`SESHI_CAPTURE__REDACT_TOOL_CALLS` from the
environment), applied at once on a reload, an entry that could never match refused by the
reload and `seshi config check`. **Exclusion wins**: a place on both lists is not stored at
all. Where it applies:

- **On laptops, before upload.** `GET /v1/capture/rules` serves it with the exclude list; the
  uploader keeps the copy and applies it with the machine's own `capture.redact_tool_calls`,
  which can only add entries. Each agent's pass redacts the session's log before it leaves the
  machine, and `seshi capture status` names the entry and whether it is the server's list
  ([capture.md](capture.md#tool-calls-redacted)).
- **On the server's own sources.** A Cursor Cloud agent with any repository listed is stored
  with its tool calls redacted ([cursor-cloud.md](cursor-cloud.md#the-orgs-tool-call-redaction-list)).
- **At ingest, as a backstop.** A session whose `repo` the list names has its normalized
  records redacted before anything is stored or indexed, whoever sends it: a laptop with an old
  copy of the list or an older seshi, any source that sets `repo`. Records a laptop already
  redacted are left as they are. The session's `redaction.counts` counts what was replaced under
  `tool-call`. Folder entries are laptops': the server never matches one.

An entry added applies to what is stored next; it rewrites nothing already stored. An entry
removed applies to what comes after.

## The CLI's config

The CLI keeps its own file, `~/.config/seshi/config.toml` (`$XDG_CONFIG_HOME/seshi/config.toml`
when set, `%APPDATA%\seshi\config.toml` on Windows), loaded the same way with its own strict
schema (`spec/cli-config.schema.json`). `seshi config check --cli` and `seshi config show --cli`
read it.

```toml
server = "https://seshi.acme.internal"   # SESHI_SERVER
user = "alice@acme.com"                  # SESHI_USER: the username stated with the org key
theme = "auto"                           # SESHI_THEME: auto, dark or light
keychain = true                          # SESHI_KEYCHAIN: false keeps credentials in credentials.json

[capture]
enabled = true                           # SESHI_CAPTURE__ENABLED: the global level (F9.5)
remotes = ["github.com/acme"]            # SESHI_CAPTURE__REMOTES: the org rule, see below
exclude = ["acme/payments", "~/clients"] # SESHI_CAPTURE__EXCLUDE: added to the server's list, see below
redact_tool_calls = ["acme/research"]    # SESHI_CAPTURE__REDACT_TOOL_CALLS: uploaded without tool detail

[[capture.paths]]                        # personal rules by folder, longest match wins (F9.5)
path = "~/clients/acme"
capture = false

[labels]                                 # put on each session when it is first seen, see below
"dosu.project" = { env = "DOSU_PROJECT" } # from the agent's environment; absent when unset
team = "platform"                        # SESHI_LABELS__TEAM: a fixed value

[[labels.paths]]                         # per folder; the longest matching folder wins
path = "~/code/monorepo/packages/billing"
"dosu.project" = "github.com/acme/billing"
```

**Capture rules** (F9.5, [capture.md](capture.md#what-is-captured)). `capture.enabled` is the
global level, on by default once capture is installed; `seshi capture off|on` sets it.
`[[capture.paths]]` are personal folder rules (`seshi capture off|on --path <folder>` adds or
changes one); the longest matching folder decides. `capture.remotes` is the org rule, meant to
be delivered with a managed CLI config: when it is set, only sessions in a git repo with a
remote matching one of its patterns are captured (`github.com/acme` matches every repo under
it; `*` stands for one path segment, `**` for any number, none included). `capture.exclude` is
an exclude list of this machine's: no session in a place it names is ever uploaded. The org's
list is the server's (`[capture] exclude`, [above](#the-orgs-exclude-list-capture-exclude)),
which the uploader downloads; this one can only add to it. Each entry is

- a repository, `owner/name` on any host or `host/owner/name` on that one (`acme/payments`,
  `github.com/acme/*`; a remote URL works too, and a number after the host is read as a port),
  matched against every remote of the session's repo, ignoring case. An entry names the
  remote's last segments: `acme/payments` is `github.com/acme/payments` and
  `gitlab.example.com/acme/payments`, never `acme/payments-ui`, and a bare `payments` is any repo
  named payments, not an owner called that. A whole remote with no wildcard also covers
  everything under it, as in `capture.remotes` (`github.com/acme`: every acme repo there);
- a folder, starting with `/`, `~`, a drive (`C:\`) or a network share (`\\server`), and
  everything under it: `~/clients` is `~/clients/x`, not `~/clients-old`. Its symbolic links are
  resolved too (up to its first wildcard).

In both, `*` matches within one path segment and `**` across any number of them, none included
(`~/work/**/secrets` is `~/work/secrets` too). Blank entries and `#` comments are skipped. From
the environment the list is comma-separated (`SESHI_CAPTURE__EXCLUDE=acme/payments,~/clients`).
`seshi capture status` names the entry that turned a session off, and whether it is the
server's list or this config's.

`capture.redact_tool_calls` is the org's middle ground between capturing a place and excluding
it, written and matched exactly as `capture.exclude` is (repositories and folders, wildcards,
comments, comma-separated from `SESHI_CAPTURE__REDACT_TOOL_CALLS`). The org's list is the
server's (`[capture] redact_tool_calls`,
[above](#the-orgs-tool-call-redaction-list-capture-redact_tool_calls)), which the uploader
downloads with the exclude list; this one can only add to it. A
session in a place it names is still uploaded, but with every string of every tool call's input
and result replaced by `[redacted:tool-call]`: what the person asked, what the agent said and
thought, which tools ran, their ids, their order and whether each failed are kept; code, file
contents and command output are not ([capture.md](capture.md#tool-calls-redacted)). A place on
both lists is excluded. Like the exclude list it holds for every folder a session was seen in,
and it turns nothing on: a session it names that another rule turns off stays off. A subagent's
session there is not uploaded at all: it is its parent's tool call.
`seshi capture status` names the entry, whether it is the server's list or this config's, and
says the session goes with its tool calls redacted.

Like a repo's own `capture = false`, the org rules can only turn capture off. A repo opts out
for everyone who works in it with its own committed `.seshi/config.toml`:

```toml
capture = false        # no session in this repo is captured, whatever anyone's personal rules
visibility = "owner"   # sessions uploaded from this repo are private to their owner (X5.10)
```

A repo config can only narrow who reads a session. `visibility = "owner"` is sent with every
upload from the repo and beats the token's default; `visibility = "org"` is accepted but never
sent, so a repo you clone or a branch you check out for review cannot make sessions readable
by the team when your token keeps them private (the token's default, then the server's
`default_visibility`, decides instead).

A repo config that cannot be read (a wrong type, bad TOML) turns capture off in that repo until
it is fixed. So does one that is not a regular file (a folder, or a link to a device such as
`/dev/zero`) or is larger than 64 KiB, and the same goes for the git files capture reads to
find the repo (a worktree's `.git` file and `commondir`, `HEAD`, git's `config`): capture reads
each of them bounded, so a planted file never hangs a hook or the status line. Hooks read the CLI config through a cache (`rules.json` in the capture folder),
loaded again whenever the file or a `SESHI_*` setting changes.

### Labels

Labels are small key/value strings attached to each captured session, uploaded with it, kept
on its metadata (and on each trace's) and searchable (`seshi search --label key=value`,
[search.md](search.md)). seshi gives them no meaning: they carry what another tool needs to
file a session, such as a project key.

Every key of `[labels]` but `paths` is a label, and every key of a `[[labels.paths]]` entry but
`path`. A value is a string, or `{ env = "NAME" }`, read from the environment of the agent the
session runs in; nothing else (no files, no commands). Per key, highest first:

1. the `[[labels.paths]]` entries the session's folder is in, the longest folder first
   (matched as `[[capture.paths]]` is: `~` is the home folder, whole folder names only, and
   symbolic links resolved);
2. `[labels]`;
3. `[labels]` in the repo's committed `.seshi/config.toml`, plain strings only.

An `env` reference whose variable is unset or empty counts as absent, so the next one down gives
the key. A repo's labels never read the environment: a cloned repo cannot copy your variables
into a label, and a repo label that is not a string is left out (it never turns capture off).

Keys are `[a-z0-9][a-z0-9._-]{0,63}`, values 1 to 512 characters, at most 32 labels a session.
A label out of those limits (a fixed empty value too) is a config error that `seshi config check
--cli` and `seshi doctor` report; a hook never fails over it, it leaves the label out and logs
why, and the next one down gives the key. Past 32, the lowest in the order above are left out.
The server redacts label values as it redacts a session's text. Labels are
resolved once, when the session is first seen, and kept: see
[capture.md](capture.md#labels). From the environment, `SESHI_LABELS__<KEY>` sets a fixed one
(`SESHI_LABELS__TEAM=platform`; the key in lowercase, so not one with a `.`).

```toml
# .seshi/config.toml, committed: the repo's own, under anyone's
[labels]
"dosu.project" = "github.com/acme/monorepo"
```

`SESHI_SESSION_ID`, `SESHI_AGENT` and `SESHI_NO_UPLOADER` are capture's own variables, not
settings; both loaders pass over them (with `SESHI_CONFIG`). Claude Code sets the first two for
every command it runs in a captured session, so the `/session-capture` skill can name the session.
They also pass over `SESHI_TOKEN`, a name scripts use for the token they pipe to
`seshi login --token -`: seshi never reads a token from the environment itself.

`seshi login --server <url>` writes `server` here, and `--user` writes `user`; everything else
in the file is left as written. The credentials themselves are never in this file: they go in
the OS keychain, or `credentials.json` (0600) beside it where there is none, with the
non-secret `logins.json` ([cli.md](cli.md#signing-in-f82)). `keychain = false`
(`SESHI_KEYCHAIN=false`) skips the keychain and always uses that file: for a CI runner, a
container or a headless machine whose keychain prompts or hangs instead of refusing. Run
`seshi logout` before turning it off: a login made with the keychain cannot be read with
`keychain = false`, and every command warns about it until it is removed.

### Serverless mode

Instead of `server`, the CLI can write a shared bucket directly: it runs the pipeline itself and
writes its owner's folder (F11, [serverless.md](serverless.md)). `seshi init --serverless`
writes these tables. Set `server` or `serverless`, not both.

```toml
[serverless]
url = "s3://acme-seshi/seshi"          # SESHI_SERVERLESS__URL
region = "us-east-1"
owner = "alice"                        # SESHI_SERVERLESS__OWNER

[search]
enabled = true
scope = "visible"
```

`[serverless]`:

| Key | Default | |
|---|---|---|
| `url` | | The bucket and prefix: `s3://bucket/prefix`, `r2://bucket/prefix`, `az://container/prefix`, `gs://bucket/prefix` or `file:///path`. Required unless `config` names a server config with a `[store]`; with both, `url` wins |
| `region` | | As `[store] region`, for `s3://`. Falls back to `AWS_REGION` |
| `endpoint` | | As `[store] endpoint`, for other S3-compatible stores. Falls back to `S3_ENDPOINT` |
| `account_id` | | As `[store] account_id`, the Cloudflare account for `r2://`. Falls back to `R2_ACCOUNT_ID` |
| `account_name` | | As `[store] account_name`, the Azure storage account for `az://`. Falls back to `AZURE_STORAGE_ACCOUNT` |
| `owner` | `user`, else the OS user | The owner sessions are written under, `owners/<owner>/`. Lowercased; a name that can't be a folder becomes a hashed `h-…` id. `seshi whoami` prints it |
| `config` | | A server config (`seshi.toml`; `~` is the home folder) layered over the bucket's shared `config/seshi.toml`, for this machine's own settings. Its `[store].credentials`, when set, are the bucket key |

The bucket key is not in this file: `seshi init --serverless` keeps it in the keychain, or in
`credentials.json` with `keychain = false`; without one, the `AWS_*`, `S3_*` and `R2_*` variables
(the `AZURE_STORAGE_*` ones for `az://`, Application Default Credentials for `gs://`) apply ([serverless.md](serverless.md#credentials)). The server config this machine uses is,
lowest first: built-in defaults, the bucket's `config/seshi.toml`, the file `config` names,
`SESHI_*` env, `--set`; `[[sources]]` (OTLP intake included), `[auth]`, `[server]` and `[worker]` are ignored
in any of them.

`[search]`, this machine's search index in serverless mode (F11.9):

| Key | Default | |
|---|---|---|
| `enabled` | the shared config's `search.enabled` | Keep a search index on this machine. `seshi init --serverless` writes the shared config's value here |
| `scope` | `"visible"` | What the index holds: `"mine"` (your sessions only; the scope for a key that reads only its own folder, which `seshi init --serverless` sets for such a key), `"visible"` (yours and every `org` session), or `"all"` (owner-only sessions too, as `--include-private` on every search). Changing it (or the owner) empties the index and builds it again |

**`[local]`** is the old name of `[serverless]` (F11.1), from local mode, and is still read:
`local.config` (`SESHI_LOCAL__CONFIG`) names a server config whose `[store]` gives the bucket,
and `local.owner` (`SESHI_LOCAL__OWNER`) is `serverless.owner`. `seshi config check --cli`
prints the new table. Set one of the two, not both; `seshi init --serverless` replaces `[local]`
with `[serverless]`.

```toml
[local]
config = "~/.config/seshi/seshi.toml"    # names the bucket and its keys
owner = "alice"
```
