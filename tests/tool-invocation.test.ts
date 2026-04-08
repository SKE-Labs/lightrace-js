/**
 * Integration tests for the full tool invocation flow.
 *
 * Tests the complete chain:
 *   trace() registers tool → DevServer starts → /health check → /invoke → result
 *
 * Also covers: auth, callbackHost, re-registration, error handling, and
 * smart dispatch consistency with Python SDK.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { DevServer } from "../src/dev-server.js";
import { _setOtelExporter, _getToolRegistry, _setOnToolRegistered, trace } from "../src/trace.js";
import { Lightrace } from "../src/client.js";

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
  _setOnToolRegistered(null);
});

afterEach(async () => {
  _setOtelExporter(null);
  _getToolRegistry().clear();
  _setOnToolRegistered(null);
  await provider.shutdown();
  const instance = Lightrace.getInstance();
  if (instance) await instance.shutdown();
});

// ── Full invocation flow ────────────────────────────────────────────────

describe("Full tool invocation flow", () => {
  let server: DevServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("registers tool, starts server, health check, invoke, get result", async () => {
    // 1. Register a tool
    trace("weather", { type: "tool" }, (input: { city: string }) => {
      return { temp: 72, city: input.city, unit: "F" };
    });

    expect(_getToolRegistry().has("weather")).toBe(true);

    // 2. Start dev server
    server = new DevServer();
    const port = await server.start();
    expect(port).toBeGreaterThan(0);

    // 3. Health check
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.ok).toBe(true);
    const healthBody = await healthRes.json();
    expect(healthBody.response.status).toBe("ok");

    // 4. Invoke tool
    const invokeRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "weather", input: { city: "NYC" } }),
    });

    const invokeBody = await invokeRes.json();
    expect(invokeRes.status).toBe(200);
    expect(invokeBody.code).toBe(200);
    expect(invokeBody.response.output).toEqual({ temp: 72, city: "NYC", unit: "F" });
    expect(invokeBody.response.durationMs).toBeGreaterThanOrEqual(0);
    expect(invokeBody.response.error).toBeUndefined();
  });

  it("invokes async tools correctly", async () => {
    trace("slow-search", { type: "tool" }, async (input: { query: string }) => {
      await new Promise((r) => setTimeout(r, 10));
      return { results: [`Result for: ${input.query}`] };
    });

    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "slow-search", input: { query: "test" } }),
    });

    const body = await res.json();
    expect(body.response.output.results).toEqual(["Result for: test"]);
    expect(body.response.durationMs).toBeGreaterThanOrEqual(10);
  });

  it("handles tool errors gracefully", async () => {
    trace("risky-tool", { type: "tool" }, () => {
      throw new Error("database connection failed");
    });

    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "risky-tool", input: null }),
    });

    const body = await res.json();
    // Server returns 200 with error in response envelope (not HTTP error)
    expect(res.status).toBe(200);
    expect(body.response.output).toBeNull();
    expect(body.response.error).toBe("database connection failed");
    expect(body.response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns 404 for unregistered tool", async () => {
    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "nonexistent", input: {} }),
    });

    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.message).toContain("Tool not found");
  });
});

// ── Auth flow ───────────────────────────────────────────────────────────

describe("Auth flow", () => {
  let server: DevServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("rejects invoke with wrong Bearer token", async () => {
    trace("secret-tool", { type: "tool" }, () => "secret result");

    server = new DevServer({ publicKey: "pk-lt-demo" });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({ tool: "secret-tool", input: null }),
    });

    expect(res.status).toBe(401);
  });

  it("accepts invoke with correct Bearer token", async () => {
    trace("secret-tool", { type: "tool" }, () => "secret result");

    server = new DevServer({ publicKey: "pk-lt-demo" });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer pk-lt-demo",
      },
      body: JSON.stringify({ tool: "secret-tool", input: null }),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.response.output).toBe("secret result");
  });

  it("allows invoke when no publicKey is set (open server)", async () => {
    trace("open-tool", { type: "tool" }, () => "open result");

    server = new DevServer(); // no publicKey
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "open-tool", input: null }),
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.response.output).toBe("open result");
  });
});

// ── Callback host configuration ─────────────────────────────────────────

describe("Callback host configuration", () => {
  let server: DevServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("uses default 127.0.0.1 callback host", async () => {
    server = new DevServer();
    const port = await server.start();
    expect(server.getCallbackUrl()).toBe(`http://127.0.0.1:${port}`);
  });

  it("uses custom callback host for Docker networking", async () => {
    server = new DevServer({ callbackHost: "host.docker.internal" });
    const port = await server.start();
    expect(server.getCallbackUrl()).toBe(`http://host.docker.internal:${port}`);
  });

  it("uses custom IP as callback host", async () => {
    server = new DevServer({ callbackHost: "192.168.1.100" });
    const port = await server.start();
    expect(server.getCallbackUrl()).toBe(`http://192.168.1.100:${port}`);
  });
});

// ── Re-registration callback ────────────────────────────────────────────

describe("Re-registration callback", () => {
  it("fires callback when a new tool is registered after client init", async () => {
    const registeredTools: string[] = [];
    _setOnToolRegistered((name) => registeredTools.push(name));

    // Register a tool — should fire callback
    trace("tool-a", { type: "tool" }, () => "a");
    expect(registeredTools).toEqual(["tool-a"]);

    // Register another
    trace("tool-b", { type: "tool" }, () => "b");
    expect(registeredTools).toEqual(["tool-a", "tool-b"]);
  });

  it("does not fire callback for non-tool traces", () => {
    const registeredTools: string[] = [];
    _setOnToolRegistered((name) => registeredTools.push(name));

    trace("my-span", { type: "span" }, () => "result");
    trace("my-gen", { type: "generation" }, () => "result");

    expect(registeredTools).toEqual([]);
  });

  it("does not fire callback when invoke=false", () => {
    const registeredTools: string[] = [];
    _setOnToolRegistered((name) => registeredTools.push(name));

    trace("non-invocable", { type: "tool", invoke: false }, () => "result");
    expect(registeredTools).toEqual([]);
    expect(_getToolRegistry().has("non-invocable")).toBe(false);
  });

  it("client triggers re-registration via debounced callback", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ registered: [] }), { status: 200 }));

    const lt = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "http://localhost:9999",
      devServer: true,
    });

    // Wait for dev server to start + initial registration
    await new Promise((r) => setTimeout(r, 200));
    const initialCalls = fetchSpy.mock.calls.length;

    // Register a new tool AFTER client init
    trace("late-tool", { type: "tool" }, () => "late result");

    // Wait for debounce (200ms) + async
    await new Promise((r) => setTimeout(r, 400));

    // Should have made at least one more registration call
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls);

    // Check that the re-registration call included the new tool
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1]?.body as string);
    const toolNames = body.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("late-tool");

    fetchSpy.mockRestore();
  });
});

// ── Multiple tools ──────────────────────────────────────────────────────

describe("Multiple tools", () => {
  let server: DevServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("can register and invoke multiple tools on the same server", async () => {
    trace("add", { type: "tool" }, (input: { a: number; b: number }) => ({
      sum: input.a + input.b,
    }));
    trace("multiply", { type: "tool" }, (input: { a: number; b: number }) => ({
      product: input.a * input.b,
    }));
    trace("greet", { type: "tool" }, (input: { name: string }) => `Hello, ${input.name}!`);

    expect(_getToolRegistry().size).toBe(3);

    server = new DevServer();
    const port = await server.start();

    // Invoke each tool
    const addRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "add", input: { a: 5, b: 3 } }),
    });
    expect((await addRes.json()).response.output.sum).toBe(8);

    const mulRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "multiply", input: { a: 4, b: 7 } }),
    });
    expect((await mulRes.json()).response.output.product).toBe(28);

    const greetRes = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "greet", input: { name: "World" } }),
    });
    expect((await greetRes.json()).response.output).toBe("Hello, World!");
  });
});

// ── Health check after server stop ──────────────────────────────────────

describe("Health check lifecycle", () => {
  it("health check fails after server is stopped", async () => {
    trace("tool", { type: "tool" }, () => "ok");

    const server = new DevServer();
    const port = await server.start();

    // Health check should pass
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.ok).toBe(true);

    // Stop server
    await server.stop();
    expect(server.getPort()).toBeNull();
    expect(server.getCallbackUrl()).toBeNull();

    // Health check should fail
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

// ── Retry registration ──────────────────────────────────────────────────

describe("Registration retry", () => {
  it("retries registration on failure", async () => {
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        throw new Error("network error");
      }
      return new Response(JSON.stringify({ registered: ["test-tool"] }), { status: 200 });
    });

    trace("test-tool", { type: "tool" }, () => "ok");

    const lt = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "http://localhost:9999",
      devServer: true,
    });

    // Wait for retries (attempt 1 + 1s sleep + attempt 2 + 2s sleep + attempt 3)
    await new Promise((r) => setTimeout(r, 5000));

    // Should have made at least 3 calls (retried)
    expect(callCount).toBeGreaterThanOrEqual(3);

    fetchSpy.mockRestore();
  }, 10000);
});
