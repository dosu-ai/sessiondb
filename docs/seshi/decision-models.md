# Decision models for model review: scope

Status: scoping only, nothing built. This page covers whether and how the **decision step** of
model review (F3, [model-review.md](../model-review.md)) can call purpose-built decision models
instead of a general LLM. It looks at two: **Jev** from TypeSafe and OpenAI's **Decisions API**.
The redactor is out of scope and stays an LLM.

Sources were read on 2026-11-19. TypeSafe: [docs.typesafe.ai](https://docs.typesafe.ai/introduction)
(the [`/v1/systemone` reference](https://docs.typesafe.ai/api/system-one),
[models and pricing](https://docs.typesafe.ai/models),
[confidence](https://docs.typesafe.ai/confidence),
[errors](https://docs.typesafe.ai/api/errors),
[model jaggedness](https://docs.typesafe.ai/model-jaggedness),
[legal](https://docs.typesafe.ai/legal)). OpenAI: the
[Decisions guide](https://developers.openai.com/api/docs/guides/decisions), the
[create decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create),
the [`gpt-6-luna` model page](https://developers.openai.com/api/docs/models/gpt-6-luna) and
[data controls](https://developers.openai.com/api/docs/guides/your-data). All of these pages
were public. Where the docs say nothing, this page says so and does not guess.

## Summary

- Both APIs do the same thing: you send text and a typed question, and you get back one
  label from a fixed set plus a probability for each label. Neither writes any text, and
  neither gives a reason. seshi's decision step already asks for one label and no
  explanation, so it maps onto either API directly.
- **Neither provider stores anything on its side.** There is no hosted decision, policy id or
  per-account tuned model. The whole policy (the instructions and what each label means) is
  sent with every request. So the policy hash can stay entirely local, and "training" a
  provider comes down to calibrating seshi's thresholds and wording against labelled data.
- **The smallest seam:** add a `decide()` interface used only by the decision step, wrap
  today's LLM providers in an adapter behind it, and add two `provider` values that are
  valid only on `decision`. The redactor and `complete()` stay as they are.
- **Users write one prompt, as today.** seshi owns what `allow`, `redact` and `drop` mean,
  because their meaning is the pipeline's. The user's prompt says what counts as sensitive in
  their organization. The only new key is `thresholds` on the label probabilities, for
  example "drop only above 0.9, otherwise redact". The review record gains each part's three
  probabilities. That is numbers only, never text.
- **Both providers keep every "what leaves the server" guarantee** through their own SDKs,
  configured the way `anthropic.ts` configures Anthropic's: explicit key and endpoint, the
  SDK's retries and logging off, redirects refused. Retention and training terms are between
  the user and the provider they choose, under the user's own contract; seshi's part is to
  send only record text, only to the endpoint configured.
- **A first eval** ran on 10 fixtures, 40 local sessions and 40 Dosu production sessions
  (section 6):
  - **Jev**, with no thresholds, was about as accurate as today's Haiku step (81% against
    85%) at about an eighth of the latency.
  - **OpenAI Decisions** flagged far too much until given `redact = 0.8`, then matched
    Haiku.
  - **A prompt experiment** (five variants, every session judged by Opus 5.5) found that the
    instructions carry the calibration: a one-line prompt flags nearly everything. A "flag
    only text you can point to" sentence halves OpenAI's over-flagging, and with it OpenAI
    tuned beat Haiku (70/80 against 64/80). Whether the policy sits in the prompt or the
    label descriptions made no clear difference. Per-category questions ranked sessions
    best. Neither model reliably says `drop`.
- **Recommendation:** build the seam, then **Jev**, then **OpenAI Decisions**. Jev needs a
  40,000-character part size; OpenAI needs its threshold documented. Neither is clearly more
  accurate than today's LLM step; the gain is speed and cost.

## 1. What these APIs are

| | Jev (TypeSafe) | Decisions API (OpenAI) |
|---|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer` | `POST https://api.openai.com/v1/decisions`, `Authorization: Bearer` |
| Status | Generally usable; launched as "early access" ([blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). Current model `jev-1.14.0` (2026-10-14) | Generally available (was public beta). Only model: `gpt-6-luna` |
| Request | `model`, `state` (string, object or array: the content), `questions` (an object keyed by question name) | `model`, `input` (string, or messages with tool calls and outputs), `questions` (an array, 1–400, each with a `name`) |
| Question types | `choice` (up to 255 options), `score` (up to 10 ordered levels), `noul` (yes/no), `box` (images) | `choice` (2–255), `score` (2–10 levels), `predicate` (yes/no) |
| How you define the decision | `instructions` plus `criteria`: `{option: description}` for a choice, `{true, false}` for a noul | `instructions` plus `choices: [{value, description}]`, or `levels` for a score |
| Choice answer | `choice`, `probabilities` `{option: p}`, `confidence` | `choice`, `probabilities` `[{value, probability}]`, `confidence` |
| Yes/no answer | `noul`: P(yes) | `probability`: P(true) |
| Reason / explanation | None | None. An answer can instead be a `refusal` |
| Examples or training data | None. There is no fine-tuning, and every account is served the same weights ([models](https://docs.typesafe.ai/models#customizing-jev)). Examples go into the criteria text | None documented, and fine-tuning is listed as unsupported for `gpt-6-luna`. Examples go into the descriptions |
| Response also has | `model` (the versioned id that answered, even when an alias was sent), `usage` | `model`, `usage` (with cache read and write counts) |
| Context | 64k tokens per request and 32k per question by default. 262k with the `TypeSafe-Danger-Zone-Long-Context` header, which the docs call slower and less accurate | 1.05M-token window, 922k max input |
| Price | $0.042 per million input tokens. Output is free | $0.10 per million input tokens. Output is not charged. Cache reads cost $0.01/M and cache writes $0.125/M |
| Latency (published) | "Most calls complete in about 100 ms" ([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)), and 70–500 ms end to end ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)) | "About 10x faster than the Responses API". No absolute figure |
| Rate limits | Set per organization and shown in the console (behind a login, so not read) | `gpt-6-luna` tiers start at 5,000 RPM and 2M TPM. The docs don't say whether `/v1/decisions` shares those limits |
| Training on your data | "Will not train or fine tune ... on Input" ([privacy policy](https://typesafe.ai/legal/privacy-policy)) | Not used for training ([data controls](https://developers.openai.com/api/docs/guides/your-data)) |
| Retention | Set by the [DPA](https://typesafe.ai/legal/data-processing) ("as long as necessary"); no period is published. Zero data retention (ZDR) is available for enterprise customers on request | Abuse-monitoring logs are kept for 30 days. No application state is kept, apart from the prompt cache. ZDR is available to eligible organizations. Regional processing in the US and EU, and Private Link |

**Compared with today.** Today's decision step sends a system prompt that defines the three
labels, plus the records as JSON. It constrains the answer with a JSON schema
(`{"label": "allow" | "redact" | "drop"}`) and gets back one label with no probability. The
model may think first, which is why `max_tokens` is 4096, and output and thinking tokens are
billed. A decision model differs in four ways:

- **It returns a distribution.** Code decides how much risk to take, instead of the prompt
  ("when unsure between allow and redact, choose redact"). This is where thresholds come in.
- **The question is split into parts.** The instructions and the meaning of each label are
  separate fields, not one prompt. seshi fills the label fields itself (section 3).
- **It is cheaper and faster.** A full 100,000-character part is roughly 25–35k tokens. That
  costs about $0.0013 on Jev and $0.003 on OpenAI, with nothing billed for output.
- **It does no extended reasoning.** Both vendors say these models suit "gut-check"
  judgments, and that broad judgments should be split into narrow ones.

Jev's [jaggedness page](https://docs.typesafe.ai/model-jaggedness) lists failure modes that
matter for coding-agent sessions:

- It reads instructions literally.
- Accuracy falls when the state is large and mostly irrelevant.
- Adversarial content in the state "can move the answer", as it can for an LLM.
- Choice option order can matter.

## 2. Where they fit

**Decision step only.** Neither API can return findings (record, field, exact text,
category), because neither generates text. So the redactor stays an LLM on `complete()`.

**`complete()` is the wrong interface.** `CompletionRequest` is `{system, user, schema,
schemaName, maxTokens}`: a prompt and a schema to fill. A decision model needs instructions,
named labels with descriptions, and the content, and it answers with probabilities. Forcing it
through `complete()` would mean parsing seshi's schema back into questions and throwing away
the probabilities. The smallest seam is a second interface, used only by the decision step:

```ts
// packages/ts/review/src/provider.ts
export interface DecisionRequest {
  instructions: string; // the policy's prompt, with seshi's data note
  records: Entry[]; // one part, as partsOf() makes it today
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DecisionAnswer {
  probabilities?: Readonly<Record<Label, number>>; // absent for an LLM
  label?: Label; // an LLM's own label; absent when probabilities are given
  model?: string; // the version that answered, when the provider says
}

export interface DecisionProvider {
  readonly kind: string;
  readonly model: string;
  readonly endpoint: string;
  decide(request: DecisionRequest): Promise<DecisionAnswer>;
}
```

- **`LlmDecision`** wraps any `ModelProvider`. It builds today's `decisionSystem(prompt)`,
  `recordsMessage(part)` and `DECISION_SCHEMA`, and runs `checkLabel`. An LLM policy behaves
  and hashes exactly as it does now. `thresholds` is refused on LLM providers: they return no
  probabilities.
- **`OpenAiDecisions`** and **`TypeSafe`** use the vendors' SDKs (`openai`,
  `@typesafe-ai/sdk`), configured as in section 4. They send one `choice` question named
  `label`, with the three labels in a fixed order (allow, redact, drop) and seshi's own
  description of each (`LABEL_DESCRIPTIONS` in `prompts.ts`, section 3).
  - **Jev:** `state` is `{records: [...]}` as a JSON object, Jev's native form.
  - **OpenAI:** `input` is one user message whose `input_text` is `recordsMessage(part)`. Its
    `input_json` part caps at 256 KiB and 10,000 values, which a large part can pass.
- **`ModelReviewer.call`** calls `decide()` for the decision step and `complete()` for the
  redactor. Thresholds are applied in the reviewer (`labelOf(answer, thresholds)`), not in each
  provider, so they mean the same thing for both.
- **Unchanged:** retries, backoff and `on_failure`. Providers throw `ProviderError` with the
  same codes as today. New mappings:
  - A refusal (OpenAI's `refusal` answer) is `refusal`, not retried.
  - Jev's `529` is `http_529`, retried like any status of 500 or above.
  - Jev's `400` with `max_tokens_exceeded` becomes a new code, `too_long`, not retried.
  - Anything other than one well-formed answer for `label` is `invalid_answer`, retried.

**`max_input_chars` and splitting.** Splitting stays as it is. One `drop` drops the upload,
and only parts labelled `redact` reach the redactor. Jev's 32k tokens per question is below
what a 100,000-character part of JSON-escaped code can reach. Two options:

- Use a provider default of **40,000** for `typesafe`, measured in section 6.
- When Jev still answers `too_long`, split that part in two and ask again rather than fail:
  token density varies by up to 3x between parts.

Smaller parts also help Jev's accuracy, and cost about the same, since only input tokens are
billed. OpenAI needs no change.

## 3. Config

Two new `provider` values, valid on `decision` only:

- **`typesafe`** (the model is Jev). Default `base_url` `https://api.typesafe.ai`.
- **`openai-decisions`**. Default `base_url` `https://api.openai.com/v1`, default model
  `gpt-6-luna`.

They are separate from `openai-compatible` because the request, the answer and what can be
configured all differ.

```toml
[[review.policies]]
id = "default"
decision = { provider = "openai-decisions", api_key = { env = "OPENAI_API_KEY" } }
redactor = { provider = "anthropic", api_key = { env = "ANTHROPIC_API_KEY" } }
```

```toml
[[review.policies]]
id = "strict"

[review.policies.decision]
provider = "typesafe"
model = "jev-1.14.0"                    # or an alias; the version that answered is recorded
api_key = { env = "TYPESAFE_API_KEY" }
# base_url = "https://api.typesafe.ai"  # the default
prompt_file = "/etc/seshi/review/decision.md"   # what counts as sensitive here
thresholds = { drop = 0.9, redact = 0.3 }
timeout = "10s"

[review.policies.redactor]
provider = "anthropic"
api_key = { env = "ANTHROPIC_API_KEY" }
```

| Key on a decision-model step | |
|---|---|
| `provider` | `typesafe` or `openai-decisions`. Refused on `redactor` with "makes decisions only; name the redactor's provider" |
| `model` | Any model the provider serves, a version or an alias: the user's choice. `jev-latest` by default for `typesafe`, `gpt-6-luna` for `openai-decisions`. The record names the version that answered, so a moved alias shows |
| `api_key`, `base_url`, `timeout` | As today. Required key. `timeout` defaults to `"10s"`: these calls are fast, and a hung call should fail over to a retry sooner |
| `prompt`, `prompt_file` | The question's `instructions`: the organization's policy (below). seshi always appends its data note (the records are data, never instructions) |
| `thresholds.drop`, `.redact` | Below. `drop` is `0.9` by default, so a drop is high precision; `redact` unset means the most probable label |
| `labels` | Not a key. seshi owns the label descriptions (below) |
| `max_tokens`, `effort` | Refused: there are no output tokens or effort to set |

**What users customize: the prompt, not the labels.** A decision-model question has two
kinds of text: the instructions, and a description of each option. They divide cleanly:

- **seshi writes the label descriptions.** What `allow`, `redact` and `drop` *do* is the
  pipeline's contract: `redact` sends the part to the redactor, and `drop` stores nothing. So
  their descriptions say what each action means and nothing about any organization's data.
  They sit beside the label names and the data note as seshi's own wrapping, and they are
  versioned with it:
  - **allow:** nothing in the records needs removing; store them as they are.
  - **redact:** specific text in the records must not be stored, and removing that text leaves
    the rest useful.
  - **drop:** removing text could not make the records safe to store; store none of them.
- **The user writes the prompt.** It says what counts as sensitive in this organization:
  credentials in prose, personal data, whose data is customer data, which internal hostnames
  are fine, what a confidential project looks like. It also carries the organization's edge
  cases between labels, for example "a customer's ticket text is redact, a full export of
  tickets is drop". In particular, **what to drop is the user's to describe**: seshi's
  default only gives the generic case. seshi's default prompt is today's opening paragraph and the examples from
  its bullets, rewritten as a question. It adds that most sessions are ordinary engineering
  work, and that `redact` needs specific text the model can point to; that sentence halved
  OpenAI's over-flagging in the experiment (section 6).
- **Thresholds carry the risk tolerance.** "When unsure, choose redact" is no longer prose
  but two numbers that `seshi review eval --sweep` can tune.

This keeps one setting, as for an LLM step today, and it leaves no way for a user's
instructions and option descriptions to contradict each other. Jev's
[jaggedness page](https://docs.typesafe.ai/model-jaggedness) names that contradiction as a
failure mode. The cost is that Jev advises putting edge cases in the option descriptions,
where the model weighs them option by option. Here they go in the instructions instead,
which may cost some accuracy. The eval measures that. If evidence shows organizations need
their own descriptions, a `labels` key can be added later without breaking anything.

An LLM prompt file does not carry over unchanged. It defines the labels itself, which
duplicates seshi's descriptions and can contradict them. Moving a policy to a decision model
means deleting the label definitions from the prompt and keeping the policy.

**The redactor no longer inherits.** Today a redactor that names no provider inherits the
decision step's. With a decision model, there is nothing for it to inherit, so the policy must
name the redactor's provider and key. That makes the smallest policy two lines instead of
one. That is the honest cost: two vendors see the text (one sees all of it, one sees only the
parts labelled `redact`), and `config check` already lists both.

**Mapping seshi's labels and categories.** The three labels map to one `choice` with options
`allow`, `redact` and `drop`. The redactor categories (`secret`, `personal`, `customer-data`)
do not need to reach the decision model at all: they are the redactor's to apply. A later
option (phase 5) asks one yes/no question per category plus one for "inseparable", and
derives the label in code. That follows both vendors' "decompose the judgment" advice, and
records which category triggered `redact`. It is a second request shape, so it waits for eval
evidence that it beats the single choice.

**Thresholds.** The vendors advise putting a threshold on the probability of the action you
will take, not on `confidence`. Jev's [confidence page](https://docs.typesafe.ai/confidence)
says so directly, and OpenAI says to "set thresholds ... based on the cost of false
positives and false negatives". For one part with probabilities `p`:

1. **Drop.** When `thresholds.drop` is set, drop only if `p.drop >= drop`. A drop below the
   threshold becomes **redact**, never allow: "drop only above 0.9, otherwise redact".
2. **Redact.** When `thresholds.redact` is set, redact if `p.redact + p.drop >= redact`
   (the chance that something needs removing), else allow.
3. **Defaults.** `drop` is `0.9` unless the policy sets it. An unset `redact` falls back to
   the most probable label.

Both thresholds are in `(0, 1]` and refused on LLM providers. This moves "when unsure,
redact" out of the prompt and into code, where `seshi review eval` can measure it.

**`drop` is high precision.** A false drop loses a session for good. A missed drop falls
back to `redact`: the redactor still removes what it finds, and the rest is stored. So a
decision-model step drops only when it is confident and the user's prompt describes the
case, and otherwise redacts. The default of 0.9 follows from that, and the experiment
supports it: at 0.7 and above, no variant on either model dropped a session wrongly
(section 6).

**The policy hash.** Nothing lives at the provider, so the hash stays local and complete. For a
decision-model step it covers the same fields as now: provider, model, base_url, prompt and
timeout. It adds the thresholds, and the wrapper version, which covers seshi's label
descriptions, its data note and the question shape. `thresholds` enter the identity only when
set, so every existing policy keeps its hash. The configured model is hashed. The
version that actually answered (Jev returns it even for an alias) goes in the review record
instead (below), because it is not config.

**What the review record gains** at `owners/<o>/sessions/<a>/review/<n>.json`, and in the drop
record:

- `decision_model` names the version that answered when the provider reports one
  (`typesafe/jev-1.14.0`), not the alias that was sent.
- `scores`: each part's `{allow, redact, drop}` probabilities, in part order, up to the part
  that decided.

These are numbers, not text, so the record still holds "labels and findings, never text".
`GET /v1/sessions/:agent/:session_id/reviews` gives admins the scores and readers only the
label, as it does today.

## 4. Guarantees seshi must keep

Both SDKs fall back to environment variables only for options left unset, so seshi sets
every one of them explicitly, as `anthropic.ts` does for Anthropic's SDK.

| Guarantee ([model-review.md](../model-review.md)) | Jev (`@typesafe-ai/sdk`) | OpenAI Decisions (`openai`) |
|---|---|---|
| Only record text leaves, and only to the configured endpoint | Kept. seshi sends the same entries an LLM gets, and never sends `assets` or the `TypeSafe-Danger-Zone-*` headers, so no image placeholder is ever expanded | Kept. seshi never sends `input_image` (a URL there is fetched by OpenAI), `safety_identifier` (an id) or `prompt_cache_key` |
| No implicit environment keys; redirects refused | Kept. Set `apiKey`, `baseURL` and `defaultModel`, so `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` are never read. The SDK has no fetch options, so pass a `fetch` that sets `redirect: "error"` | Kept. Set `apiKey` and `baseURL`, and `organization: null` and `project: null` (else `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` become headers). Set `fetchOptions: { redirect: "error" }` |
| The SDK's own retries off (the reviewer's retries are F3.4's) | `retry: { maxRetries: 0 }` | `maxRetries: 0` |
| The client never logs requests | `logLevel: "off"`. Otherwise `TYPESAFE_LOG_LEVEL=debug` logs request bodies, which "are not" redacted | `logLevel: "off"`, so `OPENAI_LOG` is never read |
| Provider error text never logged | Kept. The SDK's error messages carry the provider's text, so errors are mapped to codes from their class and status only, as `mapError` in `anthropic.ts` does. This matters here: a `422` body echoes "a text preview of the rejected input". `max_tokens_exceeded` is read from the error to set the code, and never recorded | Kept the same way. A `refusal` answer carries no text |
| Review record stores labels and findings, never text | Kept. Probabilities are added, never text | Kept |

**Prompt caching (OpenAI).** Caching is on by default: OpenAI places a cache breakpoint at
the end of the shared `input`, which is the records, whenever they reach 1,024 tokens. That
stores the records as cache state on OpenAI's GPUs until the cache expires: `ttl` is 30
minutes, and data controls says it is gone within 24 hours. It also bills a cache write
($0.125/M) above the normal input rate, for a prefix that is never reused. seshi should send
`prompt_cache_options: {mode: "explicit"}` with no breakpoints, which turns caching off.

**Retention and training are the user's contract.** seshi assumes users have contracts with
the providers they choose, as it already does for Anthropic and OpenAI-compatible endpoints.
Retention, training and residency terms come from that contract, not from seshi. seshi's part
is unchanged: only record text, only to the endpoint configured, and `seshi config check`
names that endpoint. For reference, the published defaults:

- **OpenAI:** abuse-monitoring logs kept 30 days, no training, ZDR for eligible
  organizations, regional processing in the US and EU.
- **TypeSafe:** no training on input. Retention follows its DPA. ZDR is offered to enterprise
  customers.

Neither decision model runs locally. Users who must keep transcripts in-house stay on a local
model through `openai-compatible`.

**Serverless mode.**

- Laptops need the decision key too, through `seshi review key set typesafe` or
  `seshi review key set openai-decisions`, alongside the redactor's key.
- The shared-config rule still applies: a policy in `config/seshi.toml` that carries a key may
  not name a `base_url` other than its provider's own.

## 5. Evaluation and calibration

**`seshi review eval` measures these providers as is.** It builds a reviewer from the policy
and runs labelled fixtures through the real providers. Once the decision step goes through
`decide()`, label accuracy, false and missed drops, redactor recall and leaks all work
unchanged. It needs four additions:

- Each fixture's probabilities in the report.
- Latency per call (median and p95), and tokens and cost, since these providers are chosen
  for speed and price.
- **A threshold sweep** (`--sweep`): from the probabilities it already has, recompute the
  labels at each pair of thresholds, with no new calls. Report the pairs with zero missed
  drops and zero leaks, and the fewest false drops. This is how an operator sets
  `thresholds`.
- **A compare mode** (`--against <policy>`): run two policies on the same records and report
  how often their labels agree, by label, with each disagreement's scores. It needs no
  labels, so it runs on unlabelled sessions (below).

**The built-in fixtures are too few to calibrate.** There are ten (3 allow, 5 redact,
2 drop), enough to catch a broken policy but not to pick a threshold. A threshold sweep needs
an operator's own few hundred labelled fixtures (`--fixtures <dir>`). seshi can help build
them without text leaving the server:

- **`seshi review fixture add <agent> <session> --records a..b --label redact`** writes a
  slice of a stored session as a local fixture file for the operator to label. Stored text has
  already been redacted, so these fixtures are good for false-positive cases (allow, redact)
  but under-represent leaks. Leak fixtures still have to be written by hand, as the built-ins
  were.
- **Export past decisions, without text** (`seshi review export`). This exports `policy_hash`,
  `decision_model`, label, per-part `scores`, finding categories and counts, plus what
  happened afterwards (retracted, deleted). It shows how labels and scores are distributed on
  real traffic, and how many writes a threshold change would flip. It gives no ground truth,
  because it has no text to label.

**Calibrating thresholds without labelled data.** Nobody has to read session text to set
thresholds. Four ways, from cheapest to most reliable:

1. **From costs.** Both vendors train for calibrated probabilities. If they are calibrated,
   a threshold follows from what each mistake costs: drop when `p.drop` exceeds
   `cost of a false drop / (cost of a false drop + cost of a missed drop)`. "Drop only above
   0.9" says losing a session wrongly is nine times worse than storing, redacted, one that
   should have been dropped. The vendors' calibration holds on their data, not necessarily
   on seshi's question, so this is a starting point.
2. **From synthetic fixtures.** Generate sessions with known sensitive text planted in them.
   The label is known by construction, as it is for seshi's built-in fixtures. This scales to
   the few hundred fixtures a sweep needs, and no real text is involved.
3. **From the current policy, in shadow.** Run the decision model beside the live LLM policy
   on real uploads, on the server, without acting on its answer. Record its label and scores
   in the review record next to the LLM's label, which is numbers and labels only. Then sweep
   thresholds for agreement with the LLM, and count the disagreements in each direction. The
   LLM is not ground truth, but it is the behaviour being replaced, and the text never
   leaves where it already goes.
4. **From target rates.** From exported scores (no text), pick thresholds that give a drop
   rate and a redact rate the operator can accept. This fixes how often each action happens,
   not whether it is right.

**Where eval data can come from.**

- **Local sessions.** A developer's own raw transcripts on their laptop. These are the best
  source of real positives, because nothing has removed anything yet. Sending them to a
  provider is the developer's own call under their contract. They are unlabelled, so they
  suit compare mode, and part-size measurement (section 6). `seshi review eval` needs a
  way to read them: `--sessions <path>`, normalized with the same formats capture uses.
- **A deployment's stored sessions.** These suit measuring false positives (most stored
  traffic is `allow`) and token counts. They are a poor source of positives: regex redaction
  and any earlier review already removed what we most want to catch, and their
  `[redacted:<category>]` markers tell the model where it was. They usually hold other
  people's sessions too. So the place to use them is shadow mode on the server that already
  holds them, not exported to a laptop.
- **Synthetic fixtures.** For leaks and drops, which real stored data under-represents.

**Training a provider: not possible, and not needed.** Neither provider offers per-account
training: Jev serves every account the same weights, and `gpt-6-luna` lists fine-tuning as
unsupported. Calibration therefore happens in seshi. The user tunes the prompt and the
thresholds, both local config, covered by the hash and measured by eval. seshi tunes its own
label descriptions and the part size, versioned in the wrapper.
**seshi should not build a way to send session text to a vendor for training.** If a vendor
asks for labelled data, the operator's fixtures are files the operator owns and can share
under their own agreement.

## 6. A first eval (2026-11-20)

A scratch harness (not in the repo) ran the decision step three ways on the same parts:

- **Today's LLM step:** Claude Haiku 5.5 with seshi's default decision prompt.
- **OpenAI Decisions:** `gpt-6-luna`.
- **Jev:** `jev-1.14.0`.

Both decision models got the design in section 3: seshi's fixed label descriptions, a policy
prompt rewritten from today's default, no thresholds (the most probable label), and OpenAI's
caching off. The inputs:

- **The 10 built-in fixtures**, labelled.
- **40 local Claude Code sessions** from one developer's laptop, spread across two months,
  normalized and regex-redacted the way capture does it.
- **40 production sessions** from the Dosu organization only, a random sample of
  `memory.trace` (33 Claude Code, 6 Codex, 1 Cursor), already regex-redacted. The sample was
  deleted after the run.

The harness recorded labels, probabilities, sizes, tokens and latency, never text.

There is no ground truth for real sessions, so the target is a proxy. Where all three agreed
on a session (35 of 80), that label stands. Where they disagreed (45 of 80), **Claude Opus
5.5 at high effort** judged every part with today's decision prompt. The judge shares the
LLM step's prompt, which may favour it. Treat the figures as a first read on 80 sessions,
not a benchmark.

**Accuracy**

| | Fixtures (expected label) | Real sessions (consensus or judge) | Missed: allowed where the target flagged | Over-flagged: flagged where the target allowed |
|---|---|---|---|---|
| Today's LLM (Haiku 5.5) | 10/10 | 68/80 (85%) | 6 | 6 (1 a drop) |
| Jev, most probable label | 10/10 | 65/80 (81%) | 5 | 9 |
| OpenAI, most probable label | 9/10 | 48/80 (60%) | 0 | 31 (1 a drop) |
| OpenAI, `thresholds = {drop = 0.5, redact = 0.8}` | | 66/80 (83%) | 7 | 6 |

**Speed and cost**

| | Median call | p95 call | Input tokens per session | Cost per session |
|---|---|---|---|---|
| Today's LLM | 1.6 s | 4.0 s | ~39k, plus thinking | (Haiku rates) |
| OpenAI Decisions | 0.4 s | 1.1 s | ~39k | ~$0.004 |
| Jev | 0.2 s | 0.4 s | ~45k (smaller parts repeat the instructions) | ~$0.002 |

**What it shows**

- **Jev is about as good as today's LLM, unchanged.** It sits within a few sessions of Haiku
  on both accuracy and misses, with no thresholds, and is about 8x faster per call. On the
  production sample it matched the judge on 19 of 25 disputed sessions, against Haiku's 18.
- **OpenAI over-flags until it is calibrated.** With the most probable label it never missed
  anything, but it flagged 31 sessions the target allowed. A `redact` sends the part to the
  redactor LLM, so this throws away most of the savings. With `redact = 0.8` it lands at
  Haiku's level. So thresholds must be **per provider and per policy**: a single default
  would be wrong for one of them.
- **Drops are rare and the decision models are cautious about them.** One session was
  judged `drop`. Haiku dropped it. Both decision models called it `redact`, so it still went
  to the redactor and was not stored raw. Two sessions were dropped wrongly: one by Haiku,
  and one by OpenAI that `drop = 0.5` removes. 80 sessions are too few to set a drop
  threshold.
- **Consistency.** OpenAI returned identical probabilities on a second run over the same
  production parts. Haiku gave the same part label on 76 of 80 parts. Jev was run at
  different part sizes in the two runs, so its consistency was not measured.
- **Jev's part size.** Jev used about 0.31 tokens per character of seshi's part budget
  (text plus 120 per entry) at the median, and up to 0.53 at the 95th percentile. At a
  60,000 budget, 2 of 115 production parts exceeded its 32k-token limit. At 50,000 none did,
  but the largest part reached 31.4k tokens. The `typesafe` default should be **40,000**.
  And `too_long` should split the part in two and ask again rather than fail, since
  token density varies by up to 3x between parts.

### Prompt and label-description experiment

The same 80 real sessions and 10 fixtures, run through five ways of asking each decision
model. Jev used 40,000-character parts; OpenAI used 100,000.

| Variant | What changes |
|---|---|
| `baseline` | The section 3 design: seshi's generic label descriptions, and the policy in the instructions |
| `labels-carry-policy` | A short instruction; the policy (what to remove, what to drop, what is fine) written into each label's description |
| `minimal` | A one-line instruction ("records from a coding agent's session that an organization is about to store") and the generic labels |
| `precise` | `baseline`, plus: most sessions are ordinary engineering work; choose redact only for specific text you can point to, not for a sensitive-sounding topic, a possibility, placeholders, example values, or text already `[redacted:…]` |
| `categories` | Four yes/no questions in one request: credential, personal data, customer data, and "should not be stored at all". `redact` when any is likely; `drop` from the last |

The target is stricter than above. **Opus 5.5 at high effort judged all 80 sessions**, not
only the disputed ones, so no variant is favoured by a consensus it took part in. The judge
found 57 `allow`, 22 `redact` and 1 `drop`. Against this target, **today's Haiku step scores
64/80, missing 7 and over-flagging 9.** For each variant the table gives:

- **At 0.5:** each part is labelled with `thresholds = {drop = 0.5, redact = 0.5}`, which is
  the same as the most probable label. The figures in brackets are sessions missed / sessions
  over-flagged.
- **Tuned:** the best redact threshold found on this same data, so it flatters every variant.
- **AUROC:** how well the session's flag probability ranks the target's flagged sessions above
  its allowed ones, whatever the threshold. 1.0 is perfect; 0.5 is chance.

| Variant | Jev at 0.5 | Jev tuned | Jev AUROC | OpenAI at 0.5 | OpenAI tuned | OpenAI AUROC |
|---|---|---|---|---|---|---|
| `baseline` | 64 (6 / 9) | 66 at 0.55 | 0.87 | 38 (0 / 40) | 60 at 0.95 | 0.86 |
| `labels-carry-policy` | **68** (9 / 2) | 68 at 0.50 | 0.88 | 50 (2 / 27) | 65 at 0.85 | 0.84 |
| `minimal` | 29 (0 / 50) | 65 at 0.85 | 0.86 | 28 (0 / 51) | 57 at 0.95 | 0.83 |
| `precise` | 66 (8 / 5) | 67 at 0.55 | 0.85 | 57 (3 / 19) | **70** at 0.90 | 0.90 |
| `categories` | 64 (7 / 7) | 65 at 0.40 | **0.92** | **66** (6 / 7) | 69 at 0.85 | 0.90 |

On the fixtures, Jev's `baseline`, `precise` and `categories` each scored 10/10, and
`minimal` missed both drops. OpenAI's best on the fixtures was `baseline`, at 9/10.

**What it shows**

- **The instructions carry the calibration.** With a one-line instruction, both models
  flagged nearly every session: 50 and 51 of the 57 the judge allowed. They still ranked
  sessions fairly well (AUROC 0.83–0.86), but they had no anchor for what counts as
  ordinary work. So seshi's default prompt must be substantial, and the docs should tell
  users who write their own to keep saying what is fine to store, not only what is not.
- **"Point to specific text" fixes most of OpenAI's over-flagging.** The `precise` paragraph
  halved it at 0.5 (40 to 19), and gave the best result of the experiment once tuned: 70/80,
  missing 6 and over-flagging 3. That beats today's Haiku step. For Jev it changed little.
  **seshi's default decision-model prompt should include it.**
- **Where the policy lives (instructions or label descriptions) makes no clear
  difference.** Moving it into the labels made both models more conservative: fewer flags,
  more misses (Jev 9 missed against 6). It did not rank sessions better (AUROC 0.88 against
  0.87 for Jev; 0.84 against 0.86 for OpenAI). This is the evidence open question 2 asked
  for. Keeping seshi's own generic label descriptions, with the user's policy in the prompt,
  costs nothing measurable here.
- **Per-category questions rank best.** `categories` had the highest AUROC on both models.
  It was the best untuned OpenAI variant (66/80), and the only variant to catch the one true
  drop. At its best Jev threshold (0.40) it missed only 2 sessions, but at the cost of 11
  over-flags. It costs about the same, since each provider bills the shared input once per
  request, not per question. It is the strongest candidate for phase 5.
- **Drops cannot be calibrated from this data.** In every variant the one true drop scored
  0.54 or less on `drop`. Thresholds high enough to stop false drops (0.7–0.8) also miss it.
  Decision models call such sessions `redact` instead, so their text goes to the redactor
  rather than being stored raw. That is acceptable because `drop` is meant to be high
  precision (section 3): missing a drop costs less than a false one, and what to drop is
  for each organization's prompt to describe.
- **Noise.** With 23 flagged sessions, a difference of two or three sessions is within
  noise. Treat the ordering of `baseline`, `labels-carry-policy` and `precise` on Jev as a
  tie.

## 7. Recommendation, open questions and plan

**Recommendation.** Build the `decide()` seam with thresholds and recorded scores, then
**Jev**, then **OpenAI Decisions**. The eval reverses the earlier order:

- Jev is as accurate as today's LLM step with no thresholds to tune.
- Jev is the fastest and cheapest of the three.
- Its one real constraint, part size, is now measured.

OpenAI follows as a small change, documented with the threshold it needs: about
`redact = 0.8` on this data. The two APIs are nearly the same shape (one choice,
probabilities, no text), so most of the work is the seam, not the providers.

**Open questions**

Rate limits, retention and model choice are the user's, under their contract with the
provider. Prompt injection is not treated separately from today's LLM step.

1. **The `redact` threshold.** One default cannot serve both providers. Ship none, and
   document per-provider starting points measured by the sweep: none for Jev, and 0.8–0.9
   for OpenAI. Revisit on more data, and on ground truth rather than a judge.
2. **Category questions (phase 5).** They ranked best in the experiment. Should they replace
   the single choice once the seam exists? And should the categories that triggered
   `redact` narrow what the redactor is asked to look for?

Answered by the eval (section 6):

- **Jev's part size** is 40,000 characters, with `too_long` splitting the part.
- **Drops** are high precision: `drop = 0.9` by default, and below it the part is redacted.
  What to drop is for the user's prompt to describe.
- **Edge cases in the prompt or in the label descriptions:** no measurable difference, so
  no `labels` key.
- **seshi's default decision-model prompt** should keep the full policy and add the "point
  to specific text" paragraph.

**Plan** (S = up to a day, M = two to four days)

| Phase | Work | Size |
|---|---|---|
| 0 | Get keys for both. No code | S |
| 1 | The seam: `DecisionProvider`, the `LlmDecision` adapter, seshi's label descriptions and default decision-model prompt, `thresholds` in the schema and the hash (existing hashes unchanged), `scores` and the served model in the review and drop records, the eval's probabilities, latency, cost and `--sweep`, the new fixtures. No behaviour change for existing policies | M |
| 2 | `typesafe`: the `@typesafe-ai/sdk` client (section 4), a 40,000 `max_input_chars` default, `too_long` splitting the part and asking again, fake-fetch tests, `config check` output, serverless key name, [config.md](../config.md#review) and [model-review.md](../model-review.md) | S–M |
| 3 | `openai-decisions`: the `openai` SDK client (section 4), caching off, refusal and status mapping, tests, docs with its measured starting thresholds | S |
| 4 | Calibration data: `seshi review eval --sessions` and `--against`, shadow mode for a candidate decision step on the server, synthetic fixture generation | M |
| 5 | Per-category questions (the strongest variant in the experiment), measured against the single choice on more data; then, on evidence, `seshi review fixture add` and `seshi review export` | M |
