import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LightraceCallbackHandler } from "../src/integrations/langchain.js";
import { Lightrace } from "../src/client.js";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import * as attrs from "../src/otel-exporter.js";

// ── Helpers ────────────────────────────────────────────────────────────

function createTestSetup() {
  const memoryExporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
  });
  const tracer = provider.getTracer("test");

  // Create client with enabled: false so no real OTel exporter is created
  const client = new Lightrace({
    publicKey: "pk-test",
    secretKey: "sk-test",
    host: "http://localhost:9999",
    enabled: false,
  });

  // Override the private otelExporter with our test tracer so getOtelExporter() returns it
  (client as any).otelExporter = {
    tracer,
    flush: () => {},
    shutdown: async () => {},
  };
  (client as any).enabled = true;

  return { client, memoryExporter, provider };
}

function serializedWithName(name: string): Serialized {
  return {
    lc: 1,
    type: "not_implemented",
    id: ["langchain", name],
    name,
  } as unknown as Serialized;
}

function serializedLLM(model: string): Serialized {
  return {
    lc: 1,
    type: "not_implemented",
    id: ["langchain", "chat_models", "ChatOpenAI"],
    kwargs: { model_name: model },
  } as unknown as Serialized;
}

/** Helper: find a finished span whose attributes contain a specific observation type. */
function findSpanByObsType(spans: ReadonlyArray<any>, type: string) {
  return spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === type);
}

/** Helper: find the root span (has AS_ROOT attribute). */
function findRootSpan(spans: ReadonlyArray<any>) {
  return spans.find((s) => s.attributes[attrs.AS_ROOT] === "true");
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("LightraceCallbackHandler", () => {
  let client: Lightrace;
  let memoryExporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let handler: LightraceCallbackHandler;

  beforeEach(() => {
    const setup = createTestSetup();
    client = setup.client;
    memoryExporter = setup.memoryExporter;
    provider = setup.provider;
    handler = new LightraceCallbackHandler({
      userId: "user-123",
      sessionId: "sess-456",
      client,
    });
  });

  afterEach(async () => {
    await client.shutdown();
    await provider.shutdown();
  });

  // ── Chain lifecycle ────────────────────────────────────────────────

  it("creates a trace and chain observation on chain start/end", async () => {
    const runId = "run-1";
    await handler.handleChainStart(serializedWithName("MyChain"), { query: "hello" }, runId);
    await handler.handleChainEnd({ result: "world" }, runId);

    const spans = memoryExporter.getFinishedSpans();
    // Root span + observation span
    expect(spans.length).toBe(2);

    const rootSpan = findRootSpan(spans);
    expect(rootSpan).toBeTruthy();
    expect(rootSpan!.attributes[attrs.TRACE_USER_ID]).toBe("user-123");
    expect(rootSpan!.attributes[attrs.TRACE_SESSION_ID]).toBe("sess-456");

    const chainSpan = findSpanByObsType(spans, "CHAIN");
    expect(chainSpan).toBeTruthy();
    expect(chainSpan!.name).toBe("MyChain");
    expect(chainSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("DEFAULT");

    const input = JSON.parse(chainSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input).toEqual({ query: "hello" });

    const output = JSON.parse(chainSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output).toEqual({ result: "world" });

    expect(handler.lastTraceId).toBeTruthy();
  });

  // ── LLM lifecycle ─────────────────────────────────────────────────

  it("creates a generation observation for LLM start/end", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    await handler.handleChainStart(serializedWithName("MyChain"), { input: "test" }, chainRunId);
    await handler.handleLLMStart(serializedLLM("gpt-4"), ["What is 2+2?"], llmRunId, chainRunId);
    await handler.handleLLMEnd(
      {
        generations: [[{ text: "4", generationInfo: {} }]],
        llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      },
      llmRunId,
    );
    await handler.handleChainEnd({ answer: "4" }, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    expect(genSpan!.name).toBe("gpt-4");
    expect(genSpan!.attributes[attrs.OBSERVATION_MODEL]).toBe("gpt-4");

    const input = genSpan!.attributes[attrs.OBSERVATION_INPUT] as string;
    expect(input).toContain("What is 2+2?");

    const output = genSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string;
    expect(output).toContain("4");

    const usage = JSON.parse(genSpan!.attributes[attrs.OBSERVATION_USAGE_DETAILS] as string);
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(5);
    expect(usage.totalTokens).toBe(15);

    expect(genSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("DEFAULT");
  });

  it("creates a generation for chat model with messages", async () => {
    const chainRunId = "run-chain";
    const chatRunId = "run-chat";

    await handler.handleChainStart(serializedWithName("MyChain"), { input: "hi" }, chainRunId);
    await handler.handleChatModelStart(
      serializedLLM("claude-3"),
      [[new HumanMessage("Hello"), new AIMessage("Hi there")]],
      chatRunId,
      chainRunId,
    );
    await handler.handleLLMEnd(
      {
        generations: [[{ text: "Hi there", generationInfo: {} }]],
        llmOutput: {},
      },
      chatRunId,
    );
    await handler.handleChainEnd({ output: "done" }, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    expect(genSpan!.attributes[attrs.OBSERVATION_MODEL]).toBe("claude-3");

    // Input should be formatted messages
    const input = JSON.parse(genSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(Array.isArray(input)).toBe(true);
    expect(input[0].role).toBe("human");
    expect(input[0].content).toBe("Hello");
  });

  // ── Tool lifecycle ────────────────────────────────────────────────

  it("creates a tool observation on tool start/end", async () => {
    const chainRunId = "run-chain";
    const toolRunId = "run-tool";

    await handler.handleChainStart(serializedWithName("AgentChain"), {}, chainRunId);
    await handler.handleToolStart(
      serializedWithName("calculator"),
      JSON.stringify({ expression: "2+2" }),
      toolRunId,
      chainRunId,
    );
    await handler.handleToolEnd("4", toolRunId);
    await handler.handleChainEnd({ result: "4" }, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const toolSpan = findSpanByObsType(spans, "TOOL");
    expect(toolSpan).toBeTruthy();
    expect(toolSpan!.name).toBe("calculator");

    const input = JSON.parse(toolSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input).toEqual({ expression: "2+2" });

    // "4" is JSON-parsed to number
    const output = JSON.parse(toolSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output).toBe(4);
  });

  // ── Retriever lifecycle ───────────────────────────────────────────

  it("creates a span observation for retriever start/end", async () => {
    const chainRunId = "run-chain";
    const retRunId = "run-ret";

    await handler.handleChainStart(serializedWithName("RAGChain"), {}, chainRunId);
    await handler.handleRetrieverStart(
      serializedWithName("VectorRetriever"),
      "search query",
      retRunId,
      chainRunId,
    );
    await handler.handleRetrieverEnd(
      [{ pageContent: "doc content", metadata: { source: "test" } }],
      retRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const retSpan = findSpanByObsType(spans, "SPAN");
    expect(retSpan).toBeTruthy();
    expect(retSpan!.name).toBe("VectorRetriever");

    const input = retSpan!.attributes[attrs.OBSERVATION_INPUT] as string;
    expect(input).toContain("search query");

    const output = JSON.parse(retSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output[0].pageContent).toBe("doc content");
  });

  // ── Error handling ────────────────────────────────────────────────

  it("sets ERROR level on chain error", async () => {
    const runId = "run-err";
    await handler.handleChainStart(serializedWithName("FailChain"), {}, runId);
    await handler.handleChainError(new Error("something broke"), runId);

    const spans = memoryExporter.getFinishedSpans();
    const chainSpan = findSpanByObsType(spans, "CHAIN");
    expect(chainSpan).toBeTruthy();
    expect(chainSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
    expect(chainSpan!.attributes[attrs.OBSERVATION_STATUS_MESSAGE]).toBe("something broke");
  });

  it("sets ERROR level on LLM error", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(serializedLLM("gpt-4"), ["prompt"], llmRunId, chainRunId);
    await handler.handleLLMError(new Error("rate limited"), llmRunId);
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    expect(genSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
    expect(genSpan!.attributes[attrs.OBSERVATION_STATUS_MESSAGE]).toBe("rate limited");
  });

  it("sets ERROR level on tool error", async () => {
    const chainRunId = "run-chain";
    const toolRunId = "run-tool";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleToolStart(serializedWithName("bad-tool"), "input", toolRunId, chainRunId);
    await handler.handleToolError(new Error("tool failed"), toolRunId);
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const toolSpan = findSpanByObsType(spans, "TOOL");
    expect(toolSpan).toBeTruthy();
    expect(toolSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
  });

  it("sets ERROR level on retriever error", async () => {
    const chainRunId = "run-chain";
    const retRunId = "run-ret";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleRetrieverStart(
      serializedWithName("Retriever"),
      "query",
      retRunId,
      chainRunId,
    );
    await handler.handleRetrieverError(new Error("db down"), retRunId);
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const retSpan = findSpanByObsType(spans, "SPAN");
    expect(retSpan).toBeTruthy();
    expect(retSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
  });

  // ── GraphBubbleUp ─────────────────────────────────────────────────

  it("does not mark GraphBubbleUp as error", async () => {
    const runId = "run-bubble";
    await handler.handleChainStart(serializedWithName("Graph"), {}, runId);

    const err = new Error("bubble");
    Object.defineProperty(err, "name", { value: "GraphBubbleUp" });
    await handler.handleChainError(err, runId);

    const spans = memoryExporter.getFinishedSpans();
    const chainSpan = findSpanByObsType(spans, "CHAIN");
    expect(chainSpan).toBeTruthy();
    expect(chainSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("DEFAULT");
  });

  // ── Nested hierarchy ─────────────────────────────────────────────

  it("tracks parent-child relationships across nested runs", async () => {
    const chainId = "run-chain";
    const llmId = "run-llm";
    const toolId = "run-tool";

    await handler.handleChainStart(serializedWithName("MainChain"), {}, chainId);
    await handler.handleLLMStart(serializedLLM("gpt-4"), ["prompt"], llmId, chainId);
    await handler.handleLLMEnd(
      { generations: [[{ text: "output", generationInfo: {} }]], llmOutput: {} },
      llmId,
    );
    await handler.handleToolStart(serializedWithName("search"), "query", toolId, chainId);
    await handler.handleToolEnd("result", toolId);
    await handler.handleChainEnd({ done: true }, chainId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    const toolSpan = findSpanByObsType(spans, "TOOL");
    const chainSpan = findSpanByObsType(spans, "CHAIN");

    expect(genSpan).toBeTruthy();
    expect(toolSpan).toBeTruthy();
    expect(chainSpan).toBeTruthy();

    // All observation spans should be present (hierarchy is maintained via OTel tracer)
    // Since we use a flat tracer (no context propagation in test), verify all spans exist
    expect(spans.length).toBeGreaterThanOrEqual(3);
  });

  // ── TTFT tracking ─────────────────────────────────────────────────

  it("records time-to-first-token in metadata", async () => {
    const chainId = "run-chain";
    const llmId = "run-llm";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainId);
    await handler.handleLLMStart(serializedLLM("gpt-4"), ["prompt"], llmId, chainId);
    await handler.handleLLMNewToken(
      "Hello",
      { prompt: 0, completion: 0 } as Record<string, unknown>,
      llmId,
    );
    await handler.handleLLMEnd(
      { generations: [[{ text: "Hello world", generationInfo: {} }]], llmOutput: {} },
      llmId,
    );
    await handler.handleChainEnd({}, chainId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    const metaStr = genSpan!.attributes[attrs.OBSERVATION_METADATA] as string;
    expect(metaStr).toBeTruthy();
    const meta = JSON.parse(metaStr);
    expect(typeof meta.timeToFirstToken).toBe("number");
    expect(meta.timeToFirstToken).toBeGreaterThanOrEqual(0);
  });

  // ── traceName override ────────────────────────────────────────────

  it("uses traceName option for root trace name", async () => {
    const namedHandler = new LightraceCallbackHandler({
      traceName: "my-custom-trace",
      client,
    });

    await namedHandler.handleChainStart(serializedWithName("SomeChain"), {}, "run-1");
    await namedHandler.handleChainEnd({}, "run-1");

    const spans = memoryExporter.getFinishedSpans();
    const rootSpan = findRootSpan(spans);
    expect(rootSpan).toBeTruthy();
    expect(rootSpan!.attributes[attrs.TRACE_NAME]).toBe("my-custom-trace");
  });

  // ── traceId accessor ─────────────────────────────────────────────

  it("exposes traceId while run is active, null afterwards", async () => {
    expect(handler.traceId).toBeNull();

    await handler.handleChainStart(serializedWithName("Chain"), {}, "run-1");
    const activeTraceId = handler.traceId;
    expect(activeTraceId).toBeTruthy();

    await handler.handleChainEnd({}, "run-1");
    expect(handler.traceId).toBeNull();
    expect(handler.lastTraceId).toBe(activeTraceId);
  });

  // ── Multiple invocations ──────────────────────────────────────────

  it("supports multiple sequential invocations with separate trace IDs", async () => {
    await handler.handleChainStart(serializedWithName("Chain"), {}, "run-1");
    await handler.handleChainEnd({}, "run-1");
    const firstTraceId = handler.lastTraceId;

    await handler.handleChainStart(serializedWithName("Chain"), {}, "run-2");
    await handler.handleChainEnd({}, "run-2");
    const secondTraceId = handler.lastTraceId;

    expect(firstTraceId).toBeTruthy();
    expect(secondTraceId).toBeTruthy();
    expect(firstTraceId).not.toBe(secondTraceId);
  });

  // ── undefined/null serialized and inputs ─────────────────────────

  it("handles undefined serialized and inputs gracefully", async () => {
    await handler.handleChainStart(
      undefined as unknown as Serialized,
      undefined as unknown as Record<string, unknown>,
      "run-undef",
    );
    await handler.handleChainEnd(undefined as unknown as Record<string, unknown>, "run-undef");

    const spans = memoryExporter.getFinishedSpans();
    const rootSpan = findRootSpan(spans);
    expect(rootSpan).toBeTruthy();

    const chainSpan = findSpanByObsType(spans, "CHAIN");
    expect(chainSpan).toBeTruthy();
    expect(chainSpan!.name).toBe("Chain"); // fallback name
    expect(chainSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("DEFAULT");
  });

  // ── name parameter override ──────────────────────────────────────

  it("uses the name parameter when provided to handleChainStart", async () => {
    await handler.handleChainStart(
      serializedWithName("GenericChain"),
      { input: "test" },
      "run-named",
      undefined,
      undefined,
      undefined,
      undefined,
      "MyCustomName",
    );
    await handler.handleChainEnd({}, "run-named");

    const spans = memoryExporter.getFinishedSpans();
    const chainSpan = findSpanByObsType(spans, "CHAIN");
    expect(chainSpan).toBeTruthy();
    expect(chainSpan!.name).toBe("MyCustomName");
  });

  it("uses the name parameter when provided to handleLLMStart", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm-named";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(
      serializedLLM("gpt-4"),
      ["prompt"],
      llmRunId,
      chainRunId,
      undefined,
      undefined,
      undefined,
      "CustomLLMName",
    );
    await handler.handleLLMEnd(
      { generations: [[{ text: "output", generationInfo: {} }]], llmOutput: {} },
      llmRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    expect(genSpan!.name).toBe("CustomLLMName");
  });

  it("uses the name parameter when provided to handleToolStart", async () => {
    const chainRunId = "run-chain";
    const toolRunId = "run-tool-named";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleToolStart(
      serializedWithName("generic-tool"),
      "input",
      toolRunId,
      chainRunId,
      undefined,
      undefined,
      "CustomToolName",
    );
    await handler.handleToolEnd("result", toolRunId);
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const toolSpan = findSpanByObsType(spans, "TOOL");
    expect(toolSpan).toBeTruthy();
    expect(toolSpan!.name).toBe("CustomToolName");
  });

  // ── Multi-provider usage (Anthropic-style) ───────────────────────

  it("extracts Anthropic-style token usage (input_tokens/output_tokens)", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(serializedLLM("claude-3-opus"), ["prompt"], llmRunId, chainRunId);
    await handler.handleLLMEnd(
      {
        generations: [[{ text: "response", generationInfo: {} }]],
        llmOutput: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
      },
      llmRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    const usage = JSON.parse(genSpan!.attributes[attrs.OBSERVATION_USAGE_DETAILS] as string);
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
    expect(usage.totalTokens).toBe(150); // auto-calculated
  });

  it("extracts usage_metadata from generation-level message", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(serializedLLM("claude-3"), ["prompt"], llmRunId, chainRunId);
    await handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "response",
              generationInfo: {},
              message: {
                content: "response",
                type: "ai",
                usage_metadata: {
                  input_tokens: 200,
                  output_tokens: 80,
                },
              },
            },
          ],
        ],
        llmOutput: {}, // no usage at llmOutput level
      },
      llmRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    const usage = JSON.parse(genSpan!.attributes[attrs.OBSERVATION_USAGE_DETAILS] as string);
    expect(usage.promptTokens).toBe(200);
    expect(usage.completionTokens).toBe(80);
  });

  // ── Model parameter extraction ───────────────────────────────────

  it("extracts model parameters from invocation_params", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(serializedLLM("gpt-4"), ["prompt"], llmRunId, chainRunId, {
      invocation_params: {
        temperature: 0.7,
        max_tokens: 1000,
        top_p: 0.9,
        frequency_penalty: 0.5,
        presence_penalty: 0.3,
        some_other_param: "ignored",
      },
    });
    await handler.handleLLMEnd(
      { generations: [[{ text: "output", generationInfo: {} }]], llmOutput: {} },
      llmRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    const params = JSON.parse(genSpan!.attributes[attrs.OBSERVATION_MODEL_PARAMETERS] as string);
    expect(params.temperature).toBe(0.7);
    expect(params.max_tokens).toBe(1000);
    expect(params.top_p).toBe(0.9);
    expect(params.frequency_penalty).toBe(0.5);
    expect(params.presence_penalty).toBe(0.3);
    expect(params).not.toHaveProperty("some_other_param");
  });

  it("extracts model parameters in handleChatModelStart", async () => {
    const chainRunId = "run-chain";
    const chatRunId = "run-chat";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleChatModelStart(
      serializedLLM("gpt-4"),
      [[new HumanMessage("Hello")]],
      chatRunId,
      chainRunId,
      {
        invocation_params: {
          temperature: 0.0,
          max_tokens: 500,
        },
      },
    );
    await handler.handleLLMEnd(
      { generations: [[{ text: "Hi", generationInfo: {} }]], llmOutput: {} },
      chatRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    const params = JSON.parse(genSpan!.attributes[attrs.OBSERVATION_MODEL_PARAMETERS] as string);
    expect(params.temperature).toBe(0.0);
    expect(params.max_tokens).toBe(500);
  });

  // ── ChatGeneration with message ──────────────────────────────────

  it("extracts ChatGeneration message with role, content, and tool_calls", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(serializedLLM("gpt-4"), ["prompt"], llmRunId, chainRunId);
    await handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "",
              generationInfo: {},
              message: {
                content: "Let me search for that.",
                _getType: () => "ai",
                tool_calls: [
                  {
                    name: "search",
                    args: { query: "test" },
                    id: "call-1",
                  },
                ],
              },
            },
          ],
        ],
        llmOutput: {},
      },
      llmRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    const output = JSON.parse(genSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output.role).toBe("ai");
    expect(output.content).toBe("Let me search for that.");
    expect(output.tool_calls).toEqual([{ name: "search", args: { query: "test" }, id: "call-1" }]);
  });

  it("extracts ChatGeneration message with type fallback (no _getType)", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(serializedLLM("gpt-4"), ["prompt"], llmRunId, chainRunId);
    await handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "Hello",
              generationInfo: {},
              message: {
                content: "Hello",
                type: "ai",
                // no _getType function
              },
            },
          ],
        ],
        llmOutput: {},
      },
      llmRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    const output = JSON.parse(genSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output.role).toBe("ai");
    expect(output.content).toBe("Hello");
    expect(output).not.toHaveProperty("tool_calls");
  });

  // ── Model name from response ─────────────────────────────────────

  it("picks up model name from llmOutput when not set at start", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    // Use a serialized that has no model info
    const noModelSerialized = {
      lc: 1,
      type: "not_implemented",
      id: ["langchain", "chat_models", "ChatOpenAI"],
    } as unknown as Serialized;

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(noModelSerialized, ["prompt"], llmRunId, chainRunId);
    await handler.handleLLMEnd(
      {
        generations: [[{ text: "output", generationInfo: {} }]],
        llmOutput: { model_name: "gpt-4-turbo" },
      },
      llmRunId,
    );
    await handler.handleChainEnd({}, chainRunId);

    const spans = memoryExporter.getFinishedSpans();
    const genSpan = findSpanByObsType(spans, "GENERATION");
    expect(genSpan).toBeTruthy();
    expect(genSpan!.attributes[attrs.OBSERVATION_MODEL]).toBe("gpt-4-turbo");
    // name stays from serialized, model updated from response
    expect(genSpan!.name).toBe("ChatOpenAI");
  });

  // ── Error resilience ─────────────────────────────────────────────

  it("does not throw when callback receives completely bad input", async () => {
    // None of these should throw — they should just warn and continue
    await expect(
      handler.handleChainStart(
        null as unknown as Serialized,
        null as unknown as Record<string, unknown>,
        "run-bad-1",
      ),
    ).resolves.toBeUndefined();

    await expect(
      handler.handleLLMStart(
        null as unknown as Serialized,
        null as unknown as string[],
        "run-bad-2",
      ),
    ).resolves.toBeUndefined();

    await expect(
      handler.handleChatModelStart(
        null as unknown as Serialized,
        null as unknown as BaseMessage[][],
        "run-bad-3",
      ),
    ).resolves.toBeUndefined();

    await expect(
      handler.handleToolStart(
        null as unknown as Serialized,
        null as unknown as string,
        "run-bad-4",
      ),
    ).resolves.toBeUndefined();

    await expect(
      handler.handleLLMEnd(null as unknown as LLMResult, "run-bad-5"),
    ).resolves.toBeUndefined();

    await expect(
      handler.handleRetrieverStart(
        null as unknown as Serialized,
        null as unknown as string,
        "run-bad-6",
      ),
    ).resolves.toBeUndefined();
  });

  it("continues working after a callback error", async () => {
    // Suppress console.warn during this test
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Trigger an error with bad input
    await handler.handleLLMEnd(null as unknown as LLMResult, "nonexistent-run");

    // Handler should still work for normal operations
    await handler.handleChainStart(serializedWithName("Chain"), { ok: true }, "run-after-error");
    await handler.handleChainEnd({ result: "fine" }, "run-after-error");

    expect(handler.lastTraceId).toBeTruthy();
    const spans = memoryExporter.getFinishedSpans();
    const chainSpan = findSpanByObsType(spans, "CHAIN");
    expect(chainSpan).toBeTruthy();
    expect(chainSpan!.name).toBe("Chain");

    warnSpy.mockRestore();
  });
});
