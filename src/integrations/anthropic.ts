/**
 * Anthropic SDK integration for Lightrace.
 *
 * Wraps `messages.create` and `messages.stream` on Anthropic client instances
 * to automatically capture traces via OpenTelemetry spans.
 *
 * @example
 * ```ts
 * import { LightraceAnthropicInstrumentor } from "lightrace/integrations/anthropic";
 *
 * const instrumentor = new LightraceAnthropicInstrumentor();
 * instrumentor.instrument(client);
 *
 * const response = await client.messages.create({ ... });
 * console.log(instrumentor.lastTraceId);
 * ```
 */
import { generateId, jsonSerializable } from "../utils.js";
import { TracingMixin, type TracingMixinOptions } from "./_base.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export class LightraceAnthropicInstrumentor extends TracingMixin {
  private patchedTargets = new Map<
    unknown,
    { messages: unknown; originalCreate: AnyFn; originalStream?: AnyFn }
  >();

  constructor(opts?: TracingMixinOptions) {
    super(opts);
  }

  /**
   * Patch an Anthropic client instance so that `messages.create` and
   * `messages.stream` calls are automatically traced.
   */
  instrument(client: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    const messages = c?.messages;
    if (!messages?.create) return;
    if (this.patchedTargets.has(client)) return;

    const originalCreate = messages.create.bind(messages);
    const originalStream = messages.stream ? messages.stream.bind(messages) : undefined;
    this.patchedTargets.set(client, {
      messages,
      originalCreate,
      originalStream,
    });

    // Patch messages.create
    messages.create = async (...args: unknown[]) => {
      const kwargs =
        args.length === 1 && typeof args[0] === "object" && args[0] !== null
          ? (args[0] as Record<string, unknown>)
          : {};

      const { runId } = this.startAnthropicTrace(kwargs);
      const stream = Boolean(kwargs.stream);

      try {
        const result = await originalCreate(...args);

        if (!stream) {
          const output = extractOutput(result);
          const usage = extractUsage(result);
          this.endRun(runId, output, "DEFAULT", null, usage ?? undefined);
        } else {
          // For streaming, end immediately with partial info
          this.endRun(runId, { streaming: true });
        }

        return result;
      } catch (err) {
        this.endRun(runId, null, "ERROR", err instanceof Error ? err.message : String(err));
        throw err;
      }
    };

    // Patch messages.stream (separate context-manager streaming API)
    if (originalStream) {
      messages.stream = (...args: unknown[]) => {
        const kwargs =
          args.length === 1 && typeof args[0] === "object" && args[0] !== null
            ? (args[0] as Record<string, unknown>)
            : {};

        const { runId } = this.startAnthropicTrace(kwargs);

        try {
          const streamManager = originalStream(...args);

          // Wrap the stream manager to capture the final message
          return wrapStreamManager(streamManager, this, runId);
        } catch (err) {
          this.endRun(runId, null, "ERROR", err instanceof Error ? err.message : String(err));
          throw err;
        }
      };
    }
  }

  /** Restore the original methods. */
  uninstrument(client: unknown): void {
    const entry = this.patchedTargets.get(client);
    if (!entry) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = entry.messages as any;
    messages.create = entry.originalCreate;
    if (entry.originalStream) {
      messages.stream = entry.originalStream;
    }
    this.patchedTargets.delete(client);
  }

  /** Start a trace for an Anthropic messages call. */
  private startAnthropicTrace(kwargs: Record<string, unknown>): {
    runId: string;
  } {
    const runId = generateId();
    const model = kwargs.model as string | undefined;

    const inputData: Record<string, unknown> = {
      messages: jsonSerializable(kwargs.messages ?? []),
    };
    if (model) inputData.model = model;
    if (kwargs.system) inputData.system = jsonSerializable(kwargs.system);
    if (kwargs.tools) inputData.tools = jsonSerializable(kwargs.tools);
    if (kwargs.tool_choice) inputData.tool_choice = jsonSerializable(kwargs.tool_choice);

    const modelParams: Record<string, unknown> = {};
    for (const key of ["temperature", "max_tokens", "top_p", "top_k", "stop_sequences"]) {
      if (kwargs[key] !== undefined) modelParams[key] = kwargs[key];
    }

    this.registerRun(runId, undefined, {
      type: "generation",
      name: model ?? "anthropic",
      startTime: new Date(),
      input: inputData,
      model,
      modelParameters: Object.keys(modelParams).length > 0 ? modelParams : undefined,
    });

    return { runId };
  }
}

// -- Helpers ----------------------------------------------------------------

function extractOutput(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = response as any;
  const content = r.content;
  if (!Array.isArray(content)) return jsonSerializable(response);

  const blocks = content.map((block: Record<string, unknown>) => {
    if (block.type === "text") {
      return { type: "text", text: block.text ?? "" };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id ?? "",
        name: block.name ?? "",
        input: jsonSerializable(block.input ?? {}),
      };
    }
    return jsonSerializable(block);
  });

  const result: Record<string, unknown> = {
    role: r.role ?? "assistant",
    content: blocks,
  };
  if (r.stop_reason) result.stop_reason = r.stop_reason;
  return result;
}

function extractUsage(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = (response as any).usage;
  if (!usage) return null;

  const raw: Record<string, unknown> = {};
  if (usage.input_tokens !== undefined) raw.promptTokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) raw.completionTokens = usage.output_tokens;
  if (raw.promptTokens !== undefined && raw.completionTokens !== undefined) {
    raw.totalTokens = (raw.promptTokens as number) + (raw.completionTokens as number);
  }

  return Object.keys(raw).length > 0 ? raw : null;
}

/**
 * Wrap a stream manager (from `messages.stream()`) to capture the final
 * message when the stream ends.
 */
function wrapStreamManager(
  manager: unknown,
  instrumentor: LightraceAnthropicInstrumentor,
  runId: string,
): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = manager as any;

  // For async stream managers (most common in Node.js)
  if (typeof m[Symbol.asyncIterator] === "function" || typeof m.then === "function") {
    return {
      ...m,
      async *[Symbol.asyncIterator]() {
        let finalMessage: unknown = null;
        try {
          for await (const event of m) {
            if (event?.type === "message_stop") {
              finalMessage = event.message ?? m.currentMessageSnapshot ?? null;
            }
            yield event;
          }
        } finally {
          const msg = finalMessage ?? m.currentMessageSnapshot ?? m.finalMessage ?? null;
          if (msg) {
            const output = extractOutput(msg);
            const usage = extractUsage(msg);
            instrumentor.endRun(runId, output, "DEFAULT", null, usage ?? undefined);
          } else {
            instrumentor.endRun(runId, null);
          }
        }
      },
      // Forward method calls
      on: m.on?.bind(m),
      off: m.off?.bind(m),
      get finalMessage() {
        return m.finalMessage;
      },
      get currentMessageSnapshot() {
        return m.currentMessageSnapshot;
      },
    };
  }

  // Fallback: return as-is and end the span
  instrumentor.endRun(runId, null);
  return manager;
}
