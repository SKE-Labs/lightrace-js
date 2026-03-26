/**
 * LangChain/LangGraph integration for Lightrace.
 *
 * Extends `BaseCallbackHandler` from `@langchain/core` to automatically
 * capture chains, LLM calls, tool invocations, and retriever operations
 * as Lightrace trace observations via OpenTelemetry spans.
 *
 * @example
 * ```ts
 * import { LightraceCallbackHandler } from "lightrace/integrations/langchain";
 *
 * const handler = new LightraceCallbackHandler({ userId: "user-123" });
 * const result = await chain.invoke(inputs, { callbacks: [handler] });
 * console.log(handler.lastTraceId);
 * ```
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { DocumentInterface } from "@langchain/core/documents";
import type { Span } from "@opentelemetry/api";
import { generateId, jsonSerializable } from "../utils.js";
import type { LightraceOtelExporter } from "../otel-exporter.js";
import * as attrs from "../otel-exporter.js";
import { Lightrace } from "../client.js";

interface RunInfo {
  observationId: string;
  type: "span" | "generation" | "event" | "tool" | "chain";
  name: string;
  startTime: Date;
  input: unknown;
  parentRunId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  modelParameters?: Record<string, unknown>;
  span: Span;
}

export interface LightraceCallbackHandlerOptions {
  /** User ID to attach to the root trace. */
  userId?: string;
  /** Session ID to attach to the root trace. */
  sessionId?: string;
  /** Override name for the root trace. */
  traceName?: string;
  /** Additional metadata to attach to the root trace. */
  metadata?: Record<string, unknown>;
  /** Provide a Lightrace client instance. If omitted, uses Lightrace.getInstance(). */
  client?: Lightrace;
}

export class LightraceCallbackHandler extends BaseCallbackHandler {
  name = "lightrace";

  // Run tracking
  private runs = new Map<string, RunInfo>();
  private runParents = new Map<string, string | undefined>();
  private completionStartTimes = new Map<string, Date>();
  private rootRunId: string | null = null;
  private _traceId: string | null = null;

  // Config
  private userId?: string;
  private sessionId?: string;
  private traceName?: string;
  private rootMetadata?: Record<string, unknown>;

  // OTel exporter
  private otelExporter: LightraceOtelExporter | null = null;

  /** Root span for the current trace. */
  private rootSpan: Span | null = null;

  /** The trace ID from the most recently completed root run. */
  lastTraceId: string | null = null;

  constructor(opts?: LightraceCallbackHandlerOptions) {
    super();
    this.userId = opts?.userId;
    this.sessionId = opts?.sessionId;
    this.traceName = opts?.traceName;
    this.rootMetadata = opts?.metadata;

    const client = opts?.client ?? Lightrace.getInstance();
    this.otelExporter = client?.getOtelExporter() ?? null;
  }

  // -- helpers ----------------------------------------------------------------

  private getParentObservationId(observationId: string): string | null {
    return this.runParents.get(observationId) ?? null;
  }

  /**
   * Normalize IO data by converting BaseMessage-like objects to plain
   * {role, content, tool_calls?} objects. Recurses into arrays and plain objects.
   */
  private normalizeIO(data: unknown): unknown {
    if (data === null || data === undefined) return data;
    if (Array.isArray(data)) return data.map((d) => this.normalizeIO(d));
    if (typeof data === "object") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = data as Record<string, any>;
      // Detect BaseMessage-like objects
      if ("content" in obj && ("type" in obj || "_getType" in obj)) {
        const role = typeof obj._getType === "function" ? obj._getType() : (obj.type ?? "unknown");
        return {
          role,
          content: obj.content,
          ...(obj.tool_calls?.length ? { tool_calls: obj.tool_calls } : {}),
        };
      }
      // Recurse into plain objects
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = this.normalizeIO(v);
      }
      return result;
    }
    return data;
  }

  private endObservationSpan(
    run: RunInfo,
    output: unknown,
    level: string,
    statusMessage: string | null,
    extra?: Record<string, unknown>,
  ): void {
    const obsTypeMap: Record<string, string> = {
      span: "SPAN",
      generation: "GENERATION",
      event: "EVENT",
      tool: "TOOL",
      chain: "CHAIN",
    };

    const span = run.span;

    span.setAttribute(attrs.OBSERVATION_TYPE, obsTypeMap[run.type] ?? run.type);
    span.setAttribute(attrs.OBSERVATION_INPUT, attrs.safeJson(jsonSerializable(run.input)));
    span.setAttribute(attrs.OBSERVATION_OUTPUT, attrs.safeJson(jsonSerializable(output)));
    span.setAttribute(attrs.OBSERVATION_LEVEL, level);

    if (run.metadata) {
      span.setAttribute(attrs.OBSERVATION_METADATA, attrs.safeJson(run.metadata));
    }
    if (run.model) {
      span.setAttribute(attrs.OBSERVATION_MODEL, run.model);
    }
    if (statusMessage) {
      span.setAttribute(attrs.OBSERVATION_STATUS_MESSAGE, statusMessage);
    }
    if (run.modelParameters && Object.keys(run.modelParameters).length > 0) {
      span.setAttribute(attrs.OBSERVATION_MODEL_PARAMETERS, attrs.safeJson(run.modelParameters));
    }
    if (extra) {
      // Usage details from extra (promptTokens, completionTokens, totalTokens)
      const usageDetails: Record<string, unknown> = {};
      if (extra.promptTokens !== undefined) usageDetails.promptTokens = extra.promptTokens;
      if (extra.completionTokens !== undefined)
        usageDetails.completionTokens = extra.completionTokens;
      if (extra.totalTokens !== undefined) usageDetails.totalTokens = extra.totalTokens;
      if (Object.keys(usageDetails).length > 0) {
        span.setAttribute(attrs.OBSERVATION_USAGE_DETAILS, attrs.safeJson(usageDetails));
      }
    }

    span.end();
  }

  private extractModelName(serialized: Serialized | undefined | null): string | undefined {
    if (!serialized) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = serialized as any;
    return (
      s?.kwargs?.model_name ?? s?.kwargs?.model ?? s?.kwargs?.modelName ?? s?.name ?? undefined
    );
  }

  private extractModelParameters(
    extraParams: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const invocationParams = extraParams?.["invocation_params"] as
      | Record<string, unknown>
      | undefined;
    const modelParameters: Record<string, unknown> = {};
    for (const key of [
      "temperature",
      "max_tokens",
      "top_p",
      "frequency_penalty",
      "presence_penalty",
      "tools",
      "functions",
      "tool_choice",
    ]) {
      const val = invocationParams?.[key];
      if (val !== undefined && val !== null) modelParameters[key] = val;
    }
    return modelParameters;
  }

  private isAgent(serialized: Serialized | undefined | null): boolean {
    if (!serialized) return false;
    const name = (serialized.id?.join("/") ?? "").toLowerCase();
    const sName = (
      ((serialized as unknown as Record<string, unknown>).name as string) ?? ""
    ).toLowerCase();
    return name.includes("agent") || sName.includes("agent");
  }

  private registerRun(
    runId: string,
    parentRunId: string | undefined,
    info: Omit<RunInfo, "observationId" | "parentRunId" | "span">,
  ): RunInfo {
    const tracer = this.otelExporter?.tracer;
    const isRoot = !this.rootRunId;

    if (isRoot) {
      this.rootRunId = runId;
      this._traceId = generateId();

      // Create root span representing the trace
      if (tracer) {
        this.rootSpan = tracer.startSpan(this.traceName ?? info.name, {
          startTime: info.startTime,
        });
        this.rootSpan.setAttribute(attrs.AS_ROOT, "true");
        this.rootSpan.setAttribute(attrs.TRACE_NAME, this.traceName ?? info.name);
        this.rootSpan.setAttribute(attrs.TRACE_INPUT, attrs.safeJson(jsonSerializable(info.input)));
        if (this.userId) this.rootSpan.setAttribute(attrs.TRACE_USER_ID, this.userId);
        if (this.sessionId) this.rootSpan.setAttribute(attrs.TRACE_SESSION_ID, this.sessionId);
        if (this.rootMetadata) {
          this.rootSpan.setAttribute(attrs.TRACE_METADATA, attrs.safeJson(this.rootMetadata));
        }
      }
    }

    const observationId = generateId();

    // Create an OTel span for this observation
    let span: Span;
    if (tracer) {
      span = tracer.startSpan(info.name, { startTime: info.startTime });
    } else {
      // Dummy span if no tracer -- will be a no-op
      span = {
        setAttribute: () => span,
        setAttributes: () => span,
        addEvent: () => span,
        setStatus: () => span,
        end: () => {},
        isRecording: () => false,
        recordException: () => {},
        spanContext: () => ({
          traceId: "",
          spanId: "",
          traceFlags: 0,
        }),
        updateName: () => span,
      } as unknown as Span;
    }

    const runInfo: RunInfo = { ...info, observationId, parentRunId, span };
    this.runs.set(runId, runInfo);
    this.runParents.set(
      observationId,
      parentRunId ? this.runs.get(parentRunId)?.observationId : undefined,
    );

    return runInfo;
  }

  private endRun(
    runId: string,
    output: unknown,
    level = "DEFAULT",
    statusMessage: string | null = null,
    extra?: Record<string, unknown>,
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;

    this.endObservationSpan(run, output, level, statusMessage, extra);

    // If this is the root run completing, end the root span and reset
    if (runId === this.rootRunId) {
      if (this.rootSpan) {
        this.rootSpan.setAttribute(attrs.TRACE_OUTPUT, attrs.safeJson(jsonSerializable(output)));
        this.rootSpan.end();
        this.rootSpan = null;
      }

      this.lastTraceId = this._traceId;
      this.rootRunId = null;
      this._traceId = null;
      this.runs.clear();
      this.runParents.clear();
      this.completionStartTimes.clear();
    } else {
      this.runs.delete(runId);
    }
  }

  // -- Chain callbacks --------------------------------------------------------

  async handleChainStart(
    chain: Serialized,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    name?: string,
  ): Promise<void> {
    try {
      const resolvedName =
        name ??
        ((chain as unknown as Record<string, unknown>)?.name as string) ??
        chain?.id?.[chain.id.length - 1] ??
        "Chain";
      const type = this.isAgent(chain) ? "chain" : "chain";
      const mergedMetadata = { ...metadata, ...(tags?.length ? { tags } : {}) };

      this.registerRun(runId, parentRunId, {
        type,
        name: resolvedName,
        startTime: new Date(),
        input: this.normalizeIO(inputs ?? {}),
        metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
      });
    } catch (e) {
      console.warn("[lightrace] Error in handleChainStart:", e);
    }
  }

  async handleChainEnd(
    outputs: Record<string, unknown>,
    runId: string,
    _parentRunId?: string,
  ): Promise<void> {
    try {
      this.endRun(runId, this.normalizeIO(outputs ?? null));
    } catch (e) {
      console.warn("[lightrace] Error in handleChainEnd:", e);
    }
  }

  async handleChainError(error: Error, runId: string, _parentRunId?: string): Promise<void> {
    try {
      // LangGraph GraphBubbleUp is a control flow error, not an actual error
      if (error?.constructor?.name === "GraphBubbleUp" || error?.name === "GraphBubbleUp") {
        this.endRun(runId, null, "DEFAULT", null);
        return;
      }
      this.endRun(runId, null, "ERROR", error?.message ?? String(error));
    } catch (e) {
      console.warn("[lightrace] Error in handleChainError:", e);
    }
  }

  // -- LLM callbacks ----------------------------------------------------------

  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    try {
      const model = this.extractModelName(llm);
      const resolvedName =
        name ??
        model ??
        ((llm as unknown as Record<string, unknown>)?.name as string) ??
        llm?.id?.[llm.id.length - 1] ??
        "LLM";
      const modelParameters = this.extractModelParameters(extraParams);

      this.registerRun(runId, parentRunId, {
        type: "generation",
        name: resolvedName,
        startTime: new Date(),
        input: prompts?.length === 1 ? prompts[0] : (prompts ?? []),
        model,
        metadata,
        modelParameters,
      });
    } catch (e) {
      console.warn("[lightrace] Error in handleLLMStart:", e);
    }
  }

  async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    try {
      const model = this.extractModelName(llm);
      const resolvedName =
        name ??
        model ??
        ((llm as unknown as Record<string, unknown>)?.name as string) ??
        llm?.id?.[llm.id.length - 1] ??
        "ChatModel";
      const modelParameters = this.extractModelParameters(extraParams);

      // Convert messages to a simpler role/content format
      const formattedMessages = (messages ?? []).map((msgGroup) =>
        (msgGroup ?? []).map((msg) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msgAny = msg as any;
          const role =
            typeof msgAny?._getType === "function"
              ? msgAny._getType()
              : (msgAny?.type ?? "unknown");
          return {
            role,
            content: msg?.content,
            ...(msg?.name ? { name: msg.name } : {}),
            ...(msgAny?.tool_calls?.length ? { tool_calls: msgAny.tool_calls } : {}),
          };
        }),
      );

      // Include tool definitions in input when present
      const invocationParams = extraParams?.["invocation_params"] as
        | Record<string, unknown>
        | undefined;
      const tools = invocationParams?.["tools"] ?? invocationParams?.["functions"] ?? undefined;
      const messagesInput =
        formattedMessages.length === 1 ? formattedMessages[0] : formattedMessages;
      const input = tools ? { messages: messagesInput, tools } : messagesInput;

      this.registerRun(runId, parentRunId, {
        type: "generation",
        name: resolvedName,
        startTime: new Date(),
        input,
        model,
        metadata,
        modelParameters,
      });
    } catch (e) {
      console.warn("[lightrace] Error in handleChatModelStart:", e);
    }
  }

  async handleLLMEnd(output: LLMResult, runId: string, _parentRunId?: string): Promise<void> {
    try {
      const extra: Record<string, unknown> = {};
      const run = this.runs.get(runId);

      // Extract token usage from multiple sources
      const llmUsage = output?.llmOutput?.tokenUsage ?? output?.llmOutput?.usage ?? null;

      // Also check generation-level usage_metadata (e.g. Anthropic, Google)
      const lastGen = output?.generations?.at(-1)?.at(-1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgUsage = (lastGen as any)?.message?.usage_metadata;
      const usage = llmUsage ?? msgUsage;

      if (usage) {
        const promptTokens =
          usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? undefined;
        const completionTokens =
          usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? undefined;
        const totalTokens = usage.totalTokens ?? usage.total_tokens ?? undefined;

        if (promptTokens !== undefined) extra.promptTokens = promptTokens;
        if (completionTokens !== undefined) extra.completionTokens = completionTokens;
        if (totalTokens !== undefined) extra.totalTokens = totalTokens;
        else if (promptTokens !== undefined && completionTokens !== undefined)
          extra.totalTokens = promptTokens + completionTokens;
      }

      // Extract model name from response if not set at start
      if (run && !run.model) {
        const modelFromResponse =
          output?.llmOutput?.model_name ?? output?.llmOutput?.model ?? undefined;
        if (modelFromResponse) {
          run.model = modelFromResponse as string;
          // Also update name if it was a default
          if (run.name === "LLM" || run.name === "ChatModel") {
            run.name = modelFromResponse as string;
          }
        }
      }

      // Add TTFT if we have it
      const ttftStart = this.completionStartTimes.get(runId);
      if (ttftStart && run) {
        const ttft = ttftStart.getTime() - run.startTime.getTime();
        if (!run.metadata) run.metadata = {};
        run.metadata.timeToFirstToken = ttft;
      }

      // Extract output -- handle ChatGeneration (has .message) vs Generation (only .text)
      let outputData: unknown;
      const generations = output?.generations;
      if (generations && generations.length > 0) {
        const singleGen = generations.length === 1 && generations[0].length === 1;
        if (singleGen) {
          const gen = generations[0][0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const genAny = gen as any;
          if (genAny?.message) {
            const msg = genAny.message;
            const role =
              typeof msg._getType === "function" ? msg._getType() : (msg.type ?? "assistant");
            outputData = {
              role,
              content: msg.content,
              ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
            };
          } else {
            outputData = gen?.text;
          }
        } else {
          outputData = generations.map((g) =>
            g.map((gg) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ggAny = gg as any;
              if (ggAny?.message) {
                const msg = ggAny.message;
                const role =
                  typeof msg._getType === "function" ? msg._getType() : (msg.type ?? "assistant");
                return {
                  role,
                  content: msg.content,
                  ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
                };
              }
              return gg?.text;
            }),
          );
        }
      } else {
        outputData = null;
      }

      this.endRun(runId, outputData, "DEFAULT", null, extra);
      this.completionStartTimes.delete(runId);
    } catch (e) {
      console.warn("[lightrace] Error in handleLLMEnd:", e);
    }
  }

  async handleLLMNewToken(_token: string, _idx: unknown, runId: string): Promise<void> {
    try {
      if (!this.completionStartTimes.has(runId)) {
        this.completionStartTimes.set(runId, new Date());
      }
    } catch (e) {
      console.warn("[lightrace] Error in handleLLMNewToken:", e);
    }
  }

  async handleLLMError(error: Error, runId: string, _parentRunId?: string): Promise<void> {
    try {
      this.endRun(runId, null, "ERROR", error?.message ?? String(error));
      this.completionStartTimes.delete(runId);
    } catch (e) {
      console.warn("[lightrace] Error in handleLLMError:", e);
    }
  }

  // -- Tool callbacks ---------------------------------------------------------

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    try {
      const resolvedName =
        name ??
        ((tool as unknown as Record<string, unknown>)?.name as string) ??
        tool?.id?.[tool.id.length - 1] ??
        "Tool";

      // Try to parse input as JSON
      let parsedInput: unknown = input;
      if (typeof input === "string") {
        try {
          parsedInput = JSON.parse(input);
        } catch {
          // keep as string
        }
      }

      this.registerRun(runId, parentRunId, {
        type: "tool",
        name: resolvedName,
        startTime: new Date(),
        input: parsedInput,
        metadata,
      });
    } catch (e) {
      console.warn("[lightrace] Error in handleToolStart:", e);
    }
  }

  async handleToolEnd(output: string, runId: string, _parentRunId?: string): Promise<void> {
    try {
      // Try to parse output as JSON
      let parsedOutput: unknown = output;
      if (typeof output === "string") {
        try {
          parsedOutput = JSON.parse(output);
        } catch {
          // keep as string
        }
      }
      this.endRun(runId, parsedOutput);
    } catch (e) {
      console.warn("[lightrace] Error in handleToolEnd:", e);
    }
  }

  async handleToolError(error: Error, runId: string, _parentRunId?: string): Promise<void> {
    try {
      this.endRun(runId, null, "ERROR", error?.message ?? String(error));
    } catch (e) {
      console.warn("[lightrace] Error in handleToolError:", e);
    }
  }

  // -- Retriever callbacks ----------------------------------------------------

  async handleRetrieverStart(
    retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const name =
        ((retriever as unknown as Record<string, unknown>)?.name as string) ??
        retriever?.id?.[retriever.id.length - 1] ??
        "Retriever";

      this.registerRun(runId, parentRunId, {
        type: "span",
        name,
        startTime: new Date(),
        input: query,
        metadata,
      });
    } catch (e) {
      console.warn("[lightrace] Error in handleRetrieverStart:", e);
    }
  }

  async handleRetrieverEnd(
    documents: DocumentInterface[],
    runId: string,
    _parentRunId?: string,
  ): Promise<void> {
    try {
      const output = (documents ?? []).map((doc) => ({
        pageContent: doc?.pageContent,
        metadata: doc?.metadata,
      }));
      this.endRun(runId, output);
    } catch (e) {
      console.warn("[lightrace] Error in handleRetrieverEnd:", e);
    }
  }

  async handleRetrieverError(error: Error, runId: string, _parentRunId?: string): Promise<void> {
    try {
      this.endRun(runId, null, "ERROR", error?.message ?? String(error));
    } catch (e) {
      console.warn("[lightrace] Error in handleRetrieverError:", e);
    }
  }

  // -- Accessors --------------------------------------------------------------

  /** Get the current active trace ID (null if no run is active). */
  get traceId(): string | null {
    return this._traceId;
  }
}
