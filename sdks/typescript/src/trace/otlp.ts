/** A `Trace` as OTLP: the session as GenAI spans (OpenTelemetry's `gen_ai.*` semantic
 * conventions), for a store whose format is `otlp`. The trace is made the same way in both
 * formats (normalize, redact, derive events, hash); this is only how it is written.
 *
 * One stored object is one OTLP trace, its id taken from `content_hash`; the session's objects
 * share `gen_ai.conversation.id`. Under an `invoke_agent` root:
 *
 * - a `chat` span per assistant record, from the record before it to the record itself, with
 *   the messages that arrived since the last one as `gen_ai.input.messages` (never the whole
 *   history) and what the assistant said, reasoned and called as `gen_ai.output.messages`;
 * - an `execute_tool` span per tool call, from the call to its result, with the arguments and
 *   the result, `ERROR` status when the result says it failed.
 *
 * trajectory-v1 has no token usage, so the spans carry none. Every id is derived from the
 * content hash, so the same trace always converts to the same bytes.
 *
 * Nothing is lost: each `chat` span carries the records it was made from verbatim
 * (`sessiondb.records`, from index `sessiondb.record_start`), the root the records after the
 * last assistant turn, and the resource the meta record and `metadata` whole, so `fromOtlp`
 * gives back the `letta` trace, same records and same `content_hash`. That is how a reader
 * that only knows `letta` (Dosu's backend) reads an `otlp` store. */

import { createHash } from "node:crypto";
import {
  OTLP_TRACE_SCHEMA,
  type OtlpKeyValue,
  type OtlpSpan,
  type OtlpTrace,
} from "../schemas/otlp";
import type { Trace, TraceMetadata } from "../schemas/trace";
import { type MetaRecord, type NormalizedRecord, TrajectoryError } from "../schemas/trajectory";
import { VERSION } from "../version";
import { parseTrajectory } from "./parse";

type Scalar = string | number | boolean | null | undefined;

function attributes(pairs: [string, Scalar][]): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") out.push({ key, value: { stringValue: value } });
    else if (typeof value === "boolean") out.push({ key, value: { boolValue: value } });
    else if (Number.isInteger(value)) out.push({ key, value: { intValue: String(value) } });
    else out.push({ key, value: { doubleValue: value } });
  }
  return out;
}

function idFrom(seed: string, hexChars: number): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, hexChars);
}

function nanos(ms: number): string {
  return (BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n).toString();
}

function epochOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** A tool call's arguments as a message part wants them: the JSON value when they are JSON,
 * else the string. */
function argumentsOf(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

type Part =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_call_response"; id: string; response: string };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  parts: Part[];
  finish_reason?: "stop" | "tool_call";
}

export function toOtlp(trace: Trace): OtlpTrace {
  const traceId = idFrom(`sessiondb\n${trace.content_hash}`, 32);
  const spanId = (key: string) => idFrom(`sessiondb\n${trace.content_hash}\n${key}`, 16);
  const rootId = spanId("root");
  const model = typeof trace.metadata.model === "string" ? trace.metadata.model : undefined;
  const conversation = trace.session_id ?? undefined;

  const records = trace.records;
  const meta = records[0]?.role === "meta" ? (records[0] as MetaRecord) : undefined;
  const firstKnown = records
    .map((r) => (r.role === "meta" ? null : epochOf(r.timestamp)))
    .find((ms): ms is number => ms !== null);
  const startMs = epochOf(trace.started_at) ?? firstKnown ?? 0;
  let clock = startMs;

  const spans: OtlpSpan[] = [];
  const tools = new Map<string, { span: OtlpSpan; startMs: number }>();
  let pending: Message[] = [];
  let reasoning: Part[] = [];
  // The first record not yet on a span: what the next `chat` span (or the root) carries.
  let chunkStart = meta ? 1 : 0;

  records.forEach((record: NormalizedRecord, index) => {
    if (record.role === "meta") return;
    const at = epochOf(record.timestamp) ?? clock;
    switch (record.role) {
      case "user":
      case "observation":
        pending.push({ role: "user", parts: [{ type: "text", content: record.content }] });
        break;
      case "system":
        pending.push({ role: "system", parts: [{ type: "text", content: record.content }] });
        break;
      case "reasoning":
        reasoning.push({ type: "reasoning", content: record.content });
        break;
      case "tool": {
        pending.push({
          role: "tool",
          parts: [
            { type: "tool_call_response", id: record.tool_call_id, response: record.content },
          ],
        });
        const tool = tools.get(record.tool_call_id);
        if (tool) {
          tool.span.endTimeUnixNano = nanos(Math.max(tool.startMs, at));
          tool.span.attributes.push(...attributes([["gen_ai.tool.call.result", record.content]]));
          if (record.ok === false) tool.span.status = { code: 2, message: "tool call failed" };
          tools.delete(record.tool_call_id);
        }
        break;
      }
      case "assistant": {
        const calls = "tool_calls" in record ? (record.tool_calls ?? []) : [];
        const parts: Part[] = [...reasoning];
        if (record.content) parts.push({ type: "text", content: record.content });
        for (const call of calls) {
          parts.push({
            type: "tool_call",
            id: call.id,
            name: call.name,
            arguments: argumentsOf(call.args),
          });
        }
        const output: Message = {
          role: "assistant",
          parts,
          finish_reason: calls.length > 0 ? "tool_call" : "stop",
        };
        spans.push({
          traceId,
          spanId: spanId(`chat:${index}`),
          parentSpanId: rootId,
          name: model ? `chat ${model}` : "chat",
          kind: 3,
          startTimeUnixNano: nanos(Math.min(clock, at)),
          endTimeUnixNano: nanos(at),
          attributes: attributes([
            ["gen_ai.operation.name", "chat"],
            ["gen_ai.conversation.id", conversation],
            ["gen_ai.request.model", model],
            ["gen_ai.input.messages", JSON.stringify(pending)],
            ["gen_ai.output.messages", JSON.stringify([output])],
            ["sessiondb.record_start", chunkStart],
            ["sessiondb.records", JSON.stringify(records.slice(chunkStart, index + 1))],
          ]),
          status: { code: 0 },
        });
        calls.forEach((call, at_) => {
          const span: OtlpSpan = {
            traceId,
            spanId: spanId(`tool:${index}:${at_}`),
            parentSpanId: rootId,
            name: `execute_tool ${call.name}`,
            kind: 1,
            startTimeUnixNano: nanos(at),
            endTimeUnixNano: nanos(at),
            attributes: attributes([
              ["gen_ai.operation.name", "execute_tool"],
              ["gen_ai.conversation.id", conversation],
              ["gen_ai.tool.type", "function"],
              ["gen_ai.tool.name", call.name],
              ["gen_ai.tool.call.id", call.id],
              ["gen_ai.tool.call.arguments", call.args],
            ]),
            status: { code: 0 },
          };
          spans.push(span);
          tools.set(call.id, { span, startMs: at });
        });
        pending = [];
        reasoning = [];
        chunkStart = index + 1;
        break;
      }
    }
    clock = Math.max(clock, at);
  });

  // What arrived after the last assistant turn (a question never answered, a result the
  // session ended on) has no `chat` span to belong to; it stays on the root.
  const left =
    reasoning.length > 0 ? [...pending, { role: "assistant", parts: reasoning }] : pending;
  const endMs = Math.max(epochOf(trace.ended_at) ?? clock, startMs);
  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    name: `invoke_agent ${trace.source}`,
    kind: 1,
    startTimeUnixNano: nanos(startMs),
    endTimeUnixNano: nanos(endMs),
    attributes: attributes([
      ["gen_ai.operation.name", "invoke_agent"],
      ["gen_ai.agent.name", trace.source],
      ["gen_ai.conversation.id", conversation],
      ["gen_ai.request.model", model],
      ["sessiondb.unanswered_messages", left.length > 0 ? JSON.stringify(left) : undefined],
      ["sessiondb.record_start", chunkStart < records.length ? chunkStart : undefined],
      [
        "sessiondb.records",
        chunkStart < records.length ? JSON.stringify(records.slice(chunkStart)) : undefined,
      ],
    ]),
    status: { code: 0 },
  };

  const { continuation, normalizer, parent_session_id } = trace.metadata;
  const resource = attributes([
    ["service.name", "sessiondb"],
    ["sessiondb.schema", OTLP_TRACE_SCHEMA],
    ["sessiondb.content_hash", trace.content_hash],
    ["sessiondb.agent", trace.agent],
    ["sessiondb.source", trace.source],
    ["sessiondb.session_id", trace.session_id],
    ["sessiondb.project", trace.project],
    ["sessiondb.branch", trace.branch],
    ["sessiondb.started_at", trace.started_at],
    ["sessiondb.ended_at", trace.ended_at],
    ["sessiondb.cwd", typeof trace.metadata.cwd === "string" ? trace.metadata.cwd : undefined],
    ["sessiondb.git_branch", trace.metadata.git_branch],
    ["sessiondb.model", model],
    ["sessiondb.parent_session_id", parent_session_id],
    ["sessiondb.continuation.from_record", continuation?.from_record],
    ["sessiondb.continuation.prefix_sha256", continuation?.prefix_sha256],
    ["sessiondb.normalizer.name", normalizer?.name],
    ["sessiondb.normalizer.version", normalizer?.version],
    ["sessiondb.records", records.length],
    ["sessiondb.events", trace.events.length],
    ["sessiondb.meta", meta ? JSON.stringify(meta) : undefined],
    ["sessiondb.metadata", JSON.stringify(trace.metadata)],
  ]);

  return {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [
          { scope: { name: "@dosu/sessiondb", version: VERSION }, spans: [root, ...spans] },
        ],
      },
    ],
  };
}

/** Whether a stored trace object is the `otlp` format's. */
export function isOtlpTrace(value: unknown): value is OtlpTrace {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { resourceSpans?: unknown }).resourceSpans)
  );
}

/** A resource attribute of an OTLP trace object, as a string or number; undefined when absent. */
export function otlpResource(trace: OtlpTrace, key: string): string | number | boolean | undefined {
  const kv = trace.resourceSpans[0]?.resource.attributes.find((a) => a.key === key);
  if (!kv) return undefined;
  const v = kv.value;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("boolValue" in v) return v.boolValue;
  return v.doubleValue;
}

/** The meta record an OTLP trace object was made with, for continuing its session. */
export function otlpMeta(trace: OtlpTrace): MetaRecord | undefined {
  const raw = otlpResource(trace, "sessiondb.meta");
  if (typeof raw !== "string") return undefined;
  const meta = JSON.parse(raw) as MetaRecord;
  return meta.role === "meta" ? meta : undefined;
}

function spanAttribute(span: OtlpSpan, key: string): string | number | undefined {
  const kv = span.attributes.find((a) => a.key === key);
  if (!kv) return undefined;
  if ("stringValue" in kv.value) return kv.value.stringValue;
  if ("intValue" in kv.value) return Number(kv.value.intValue);
  return undefined;
}

/** The `letta` trace an OTLP trace object was made from: the meta record and every span's
 * `sessiondb.records` in record order, parsed again, its `content_hash` checked against the one
 * the object names. Throws `TrajectoryError` for an object this SDK did not write (no records
 * on its spans, a gap between them) or whose records hash to something else. */
export function fromOtlp(otlp: OtlpTrace): Trace {
  const hash = otlpResource(otlp, "sessiondb.content_hash");
  if (typeof hash !== "string") throw new TrajectoryError("not a sessiondb OTLP trace");
  const chunks: { start: number; records: NormalizedRecord[] }[] = [];
  for (const span of otlp.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))) {
    const start = spanAttribute(span, "sessiondb.record_start");
    const raw = spanAttribute(span, "sessiondb.records");
    if (typeof start === "number" && typeof raw === "string") {
      chunks.push({ start, records: JSON.parse(raw) as NormalizedRecord[] });
    }
  }
  chunks.sort((a, b) => a.start - b.start);
  const meta = otlpMeta(otlp);
  const records: NormalizedRecord[] = meta ? [meta] : [];
  for (const chunk of chunks) {
    if (chunk.start !== records.length) {
      throw new TrajectoryError(`records ${records.length}..${chunk.start} are on no span`);
    }
    records.push(...chunk.records);
  }
  const str = (key: string) => {
    const v = otlpResource(otlp, key);
    return typeof v === "string" ? v : undefined;
  };
  const metadataJson = str("sessiondb.metadata");
  const trace = parseTrajectory(records, {
    agent: str("sessiondb.agent"),
    session_id: str("sessiondb.session_id"),
    project: str("sessiondb.project"),
    branch: str("sessiondb.branch"),
    metadata: metadataJson ? (JSON.parse(metadataJson) as TraceMetadata) : undefined,
  });
  if (trace.content_hash !== hash) {
    throw new TrajectoryError(
      `records hash to ${trace.content_hash.slice(0, 12)}, object ${hash.slice(0, 12)}`,
    );
  }
  return trace;
}
