/**
 * Main Lightrace SDK client.
 */
import { LightraceOtelExporter } from "./otel-exporter.js";
import { AS_ROOT, TRACE_NAME } from "./otel-exporter.js";
import {
  _setOtelExporter,
  _getOtelExporter,
  _setClientDefaults,
  _getTraceContext,
  _getToolRegistry,
} from "./trace.js";
import { DevServer } from "./dev-server.js";
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
  /**
   * Start the embedded dev server for tool invocation from the dashboard.
   * Default: true. Set to false in production environments.
   */
  devServer?: boolean;
  /** Port for the dev server (0 = auto-discover free port). Default: 0. */
  devServerPort?: number;
}

export class Lightrace {
  private static instance: Lightrace | null = null;

  private otelExporter: LightraceOtelExporter | null = null;
  private _devServer: DevServer | null = null;
  private enabled: boolean;
  private host: string;
  private publicKey: string;
  private secretKey: string;
  private devServerEnabled: boolean;
  private devServerPort: number;
  readonly userId: string | undefined;
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
    this.devServerEnabled = options.devServer !== false;
    this.devServerPort = options.devServerPort ?? 0;

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

    if (this.devServerEnabled) {
      this.startDevServer();
    }
  }

  static getInstance(): Lightrace | null {
    return Lightrace.instance;
  }

  getOtelExporter(): LightraceOtelExporter | null {
    return this.otelExporter;
  }

  getDevServer(): DevServer | null {
    return this._devServer;
  }

  // -- Dev server + tool registration -----------------------------------------

  private startDevServer(): void {
    this._devServer = new DevServer({
      port: this.devServerPort,
      publicKey: this.publicKey,
    });

    this._devServer
      .start()
      .then((port) => {
        console.log(`[lightrace] Dev server listening on http://127.0.0.1:${port}`);
        this.registerToolsHttp();
      })
      .catch((err) => {
        console.error("[lightrace] Failed to start dev server:", err);
      });
  }

  private registerToolsHttp(): void {
    const registry = _getToolRegistry();
    if (registry.size === 0) return;

    const callbackUrl = this._devServer?.getCallbackUrl();
    if (!callbackUrl) return;

    const tools = Array.from(registry.entries()).map(([name, entry]) => ({
      name,
      inputSchema: entry.inputSchema,
      description: entry.description ?? null,
    }));

    const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64");

    fetch(`${this.host}/api/public/tools/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ callbackUrl, tools }),
    })
      .then((res) => {
        if (!res.ok) console.warn(`[lightrace] Tool registration returned ${res.status}`);
      })
      .catch((err) => {
        console.error("[lightrace] Failed to register tools:", err.message);
      });
  }

  // -- Flush / shutdown --------------------------------------------------------

  flush(): void {
    this.otelExporter?.flush();
  }

  async shutdown(): Promise<void> {
    if (this._devServer) {
      await this._devServer.stop();
      this._devServer = null;
    }
    if (this.otelExporter) {
      await this.otelExporter.shutdown();
      this.otelExporter = null;
      _setOtelExporter(null);
    }
    Lightrace.instance = null;
  }

  // -- Imperative observation API ----------------------------------------------

  span(opts: {
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    traceId?: string;
    parentObservationId?: string;
  }): Observation {
    return this._createObservation("span", opts);
  }

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

    const ctx = _getTraceContext();
    let traceId = opts.traceId ?? ctx?.traceId;
    const parentObservationId = opts.parentObservationId ?? ctx?.observationId;

    if (!traceId && otelExporter) {
      const tracer = otelExporter.tracer;
      const rootSpan = tracer.startSpan(opts.name);
      rootSpan.setAttribute(AS_ROOT, "true");
      rootSpan.setAttribute(TRACE_NAME, opts.name);
      traceId = rootSpan.spanContext().traceId;
      rootSpan.end();
    }

    if (!traceId) {
      traceId = generateId();
    }

    return new Observation({
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
  }
}
