/**
 * WebSocket client for remote tool invocation.
 */
import WebSocket from "ws";
import type { ServerMessage } from "./types.js";
import { _getToolRegistry } from "./trace.js";
import { generateId } from "./utils.js";
import { sign, verify, NonceTracker } from "./security.js";
import { jsonSerializable } from "./utils.js";

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

  private async handleInvoke(
    ws: WebSocket,
    msg: { nonce: string; tool: string; input: unknown; signature: string },
  ): Promise<void> {
    const { nonce, tool, input, signature: sig } = msg;

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

    const start = performance.now();
    try {
      let output: unknown;
      if (input && typeof input === "object" && !Array.isArray(input)) {
        output = await entry.fn(input);
      } else {
        output = input !== null && input !== undefined ? await entry.fn(input) : await entry.fn();
      }
      const durationMs = Math.round(performance.now() - start);
      output = jsonSerializable(output);

      ws.send(
        JSON.stringify({
          type: "result",
          nonce,
          output,
          durationMs,
          signature: sign(this.sessionToken, nonce, tool, output),
        }),
      );
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const error = err instanceof Error ? err.message : String(err);

      ws.send(
        JSON.stringify({
          type: "result",
          nonce,
          output: null,
          error,
          durationMs,
          signature: sign(this.sessionToken, nonce, tool, null),
        }),
      );
    }
  }
}
