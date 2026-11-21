import { createHash } from "node:crypto";
import { type Principal, pickClaims, requireScope, serviceSourceId } from "@seshi/auth";
import { OTLP_GENAI, readExportRequest, type SpanGroup } from "@seshi/formats";
import type { Instance } from "@seshi/instance";
import {
  type Claims,
  ENVELOPE_SCHEMA,
  type Envelope,
  Forbidden,
  type ReceivedSpan,
  SessionRejected,
  StoreError,
  Unauthorized,
} from "@seshi/model";
import { type OtlpBodyCaps, readOtlpBody } from "./body";
import { decodeExportRequest, encodeExportResponse, encodeStatus } from "./protobuf";

export const METADATA_ONLY_MESSAGE =
  "seshi stores conversations, and no span in this batch carries prompt or response content: set this destination's content mode to Full content (spans were not stored)";

const GRPC = {
  INVALID_ARGUMENT: 3,
  PERMISSION_DENIED: 7,
  UNAUTHENTICATED: 16,
  UNAVAILABLE: 14,
  INTERNAL: 13,
};

type Encoding = "protobuf" | "json";

export interface ReceiverDeps {
  bearer(request: Request): string | undefined;
  caps: OtlpBodyCaps;
}

/** The encoding a `Content-Type` names, or null for one OTLP/HTTP does not define. */
export function encodingOf(contentType: string | null): Encoding | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "application/x-protobuf" || type === "application/protobuf") return "protobuf";
  if (type === "application/json") return "json";
  return null;
}

function respond(encoding: Encoding, status: number, body: Uint8Array | object): Response {
  if (encoding === "protobuf") {
    return new Response(body as Uint8Array<ArrayBuffer>, {
      status,
      headers: { "content-type": "application/x-protobuf" },
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(encoding: Encoding, status: number, code: number, message: string): Response {
  return respond(
    encoding,
    status,
    encoding === "protobuf" ? encodeStatus(code, message) : { code, message },
  );
}

function success(encoding: Encoding, rejected: number, message: string | undefined): Response {
  const partial =
    rejected > 0 || message ? { rejected_spans: rejected, error_message: message } : undefined;
  if (encoding === "protobuf") return respond(encoding, 200, encodeExportResponse(partial));
  return respond(
    encoding,
    200,
    partial
      ? {
          partialSuccess: {
            rejectedSpans: String(partial.rejected_spans),
            ...(partial.error_message ? { errorMessage: partial.error_message } : {}),
          },
        }
      : {},
  );
}

function batchKey(spans: readonly ReceivedSpan[]): string {
  const ids = spans.map((s) => `${s.traceId}-${s.spanId}`).sort();
  return `otlp:${createHash("sha256").update(ids.join("\n")).digest("hex")}`;
}

function mergeClaims(into: Claims | undefined, more: Claims | undefined): Claims | undefined {
  if (!more) return into;
  return {
    ...into,
    ...more,
    ...(into?.account_ids || more.account_ids
      ? { account_ids: { ...into?.account_ids, ...more.account_ids } }
      : {}),
  };
}

interface SessionBatch {
  session_key: string;
  resource: SpanGroup["resource"];
  spans: ReceivedSpan[];
}

export function otlpTraces(instance: Instance, deps: ReceiverDeps) {
  return async (request: Request): Promise<Response> => {
    const accept = encodingOf(request.headers.get("content-type"));
    const encoding: Encoding = accept ?? "json";
    let principal: Principal;
    try {
      principal = await instance.auth.authenticate(deps.bearer(request), undefined);
      requireScope(principal, "sessions:write");
    } catch (err) {
      if (err instanceof Unauthorized)
        return failure(encoding, 401, GRPC.UNAUTHENTICATED, err.message);
      if (err instanceof Forbidden)
        return failure(encoding, 403, GRPC.PERMISSION_DENIED, err.message);
      throw err;
    }
    const sourceId = principal.kind === "service" ? serviceSourceId(principal.owner) : undefined;
    let source = sourceId ? instance.source(sourceId) : undefined;
    const lastSync = instance.runtime?.lastSync?.getTime() ?? 0;
    if (sourceId && !source && instance.runtime && instance.now().getTime() - lastSync > 1_000) {
      // A source the admin API just stored may not have reached this instance yet; read the
      // bucket again, at most once a second, so a token for a deleted source is not a sync
      // per request.
      await instance.refreshConfig().catch(() => undefined);
      source = instance.source(sourceId);
    }
    if (!sourceId || !source || source.type !== "otlp") {
      return failure(
        encoding,
        403,
        GRPC.PERMISSION_DENIED,
        sourceId
          ? `source ${sourceId} is not an otlp source in [[sources]]`
          : "an OTLP destination sends with a service token for its otlp source (POST /v1/tokens, kind service)",
      );
    }
    if (!source.enabled) {
      return failure(encoding, 403, GRPC.PERMISSION_DENIED, `source ${sourceId} is disabled`);
    }
    if (accept === null) {
      return failure(
        encoding,
        415,
        GRPC.INVALID_ARGUMENT,
        "Content-Type must be application/x-protobuf or application/json",
      );
    }

    let groups: SpanGroup[];
    let rejected: number;
    let reason: string | undefined;
    try {
      const body = await readOtlpBody(request, deps.caps);
      const value =
        encoding === "protobuf"
          ? decodeExportRequest(body)
          : JSON.parse(new TextDecoder().decode(body));
      ({ groups, rejected, reason } = readExportRequest(value));
    } catch (err) {
      const http = err as { status?: unknown; code?: unknown; message?: string };
      if (typeof http.status === "number" && typeof http.code === "string") {
        return failure(encoding, http.status, GRPC.INVALID_ARGUMENT, http.message ?? http.code);
      }
      if (err instanceof Error) {
        return failure(
          encoding,
          400,
          GRPC.INVALID_ARGUMENT,
          `not an ExportTraceServiceRequest: ${err.message}`,
        );
      }
      throw err;
    }

    const adapter = instance.formats.get(OTLP_GENAI)?.spans;
    if (!adapter) {
      return failure(encoding, 503, GRPC.UNAVAILABLE, `this binary has no ${OTLP_GENAI} format`);
    }
    const total = groups.reduce((n, g) => n + g.spans.length, 0);
    if (total === 0) return success(encoding, rejected, reason);

    const hasContent = groups.some((g) => g.spans.some((s) => adapter.hasContent(s, g.resource)));
    if (!hasContent) {
      instance.pipeline.health.count(sourceId, "rejected");
      return success(encoding, rejected + total, METADATA_ONLY_MESSAGE);
    }

    const batches = new Map<string, SessionBatch>();
    groups.forEach((group, g) => {
      for (const span of group.spans) {
        const key = adapter.sessionKey(span, group.resource);
        const id = `${g}\n${key}`;
        const batch = batches.get(id) ?? { session_key: key, resource: group.resource, spans: [] };
        batch.spans.push(span);
        batches.set(id, batch);
      }
    });

    const now = instance.now().toISOString();
    let message = reason;
    try {
      for (const batch of batches.values()) {
        let claims: Claims | undefined;
        for (const span of batch.spans)
          claims = mergeClaims(claims, adapter.claims?.(span, batch.resource));
        const picked = pickClaims(claims);
        const envelope: Envelope = {
          schema: ENVELOPE_SCHEMA,
          source: "otlp",
          source_id: sourceId,
          format: OTLP_GENAI,
          session_key: batch.session_key,
          payload: {
            kind: "spans",
            spans: batch.spans as unknown as Record<string, unknown>[],
            ...(batch.resource.length > 0
              ? { resource: batch.resource as unknown as Record<string, unknown>[] }
              : {}),
          },
          caller: {
            kind: "service",
            principal: principal.owner,
            credential_id: principal.credential_id,
          },
          owner: principal.owner,
          owner_basis: "service",
          idempotency_key: batchKey(batch.spans),
          received_at: now,
          ...(picked ? { claims: picked } : {}),
          ...(principal.visibility ? { visibility: principal.visibility } : {}),
        };
        try {
          const result = await instance.pipeline.submit(envelope, { onFailure: "throw" });
          if (result.status === "accepted" && result.rejected) {
            rejected += result.rejected;
            message ??=
              "some spans could not be read (no start time, or ids that are not OTLP hex)";
          }
        } catch (err) {
          if (err instanceof SessionRejected) {
            rejected += batch.spans.length;
            message ??= err.message;
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof StoreError)
        return failure(encoding, 503, GRPC.UNAVAILABLE, `storage failed: ${err.message}`);
      if (err instanceof Forbidden)
        return failure(encoding, 403, GRPC.PERMISSION_DENIED, err.message);
      const text = err instanceof Error ? err.message : String(err);
      console.error(`[seshi] POST /otlp/v1/traces: ${text}`);
      return failure(encoding, 500, GRPC.INTERNAL, "internal error");
    }
    return success(encoding, rejected, rejected > 0 ? message : undefined);
  };
}
