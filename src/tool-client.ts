/**
 * WebSocket client for remote tool invocation.
 *
 * Tool execution is isolated: handleInvoke fires-and-forgets so the WS
 * message handler is never blocked, allowing heartbeats to continue.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import WebSocket from "ws";
import type { ServerMessage, ToolRegistryEntry } from "./types.js";
import { _getToolRegistry } from "./trace.js";
import { generateId } from "./utils.js";
import { restoreContext } from "./context.js";
import { sign, verify, NonceTracker } from "./security.js";
import { jsonSerializable } from "./utils.js";

/** AsyncLocalStorage for invoke state -- tools can access via getInvokeState(). */
const invokeStateStorage = new AsyncLocalStorage<unknown>();

/**
 * Get the state passed with the current tool invocation.
 * Returns undefined if not in an invocation context or no state was provided.
 */
export function getInvokeState(): unknown {
  return invokeStateStorage.getStore();
}

export class ToolClient {
  private host: string;
  private publicKey: string;
  private secretKey: string;
  private sdkInstanceId: string;
  private heartbeatInterval: number;
  private maxReconnectDelay: number;

  private sessionToken: string | null = null;
  private nonceTracker = new NonceTracker(60);
  private running = false;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    host: string;
    publicKey: string;
    secretKey: string;
    sdkInstanceId?: string;
    heartbeatInterval?: number;
    maxReconnectDelay?: number;
  }) {
    this.host = options.host.replace(/\/$/, "");
    this.publicKey = options.publicKey;
    this.secretKey = options.secretKey;
    this.sdkInstanceId = options.sdkInstanceId ?? generateId();
    this.heartbeatInterval = (options.heartbeatInterval ?? 30) * 1000;
    this.maxReconnectDelay = (options.maxReconnectDelay ?? 30) * 1000;
  }

  private get wsUrl(): string {
    return (
      this.host.replace("http://", "ws://").replace("https://", "wss://") + "/api/public/tools/ws"
    );
  }

  start(): void {
    const registry = _getToolRegistry();
    if (registry.size === 0) return;

    this.running = true;
    this.connect(1000);
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(delay: number): void {
    if (!this.running) return;

    const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64");

    const ws = new WebSocket(this.wsUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });

    ws.on("open", () => {
      this.ws = ws;
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        this.handleMessage(ws, msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      this.cleanup();
      if (this.running) {
        const nextDelay = Math.min(delay * 2, this.maxReconnectDelay);
        this.reconnectTimer = setTimeout(() => this.connect(nextDelay), delay);
      }
    });

    ws.on("error", () => {
      // close event will handle reconnection
    });
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.sessionToken = null;
    this.ws = null;
  }

  private handleMessage(ws: WebSocket, msg: ServerMessage): void {
    switch (msg.type) {
      case "connected":
        this.sessionToken = msg.sessionToken;
        this.registerTools(ws);
        this.startHeartbeat(ws);
        break;

      case "registered":
        // Tools registered successfully
        break;

      case "invoke":
        this.handleInvoke(ws, msg);
        break;

      case "heartbeat_ack":
        break;

      case "error":
        console.error(`[lightrace] Server error: ${msg.message}`);
        break;
    }
  }

  private registerTools(ws: WebSocket): void {
    const registry = _getToolRegistry();
    const tools = Array.from(registry.entries()).map(([name, entry]) => ({
      name,
      inputSchema: entry.inputSchema,
    }));

    ws.send(
      JSON.stringify({
        type: "register",
        sdkInstanceId: this.sdkInstanceId,
        tools,
      }),
    );
  }

  private startHeartbeat(ws: WebSocket): void {
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, this.heartbeatInterval);
  }

  /**
   * Handle an invoke message. Validates signature and nonce, then fires off
   * isolated execution without blocking the WS message handler.
   */
  private handleInvoke(
    ws: WebSocket,
    msg: { nonce: string; tool: string; input: unknown; state?: unknown; signature: string },
  ): void {
    const { nonce, tool, input, state, signature: sig } = msg;

    // Verify HMAC
    if (!this.sessionToken || !verify(this.sessionToken, nonce, tool, input, sig)) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid signature" }));
      return;
    }

    // Check nonce freshness
    if (!this.nonceTracker.checkAndMark(nonce)) {
      ws.send(JSON.stringify({ type: "error", message: "Replayed nonce" }));
      return;
    }

    const registry = _getToolRegistry();
    const entry = registry.get(tool);
    if (!entry) {
      ws.send(
        JSON.stringify({
          type: "result",
          nonce,
          output: null,
          error: `Tool not found: ${tool}`,
          durationMs: 0,
          signature: sign(this.sessionToken, nonce, tool, null),
        }),
      );
      return;
    }

    // Fire and forget -- don't block the WS message handler
    this.executeToolIsolated(ws, nonce, tool, input, state, entry).catch((err) =>
      console.error("[lightrace] Tool execution error:", err),
    );
  }

  /**
   * Execute a tool invocation in isolation with a timeout.
   * Runs outside the WS message handler so heartbeats continue flowing.
   */
  private async executeToolIsolated(
    ws: WebSocket,
    nonce: string,
    tool: string,
    input: unknown,
    state: unknown,
    entry: ToolRegistryEntry,
  ): Promise<void> {
    // Restore registered context variables from __lightrace_context
    const contextData =
      state &&
      typeof state === "object" &&
      "__lightrace_context" in (state as Record<string, unknown>)
        ? ((state as Record<string, unknown>).__lightrace_context as Record<string, unknown>)
        : {};
    if (contextData && typeof contextData === "object") {
      restoreContext(contextData);
    }

    const start = performance.now();
    const timeoutMs = 30_000;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        invokeStateStorage.run(state ?? null, async () => {
          let result: unknown;
          if (input && typeof input === "object" && !Array.isArray(input)) {
            result = await entry.fn(input);
          } else {
            result =
              input !== null && input !== undefined ? await entry.fn(input) : await entry.fn();
          }
          return jsonSerializable(result);
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Tool execution timed out")), timeoutMs);
        }),
      ]);
      clearTimeout(timeoutId);

      const durationMs = Math.round(performance.now() - start);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "result",
            nonce,
            output,
            durationMs,
            signature: sign(this.sessionToken!, nonce, tool, output),
          }),
        );
      }
    } catch (err) {
      clearTimeout(timeoutId);
      const durationMs = Math.round(performance.now() - start);
      const error = err instanceof Error ? err.message : String(err);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "result",
            nonce,
            output: null,
            error,
            durationMs,
            signature: sign(this.sessionToken!, nonce, tool, null),
          }),
        );
      }
    }
  }
}
