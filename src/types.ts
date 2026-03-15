/** Observation types supported by lightrace. */
export type ObservationType = "span" | "generation" | "event" | "tool" | "chain";

/** Map user-facing type strings to ingestion event types [create, update]. */
export const EVENT_TYPE_MAP: Record<string, [createType: string, updateType: string]> = {
  span: ["span-create", "span-update"],
  generation: ["generation-create", "generation-update"],
  event: ["event-create", "event-create"],
  tool: ["tool-create", "tool-update"],
  chain: ["chain-create", "chain-update"],
};

/** Map type strings to observation type enum values. */
export const OBSERVATION_TYPE_ENUM: Record<string, string> = {
  span: "SPAN",
  generation: "GENERATION",
  event: "EVENT",
  tool: "TOOL",
  chain: "CHAIN",
};

/** Options for the trace() wrapper. */
export interface TraceOptions {
  /** Observation type. undefined = root trace. */
  type?: ObservationType;
  /** Override observation name (defaults to the name argument). */
  name?: string;
  /** For type="tool": register for remote invocation. Default: true. */
  invoke?: boolean;
  /** For type="generation": LLM model name. */
  model?: string;
  /** Optional Zod schema for tool input (auto-converted to JSON Schema). */
  inputSchema?: { _def?: unknown };
  /** Static metadata attached to every call. */
  metadata?: Record<string, unknown>;
}

/** A single event to be batched and sent to the ingestion endpoint. */
export interface TraceEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

/** Tool registration entry in the local registry. */
export interface ToolRegistryEntry {
  fn: (...args: unknown[]) => unknown;
  inputSchema: Record<string, unknown> | null;
}

/** WebSocket messages from SDK to backend. */
export type SdkMessage =
  | {
      type: "register";
      sdkInstanceId: string;
      tools: Array<{ name: string; inputSchema: unknown }>;
    }
  | {
      type: "result";
      nonce: string;
      output: unknown;
      error?: string;
      durationMs: number;
      signature: string;
    }
  | { type: "heartbeat" };

/** WebSocket messages from backend to SDK. */
export type ServerMessage =
  | { type: "connected"; sessionToken: string }
  | { type: "registered"; tools: string[] }
  | {
      type: "invoke";
      nonce: string;
      tool: string;
      input: unknown;
      signature: string;
    }
  | { type: "heartbeat_ack" }
  | { type: "error"; message: string };
