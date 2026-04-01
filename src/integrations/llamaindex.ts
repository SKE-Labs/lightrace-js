/**
 * LlamaIndex integration for Lightrace.
 *
 * Provides a handler that hooks into LlamaIndex's callback system to capture
 * LLM calls, tool invocations, retrieval, and query events as OTel spans.
 *
 * @example
 * ```ts
 * import { LightraceLlamaIndexHandler } from "lightrace/integrations/llamaindex";
 *
 * const handler = new LightraceLlamaIndexHandler({ userId: "user-123" });
 * // Register with LlamaIndex Settings or CallbackManager
 * ```
 */
import { generateId, jsonSerializable } from "../utils.js";
import { TracingMixin, normalizeUsage, type TracingMixinOptions } from "./_base.js";

/** Observation type mapping for LlamaIndex event types. */
const EVENT_TYPE_MAP: Record<string, "generation" | "span" | "tool"> = {
  llm: "generation",
  embedding: "span",
  retrieve: "span",
  query: "span",
  function_call: "tool",
  agent_step: "span",
  chunking: "span",
  reranking: "span",
  synthesize: "span",
  tree: "span",
  sub_question: "span",
  templating: "span",
};

export class LightraceLlamaIndexHandler extends TracingMixin {
  private traceRunId: string | null = null;

  constructor(opts?: TracingMixinOptions) {
    super(opts);
  }

  /** Called when a LlamaIndex trace begins. */
  startTrace(traceId?: string): void {
    try {
      const runId = generateId();
      this.traceRunId = runId;
      this.registerRun(runId, undefined, {
        type: "span",
        name: traceId ?? "llamaindex-trace",
        startTime: new Date(),
        input: traceId ? { trace_id: traceId } : undefined,
      });
    } catch (e) {
      console.warn("[lightrace] Error in startTrace:", e);
    }
  }

  /** Called when a LlamaIndex trace ends. */
  endTrace(): void {
    try {
      if (this.traceRunId) {
        this.endRun(this.traceRunId, null);
        this.traceRunId = null;
      }
    } catch (e) {
      console.warn("[lightrace] Error in endTrace:", e);
    }
  }

  /** Called when a LlamaIndex event starts. */
  onEventStart(
    eventType: string,
    payload?: Record<string, unknown> | null,
    eventId?: string,
    parentId?: string,
  ): string {
    try {
      const obsType = EVENT_TYPE_MAP[eventType.toLowerCase()] ?? "span";
      const runId = eventId ?? generateId();
      const parentRunId =
        parentId && this.runs.has(parentId) ? parentId : (this.traceRunId ?? undefined);

      let input: unknown = undefined;
      let model: string | undefined;
      let modelParams: Record<string, unknown> | undefined;

      if (payload) {
        input = extractInput(eventType, payload);
        if (eventType.toLowerCase() === "llm") {
          model = extractModel(payload);
          modelParams = extractModelParams(payload);
        }
      }

      this.registerRun(runId, parentRunId, {
        type: obsType,
        name: eventType,
        startTime: new Date(),
        input,
        model,
        modelParameters: modelParams,
      });

      return runId;
    } catch (e) {
      console.warn("[lightrace] Error in onEventStart:", e);
      return eventId ?? generateId();
    }
  }

  /** Called when a LlamaIndex event ends. */
  onEventEnd(eventType: string, payload?: Record<string, unknown> | null, eventId?: string): void {
    try {
      if (!eventId) return;

      let output: unknown = undefined;
      let extra: Record<string, unknown> | undefined;

      if (payload) {
        output = extractOutput(eventType, payload);
        if (eventType.toLowerCase() === "llm") {
          extra = extractLlmUsage(payload) ?? undefined;
        }
      }

      this.endRun(eventId, output, "DEFAULT", null, extra);
    } catch (e) {
      console.warn("[lightrace] Error in onEventEnd:", e);
    }
  }
}

// -- Extraction helpers -----------------------------------------------------

function extractInput(eventType: string, payload: Record<string, unknown>): unknown {
  const type = eventType.toLowerCase();

  if (type === "llm") {
    if (payload.messages) return jsonSerializable(payload.messages);
    if (payload.template) return String(payload.template);
    return payload.prompt ?? payload.query_str ?? null;
  }

  if (type === "retrieve" || type === "query") {
    return payload.query_str ?? null;
  }

  if (type === "function_call") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = payload.tool as any;
    return {
      tool: tool?.name ?? payload.function_call ?? "unknown",
      arguments: jsonSerializable(payload.function_call_args ?? {}),
    };
  }

  if (type === "embedding") {
    const chunks = payload.chunks as unknown[];
    if (chunks) return { num_chunks: chunks.length };
  }

  return jsonSerializable(payload);
}

function extractOutput(eventType: string, payload: Record<string, unknown>): unknown {
  const type = eventType.toLowerCase();

  if (type === "llm") {
    if (payload.response) return jsonSerializable(payload.response);
    if (payload.completion) return String(payload.completion);
    return payload.formatted_prompt ?? null;
  }

  if (type === "retrieve") {
    const nodes = payload.nodes as unknown[];
    if (nodes) {
      return nodes.slice(0, 10).map((n: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const node = n as any;
        return {
          text: String(node?.text ?? node).slice(0, 500),
          score: node?.score ?? null,
        };
      });
    }
  }

  if (type === "query") {
    if (payload.response) return String(payload.response);
  }

  if (type === "function_call") {
    return payload.function_call_response ?? null;
  }

  if (type === "embedding") {
    const embeddings = payload.embeddings as unknown[];
    if (embeddings) return { num_embeddings: embeddings.length };
  }

  return jsonSerializable(payload);
}

function extractModel(payload: Record<string, unknown>): string | undefined {
  const serialized = payload.serialized as Record<string, unknown> | undefined;
  if (serialized) {
    const model = serialized.model ?? serialized.model_name;
    if (model) return String(model);
  }
  return undefined;
}

function extractModelParams(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const serialized = payload.serialized as Record<string, unknown> | undefined;
  if (!serialized) return undefined;

  const params: Record<string, unknown> = {};
  for (const key of ["temperature", "max_tokens", "top_p"]) {
    if (serialized[key] !== undefined) params[key] = serialized[key];
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function extractLlmUsage(payload: Record<string, unknown>): Record<string, unknown> | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = payload.response as any;
  if (!response) return null;

  const usage = response?.raw?.usage;
  if (usage) {
    const raw: Record<string, unknown> = {};
    if (usage.prompt_tokens !== undefined) raw.promptTokens = usage.prompt_tokens;
    if (usage.completion_tokens !== undefined) raw.completionTokens = usage.completion_tokens;
    if (usage.total_tokens !== undefined) raw.totalTokens = usage.total_tokens;
    if (usage.input_tokens !== undefined) raw.promptTokens = usage.input_tokens;
    if (usage.output_tokens !== undefined) raw.completionTokens = usage.output_tokens;
    return Object.keys(raw).length > 0 ? raw : null;
  }

  return null;
}
