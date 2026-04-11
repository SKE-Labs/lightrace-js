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
import { _getToolRegistry } from "./trace.js";
import { jsonSerializable } from "./utils.js";
import { captureContext, restoreContext } from "./context.js";

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
