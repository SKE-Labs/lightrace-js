/**
 * Lightweight HTTP dev server embedded in the SDK.
 *
 * Starts automatically with `new Lightrace()` to accept tool invocation
 * requests from the Lightrace dashboard (proxied via the backend).
 */
import { type Server } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { _getToolRegistry, _getReplayRegistry } from "./trace.js";
import { jsonSerializable } from "./utils.js";
import { captureContext, restoreContext } from "./context.js";

export interface ForkOptions {
  graph: unknown;
  threadId: string;
  toolCallId?: string;
  toolName: string;
  modifiedContent: string;
  context?: Record<string, unknown>;
  forkedTraceId?: string;
}

type ForkFn = (opts: ForkOptions) => Promise<void>;

function resolveForkFn(handler: unknown): ForkFn | null {
  const h = handler as Record<string, unknown>;

  // LangChain / LangGraph — compiled graph with checkpoint support
  if (typeof h.invoke === "function" && typeof h.updateState === "function") {
    // Lazy import to avoid pulling in @langchain/core when not needed
    return async (opts) => {
      const { forkGraph } = await import("./integrations/langchain.js");
      return forkGraph(opts);
    };
  }

  // TODO: CrewAI fork support
  // TODO: Claude Agent SDK fork support

  return null;
}

function apiResponse(c: Context, code: number, message: string, response: unknown = null) {
  return c.json({ code, message, response }, code as ContentfulStatusCode);
}

export interface DevServerOptions {
  /** Port to bind (0 = auto-discover free port). Default: 0. */
  port?: number;
  /** Public key for request authentication. */
  publicKey?: string;
  /** Host to use in the callback URL registered with the backend. Default: "127.0.0.1". */
  callbackHost?: string;
}

export class DevServer {
  private server: Server | null = null;
  private publicKey: string;
  private assignedPort: number | null = null;
  private requestedPort: number;
  private callbackHost: string;

  constructor(options: DevServerOptions = {}) {
    this.requestedPort = options.port ?? 0;
    this.publicKey = options.publicKey ?? "";
    this.callbackHost = options.callbackHost ?? "127.0.0.1";
  }

  async start(): Promise<number> {
    if (this.server) return this.assignedPort!;

    const app = new Hono();
    const publicKey = this.publicKey;

    app.use("*", cors());
    app.use("/invoke", bodyLimit({ maxSize: 1024 * 1024 }));
    app.use("/replay", bodyLimit({ maxSize: 1024 * 1024 }));

    app.get("/health", (c) => apiResponse(c, 200, "OK", { status: "ok" }));

    app.post("/invoke", async (c) => {
      if (publicKey && c.req.header("Authorization") !== `Bearer ${publicKey}`) {
        return apiResponse(c, 401, "Unauthorized");
      }

      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return apiResponse(c, 400, "Invalid JSON body");
      }

      const { tool, input, context } = body as {
        tool: string;
        input: unknown;
        context?: Record<string, unknown>;
      };

      const registry = _getToolRegistry();
      const entry = registry.get(tool);
      if (!entry) {
        return apiResponse(c, 404, `Tool not found: ${tool}`);
      }

      // Restore captured context, saving old values to reset after invocation
      const savedContext = context ? captureContext() : null;
      if (context) {
        restoreContext(context);
      }

      const start = performance.now();
      try {
        let result: unknown;
        if (input && typeof input === "object" && !Array.isArray(input)) {
          result = await entry.fn(input);
        } else {
          result = input != null ? await entry.fn(input) : await entry.fn();
        }

        const durationMs = Math.round(performance.now() - start);
        return apiResponse(c, 200, "OK", { output: jsonSerializable(result), durationMs });
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        return apiResponse(c, 200, "OK", {
          output: null,
          error: err instanceof Error ? err.message : String(err),
          durationMs,
        });
      } finally {
        if (savedContext) {
          restoreContext(savedContext);
        }
      }
    });

    app.post("/replay", async (c) => {
      if (publicKey && c.req.header("Authorization") !== `Bearer ${publicKey}`) {
        return apiResponse(c, 401, "Unauthorized");
      }

      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return apiResponse(c, 400, "Invalid JSON body");
      }

      const {
        thread_id: threadId,
        tool_call_id: toolCallId,
        tool_name: toolName,
        modified_content: modifiedContent,
        context,
        forked_trace_id: forkedTraceId,
      } = body as {
        thread_id?: string;
        tool_call_id?: string;
        tool_name?: string;
        modified_content?: string;
        context?: Record<string, unknown>;
        forked_trace_id?: string;
      };

      if (!threadId || !toolName || modifiedContent == null) {
        return apiResponse(
          c,
          422,
          "Missing required fields: thread_id, tool_name, modified_content",
        );
      }

      const handler = _getReplayRegistry().get("default");
      if (!handler) {
        return apiResponse(
          c,
          400,
          "No graph registered for replay. Call registerGraph() to enable fork/replay.",
        );
      }

      // Detect framework and resolve fork function
      const forkFn = resolveForkFn(handler);
      if (!forkFn) {
        return apiResponse(
          c,
          400,
          "Registered handler is not a supported graph type. Currently supported: LangChain/LangGraph.",
        );
      }

      // Fire-and-forget: start fork in background, return immediately
      const replayContext = context;
      forkFn({
        graph: handler,
        threadId,
        toolCallId,
        toolName,
        modifiedContent,
        context: replayContext,
        forkedTraceId,
      }).catch((err: unknown) => {
        console.error("[lightrace] Fork replay failed:", err instanceof Error ? err.message : err);
      });

      return apiResponse(c, 200, "OK", { status: "started" });
    });

    return new Promise((resolve, reject) => {
      try {
        const server = serve(
          {
            fetch: app.fetch,
            port: this.requestedPort,
            hostname:
              this.callbackHost === "127.0.0.1" || this.callbackHost === "localhost"
                ? "127.0.0.1"
                : "0.0.0.0",
          },
          (info) => {
            this.assignedPort = info.port;
            this.server = server as Server;
            resolve(info.port);
          },
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this.assignedPort = null;
        resolve();
      });
    });
  }

  getPort(): number | null {
    return this.assignedPort;
  }

  getCallbackUrl(): string | null {
    if (!this.assignedPort) return null;
    return `http://${this.callbackHost}:${this.assignedPort}`;
  }
}
