/**
 * OpenAI SDK integration for Lightrace.
 *
 * Wraps `chat.completions.create` and `responses.create` on OpenAI client
 * instances to automatically capture traces via OpenTelemetry spans.
 *
 * @example
 * ```ts
 * import { LightraceOpenAIInstrumentor } from "lightrace/integrations/openai";
 *
 * const instrumentor = new LightraceOpenAIInstrumentor();
 * instrumentor.instrument(client);
 *
 * const response = await client.chat.completions.create({ ... });
 * console.log(instrumentor.lastTraceId);
 * ```
 */
import { generateId, jsonSerializable } from "../utils.js";
import { TracingMixin, type TracingMixinOptions } from "./_base.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export class LightraceOpenAIInstrumentor extends TracingMixin {
  private patchedTargets = new Map<
    unknown,
    {
      completions?: unknown;
      originalChatCreate?: AnyFn;
      responses?: unknown;
      originalResponsesCreate?: AnyFn;
    }
  >();

  constructor(opts?: TracingMixinOptions) {
    super(opts);
  }

  /**
   * Patch an OpenAI client instance so that `chat.completions.create` and
   * `responses.create` calls are automatically traced.
   */
  instrument(client: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    if (this.patchedTargets.has(client)) return;

    const entry: {
      completions?: unknown;
      originalChatCreate?: AnyFn;
      responses?: unknown;
      originalResponsesCreate?: AnyFn;
    } = {};

    // Patch chat.completions.create
    const completions = c?.chat?.completions;
    if (completions?.create) {
      const originalChatCreate = completions.create.bind(completions);
      entry.completions = completions;
      entry.originalChatCreate = originalChatCreate;

      completions.create = async (...args: unknown[]) => {
        const kwargs =
          args.length === 1 && typeof args[0] === "object" && args[0] !== null
            ? (args[0] as Record<string, unknown>)
            : {};

        const { runId, stream } = this.startChatTrace(kwargs);

        try {
          const result = await originalChatCreate(...args);

          if (!stream) {
            const output = extractChatOutput(result);
            const usage = extractUsage(result);
            this.endRun(runId, output, "DEFAULT", null, usage ?? undefined);
          } else {
            this.endRun(runId, { streaming: true });
          }

          return result;
        } catch (err) {
          this.endRun(runId, null, "ERROR", err instanceof Error ? err.message : String(err));
          throw err;
        }
      };
    }

    // Patch responses.create (Responses API)
    const responses = c?.responses;
    if (responses?.create) {
      const originalResponsesCreate = responses.create.bind(responses);
      entry.responses = responses;
      entry.originalResponsesCreate = originalResponsesCreate;

      responses.create = async (...args: unknown[]) => {
        const kwargs =
          args.length === 1 && typeof args[0] === "object" && args[0] !== null
            ? (args[0] as Record<string, unknown>)
            : {};

        const { runId, stream } = this.startResponsesTrace(kwargs);

        try {
          const result = await originalResponsesCreate(...args);

          if (!stream) {
            const output = extractResponsesOutput(result);
            const usage = extractUsage(result);
            this.endRun(runId, output, "DEFAULT", null, usage ?? undefined);
          } else {
            this.endRun(runId, { streaming: true });
          }

          return result;
        } catch (err) {
          this.endRun(runId, null, "ERROR", err instanceof Error ? err.message : String(err));
          throw err;
        }
      };
    }

    if (!entry.completions && !entry.responses) return;

    this.patchedTargets.set(client, entry);
  }

  /** Restore the original methods. */
  uninstrument(client: unknown): void {
    const entry = this.patchedTargets.get(client);
    if (!entry) return;
    if (entry.completions && entry.originalChatCreate) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entry.completions as any).create = entry.originalChatCreate;
    }
    if (entry.responses && entry.originalResponsesCreate) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entry.responses as any).create = entry.originalResponsesCreate;
    }
    this.patchedTargets.delete(client);
  }

  /** Start a trace for a chat completions call. */
  private startChatTrace(kwargs: Record<string, unknown>): {
    runId: string;
    stream: boolean;
  } {
    const runId = generateId();
    const model = kwargs.model as string | undefined;
    const stream = Boolean(kwargs.stream);

    const inputData: Record<string, unknown> = {
      messages: jsonSerializable(kwargs.messages ?? []),
    };
    if (model) inputData.model = model;
    if (kwargs.tools) inputData.tools = jsonSerializable(kwargs.tools);
    if (kwargs.tool_choice) inputData.tool_choice = jsonSerializable(kwargs.tool_choice);
    if (kwargs.response_format)
      inputData.response_format = jsonSerializable(kwargs.response_format);

    const modelParams: Record<string, unknown> = {};
    for (const key of [
      "temperature",
      "max_tokens",
      "max_completion_tokens",
      "top_p",
      "frequency_penalty",
      "presence_penalty",
      "stop",
      "seed",
      "n",
    ]) {
      if (kwargs[key] !== undefined) modelParams[key] = kwargs[key];
    }

    this.registerRun(runId, undefined, {
      type: "generation",
      name: model ?? "openai",
      startTime: new Date(),
      input: inputData,
      model,
      modelParameters: Object.keys(modelParams).length > 0 ? modelParams : undefined,
    });

    return { runId, stream };
  }

  /** Start a trace for a Responses API call. */
  private startResponsesTrace(kwargs: Record<string, unknown>): {
    runId: string;
    stream: boolean;
  } {
    const runId = generateId();
    const model = kwargs.model as string | undefined;
    const stream = Boolean(kwargs.stream);

    const inputData: Record<string, unknown> = {
      input: jsonSerializable(kwargs.input ?? []),
    };
    if (model) inputData.model = model;
    if (kwargs.tools) inputData.tools = jsonSerializable(kwargs.tools);
    if (kwargs.instructions) inputData.instructions = kwargs.instructions;

    const modelParams: Record<string, unknown> = {};
    for (const key of [
      "temperature",
      "max_output_tokens",
      "top_p",
      "frequency_penalty",
      "presence_penalty",
      "seed",
    ]) {
      if (kwargs[key] !== undefined) modelParams[key] = kwargs[key];
    }

    this.registerRun(runId, undefined, {
      type: "generation",
      name: model ?? "openai-responses",
      startTime: new Date(),
      input: inputData,
      model,
      modelParameters: Object.keys(modelParams).length > 0 ? modelParams : undefined,
    });

    return { runId, stream };
  }
}

// -- Helpers ----------------------------------------------------------------

function extractChatOutput(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = response as any;
  const choices = r.choices;
  if (!Array.isArray(choices) || choices.length === 0) return jsonSerializable(response);

  const message = choices[0]?.message;
  if (!message) return jsonSerializable(choices[0]);

  const output: Record<string, unknown> = {
    role: message.role ?? "assistant",
    content: message.content ?? null,
  };

  if (message.tool_calls?.length) {
    output.tool_calls = message.tool_calls.map((tc: Record<string, unknown>) => ({
      id: tc.id ?? "",
      type: tc.type ?? "function",
      function: {
        name: (tc.function as Record<string, unknown>)?.name ?? "",
        arguments: (tc.function as Record<string, unknown>)?.arguments ?? "",
      },
    }));
  }

  const finishReason = choices[0]?.finish_reason;
  if (finishReason) output.finish_reason = finishReason;

  return output;
}

function extractResponsesOutput(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = response as any;
  if (r.output !== undefined) return jsonSerializable(r.output);
  return jsonSerializable(response);
}

function extractUsage(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = (response as any).usage;
  if (!usage) return null;

  const raw: Record<string, unknown> = {};
  // Chat Completions API
  if (usage.prompt_tokens !== undefined) raw.promptTokens = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) raw.completionTokens = usage.completion_tokens;
  if (usage.total_tokens !== undefined) raw.totalTokens = usage.total_tokens;
  // Responses API
  if (usage.input_tokens !== undefined) raw.promptTokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) raw.completionTokens = usage.output_tokens;
  // Auto-total
  if (
    raw.totalTokens === undefined &&
    raw.promptTokens !== undefined &&
    raw.completionTokens !== undefined
  ) {
    raw.totalTokens = (raw.promptTokens as number) + (raw.completionTokens as number);
  }

  return Object.keys(raw).length > 0 ? raw : null;
}
