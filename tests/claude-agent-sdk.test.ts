/**
 * Tests for the Claude Agent SDK integration (LightraceAgentHandler).
 *
 * Note: JS TracingMixin creates an extra root trace span (AS_ROOT) separate
 * from observation spans, and does NOT propagate OTel context between spans,
 * so each observation gets its own trace_id. Span counts include the root.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { Lightrace } from "../src/client.js";
import { LightraceAgentHandler } from "../src/integrations/claude-agent-sdk.js";
import * as attrs from "../src/otel-exporter.js";
import { getSpanData, getJsonAttr, findSpanByName, findAllSpansByName } from "./test-helpers.js";

// ── Fake message factories ──────────────────────────────────────────────

function fakeAssistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant" as const,
    model: "claude-sonnet-4-20250514",
    message: {
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "Hello!" }],
      usage: { input_tokens: 100, output_tokens: 50 },
      ...((overrides.message as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "message")),
  };
}

function fakeUserMessage(content: unknown[] = []) {
  return { type: "user" as const, message: { content } };
}

function fakeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "result" as const,
    result: "Done",
    num_turns: 1,
    total_cost_usd: 0.01,
    duration_ms: 1500,
    is_error: false,
    subtype: "success",
    ...overrides,
  };
}

function textBlock(text: string) {
  return { type: "text", text };
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown> = {}) {
  return { type: "tool_use", id, name, input };
}

function toolResultBlock(toolUseId: string, content: string = "result", isError = false) {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
}

// ── Setup ───────────────────────────────────────────────────────────────

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

let lightraceClient: Lightrace;
let memoryExporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  const setup = createTestSetup();
  lightraceClient = setup.client;
  memoryExporter = setup.memoryExporter;
  provider = setup.provider;
});

afterEach(async () => {
  await lightraceClient.shutdown();
  await provider.shutdown();
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Find the root trace span (AS_ROOT="true"). */
function findRoot() {
  return memoryExporter
    .getFinishedSpans()
    .map(getSpanData)
    .find((s) => s.attributes[attrs.AS_ROOT] === "true");
}

/** Find spans with a specific observation type. */
function findByObsType(type: string) {
  return memoryExporter
    .getFinishedSpans()
    .map(getSpanData)
    .filter((s) => s.attributes[attrs.OBSERVATION_TYPE] === type);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("LightraceAgentHandler", () => {
  it("traces single turn text-only conversation", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Hello" });

    handler.handle(fakeAssistantMessage());
    handler.handle(fakeResultMessage());

    // root trace + agent obs + generation obs = 3 spans
    const spans = memoryExporter.getFinishedSpans();
    expect(spans.length).toBe(3);

    const gens = findByObsType("GENERATION");
    expect(gens.length).toBe(1);
    expect(gens[0].name).toBe("claude-sonnet-4-20250514");
  });

  it("traces single turn with tool call", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Search" });

    handler.handle(
      fakeAssistantMessage({
        message: {
          content: [textBlock("Let me search"), toolUseBlock("t1", "web_search", { q: "X" })],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    );
    handler.handle(fakeUserMessage([toolResultBlock("t1", "Found X")]));
    handler.handle(fakeResultMessage());

    // root trace + agent obs + generation + tool = 4
    const spans = memoryExporter.getFinishedSpans();
    expect(spans.length).toBe(4);

    const tools = findByObsType("TOOL");
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("web_search");
  });

  it("traces multi-turn conversation", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Analyze" });

    // Turn 1: tool call
    handler.handle(
      fakeAssistantMessage({
        message: {
          content: [toolUseBlock("t1", "read_file", { path: "a.py" })],
          usage: { input_tokens: 50, output_tokens: 30 },
        },
      }),
    );
    handler.handle(fakeUserMessage([toolResultBlock("t1", "file contents")]));

    // Turn 2: final answer
    handler.handle(fakeAssistantMessage());
    handler.handle(fakeResultMessage({ num_turns: 2 }));

    // root trace + agent obs + gen1 + tool + gen2 = 5
    expect(memoryExporter.getFinishedSpans().length).toBe(5);
    expect(findByObsType("GENERATION").length).toBe(2);
    expect(findByObsType("TOOL").length).toBe(1);
  });

  it("marks tool span as error when tool result has is_error", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Run" });

    handler.handle(
      fakeAssistantMessage({
        message: {
          content: [toolUseBlock("t1", "bash", { cmd: "fail" })],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      }),
    );
    handler.handle(fakeUserMessage([toolResultBlock("t1", "Command failed", true)]));
    handler.handle(fakeResultMessage());

    const tool = findSpanByName(memoryExporter.getFinishedSpans(), "bash");
    expect(tool).toBeDefined();
    expect(tool!.attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
    expect(tool!.attributes[attrs.OBSERVATION_STATUS_MESSAGE]).toContain("Command failed");
  });

  it("marks agent observation as error when result is_error is true", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Do" });

    handler.handle(fakeAssistantMessage());
    handler.handle(
      fakeResultMessage({
        is_error: true,
        subtype: "error_max_turns",
        result: "Max turns exceeded",
      }),
    );

    // The agent observation span (not the root trace span) gets the error level
    const agentObs = findSpanByName(memoryExporter.getFinishedSpans(), "claude-agent");
    expect(agentObs).toBeDefined();
    expect(agentObs!.attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
    expect(agentObs!.attributes[attrs.OBSERVATION_STATUS_MESSAGE]).toContain("Max turns exceeded");
  });

  it("extracts usage from assistant message onto generation span", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Q" });

    handler.handle(
      fakeAssistantMessage({
        message: {
          content: [textBlock("A")],
          usage: { input_tokens: 200, output_tokens: 80 },
        },
      }),
    );
    handler.handle(fakeResultMessage());

    const gens = findByObsType("GENERATION");
    expect(gens.length).toBe(1);
    const usage = getJsonAttr(gens[0], attrs.OBSERVATION_USAGE_DETAILS) as Record<string, number>;
    expect(usage).not.toBeNull();
    expect(usage.promptTokens).toBe(200);
    expect(usage.completionTokens).toBe(80);
    expect(usage.totalTokens).toBe(280);
  });

  it("tracks cost in root span output", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Q" });

    handler.handle(fakeAssistantMessage());
    handler.handle(fakeResultMessage({ total_cost_usd: 0.05 }));

    const root = findRoot();
    expect(root).toBeDefined();
    const output = getJsonAttr(root!, attrs.TRACE_OUTPUT) as Record<string, unknown>;
    expect(output).not.toBeNull();
    expect(output.total_cost_usd).toBe(0.05);
  });

  it("creates a root trace span with AS_ROOT attribute", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Q" });

    handler.handle(fakeAssistantMessage());
    handler.handle(fakeResultMessage());

    const root = findRoot();
    expect(root).toBeDefined();
    expect(root!.attributes[attrs.TRACE_NAME]).toBe("claude-agent");
  });

  it("handles empty content blocks gracefully", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Q" });

    handler.handle(fakeAssistantMessage({ message: { content: [], usage: null } }));
    handler.handle(fakeResultMessage());

    // root trace + agent obs + generation = 3
    expect(memoryExporter.getFinishedSpans().length).toBe(3);
  });

  it("handles undefined content gracefully", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Q" });

    handler.handle({ type: "assistant", message: {} });
    handler.handle(fakeResultMessage());

    expect(memoryExporter.getFinishedSpans().length).toBe(3);
  });

  it("ignores unknown message types", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Q" });

    handler.handle({ type: "system", subtype: "init" });

    expect(memoryExporter.getFinishedSpans().length).toBe(0);
  });

  it("uses custom trace name", () => {
    const handler = new LightraceAgentHandler({
      client: lightraceClient,
      prompt: "Q",
      traceName: "my-agent",
    });

    handler.handle(fakeAssistantMessage());
    handler.handle(fakeResultMessage());

    const root = findRoot();
    expect(root).toBeDefined();
    expect(root!.attributes[attrs.TRACE_NAME]).toBe("my-agent");
  });

  it("sets user_id and session_id on root span", () => {
    const handler = new LightraceAgentHandler({
      client: lightraceClient,
      prompt: "Q",
      userId: "u1",
      sessionId: "s1",
    });

    handler.handle(fakeAssistantMessage());
    handler.handle(fakeResultMessage());

    const root = findRoot();
    expect(root).toBeDefined();
    expect(root!.attributes[attrs.TRACE_USER_ID]).toBe("u1");
    expect(root!.attributes[attrs.TRACE_SESSION_ID]).toBe("s1");
  });

  it("traces multiple tool calls in a single turn", () => {
    const handler = new LightraceAgentHandler({ client: lightraceClient, prompt: "Do both" });

    handler.handle(
      fakeAssistantMessage({
        message: {
          content: [
            toolUseBlock("t1", "search", { q: "a" }),
            toolUseBlock("t2", "read_file", { path: "b.py" }),
          ],
          usage: { input_tokens: 50, output_tokens: 40 },
        },
      }),
    );
    handler.handle(
      fakeUserMessage([toolResultBlock("t1", "result_a"), toolResultBlock("t2", "result_b")]),
    );
    handler.handle(fakeResultMessage());

    const tools = findByObsType("TOOL");
    expect(tools.length).toBe(2);
    const names = new Set(tools.map((s) => s.name));
    expect(names).toEqual(new Set(["search", "read_file"]));
  });
});
