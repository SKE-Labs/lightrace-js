import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Lightrace } from "../src/client.js";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import * as attrs from "../src/otel-exporter.js";
import { LightraceOpenAIInstrumentor } from "../src/integrations/openai.js";

// ── Fake OpenAI types ─────────────────────────────────────────────────

function fakeCompletion(overrides: Record<string, unknown> = {}) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: "Hello!",
          tool_calls: null,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 20,
      total_tokens: 70,
    },
    model: "gpt-4o",
    ...overrides,
  };
}

function fakeResponsesResult(overrides: Record<string, unknown> = {}) {
  return {
    output: [{ type: "message", content: [{ type: "text", text: "Hi there!" }] }],
    usage: { input_tokens: 30, output_tokens: 10 },
    model: "gpt-4o",
    ...overrides,
  };
}

function createFakeClient(chatResponse?: unknown, responsesResponse?: unknown) {
  const chatMsg = chatResponse ?? fakeCompletion();
  const respMsg = responsesResponse ?? fakeResponsesResult();
  return {
    chat: {
      completions: {
        create: async (..._args: unknown[]) => chatMsg,
      },
    },
    responses: {
      create: async (..._args: unknown[]) => respMsg,
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

describe("LightraceOpenAIInstrumentor", () => {
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

  // ── Chat Completions ────────────────────────────────────────────

  it("traces a basic chat.completions.create call", async () => {
    const openaiClient = createFakeClient();
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    const result = (await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;

    expect(result.choices[0].message.content).toBe("Hello!");

    const spans = memoryExporter.getFinishedSpans();
    expect(spans.length).toBe(2); // root + observation

    const rootSpan = spans.find((s) => s.attributes[attrs.AS_ROOT] === "true");
    expect(rootSpan).toBeTruthy();
    expect(rootSpan!.attributes[attrs.TRACE_NAME]).toBe("gpt-4o");

    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    expect(obsSpan).toBeTruthy();

    const input = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input.messages).toBeTruthy();
    expect(input.model).toBe("gpt-4o");

    const output = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output.role).toBe("assistant");
    expect(output.content).toBe("Hello!");
    expect(output.finish_reason).toBe("stop");
  });

  it("extracts token usage", async () => {
    const openaiClient = createFakeClient(
      fakeCompletion({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      }),
    );
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Test" }],
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    expect(obsSpan).toBeTruthy();
    const usage = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_USAGE_DETAILS] as string);
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
    expect(usage.totalTokens).toBe(150);
  });

  it("captures tool_calls in output", async () => {
    const openaiClient = createFakeClient(
      fakeCompletion({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"NYC"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Weather?" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    const output = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_OUTPUT] as string);
    expect(output.tool_calls[0].function.name).toBe("get_weather");
    expect(output.finish_reason).toBe("tool_calls");
  });

  it("handles errors gracefully", async () => {
    const openaiClient = createFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (openaiClient.chat.completions as any).create = async () => {
      throw new Error("Rate limited");
    };

    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    await expect(
      openaiClient.chat.completions.create({
        model: "gpt-4o",
        messages: [],
      }),
    ).rejects.toThrow("Rate limited");

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    expect(obsSpan).toBeTruthy();
    expect(obsSpan!.attributes[attrs.OBSERVATION_LEVEL]).toBe("ERROR");
  });

  it("uninstrument restores original behavior", async () => {
    const openaiClient = createFakeClient();
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });

    instrumentor.instrument(openaiClient);
    await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [],
    });
    expect(memoryExporter.getFinishedSpans().length).toBeGreaterThan(0);

    instrumentor.uninstrument(openaiClient);
    memoryExporter.reset();

    await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [],
    });
    expect(memoryExporter.getFinishedSpans().length).toBe(0);
  });

  it("includes tools in input when provided", async () => {
    const openaiClient = createFakeClient();
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "search" } }],
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    const input = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input.tools).toBeTruthy();
  });

  it("captures response_format in input", async () => {
    const openaiClient = createFakeClient();
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      response_format: { type: "json_object" },
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    const input = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input.response_format).toEqual({ type: "json_object" });
  });

  it("sets lastTraceId after completion", async () => {
    const openaiClient = createFakeClient();
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [],
    });

    expect(instrumentor.lastTraceId).toBeTruthy();
  });

  // ── Responses API ───────────────────────────────────────────────

  it("traces a responses.create call", async () => {
    const openaiClient = createFakeClient();
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await openaiClient.responses.create({
      model: "gpt-4o",
      input: "What is 2+2?",
    })) as any;

    expect(result.output).toBeTruthy();

    const spans = memoryExporter.getFinishedSpans();
    expect(spans.length).toBe(2);

    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    expect(obsSpan).toBeTruthy();
    const input = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input.input).toBe("What is 2+2?");
    expect(input.model).toBe("gpt-4o");
  });

  it("extracts Responses API usage (input_tokens/output_tokens)", async () => {
    const openaiClient = createFakeClient(
      undefined,
      fakeResponsesResult({
        usage: { input_tokens: 50, output_tokens: 25 },
      }),
    );
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    await openaiClient.responses.create({
      model: "gpt-4o",
      input: "Test",
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    const usage = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_USAGE_DETAILS] as string);
    expect(usage.promptTokens).toBe(50);
    expect(usage.completionTokens).toBe(25);
    expect(usage.totalTokens).toBe(75);
  });

  it("captures tools and instructions in Responses API input", async () => {
    const openaiClient = createFakeClient();
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });
    instrumentor.instrument(openaiClient);

    await openaiClient.responses.create({
      model: "gpt-4o",
      input: "Weather?",
      tools: [{ type: "function", function: { name: "get_weather" } }],
      instructions: "You are helpful.",
    });

    const spans = memoryExporter.getFinishedSpans();
    const obsSpan = spans.find((s) => s.attributes[attrs.OBSERVATION_TYPE] === "GENERATION");
    const input = JSON.parse(obsSpan!.attributes[attrs.OBSERVATION_INPUT] as string);
    expect(input.tools).toBeTruthy();
    expect(input.instructions).toBe("You are helpful.");
  });

  it("uninstrument restores responses.create", async () => {
    const openaiClient = createFakeClient();
    const instrumentor = new LightraceOpenAIInstrumentor({
      client: lightraceClient,
    });

    instrumentor.instrument(openaiClient);
    await openaiClient.responses.create({ model: "gpt-4o", input: "Hi" });
    expect(memoryExporter.getFinishedSpans().length).toBeGreaterThan(0);

    instrumentor.uninstrument(openaiClient);
    memoryExporter.reset();

    await openaiClient.responses.create({ model: "gpt-4o", input: "Hi" });
    expect(memoryExporter.getFinishedSpans().length).toBe(0);
  });
});
