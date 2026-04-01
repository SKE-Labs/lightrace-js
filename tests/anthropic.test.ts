import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Lightrace } from "../src/client.js";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import * as attrs from "../src/otel-exporter.js";
import { LightraceAnthropicInstrumentor } from "../src/integrations/anthropic.js";

// ── Fake Anthropic types ──────────────────────────────────────────────

function fakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    usage: { input_tokens: 100, output_tokens: 50 },
    stop_reason: "end_turn",
    model: "claude-sonnet-4-20250514",
    ...overrides,
  };
}

function createFakeClient(response?: unknown) {
  const msg = response ?? fakeMessage();
  return {
    messages: {
      create: async (..._args: unknown[]) => msg,
    },
  };
}

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

describe("LightraceAnthropicInstrumentor", () => {
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

  it("traces a basic messages.create call", async () => {
    const anthropicClient = createFakeClient();
    const instrumentor = new LightraceAnthropicInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(anthropicClient);

    const result = await anthropicClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.role).toBe("assistant");

    const spans = memoryExporter.getFinishedSpans();
    // Root span + observation span
    expect(spans.length).toBe(2);

    const rootSpan = spans.find((s) => s.attributes[attrs.AS_ROOT] === "true");
    expect(rootSpan).toBeTruthy();
    expect(rootSpan!.attributes[attrs.TRACE_NAME]).toBe("claude-sonnet-4-20250514");

    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    expect(obsSpan).toBeTruthy();
    expect(obsSpan!.attributes[attrs.OBSERVATION_MODEL]).toBe("claude-sonnet-4-20250514");

    const input = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input.messages).toBeTruthy();
    expect(input.model).toBe("claude-sonnet-4-20250514");

    const output = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output.role).toBe("assistant");
    expect(output.content[0].text).toBe("Hello!");
  });

  it("extracts token usage", async () => {
    const anthropicClient = createFakeClient(
      fakeMessage({ usage: { input_tokens: 200, output_tokens: 80 } }),
    );
    const instrumentor = new LightraceAnthropicInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(anthropicClient);

    await anthropicClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Test" }],
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    expect(obsSpan).toBeTruthy();
    const usage = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_USAGE_DETAILS] as string);
    expect(usage.promptTokens).toBe(200);
    expect(usage.completionTokens).toBe(80);
    expect(usage.totalTokens).toBe(280);
  });

  it("captures tool_use content blocks", async () => {
    const anthropicClient = createFakeClient(
      fakeMessage({
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "get_weather",
            input: { city: "NYC" },
          },
        ],
        stop_reason: "tool_use",
      }),
    );
    const instrumentor = new LightraceAnthropicInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(anthropicClient);

    await anthropicClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ name: "get_weather" }],
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    const output = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output.stop_reason).toBe("tool_use");
    expect(output.content[1].type).toBe("tool_use");
    expect(output.content[1].name).toBe("get_weather");
  });

  it("handles errors gracefully", async () => {
    const anthropicClient = createFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (anthropicClient.messages as any).create = async () => {
      throw new Error("API error");
    };

    const instrumentor = new LightraceAnthropicInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(anthropicClient);

    await expect(
      anthropicClient.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [],
      }),
    ).rejects.toThrow("API error");

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    expect(obsSpan).toBeTruthy();
    expect(obsSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
    expect(obsSpan!.attributes[attrs.OBSERVATION_STATUS_MESSAGE]).toBe("API error");
  });

  it("uninstrument restores original behavior", async () => {
    const anthropicClient = createFakeClient();
    const instrumentor = new LightraceAnthropicInstrumentor({
      client: lightraceClient,
    });

    instrumentor.instrument(anthropicClient);
    await anthropicClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [],
    });
    const spansBeforeUninstrument = memoryExporter.getFinishedSpans().length;
    expect(spansBeforeUninstrument).toBeGreaterThan(0);

    instrumentor.uninstrument(anthropicClient);
    memoryExporter.reset();

    await anthropicClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [],
    });
    expect(memoryExporter.getFinishedSpans().length).toBe(0);
  });

  it("captures system message in input", async () => {
    const anthropicClient = createFakeClient();
    const instrumentor = new LightraceAnthropicInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(anthropicClient);

    await anthropicClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hi" }],
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    const input = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input.system).toBe("You are helpful.");
  });

  it("sets lastTraceId after completion", async () => {
    const anthropicClient = createFakeClient();
    const instrumentor = new LightraceAnthropicInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(anthropicClient);

    await anthropicClient.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [],
    });

    expect(instrumentor.lastTraceId).toBeTruthy();
  });
});
