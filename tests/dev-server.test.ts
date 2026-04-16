import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { DevServer } from "../src/dev-server.js";
import { _setOtelExporter, _getToolRegistry, _getReplayRegistry } from "../src/trace.js";
import { trace } from "../src/trace.js";

let memoryExporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  memoryExporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
  });
  const tracer = provider.getTracer("test");
  _setOtelExporter({ tracer } as any);
  _getToolRegistry().clear();
});

afterEach(() => {
  _setOtelExporter(null);
  _getToolRegistry().clear();
  _getReplayRegistry().clear();
  provider.shutdown();
});

describe("DevServer", () => {
  let server: DevServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("starts on a free port and responds to health check", async () => {
    server = new DevServer();
    const port = await server.start();

    expect(port).toBeGreaterThan(0);
    expect(server.getPort()).toBe(port);
    expect(server.getCallbackUrl()).toBe(`http://127.0.0.1:${port}`);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.code).toBe(200);
    expect(body.message).toBe("OK");
    expect(body.response.status).toBe("ok");
  });

  it("starts on a specified port", async () => {
    server = new DevServer({ port: 0 });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
  });

  it("returns 404 for unknown routes", async () => {
    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it("invokes a registered tool via POST /invoke", async () => {
    const addTool = trace("add", { type: "tool" }, (input: { a: number; b: number }) => {
      return { sum: input.a + input.b };
    });

    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "add", input: { a: 3, b: 4 } }),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.code).toBe(200);
    expect(body.message).toBe("OK");
    expect(body.response.output.sum).toBe(7);
    expect(body.response.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.response.error).toBeUndefined();
  });

  it("returns error for unknown tool", async () => {
    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "nonexistent", input: {} }),
    });

    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.code).toBe(404);
    expect(body.message).toContain("Tool not found");
    expect(body.response).toBeNull();
  });

  it("returns error when tool throws", async () => {
    trace("failing-tool", { type: "tool" }, () => {
      throw new Error("tool broke");
    });

    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "failing-tool", input: null }),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.code).toBe(200);
    expect(body.response.output).toBeNull();
    expect(body.response.error).toBe("tool broke");
    expect(body.response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects requests with wrong auth when publicKey is set", async () => {
    server = new DevServer({ publicKey: "pk-test-123" });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ tool: "add", input: {} }),
    });

    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.code).toBe(401);
    expect(body.message).toBe("Unauthorized");
  });

  it("accepts requests with correct auth", async () => {
    trace("echo", { type: "tool" }, (input: { msg: string }) => input.msg);

    server = new DevServer({ publicKey: "pk-test-123" });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer pk-test-123",
      },
      body: JSON.stringify({ tool: "echo", input: { msg: "hello" } }),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.code).toBe(200);
    expect(body.response.output).toBe("hello");
  });

  it("returns 400 for invalid JSON body", async () => {
    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe(400);
  });

  it("stops cleanly", async () => {
    server = new DevServer();
    const port = await server.start();

    await server.stop();
    expect(server.getPort()).toBeNull();
    expect(server.getCallbackUrl()).toBeNull();

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("handles async tool invocation", async () => {
    trace("async-tool", { type: "tool" }, async (input: { delay: number }) => {
      await new Promise((r) => setTimeout(r, input.delay));
      return { done: true };
    });

    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "async-tool", input: { delay: 10 } }),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.code).toBe(200);
    expect(body.response.output.done).toBe(true);
    expect(body.response.durationMs).toBeGreaterThanOrEqual(10);
  });

  // -- /replay endpoint -------------------------------------------------------

  it("returns 400 when no graph is registered for replay", async () => {
    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_id: "t1",
        tool_name: "search",
        modified_content: "new result",
      }),
    });

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.message).toContain("No graph registered");
  });

  it("returns 422 when required fields are missing", async () => {
    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: "t1" }),
    });

    const body = await res.json();
    expect(res.status).toBe(422);
  });

  it("returns 400 for unsupported handler type", async () => {
    // Register a plain object (not a LangGraph)
    const { _setReplayHandler } = await import("../src/trace.js");
    _setReplayHandler("default", { notAGraph: true });

    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_id: "t1",
        tool_name: "search",
        modified_content: "result",
      }),
    });

    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.message).toContain("not a supported graph type");

    _setReplayHandler("default", undefined as unknown);
  });
});
