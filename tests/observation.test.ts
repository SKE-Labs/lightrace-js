import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Observation } from "../src/observation.js";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { LightraceOtelExporter } from "../src/otel-exporter.js";
import * as attrs from "../src/otel-exporter.js";

let memoryExporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let otelExporter: LightraceOtelExporter;

beforeEach(() => {
  memoryExporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
  });
  const tracer = provider.getTracer("test");
  otelExporter = { tracer } as any;
});

afterEach(() => {
  memoryExporter.reset();
  provider.shutdown();
});

describe("Observation - span", () => {
  it("creates a span, updates, and ends it", () => {
    const obs = new Observation({
      traceId: "trace-1",
      type: "span",
      name: "search",
      otelExporter,
      input: { query: "hello" },
    });

    obs.update({ output: { results: ["a", "b"] } });
    obs.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("search");
    expect(spans[0].attributes[attrs.OBSERVATION_TYPE]).toBe("SPAN");

    const input = JSON.parse(spans[0].attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input).toEqual({ query: "hello" });

    const output = JSON.parse(spans[0].attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output).toEqual({ results: ["a", "b"] });

    expect(spans[0].attributes[attrs.OBSERVATION_LEVEL]).toBe("DEFAULT");
    expect(spans[0].startTime).toBeDefined();
    expect(spans[0].endTime).toBeDefined();
  });

  it("end() is idempotent", () => {
    const obs = new Observation({
      traceId: "trace-1",
      type: "span",
      name: "test",
      otelExporter,
    });

    obs.end();
    obs.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
  });
});

describe("Observation - generation with usage", () => {
  it("includes token usage fields", () => {
    const obs = new Observation({
      traceId: "trace-2",
      type: "generation",
      name: "llm-call",
      otelExporter,
      input: "prompt text",
      model: "gpt-4o",
    });

    obs.update({
      output: "response text",
      usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 },
    });
    obs.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[attrs.OBSERVATION_TYPE]).toBe("GENERATION");
    expect(spans[0].attributes[attrs.OBSERVATION_MODEL]).toBe("gpt-4o");
    expect(spans[0].attributes[attrs.OBSERVATION_INPUT]).toBe("prompt text");
    expect(spans[0].attributes[attrs.OBSERVATION_OUTPUT]).toBe("response text");

    const usage = JSON.parse(spans[0].attributes[attrs.OBSERVATION_USAGE_DETAILS] as string);
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(50);
    expect(usage.totalTokens).toBe(60);
  });

  it("allows partial usage", () => {
    const obs = new Observation({
      traceId: "trace-2",
      type: "generation",
      name: "gen",
      otelExporter,
      usage: { totalTokens: 100 },
    });
    obs.end();

    const spans = memoryExporter.getFinishedSpans();
    const usage = JSON.parse(spans[0].attributes[attrs.OBSERVATION_USAGE_DETAILS] as string);
    expect(usage.totalTokens).toBe(100);
    expect(usage.promptTokens).toBeUndefined();
  });
});

describe("Observation - event (auto-ended)", () => {
  it("is emitted immediately when auto-ended", () => {
    const obs = new Observation({
      traceId: "trace-3",
      type: "event",
      name: "user-click",
      otelExporter,
      input: { button: "submit" },
    });
    obs.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes[attrs.OBSERVATION_TYPE]).toBe("EVENT");
    expect(spans[0].name).toBe("user-click");

    const input = JSON.parse(spans[0].attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input).toEqual({ button: "submit" });
  });
});

describe("Observation - nested spans", () => {
  it("creates a child span with correct parentObservationId", () => {
    const parent = new Observation({
      traceId: "trace-4",
      type: "span",
      name: "parent-span",
      otelExporter,
      input: "parent-input",
    });

    const child = parent.span({
      name: "child-span",
      input: "child-input",
    });

    child.update({ output: "child-output" });
    child.end();
    parent.update({ output: "parent-output" });
    parent.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const childSpan = spans[0];
    const parentSpan = spans[1];

    // Both should be span type
    expect(childSpan.attributes[attrs.OBSERVATION_TYPE]).toBe("SPAN");
    expect(parentSpan.attributes[attrs.OBSERVATION_TYPE]).toBe("SPAN");

    expect(childSpan.name).toBe("child-span");
    expect(childSpan.attributes[attrs.OBSERVATION_OUTPUT]).toBe("child-output");
    expect(parentSpan.name).toBe("parent-span");
    expect(parentSpan.attributes[attrs.OBSERVATION_OUTPUT]).toBe("parent-output");
  });

  it("supports multiple levels of nesting", () => {
    const root = new Observation({
      traceId: "trace-5",
      type: "span",
      name: "root",
      otelExporter,
    });

    const mid = root.span({ name: "mid" });
    const leaf = mid.span({ name: "leaf" });

    leaf.end();
    mid.end();
    root.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans).toHaveLength(3);

    const leafSpan = spans[0];
    const midSpan = spans[1];
    const rootSpan = spans[2];

    expect(leafSpan.name).toBe("leaf");
    expect(midSpan.name).toBe("mid");
    expect(rootSpan.name).toBe("root");
  });
});

describe("Observation - update fields", () => {
  it("merges metadata on update", () => {
    const obs = new Observation({
      traceId: "trace-6",
      type: "span",
      name: "meta-test",
      otelExporter,
      metadata: { key1: "val1" },
    });

    obs.update({ metadata: { key2: "val2" } });
    obs.end();

    const spans = memoryExporter.getFinishedSpans();
    const metadata = JSON.parse(spans[0].attributes[attrs.OBSERVATION_METADATA] as string);
    expect(metadata).toEqual({ key1: "val1", key2: "val2" });
  });

  it("supports level and statusMessage", () => {
    const obs = new Observation({
      traceId: "trace-7",
      type: "span",
      name: "error-span",
      otelExporter,
    });

    obs.update({ level: "ERROR", statusMessage: "something went wrong" });
    obs.end();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans[0].attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
    expect(spans[0].attributes[attrs.OBSERVATION_STATUS_MESSAGE]).toBe("something went wrong");
  });
});
