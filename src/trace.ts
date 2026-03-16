/**
 * Unified trace() wrapper for all observation types.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceEvent, TraceOptions, ToolRegistryEntry } from "./types.js";
import { EVENT_TYPE_MAP, OBSERVATION_TYPE_ENUM } from "./types.js";
import { generateId, jsonSerializable, zodToJsonSchema } from "./utils.js";
import type { BatchExporter } from "./exporter.js";

/** Context for trace propagation. */
interface TraceContext {
  traceId: string;
  observationId: string | null;
}

const asyncStorage = new AsyncLocalStorage<TraceContext>();

/** Global exporter reference (set by Client). */
let _exporter: BatchExporter | null = null;

/** Client-level defaults (set by Client to avoid circular imports). */
let _clientDefaults: { userId?: string; sessionId?: string } = {};

/** Global tool registry for invocable tools. */
const _toolRegistry = new Map<string, ToolRegistryEntry>();

export function _setExporter(exporter: BatchExporter | null): void {
  _exporter = exporter;
}

export function _setClientDefaults(defaults: { userId?: string; sessionId?: string }): void {
  _clientDefaults = defaults;
}

/** Get the current trace context (used by imperative API). */
export function _getTraceContext(): TraceContext | undefined {
  return asyncStorage.getStore();
}

export function _getToolRegistry(): Map<string, ToolRegistryEntry> {
  return _toolRegistry;
}

/**
 * Unified trace wrapper.
 *
 * Signatures:
 *   trace(name, fn)              — root trace (no options)
 *   trace(name, options, fn)     — with options
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
    const isRoot = obsType === null;
    const entityId = generateId();
    const startTime = new Date();

    // Get parent context
    const parentCtx = asyncStorage.getStore();
    const traceId = isRoot ? entityId : (parentCtx?.traceId ?? generateId());
    const parentObservationId = isRoot ? null : (parentCtx?.observationId ?? null);

    // Set context for children
    const childCtx: TraceContext = {
      traceId,
      observationId: isRoot ? null : entityId,
    };

    const emitEvent = (output: unknown, level: string, statusMessage: string | null) => {
      const endTime = new Date();
      const capturedInput = jsonSerializable(args.length === 1 ? args[0] : args);

      if (isRoot) {
        const body: Record<string, unknown> = {
          id: entityId,
          name: obsName,
          timestamp: startTime.toISOString(),
          input: capturedInput,
          output: jsonSerializable(output),
          metadata: staticMetadata,
        };
        if (userId !== undefined) body.userId = userId;
        if (sessionId !== undefined) body.sessionId = sessionId;

        const event: TraceEvent = {
          id: generateId(),
          type: "trace-create",
          timestamp: startTime.toISOString(),
          body,
        };
        _exporter?.enqueue(event);
      } else {
        const createType = EVENT_TYPE_MAP[obsType!]?.[0] ?? "span-create";
        const body: Record<string, unknown> = {
          id: entityId,
          traceId,
          type: OBSERVATION_TYPE_ENUM[obsType!] ?? obsType,
          name: obsName,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          input: capturedInput,
          output: jsonSerializable(output),
          metadata: staticMetadata,
          model,
          level,
          statusMessage,
          parentObservationId,
        };
        // Add usage fields for generation observations
        if (usage && obsType === "generation") {
          if (usage.promptTokens !== undefined) body.promptTokens = usage.promptTokens;
          if (usage.completionTokens !== undefined) body.completionTokens = usage.completionTokens;
          if (usage.totalTokens !== undefined) body.totalTokens = usage.totalTokens;
        }

        const event: TraceEvent = {
          id: generateId(),
          type: createType,
          timestamp: startTime.toISOString(),
          body,
        };
        _exporter?.enqueue(event);
      }
    };

    const execute = () => {
      try {
        const result = fn(...args);

        // Handle async functions
        if (result && typeof result === "object" && typeof result.then === "function") {
          return (result as Promise<unknown>).then(
            (resolved) => {
              emitEvent(resolved, "DEFAULT", null);
              return resolved;
            },
            (err: Error) => {
              emitEvent(null, "ERROR", err.message ?? String(err));
              throw err;
            },
          );
        }

        // Sync result
        emitEvent(result, "DEFAULT", null);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitEvent(null, "ERROR", message);
        throw err;
      }
    };

    return asyncStorage.run(childCtx, execute);
  }) as unknown as T;

  // Preserve function name
  Object.defineProperty(wrapped, "name", { value: fn.name || name });

  return wrapped;
}
