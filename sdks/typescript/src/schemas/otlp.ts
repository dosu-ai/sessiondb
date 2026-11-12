/** OTLP/HTTP JSON, the subset a stored trace uses: one `ExportTraceServiceRequest`, as
 * `opentelemetry-proto`'s JSON mapping writes it (ids as lowercase hex, times as decimal strings
 * of Unix nanoseconds, enums as integers). A stored object can be POSTed as-is to any collector's
 * `/v1/traces`. */

export const OTLP_TRACE_SCHEMA = "sessionstorage/trace-otlp/1" as const;

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** `SPAN_KIND_INTERNAL` = 1, `SPAN_KIND_CLIENT` = 3. */
export type OtlpSpanKind = 1 | 3;

/** `STATUS_CODE_UNSET` = 0, `STATUS_CODE_OK` = 1, `STATUS_CODE_ERROR` = 2. */
export interface OtlpStatus {
  code: 0 | 1 | 2;
  message?: string;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: OtlpSpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: OtlpStatus;
}

export interface OtlpTrace {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: {
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }[];
  }[];
}
