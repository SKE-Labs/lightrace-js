/**
 * Context registry for automatic capture/restore during tool invocation.
 *
 * Applications register their context variables with getter/setter pairs.
 * During tracing, lightrace captures all registered context values automatically.
 * During remote tool invocation, context is restored before the tool function executes.
 *
 * @example
 * ```ts
 * import { registerContext } from "lightrace";
 *
 * let userId: string | null = null;
 * registerContext("user_id", () => userId, (v) => { userId = v as string; });
 * ```
 */

interface ContextEntry {
  get: () => unknown;
  set: (value: unknown) => void;
}

/** Registry: name -> { get, set } */
const _contextRegistry = new Map<string, ContextEntry>();

/**
 * Register a named context variable for automatic capture/restore.
 *
 * @param name - Key used in the captured context dict.
 * @param getter - Function that returns the current value.
 * @param setter - Function that sets the value.
 */
export function registerContext(
  name: string,
  getter: () => unknown,
  setter: (value: unknown) => void,
): void {
  _contextRegistry.set(name, { get: getter, set: setter });
}

/**
 * Snapshot all registered context variables.
 * Returns a record of name -> value, skipping null/undefined values.
 */
export function captureContext(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, entry] of _contextRegistry) {
    try {
      const val = entry.get();
      if (val != null) {
        result[name] = val;
      }
    } catch {
      // Skip unset context vars
    }
  }
  return result;
}

/**
 * Restore context variables from a captured dict.
 *
 * @param context - Dict of name -> value to restore.
 */
export function restoreContext(context: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(context)) {
    if (name.startsWith("__")) continue; // Skip reserved keys like __configurable
    const entry = _contextRegistry.get(name);
    if (!entry) continue;
    try {
      entry.set(value);
    } catch {
      // Ignore restore failures
    }
  }
}
