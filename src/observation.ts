/**
 * Imperative Observation handle for span / generation / event.
 */
import type { TraceEvent, UsageDetails } from "./types.js";
import { EVENT_TYPE_MAP, OBSERVATION_TYPE_ENUM } from "./types.js";
import { generateId, jsonSerializable } from "./utils.js";
import type { BatchExporter } from "./exporter.js";

export interface ObservationOptions {
  traceId: string;
  type: "span" | "generation" | "event";
  name: string;
  exporter: BatchExporter | null;
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
  private readonly exporter: BatchExporter | null;
  private readonly startTime: Date;
  private readonly parentObservationId: string | undefined;

  private input: unknown;
  private output: unknown;
  private model: string | undefined;
  private metadata: Record<string, unknown> | undefined;
  private usage: UsageDetails | undefined;
  private level: string = "DEFAULT";
  private statusMessage: string | undefined;
  private ended = false;

  constructor(opts: ObservationOptions) {
    this.id = generateId();
    this.traceId = opts.traceId;
    this.type = opts.type;
    this.name = opts.name;
    this.exporter = opts.exporter;
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
  }): this {
    if (fields.output !== undefined) this.output = fields.output;
    if (fields.metadata !== undefined) {
      this.metadata = { ...this.metadata, ...fields.metadata };
    }
    if (fields.usage !== undefined) this.usage = fields.usage;
    if (fields.level !== undefined) this.level = fields.level;
    if (fields.statusMessage !== undefined) this.statusMessage = fields.statusMessage;
    return this;
  }

  /**
   * End the observation and emit the trace event.
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;

    const endTime = new Date();
    const createType = EVENT_TYPE_MAP[this.type]?.[0] ?? "span-create";

    const body: Record<string, unknown> = {
      id: this.id,
      traceId: this.traceId,
      type: OBSERVATION_TYPE_ENUM[this.type] ?? this.type,
      name: this.name,
      startTime: this.startTime.toISOString(),
      endTime: endTime.toISOString(),
      input: jsonSerializable(this.input),
      output: jsonSerializable(this.output),
      metadata: this.metadata ?? null,
      model: this.model ?? null,
      level: this.level,
      statusMessage: this.statusMessage ?? null,
      parentObservationId: this.parentObservationId ?? null,
    };

    // Add usage fields for generations
    if (this.usage) {
      if (this.usage.promptTokens !== undefined) body.promptTokens = this.usage.promptTokens;
      if (this.usage.completionTokens !== undefined)
        body.completionTokens = this.usage.completionTokens;
      if (this.usage.totalTokens !== undefined) body.totalTokens = this.usage.totalTokens;
    }

    const event: TraceEvent = {
      id: generateId(),
      type: createType,
      timestamp: this.startTime.toISOString(),
      body,
    };

    this.exporter?.enqueue(event);
  }

  /**
   * Create a child span under this observation.
   */
  span(opts: { name: string; input?: unknown; metadata?: Record<string, unknown> }): Observation {
    return new Observation({
      traceId: this.traceId,
      type: "span",
      name: opts.name,
      exporter: this.exporter,
      input: opts.input,
      metadata: opts.metadata,
      parentObservationId: this.id,
    });
  }
}
