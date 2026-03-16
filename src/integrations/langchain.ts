/**
 * LangChain/LangGraph integration for Lightrace.
 *
 * Extends `BaseCallbackHandler` from `@langchain/core` to automatically
 * capture chains, LLM calls, tool invocations, and retriever operations
 * as Lightrace trace observations.
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
import type { TraceEvent } from "../types.js";
import { generateId, jsonSerializable } from "../utils.js";
import type { BatchExporter } from "../exporter.js";
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

  // Exporter
  private exporter: BatchExporter | null = null;

  /** The trace ID from the most recently completed root run. */
  lastTraceId: string | null = null;

  constructor(opts?: LightraceCallbackHandlerOptions) {
    super();
    this.userId = opts?.userId;
    this.sessionId = opts?.sessionId;
    this.traceName = opts?.traceName;
    this.rootMetadata = opts?.metadata;

    const client = opts?.client ?? Lightrace.getInstance();
    this.exporter = client?.getExporter() ?? null;
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private getParentObservationId(observationId: string): string | null {
    return this.runParents.get(observationId) ?? null;
  }

  private emit(event: TraceEvent): void {
    this.exporter?.enqueue(event);
  }

  private emitObservation(
    run: RunInfo,
    endTime: Date,
    output: unknown,
    level: string,
    statusMessage: string | null,
    extra?: Record<string, unknown>,
  ): void {
    const eventTypeMap: Record<string, string> = {
      span: "span-create",
      generation: "generation-create",
      event: "event-create",
      tool: "tool-create",
      chain: "chain-create",
    };
    const obsTypeMap: Record<string, string> = {
      span: "SPAN",
      generation: "GENERATION",
      event: "EVENT",
      tool: "TOOL",
      chain: "CHAIN",
    };

    const body: Record<string, unknown> = {
      id: run.observationId,
      traceId: this._traceId,
      type: obsTypeMap[run.type] ?? run.type,
      name: run.name,
      startTime: run.startTime.toISOString(),
      endTime: endTime.toISOString(),
      input: jsonSerializable(run.input),
      output: jsonSerializable(output),
      metadata: run.metadata ?? null,
      model: run.model ?? null,
      level,
      statusMessage,
      parentObservationId: this.getParentObservationId(run.observationId) ?? null,
      ...extra,
    };

    this.emit({
      id: generateId(),
      type: eventTypeMap[run.type] ?? "span-create",
      timestamp: run.startTime.toISOString(),
      body,
    });
  }

  private extractModelName(serialized: Serialized): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = serialized as any;
    return (
      s?.kwargs?.model_name ?? s?.kwargs?.model ?? s?.kwargs?.modelName ?? s?.name ?? undefined
    );
  }

  private isAgent(serialized: Serialized): boolean {
    const name = (serialized.id?.join("/") ?? "").toLowerCase();
    const sName = (
      ((serialized as unknown as Record<string, unknown>).name as string) ?? ""
    ).toLowerCase();
    return name.includes("agent") || sName.includes("agent");
  }

  private registerRun(
    runId: string,
    parentRunId: string | undefined,
    info: Omit<RunInfo, "observationId" | "parentRunId">,
  ): RunInfo {
    const isRoot = !this.rootRunId;
    if (isRoot) {
      this.rootRunId = runId;
      this._traceId = generateId();

      // Emit root trace-create event
      this.emit({
        id: generateId(),
        type: "trace-create",
        timestamp: info.startTime.toISOString(),
        body: {
          id: this._traceId,
          name: this.traceName ?? info.name,
          timestamp: info.startTime.toISOString(),
          userId: this.userId,
          sessionId: this.sessionId,
          metadata: this.rootMetadata ?? null,
          input: jsonSerializable(info.input),
        },
      });
    }

    const observationId = generateId();
    const runInfo: RunInfo = { ...info, observationId, parentRunId };
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

    const endTime = new Date();
    this.emitObservation(run, endTime, output, level, statusMessage, extra);

    // If this is the root run completing, update the trace and reset
    if (runId === this.rootRunId) {
      // Emit trace-create with output (update)
      this.emit({
        id: generateId(),
        type: "trace-create",
        timestamp: run.startTime.toISOString(),
        body: {
          id: this._traceId,
          name: this.traceName ?? run.name,
          timestamp: run.startTime.toISOString(),
          output: jsonSerializable(output),
          userId: this.userId,
          sessionId: this.sessionId,
          metadata: this.rootMetadata ?? null,
        },
      });

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

  // ── Chain callbacks ──────────────────────────────────────────────────

  async handleChainStart(
    chain: Serialized,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const name =
      ((chain as unknown as Record<string, unknown>).name as string) ??
      chain.id?.[chain.id.length - 1] ??
      "Chain";
    const type = this.isAgent(chain) ? "chain" : "chain";
    const mergedMetadata = { ...metadata, ...(tags?.length ? { tags } : {}) };

    this.registerRun(runId, parentRunId, {
      type,
      name,
      startTime: new Date(),
      input: inputs,
      metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
    });
  }

  async handleChainEnd(
    outputs: Record<string, unknown>,
    runId: string,
    _parentRunId?: string,
  ): Promise<void> {
    this.endRun(runId, outputs);
  }

  async handleChainError(error: Error, runId: string, _parentRunId?: string): Promise<void> {
    // LangGraph GraphBubbleUp is a control flow error, not an actual error
    if (error?.constructor?.name === "GraphBubbleUp" || error?.name === "GraphBubbleUp") {
      this.endRun(runId, null, "DEFAULT", null);
      return;
    }
    this.endRun(runId, null, "ERROR", error.message ?? String(error));
  }

  // ── LLM callbacks ───────────────────────────────────────────────────

  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const model = this.extractModelName(llm);
    const name =
      model ??
      ((llm as unknown as Record<string, unknown>).name as string) ??
      llm.id?.[llm.id.length - 1] ??
      "LLM";

    this.registerRun(runId, parentRunId, {
      type: "generation",
      name,
      startTime: new Date(),
      input: prompts.length === 1 ? prompts[0] : prompts,
      model,
      metadata,
    });
  }

  async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const model = this.extractModelName(llm);
    const name =
      model ??
      ((llm as unknown as Record<string, unknown>).name as string) ??
      llm.id?.[llm.id.length - 1] ??
      "ChatModel";

    // Convert messages to a simpler role/content format
    const formattedMessages = messages.map((msgGroup) =>
      msgGroup.map((msg) => ({
        role: msg._getType(),
        content: msg.content,
        ...(msg.name ? { name: msg.name } : {}),
      })),
    );

    this.registerRun(runId, parentRunId, {
      type: "generation",
      name,
      startTime: new Date(),
      input: formattedMessages.length === 1 ? formattedMessages[0] : formattedMessages,
      model,
      metadata,
    });
  }

  async handleLLMEnd(output: LLMResult, runId: string, _parentRunId?: string): Promise<void> {
    const extra: Record<string, unknown> = {};

    // Extract token usage
    const usage = output.llmOutput?.tokenUsage ?? output.llmOutput?.estimatedTokens ?? null;
    if (usage) {
      if (usage.promptTokens !== undefined) extra.promptTokens = usage.promptTokens;
      if (usage.completionTokens !== undefined) extra.completionTokens = usage.completionTokens;
      if (usage.totalTokens !== undefined) extra.totalTokens = usage.totalTokens;
    }

    // Add TTFT if we have it
    const ttftStart = this.completionStartTimes.get(runId);
    const run = this.runs.get(runId);
    if (ttftStart && run) {
      const ttft = ttftStart.getTime() - run.startTime.getTime();
      if (!run.metadata) run.metadata = {};
      run.metadata.timeToFirstToken = ttft;
    }

    // Extract output text
    const generations = output.generations;
    let outputText: unknown;
    if (generations.length === 1 && generations[0].length === 1) {
      const gen = generations[0][0];
      // ChatGeneration has a `message` field, base Generation only has `text`
      const genAny = gen as unknown as Record<string, unknown>;
      outputText = genAny.message ?? gen.text;
    } else {
      outputText = generations.map((g) =>
        g.map((gg) => {
          const ggAny = gg as unknown as Record<string, unknown>;
          return ggAny.message ?? gg.text;
        }),
      );
    }

    this.endRun(runId, outputText, "DEFAULT", null, extra);
    this.completionStartTimes.delete(runId);
  }

  async handleLLMNewToken(_token: string, _idx: unknown, runId: string): Promise<void> {
    if (!this.completionStartTimes.has(runId)) {
      this.completionStartTimes.set(runId, new Date());
    }
  }

  async handleLLMError(error: Error, runId: string, _parentRunId?: string): Promise<void> {
    this.endRun(runId, null, "ERROR", error.message ?? String(error));
    this.completionStartTimes.delete(runId);
  }

  // ── Tool callbacks ──────────────────────────────────────────────────

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const name =
      ((tool as unknown as Record<string, unknown>).name as string) ??
      tool.id?.[tool.id.length - 1] ??
      "Tool";

    // Try to parse input as JSON
    let parsedInput: unknown = input;
    try {
      parsedInput = JSON.parse(input);
    } catch {
      // keep as string
    }

    this.registerRun(runId, parentRunId, {
      type: "tool",
      name,
      startTime: new Date(),
      input: parsedInput,
      metadata,
    });
  }

  async handleToolEnd(output: string, runId: string, _parentRunId?: string): Promise<void> {
    // Try to parse output as JSON
    let parsedOutput: unknown = output;
    try {
      parsedOutput = JSON.parse(output);
    } catch {
      // keep as string
    }
    this.endRun(runId, parsedOutput);
  }

  async handleToolError(error: Error, runId: string, _parentRunId?: string): Promise<void> {
    this.endRun(runId, null, "ERROR", error.message ?? String(error));
  }

  // ── Retriever callbacks ─────────────────────────────────────────────

  async handleRetrieverStart(
    retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const name =
      ((retriever as unknown as Record<string, unknown>).name as string) ??
      retriever.id?.[retriever.id.length - 1] ??
      "Retriever";

    this.registerRun(runId, parentRunId, {
      type: "span",
      name,
      startTime: new Date(),
      input: query,
      metadata,
    });
  }

  async handleRetrieverEnd(
    documents: DocumentInterface[],
    runId: string,
    _parentRunId?: string,
  ): Promise<void> {
    const output = documents.map((doc) => ({
      pageContent: doc.pageContent,
      metadata: doc.metadata,
    }));
    this.endRun(runId, output);
  }

  async handleRetrieverError(error: Error, runId: string, _parentRunId?: string): Promise<void> {
    this.endRun(runId, null, "ERROR", error.message ?? String(error));
  }

  // ── Accessors ───────────────────────────────────────────────────────

  /** Get the current active trace ID (null if no run is active). */
  get traceId(): string | null {
    return this._traceId;
  }
}
