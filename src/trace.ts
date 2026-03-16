/**
 * Unified trace() wrapper for all observation types.
 *
 * Uses OpenTelemetry for trace/span context propagation and export.
 */
import { context, trace as otelTrace, type Span } from "@opentelemetry/api";
import type { LightraceOtelExporter } from "./otel-exporter.js";
import * as attrs from "./otel-exporter.js";
import type { TraceOptions, ToolRegistryEntry } from "./types.js";
import { OBSERVATION_TYPE_ENUM } from "./types.js";
import { generateId, jsonSerializable, zodToJsonSchema } from "./utils.js";

/** Global OTel exporter reference (set by Client). */
let _otelExporter: LightraceOtelExporter | null = null;

/** Client-level defaults (set by Client to avoid circular imports). */
let _clientDefaults: { userId?: string; sessionId?: string } = {};

/** Global tool registry for invocable tools. */
const _toolRegistry = new Map<string, ToolRegistryEntry>();

export function _setOtelExporter(exporter: LightraceOtelExporter | null): void {
  _otelExporter = exporter;
}

export function _getOtelExporter(): LightraceOtelExporter | null {
  return _otelExporter;
}

export function _setClientDefaults(defaults: { userId?: string; sessionId?: string }): void {
  _clientDefaults = defaults;
}

/** Get the current trace context from OTel's active span. */
export function _getTraceContext(): { traceId: string; observationId: string | null } | undefined {
  const span = otelTrace.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    observationId: ctx.spanId,
  };
}

export function _getToolRegistry(): Map<string, ToolRegistryEntry> {
  return _toolRegistry;
}

/** Helper to set span attributes for a root trace or child observation. */
function setSpanAttributes(
  span: Span,
  opts: {
    isRoot: boolean;
    obsType: string | null;
    obsName: string;
    input: unknown;
    output: unknown;
    model: string | null;
    metadata: Record<string, unknown> | null;
    level: string;
    statusMessage?: string | null;
    userId?: string;
    sessionId?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    } | null;
  },
): void {
  if (opts.isRoot) {
    span.setAttribute(attrs.AS_ROOT, "true");
    span.setAttribute(attrs.TRACE_NAME, opts.obsName);
    span.setAttribute(attrs.TRACE_INPUT, attrs.safeJson(opts.input));
    span.setAttribute(attrs.TRACE_OUTPUT, attrs.safeJson(opts.output));
    if (opts.metadata) span.setAttribute(attrs.TRACE_METADATA, attrs.safeJson(opts.metadata));
    if (opts.userId) span.setAttribute(attrs.TRACE_USER_ID, opts.userId);
    if (opts.sessionId) span.setAttribute(attrs.TRACE_SESSION_ID, opts.sessionId);
  } else {
    span.setAttribute(
      attrs.OBSERVATION_TYPE,
      OBSERVATION_TYPE_ENUM[opts.obsType!] ?? opts.obsType ?? "SPAN",
    );
    span.setAttribute(attrs.OBSERVATION_INPUT, attrs.safeJson(opts.input));
    span.setAttribute(attrs.OBSERVATION_OUTPUT, attrs.safeJson(opts.output));
    if (opts.metadata) span.setAttribute(attrs.OBSERVATION_METADATA, attrs.safeJson(opts.metadata));
    if (opts.model) span.setAttribute(attrs.OBSERVATION_MODEL, opts.model);
    span.setAttribute(attrs.OBSERVATION_LEVEL, opts.level);
    if (opts.statusMessage) span.setAttribute(attrs.OBSERVATION_STATUS_MESSAGE, opts.statusMessage);
    if (opts.usage) {
      span.setAttribute(attrs.OBSERVATION_USAGE_DETAILS, attrs.safeJson(opts.usage));
    }
  }
}

/**
 * Unified trace wrapper.
 *
 * Signatures:
 *   trace(name, fn)              -- root trace (no options)
 *   trace(name, options, fn)     -- with options
 */
export function trace<T extends (...args: any[]) => any>(
  name: string,
  fnOrOptions: T | TraceOptions,
  maybeFn?: T,
): T {
  let options: TraceOptions;
  let fn: T;

  if (typeof fnOrOptions === "function") {
    options = {};
    fn = fnOrOptions;
  } else {
    options = fnOrOptions;
    fn = maybeFn!;
  }

  const obsName = options.name ?? name;
  const obsType = options.type ?? null;
  const model = options.model ?? null;
  const staticMetadata = options.metadata ?? null;
  const invoke = options.invoke !== false; // default true
  const usage = options.usage ?? null;

  // Resolve userId/sessionId: per-trace option > client default
  const userId = options.userId ?? _clientDefaults.userId;
  const sessionId = options.sessionId ?? _clientDefaults.sessionId;

  // Register tool for remote invocation
  if (obsType === "tool" && invoke) {
    const inputSchema = options.inputSchema ? zodToJsonSchema(options.inputSchema) : null;
    _toolRegistry.set(obsName, {
      fn: fn as (...args: unknown[]) => unknown,
      inputSchema,
    });
  }

  const wrapped = ((...args: unknown[]) => {
    const tracer = _otelExporter?.tracer;
    if (!tracer) return fn(...args);

    const isRoot = obsType === null;

    return tracer.startActiveSpan(obsName, (span) => {
      const execute = () => {
        try {
          const capturedInput = jsonSerializable(args.length === 1 ? args[0] : args);
          const result = fn(...args);

          // Handle async functions
          if (result && typeof result === "object" && typeof result.then === "function") {
            return (result as Promise<unknown>).then(
              (resolved) => {
                setSpanAttributes(span, {
                  isRoot,
                  obsType,
                  obsName,
                  input: capturedInput,
                  output: jsonSerializable(resolved),
                  model,
                  metadata: staticMetadata,
                  level: "DEFAULT",
                  userId,
                  sessionId,
                  usage,
                });
                span.end();
                return resolved;
              },
              (err: Error) => {
                setSpanAttributes(span, {
                  isRoot,
                  obsType,
                  obsName,
                  input: capturedInput,
                  output: null,
                  model,
                  metadata: staticMetadata,
                  level: "ERROR",
                  statusMessage: err.message,
                  userId,
                  sessionId,
                  usage,
                });
                span.end();
                throw err;
              },
            );
          }

          // Sync result
          setSpanAttributes(span, {
            isRoot,
            obsType,
            obsName,
            input: capturedInput,
            output: jsonSerializable(result),
            model,
            metadata: staticMetadata,
            level: "DEFAULT",
            userId,
            sessionId,
            usage,
          });
          span.end();
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setSpanAttributes(span, {
            isRoot,
            obsType,
            obsName,
            input: jsonSerializable(args.length === 1 ? args[0] : args),
            output: null,
            model,
            metadata: staticMetadata,
            level: "ERROR",
            statusMessage: message,
            userId,
            sessionId,
            usage,
          });
          span.end();
          throw err;
        }
      };

      return execute();
    });
  }) as unknown as T;

  // Preserve function name
  Object.defineProperty(wrapped, "name", { value: fn.name || name });

  return wrapped;
}
