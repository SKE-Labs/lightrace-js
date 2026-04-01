/**
 * Shared tracing infrastructure for framework integrations.
 *
 * Provides `TracingMixin` with `registerRun` / `endRun` to manage OTel spans
 * with `lightrace.*` attributes, and `normalizeUsage` for multi-provider
 * token usage extraction.
 */
import { trace as otelTrace, type Span } from "@opentelemetry/api";
import { generateId, jsonSerializable } from "../utils.js";
import type { LightraceOtelExporter } from "../otel-exporter.js";
import * as attrs from "../otel-exporter.js";
import { Lightrace } from "../client.js";

/** State tracked for each in-flight observation. */
export interface ObsRunInfo {
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

export interface TracingMixinOptions {
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

/**
 * Normalize token usage from any provider format to a canonical form.
 *
 * Supports OpenAI (`prompt_tokens`/`completion_tokens`), Anthropic
 * (`input_tokens`/`output_tokens`), and camelCase variants.
 */
export function normalizeUsage(raw: Record<string, unknown>): Record<string, number> | null {
  if (!raw || typeof raw !== "object") return null;

  const result: Record<string, number> = {};

  const prompt = raw.promptTokens ?? raw.prompt_tokens ?? raw.input_tokens ?? undefined;
  const completion =
    raw.completionTokens ?? raw.completion_tokens ?? raw.output_tokens ?? undefined;
  const total = raw.totalTokens ?? raw.total_tokens ?? undefined;

  if (prompt !== undefined) result.promptTokens = Number(prompt);
  if (completion !== undefined) result.completionTokens = Number(completion);
  if (total !== undefined) result.totalTokens = Number(total);
  else if (result.promptTokens !== undefined && result.completionTokens !== undefined)
    result.totalTokens = result.promptTokens + result.completionTokens;

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Base class providing shared OTel tracing infrastructure for framework
 * integrations. Manages span lifecycle, run-state tracking, and
 * `lightrace.*` attribute setting.
 */
export class TracingMixin {
  protected runs = new Map<string, ObsRunInfo>();
  protected runParents = new Map<string, string | undefined>();
  protected completionStartTimes = new Map<string, Date>();
  protected rootRunId: string | null = null;
  protected _traceId: string | null = null;

  protected userId?: string;
  protected sessionId?: string;
  protected traceName?: string;
  protected rootMetadata?: Record<string, unknown>;

  protected otelExporter: LightraceOtelExporter | null = null;

  protected rootSpan: Span | null = null;
  /** True when rootSpan was borrowed from an existing trace() wrapper (don't end it). */
  private borrowedRootSpan = false;

  /** The trace ID from the most recently completed root run. */
  lastTraceId: string | null = null;

  constructor(opts?: TracingMixinOptions) {
    this.userId = opts?.userId;
    this.sessionId = opts?.sessionId;
    this.traceName = opts?.traceName;
    this.rootMetadata = opts?.metadata;

    const client = opts?.client ?? Lightrace.getInstance();
    this.otelExporter = client?.getOtelExporter() ?? null;
  }

  /** Get the current active trace ID (null if no run is active). */
  get traceId(): string | null {
    return this._traceId;
  }

  // ── Core span management ──────────────────────────────────────────

  protected registerRun(
    runId: string,
    parentRunId: string | undefined,
    info: Omit<ObsRunInfo, "observationId" | "parentRunId" | "span">,
  ): ObsRunInfo {
    const tracer = this.otelExporter?.tracer;
    const isRoot = !this.rootRunId;

    if (isRoot) {
      this.rootRunId = runId;

      const activeSpan = otelTrace.getActiveSpan();

      if (activeSpan) {
        // Reuse the existing trace span — don't create a duplicate root.
        this.rootSpan = activeSpan;
        this.borrowedRootSpan = true;
        this._traceId = activeSpan.spanContext().traceId;
      } else if (tracer) {
        this._traceId = generateId();
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
      } else {
        this._traceId = generateId();
      }
    }

    const observationId = generateId();

    let span: Span;
    if (tracer) {
      span = tracer.startSpan(info.name, { startTime: info.startTime });
    } else {
      span = {
        setAttribute: () => span,
        setAttributes: () => span,
        addEvent: () => span,
        setStatus: () => span,
        end: () => {},
        isRecording: () => false,
        recordException: () => {},
        spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0 }),
        updateName: () => span,
      } as unknown as Span;
    }

    const runInfo: ObsRunInfo = { ...info, observationId, parentRunId, span };
    this.runs.set(runId, runInfo);
    this.runParents.set(
      observationId,
      parentRunId ? this.runs.get(parentRunId)?.observationId : undefined,
    );

    return runInfo;
  }

  protected endObservationSpan(
    run: ObsRunInfo,
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

  endRun(
    runId: string,
    output: unknown,
    level = "DEFAULT",
    statusMessage: string | null = null,
    extra?: Record<string, unknown>,
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;

    this.endObservationSpan(run, output, level, statusMessage, extra);

    if (runId === this.rootRunId) {
      if (this.rootSpan) {
        this.rootSpan.setAttribute(attrs.TRACE_OUTPUT, attrs.safeJson(jsonSerializable(output)));
        if (!this.borrowedRootSpan) {
          this.rootSpan.end();
        }
        this.rootSpan = null;
      }

      this.lastTraceId = this._traceId;
      this.rootRunId = null;
      this._traceId = null;
      this.borrowedRootSpan = false;
      this.runs.clear();
      this.runParents.clear();
      this.completionStartTimes.clear();
    } else {
      this.runs.delete(runId);
    }
  }
}
