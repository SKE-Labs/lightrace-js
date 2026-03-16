import { trace as otelTrace, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

// Lightrace OTel span attribute keys — trace-level
export const TRACE_NAME = "lightrace.trace.name";
export const TRACE_USER_ID = "lightrace.trace.user_id";
export const TRACE_SESSION_ID = "lightrace.trace.session_id";
export const TRACE_TAGS = "lightrace.trace.tags";
export const TRACE_PUBLIC = "lightrace.trace.public";
export const TRACE_METADATA = "lightrace.trace.metadata";
export const TRACE_INPUT = "lightrace.trace.input";
export const TRACE_OUTPUT = "lightrace.trace.output";

// Lightrace OTel span attribute keys — observation-level
export const OBSERVATION_TYPE = "lightrace.observation.type";
export const OBSERVATION_METADATA = "lightrace.observation.metadata";
export const OBSERVATION_LEVEL = "lightrace.observation.level";
export const OBSERVATION_STATUS_MESSAGE = "lightrace.observation.status_message";
export const OBSERVATION_INPUT = "lightrace.observation.input";
export const OBSERVATION_OUTPUT = "lightrace.observation.output";

export const OBSERVATION_COMPLETION_START_TIME = "lightrace.observation.completion_start_time";
export const OBSERVATION_MODEL = "lightrace.observation.model";
export const OBSERVATION_MODEL_PARAMETERS = "lightrace.observation.model_parameters";
export const OBSERVATION_USAGE_DETAILS = "lightrace.observation.usage_details";
export const OBSERVATION_COST_DETAILS = "lightrace.observation.cost_details";

// Internal / meta
export const RELEASE = "lightrace.release";
export const VERSION = "lightrace.version";
export const AS_ROOT = "lightrace.internal.as_root";

export function safeJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class LightraceOtelExporter {
  private provider: BasicTracerProvider;
  private _tracer: Tracer;

  constructor(options: {
    host: string;
    publicKey: string;
    secretKey: string;
    flushIntervalMs?: number;
    maxExportBatchSize?: number;
  }) {
    const host = options.host.replace(/\/$/, "");
    const auth = Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64");

    const exporter = new OTLPTraceExporter({
      url: `${host}/api/public/otel/v1/traces`,
      headers: { Authorization: `Basic ${auth}` },
    });

    this.provider = new BasicTracerProvider({
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          scheduledDelayMillis: options.flushIntervalMs ?? 5000,
          maxExportBatchSize: options.maxExportBatchSize ?? 50,
        }),
      ],
    });

    this._tracer = this.provider.getTracer("lightrace-js", "0.2.0");
  }

  get tracer(): Tracer {
    return this._tracer;
  }

  flush(): void {
    this.provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}
