/**
 * Imperative Observation handle for span / generation / event.
 *
 * Uses OpenTelemetry spans for export instead of the legacy BatchExporter.
 */
import type { UsageDetails } from "./types.js";
import { OBSERVATION_TYPE_ENUM } from "./types.js";
import { generateId, jsonSerializable } from "./utils.js";
import type { LightraceOtelExporter } from "./otel-exporter.js";
import * as attrs from "./otel-exporter.js";

export interface ObservationOptions {
  traceId: string;
  type: "span" | "generation" | "event";
  name: string;
  otelExporter: LightraceOtelExporter | null;
  startTime?: Date;
  parentObservationId?: string;
  input?: unknown;
  model?: string;
  metadata?: Record<string, unknown>;
  usage?: UsageDetails;
}

export class Observation {
  readonly id: string;
  readonly traceId: string;
  readonly type: "span" | "generation" | "event";
  readonly name: string;
  private readonly otelExporter: LightraceOtelExporter | null;
  private readonly startTime: Date;
  private readonly parentObservationId: string | undefined;

  private input: unknown;
  private output: unknown;
  private model: string | undefined;
  private metadata: Record<string, unknown> | undefined;
  private usage: UsageDetails | undefined;
  private level: string = "DEFAULT";
  private statusMessage: string | undefined;
  private errorType: string | undefined;
  private errorStacktrace: string | undefined;
  private errorHandled: boolean | undefined;
  private ended = false;

  constructor(opts: ObservationOptions) {
    this.id = generateId();
    this.traceId = opts.traceId;
    this.type = opts.type;
    this.name = opts.name;
    this.otelExporter = opts.otelExporter;
    this.startTime = opts.startTime ?? new Date();
    this.parentObservationId = opts.parentObservationId;
    this.input = opts.input;
    this.model = opts.model;
    this.metadata = opts.metadata;
    this.usage = opts.usage;
  }

  /**
   * Update fields on the observation before ending it.
   */
  update(fields: {
    output?: unknown;
    metadata?: Record<string, unknown>;
    usage?: UsageDetails;
    level?: string;
    statusMessage?: string;
    errorType?: string;
    errorStacktrace?: string;
    errorHandled?: boolean;
  }): this {
    if (fields.output !== undefined) this.output = fields.output;
    if (fields.metadata !== undefined) {
      this.metadata = { ...this.metadata, ...fields.metadata };
    }
    if (fields.usage !== undefined) this.usage = fields.usage;
    if (fields.level !== undefined) this.level = fields.level;
    if (fields.statusMessage !== undefined) this.statusMessage = fields.statusMessage;
    if (fields.errorType !== undefined) this.errorType = fields.errorType;
    if (fields.errorStacktrace !== undefined)
      this.errorStacktrace =
        fields.errorStacktrace.length > 8000
          ? fields.errorStacktrace.slice(0, 8000)
          : fields.errorStacktrace;
    if (fields.errorHandled !== undefined) this.errorHandled = fields.errorHandled;
    return this;
  }

  /**
   * End the observation and emit it as an OTel span.
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;

    const tracer = this.otelExporter?.tracer;
    if (!tracer) return;

    // Create a span with the start time
    const span = tracer.startSpan(this.name, { startTime: this.startTime });

    // Set observation attributes
    span.setAttribute(attrs.OBSERVATION_TYPE, OBSERVATION_TYPE_ENUM[this.type] ?? this.type);
    span.setAttribute(attrs.OBSERVATION_INPUT, attrs.safeJson(jsonSerializable(this.input)));
    span.setAttribute(attrs.OBSERVATION_OUTPUT, attrs.safeJson(jsonSerializable(this.output)));
    span.setAttribute(attrs.OBSERVATION_LEVEL, this.level);

    if (this.metadata) {
      span.setAttribute(attrs.OBSERVATION_METADATA, attrs.safeJson(this.metadata));
    }
    if (this.model) {
      span.setAttribute(attrs.OBSERVATION_MODEL, this.model);
    }
    if (this.statusMessage) {
      span.setAttribute(attrs.OBSERVATION_STATUS_MESSAGE, this.statusMessage);
    }
    if (this.errorType) {
      span.setAttribute(attrs.OBSERVATION_ERROR_TYPE, this.errorType);
    }
    if (this.errorStacktrace) {
      span.setAttribute(
        attrs.OBSERVATION_ERROR_STACKTRACE,
        this.errorStacktrace.length > 8000
          ? this.errorStacktrace.slice(0, 8000)
          : this.errorStacktrace,
      );
    }
    if (this.errorHandled !== undefined) {
      span.setAttribute(attrs.OBSERVATION_ERROR_HANDLED, String(this.errorHandled).toLowerCase());
    }
    if (this.usage) {
      span.setAttribute(attrs.OBSERVATION_USAGE_DETAILS, attrs.safeJson(this.usage));
    }

    if (this.level === "ERROR" && this.errorStacktrace) {
      try {
        (span as any).recordException?.(new Error(this.statusMessage || "Error"));
      } catch {
        void 0;
      }
    }

    span.end();
  }

  /**
   * Create a child span under this observation.
   */
  span(opts: { name: string; input?: unknown; metadata?: Record<string, unknown> }): Observation {
    return new Observation({
      traceId: this.traceId,
      type: "span",
      name: opts.name,
      otelExporter: this.otelExporter,
      input: opts.input,
      metadata: opts.metadata,
      parentObservationId: this.id,
    });
  }
}
