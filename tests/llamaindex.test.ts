import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Lightrace } from "../src/client.js";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import * as attrs from "../src/otel-exporter.js";
import { LightraceLlamaIndexHandler } from "../src/integrations/llamaindex.js";

// ── Helpers ───────────────────────────────────────────────────────────

function createTestSetup() {
  const memoryExporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
  });
  const tracer = provider.getTracer("test");

  const client = new Lightrace({
    publicKey: "pk-test",
    secretKey: "sk-test",
    host: "http://localhost:9999",
    enabled: false,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).otelExporter = {
    tracer,
    flush: () => {},
    shutdown: async () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).enabled = true;

  return { client, memoryExporter, provider };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("LightraceLlamaIndexHandler", () => {
  let lightraceClient: Lightrace;
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let handler: LightraceLlamaIndexHandler;

  beforeEach(() => {
    const setup = createTestSetup();
    lightraceClient = setup.client;
    memoryExporter = setup.memoryExporter;
    provider = setup.provider;
    handler = new LightraceLlamaIndexHandler({ client: lightraceClient });
  });

  afterEach(async () => {
    await lightraceClient.shutdown();
    await provider.shutdown();
  });

  it("creates a trace on startTrace/endTrace", () => {
    handler.startTrace("my-query");
    handler.endTrace();

    const spans = memoryExporter.getFinishedSpans();
    // root span + observation span
    expect(spans.length).toBe(2);

    const rootSpan = spans.find((s) => s.attributes[attrs.AS_ROOT] === "true");
    expect(rootSpan).toBeTruthy();
    expect(rootSpan!.attributes[attrs.TRACE_NAME]).toBe("my-query");
  });

  it("captures LLM events as GENERATION", () => {
    handler.startTrace("llm-trace");

    const eventId = handler.onEventStart(
      "LLM",
      {
        messages: [{ role: "user", content: "Hello" }],
        serialized: { model: "gpt-4o", temperature: 0.7 },
      },
      "evt-1",
    );

    handler.onEventEnd(
      "LLM",
      {
        response: "Hi there!",
      },
      eventId,
    );

    handler.endTrace();

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    expect(genSpan).toBeTruthy();
    expect(genSpan!.attributes[attrs.OBSERVATION_MODEL]).toBe("gpt-4o");
  });

  it("captures retrieve events as SPAN", () => {
    handler.startTrace("retrieve-trace");

    const eventId = handler.onEventStart(
      "retrieve",
      {
        query_str: "What is AI?",
      },
      "evt-ret",
    );

    handler.onEventEnd(
      "retrieve",
      {
        nodes: [
          { text: "AI is...", score: 0.95 },
          { text: "Machine learning...", score: 0.8 },
        ],
      },
      eventId,
    );

    handler.endTrace();

    const spans = memoryExporter.getFinishedSpans();
    const retSpan = spans.find(
      (s) => s.attributes[attrs.OBSERVATION_TYPE] === "SPAN" && s.name === "retrieve",
    );
    expect(retSpan).toBeTruthy();
  });

  it("captures function_call events as TOOL", () => {
    handler.startTrace("tool-trace");

    const eventId = handler.onEventStart(
      "function_call",
      {
        tool: { name: "calculator" },
        function_call_args: { expression: "2+2" },
      },
      "evt-tool",
    );

    handler.onEventEnd(
      "function_call",
      {
        function_call_response: "4",
      },
      eventId,
    );

    handler.endTrace();

    const spans = memoryExporter.getFinishedSpans();
    const toolSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "TOOL");
    expect(toolSpan).toBeTruthy();
  });

  it("handles nested events", () => {
    handler.startTrace("nested-trace");

    const queryId = handler.onEventStart(
      "query",
      {
        query_str: "What is AI?",
      },
      "evt-query",
    );

    const retId = handler.onEventStart(
      "retrieve",
      {
        query_str: "What is AI?",
      },
      "evt-ret",
      queryId,
    );

    handler.onEventEnd("retrieve", { nodes: [] }, retId);

    const llmId = handler.onEventStart(
      "LLM",
      {
        messages: [{ role: "user", content: "What is AI?" }],
      },
      "evt-llm",
      queryId,
    );

    handler.onEventEnd("LLM", { response: "AI is..." }, llmId);
    handler.onEventEnd("query", { response: "AI is..." }, queryId);

    handler.endTrace();

    const spans = memoryExporter.getFinishedSpans();
    // root + query + retrieve + llm = 4 obs spans + 1 root span? Depends on structure
    // At minimum we should have 4+ spans
    expect(spans.length).toBeGreaterThanOrEqual(4);
  });

  it("captures embedding events", () => {
    handler.startTrace("embed-trace");

    const eventId = handler.onEventStart(
      "embedding",
      {
        chunks: ["chunk1", "chunk2"],
      },
      "evt-embed",
    );

    handler.onEventEnd(
      "embedding",
      {
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      },
      eventId,
    );

    handler.endTrace();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });

  it("sets lastTraceId after endTrace", () => {
    handler.startTrace("test");
    handler.endTrace();
    expect(handler.lastTraceId).toBeTruthy();
  });

  it("handles null payload gracefully", () => {
    handler.startTrace("null-trace");

    const eventId = handler.onEventStart("LLM", null, "evt-null");
    handler.onEventEnd("LLM", null, eventId);

    handler.endTrace();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });
});
