/**
 * Main Lightrace SDK client.
 */
import { LightraceOtelExporter } from "./otel-exporter.js";
import * as attrs from "./otel-exporter.js";
import {
  _setOtelExporter,
  _getOtelExporter,
  _setClientDefaults,
  _getTraceContext,
  _getToolRegistry,
} from "./trace.js";
import { ToolClient } from "./tool-client.js";
import { Observation } from "./observation.js";
import { generateId } from "./utils.js";
import type { UsageDetails } from "./types.js";

export interface LightraceOptions {
  publicKey?: string;
  secretKey?: string;
  host?: string;
  /** WebSocket host for tool connections (defaults to host if not set). */
  wsHost?: string;
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

  private otelExporter: LightraceOtelExporter | null = null;
  private toolClient: ToolClient | null = null;
  private toolConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private enabled: boolean;
  private host: string;
  private wsHost: string | null;
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
    this.wsHost =
      (options.wsHost ?? process.env.LIGHTRACE_WS_HOST ?? "").replace(/\/$/, "") || null;
    this.enabled = options.enabled !== false;
    this.userId = options.userId;
    this.sessionId = options.sessionId;

    if (!this.enabled) return;

    this.otelExporter = new LightraceOtelExporter({
      host: this.host,
      publicKey: this.publicKey,
      secretKey: this.secretKey,
      flushIntervalMs: options.flushInterval ? options.flushInterval * 1000 : undefined,
      maxExportBatchSize: options.flushAt,
    });

    _setOtelExporter(this.otelExporter);
    _setClientDefaults({ userId: this.userId, sessionId: this.sessionId });
    Lightrace.instance = this;

    // Deferred tool client start -- gives trace() decorators time to register
    this.toolConnectTimer = setTimeout(() => this.autoConnectTools(), 2000);
  }

  static getInstance(): Lightrace | null {
    return Lightrace.instance;
  }

  /** Get the OTel exporter (used by Observation). */
  getOtelExporter(): LightraceOtelExporter | null {
    return this.otelExporter;
  }

  // -- Tool registration -------------------------------------------------------

  private autoConnectTools(): void {
    this.toolConnectTimer = null;
    if (!this.enabled || this.toolClient) return;
    const registry = _getToolRegistry();
    if (registry.size === 0) return;
    this.startToolClient();
  }

  private startToolClient(): void {
    if (this.toolClient) return;
    this.toolClient = new ToolClient({
      host: this.wsHost ?? this.host,
      publicKey: this.publicKey,
      secretKey: this.secretKey,
    });
    this.toolClient.start();
  }

  /**
   * Explicitly start the tool WebSocket client.
   * Call this after all tools have been registered (via trace() or registerTools).
   * Cancels the deferred auto-connect timer if still pending.
   */
  connectTools(): void {
    if (this.toolConnectTimer) {
      clearTimeout(this.toolConnectTimer);
      this.toolConnectTimer = null;
    }
    if (!this.enabled) return;
    this.startToolClient();
  }

  /**
   * Register tools for remote invocation.
   *
   * @param tools - Array of tool descriptors with name, fn, and optional inputSchema.
   */
  registerTools(
    ...tools: Array<{
      name: string;
      fn: (...args: unknown[]) => unknown;
      inputSchema?: Record<string, unknown> | null;
    }>
  ): void {
    const registry = _getToolRegistry();
    for (const tool of tools) {
      registry.set(tool.name, {
        fn: tool.fn,
        inputSchema: tool.inputSchema ?? null,
      });
    }

    if (registry.size > 0 && this.enabled) {
      if (this.toolConnectTimer) {
        clearTimeout(this.toolConnectTimer);
        this.toolConnectTimer = null;
      }
      this.startToolClient();
    }
  }

  // -- Flush / shutdown --------------------------------------------------------

  flush(): void {
    this.otelExporter?.flush();
  }

  async shutdown(): Promise<void> {
    if (this.toolConnectTimer) {
      clearTimeout(this.toolConnectTimer);
      this.toolConnectTimer = null;
    }
    if (this.toolClient) {
      this.toolClient.stop();
      this.toolClient = null;
    }
    if (this.otelExporter) {
      await this.otelExporter.shutdown();
      _setOtelExporter(null);
    }
    Lightrace.instance = null;
  }

  // -- Imperative observation API ----------------------------------------------

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
    const otelExporter = this.otelExporter;

    // Resolve trace context: explicit > OTel active span > create new root trace
    const ctx = _getTraceContext();
    let traceId = opts.traceId ?? ctx?.traceId;
    const parentObservationId = opts.parentObservationId ?? ctx?.observationId ?? undefined;

    // If no trace context, create an implicit root trace via OTel span
    if (!traceId && otelExporter) {
      const tracer = otelExporter.tracer;
      const rootSpan = tracer.startSpan(opts.name);
      rootSpan.setAttribute(attrs.AS_ROOT, "true");
      rootSpan.setAttribute(attrs.TRACE_NAME, opts.name);
      traceId = rootSpan.spanContext().traceId;
      rootSpan.end();
    }

    if (!traceId) {
      traceId = generateId();
    }

    const obs = new Observation({
      traceId,
      type,
      name: opts.name,
      otelExporter,
      input: opts.input,
      model: opts.model,
      metadata: opts.metadata,
      usage: opts.usage,
      parentObservationId: parentObservationId ?? undefined,
    });

    return obs;
  }
}
