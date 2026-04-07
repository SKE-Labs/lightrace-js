/**
 * Shared test utilities for lightrace-js tests.
 *
 * Provides span inspection helpers following the langfuse-python pattern:
 * structured span data extraction, JSON attribute parsing, and trace assertions.
 */
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export interface SpanData {
  name: string;
  spanId: string;
  traceId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
}

/** Extract structured data from an OTel span for easy assertion. */
export function getSpanData(span: ReadableSpan): SpanData {
  return {
    name: span.name,
    spanId: span.spanContext().spanId,
    traceId: span.spanContext().traceId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parentSpanId: (span as any).parentSpanContext?.spanId ?? undefined,
    attributes: { ...span.attributes },
  };
}

/** Parse a JSON-encoded span attribute value. Returns null if missing or empty. */
export function getJsonAttr(sd: SpanData, key: string): unknown | null {
  const raw = sd.attributes[key];
  if (raw === undefined || raw === null || raw === "") return null;
  return JSON.parse(raw as string);
}

/** Find the first span matching a name and return its SpanData. */
export function findSpanByName(spans: ReadableSpan[], name: string): SpanData | undefined {
  const s = spans.find((s) => s.name === name);
  return s ? getSpanData(s) : undefined;
}

/** Find all spans matching a name. */
export function findAllSpansByName(spans: ReadableSpan[], name: string): SpanData[] {
  return spans.filter((s) => s.name === name).map(getSpanData);
}

/** Find the first span where an attribute matches a value. */
export function findSpanByAttr(
  spans: ReadableSpan[],
  key: string,
  value: string,
): SpanData | undefined {
  const s = spans.find((s) => s.attributes[key] === value);
  return s ? getSpanData(s) : undefined;
}

/** Assert all spans share the same traceId. */
export function assertSameTrace(...spanDatas: SpanData[]): void {
  const traceIds = new Set(spanDatas.map((s) => s.traceId));
  if (traceIds.size !== 1) {
    throw new Error(`Expected all spans in same trace, got ${[...traceIds].join(", ")}`);
  }
}
