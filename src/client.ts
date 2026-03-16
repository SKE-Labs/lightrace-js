/**
 * Main Lightrace SDK client.
 */
import { BatchExporter } from "./exporter.js";
import { _setExporter, _setClientDefaults, _getTraceContext } from "./trace.js";
import { Observation } from "./observation.js";
import { generateId } from "./utils.js";
import type { UsageDetails } from "./types.js";

export interface LightraceOptions {
  publicKey?: string;
  secretKey?: string;
  host?: string;
  flushAt?: number;
  flushInterval?: number;
  timeout?: number;
  enabled?: boolean;
  /** Default user ID for all traces. */
  userId?: string;
  /** Default session ID for all traces. */
  sessionId?: string;
}

export class Lightrace {
  private static instance: Lightrace | null = null;

  private exporter: BatchExporter | null = null;
  private enabled: boolean;
  private host: string;
  private publicKey: string;
  private secretKey: string;
  /** Default user ID for all traces. */
  readonly userId: string | undefined;
  /** Default session ID for all traces. */
  readonly sessionId: string | undefined;

  constructor(options: LightraceOptions = {}) {
    this.publicKey = options.publicKey ?? process.env.LIGHTRACE_PUBLIC_KEY ?? "";
    this.secretKey = options.secretKey ?? process.env.LIGHTRACE_SECRET_KEY ?? "";
    this.host = (options.host ?? process.env.LIGHTRACE_HOST ?? "http://localhost:3002").replace(
      /\/$/,
      "",
    );
    this.enabled = options.enabled !== false;
    this.userId = options.userId;
    this.sessionId = options.sessionId;

    if (!this.enabled) return;

    this.exporter = new BatchExporter({
      host: this.host,
      publicKey: this.publicKey,
      secretKey: this.secretKey,
      flushAt: options.flushAt,
      flushInterval: options.flushInterval,
      timeout: options.timeout,
    });

    _setExporter(this.exporter);
    _setClientDefaults({ userId: this.userId, sessionId: this.sessionId });
    Lightrace.instance = this;
  }

  static getInstance(): Lightrace | null {
    return Lightrace.instance;
  }

  /** Get the exporter (used by Observation). */
  getExporter(): BatchExporter | null {
    return this.exporter;
  }

  flush(): void {
    this.exporter?.flush();
  }

  async shutdown(): Promise<void> {
    if (this.exporter) {
      await this.exporter.shutdown();
      _setExporter(null);
    }
    Lightrace.instance = null;
  }

  /**
   * Create a span observation imperatively.
   */
  span(opts: {
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    traceId?: string;
    parentObservationId?: string;
  }): Observation {
    return this._createObservation("span", opts);
  }

  /**
   * Create a generation observation imperatively.
   */
  generation(opts: {
    name: string;
    input?: unknown;
    model?: string;
    metadata?: Record<string, unknown>;
    usage?: UsageDetails;
    traceId?: string;
    parentObservationId?: string;
  }): Observation {
    return this._createObservation("generation", opts);
  }

  /**
   * Create an event observation imperatively (auto-ended).
   */
  event(opts: {
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    traceId?: string;
    parentObservationId?: string;
  }): Observation {
    const obs = this._createObservation("event", opts);
    obs.end();
    return obs;
  }

  private _createObservation(
    type: "span" | "generation" | "event",
    opts: {
      name: string;
      input?: unknown;
      model?: string;
      metadata?: Record<string, unknown>;
      usage?: UsageDetails;
      traceId?: string;
      parentObservationId?: string;
    },
  ): Observation {
    const exporter = this.exporter;

    // Resolve trace context: explicit > ALS context > create new root trace
    const ctx = _getTraceContext();
    let traceId = opts.traceId ?? ctx?.traceId;
    const parentObservationId = opts.parentObservationId ?? ctx?.observationId ?? undefined;

    // If no trace context, create an implicit root trace
    if (!traceId) {
      traceId = generateId();
      // Emit root trace event
      if (exporter) {
        exporter.enqueue({
          id: generateId(),
          type: "trace-create",
          timestamp: new Date().toISOString(),
          body: {
            id: traceId,
            name: opts.name,
            timestamp: new Date().toISOString(),
            userId: this.userId,
            sessionId: this.sessionId,
          },
        });
      }
    }

    const obs = new Observation({
      traceId,
      type,
      name: opts.name,
      exporter,
      input: opts.input,
      model: opts.model,
      metadata: opts.metadata,
      usage: opts.usage,
      parentObservationId: parentObservationId ?? undefined,
    });

    return obs;
  }
}
