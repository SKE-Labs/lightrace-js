import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LightraceCallbackHandler } from "../src/integrations/langchain.js";
import { Lightrace } from "../src/client.js";
import type { TraceEvent } from "../src/types.js";
import type { Serialized } from "@langchain/core/load/serializable";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

// ── Helpers ────────────────────────────────────────────────────────────

/** Collect all enqueued events from the exporter. */
function createTestClient(): { client: Lightrace; events: TraceEvent[] } {
  const client = new Lightrace({
    publicKey: "pk-test",
    secretKey: "sk-test",
    host: "http://localhost:9999",
    enabled: true,
    flushInterval: 999, // large so timer doesn't fire
  });
  const events: TraceEvent[] = [];
  const exporter = client.getExporter()!;
  const origEnqueue = exporter.enqueue.bind(exporter);
  exporter.enqueue = (event: TraceEvent) => {
    events.push(event);
    // Don't actually send
  };
  // Suppress the timer from doing real flushes
  void origEnqueue;
  return { client, events };
}

function serializedWithName(name: string): Serialized {
  return { lc: 1, type: "not_implemented", id: ["langchain", name], name } as unknown as Serialized;
}

function serializedLLM(model: string): Serialized {
  return {
    lc: 1,
    type: "not_implemented",
    id: ["langchain", "chat_models", "ChatOpenAI"],
    kwargs: { model_name: model },
  } as unknown as Serialized;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("LightraceCallbackHandler", () => {
  let client: Lightrace;
  let events: TraceEvent[];
  let handler: LightraceCallbackHandler;

  beforeEach(() => {
    const setup = createTestClient();
    client = setup.client;
    events = setup.events;
    handler = new LightraceCallbackHandler({
      userId: "user-123",
      sessionId: "sess-456",
      client,
    });
  });

  afterEach(async () => {
    await client.shutdown();
  });

  // ── Chain lifecycle ────────────────────────────────────────────────

  it("creates a trace and chain observation on chain start/end", async () => {
    const runId = "run-1";
    await handler.handleChainStart(serializedWithName("MyChain"), { query: "hello" }, runId);

    // Should have emitted a trace-create event
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("trace-create");
    expect(events[0].body.userId).toBe("user-123");
    expect(events[0].body.sessionId).toBe("sess-456");

    await handler.handleChainEnd({ result: "world" }, runId);

    // Should have chain observation + trace update
    expect(events.length).toBe(3);
    const chainObs = events[1];
    expect(chainObs.type).toBe("chain-create");
    expect(chainObs.body.name).toBe("MyChain");
    expect(chainObs.body.input).toEqual({ query: "hello" });
    expect(chainObs.body.output).toEqual({ result: "world" });
    expect(chainObs.body.level).toBe("DEFAULT");

    // Trace should be set
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

    // Find the generation event
    const genEvent = events.find((e) => e.type === "generation-create");
    expect(genEvent).toBeTruthy();
    expect(genEvent!.body.name).toBe("gpt-4");
    expect(genEvent!.body.model).toBe("gpt-4");
    expect(genEvent!.body.input).toBe("What is 2+2?");
    expect(genEvent!.body.output).toBe("4");
    expect(genEvent!.body.promptTokens).toBe(10);
    expect(genEvent!.body.completionTokens).toBe(5);
    expect(genEvent!.body.totalTokens).toBe(15);
    expect(genEvent!.body.level).toBe("DEFAULT");
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

    const genEvent = events.find((e) => e.type === "generation-create");
    expect(genEvent).toBeTruthy();
    expect(genEvent!.body.model).toBe("claude-3");
    // Input should be formatted messages
    const input = genEvent!.body.input as Array<{ role: string; content: string }>;
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

    const toolEvent = events.find((e) => e.type === "tool-create");
    expect(toolEvent).toBeTruthy();
    expect(toolEvent!.body.name).toBe("calculator");
    expect(toolEvent!.body.input).toEqual({ expression: "2+2" });
    expect(toolEvent!.body.output).toBe(4); // "4" is JSON-parsed to number
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

    const retEvent = events.find((e) => e.type === "span-create");
    expect(retEvent).toBeTruthy();
    expect(retEvent!.body.name).toBe("VectorRetriever");
    expect(retEvent!.body.input).toBe("search query");
    const output = retEvent!.body.output as Array<{ pageContent: string }>;
    expect(output[0].pageContent).toBe("doc content");
  });

  // ── Error handling ────────────────────────────────────────────────

  it("sets ERROR level on chain error", async () => {
    const runId = "run-err";
    await handler.handleChainStart(serializedWithName("FailChain"), {}, runId);
    await handler.handleChainError(new Error("something broke"), runId);

    const chainEvent = events.find((e) => e.type === "chain-create");
    expect(chainEvent).toBeTruthy();
    expect(chainEvent!.body.level).toBe("ERROR");
    expect(chainEvent!.body.statusMessage).toBe("something broke");
  });

  it("sets ERROR level on LLM error", async () => {
    const chainRunId = "run-chain";
    const llmRunId = "run-llm";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleLLMStart(serializedLLM("gpt-4"), ["prompt"], llmRunId, chainRunId);
    await handler.handleLLMError(new Error("rate limited"), llmRunId);
    await handler.handleChainEnd({}, chainRunId);

    const genEvent = events.find((e) => e.type === "generation-create");
    expect(genEvent).toBeTruthy();
    expect(genEvent!.body.level).toBe("ERROR");
    expect(genEvent!.body.statusMessage).toBe("rate limited");
  });

  it("sets ERROR level on tool error", async () => {
    const chainRunId = "run-chain";
    const toolRunId = "run-tool";

    await handler.handleChainStart(serializedWithName("Chain"), {}, chainRunId);
    await handler.handleToolStart(serializedWithName("bad-tool"), "input", toolRunId, chainRunId);
    await handler.handleToolError(new Error("tool failed"), toolRunId);
    await handler.handleChainEnd({}, chainRunId);

    const toolEvent = events.find((e) => e.type === "tool-create");
    expect(toolEvent).toBeTruthy();
    expect(toolEvent!.body.level).toBe("ERROR");
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

    const retEvent = events.find((e) => e.type === "span-create");
    expect(retEvent).toBeTruthy();
    expect(retEvent!.body.level).toBe("ERROR");
  });

  // ── GraphBubbleUp ─────────────────────────────────────────────────

  it("does not mark GraphBubbleUp as error", async () => {
    const runId = "run-bubble";
    await handler.handleChainStart(serializedWithName("Graph"), {}, runId);

    const err = new Error("bubble");
    Object.defineProperty(err, "name", { value: "GraphBubbleUp" });
    await handler.handleChainError(err, runId);

    const chainEvent = events.find((e) => e.type === "chain-create");
    expect(chainEvent).toBeTruthy();
    expect(chainEvent!.body.level).toBe("DEFAULT");
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

    // Both LLM and tool should have the chain's observation ID as parent
    const genEvent = events.find((e) => e.type === "generation-create");
    const toolEvent = events.find((e) => e.type === "tool-create");
    const chainEvent = events.find((e) => e.type === "chain-create");

    expect(genEvent).toBeTruthy();
    expect(toolEvent).toBeTruthy();
    expect(chainEvent).toBeTruthy();

    // They should all share the same traceId
    expect(genEvent!.body.traceId).toBe(chainEvent!.body.traceId);
    expect(toolEvent!.body.traceId).toBe(chainEvent!.body.traceId);

    // LLM and tool should have chain as parent
    expect(genEvent!.body.parentObservationId).toBe(chainEvent!.body.id);
    expect(toolEvent!.body.parentObservationId).toBe(chainEvent!.body.id);
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

    const genEvent = events.find((e) => e.type === "generation-create");
    expect(genEvent).toBeTruthy();
    const meta = genEvent!.body.metadata as Record<string, unknown>;
    expect(meta).toBeTruthy();
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

    const traceCreate = events.find((e) => e.type === "trace-create");
    expect(traceCreate).toBeTruthy();
    expect(traceCreate!.body.name).toBe("my-custom-trace");
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
});
