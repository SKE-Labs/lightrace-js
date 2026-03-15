import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { trace, _setExporter, _getToolRegistry } from "../src/trace.js";
import type { TraceEvent } from "../src/types.js";

// Mock exporter that captures events
class MockExporter {
  events: TraceEvent[] = [];
  enqueue(event: TraceEvent) {
    this.events.push(event);
  }
}

let mock: MockExporter;

beforeEach(() => {
  mock = new MockExporter();
  _setExporter(mock as any);
  _getToolRegistry().clear();
});

afterEach(() => {
  _setExporter(null);
  _getToolRegistry().clear();
});

describe("trace() - root trace", () => {
  it("creates a trace event for sync function", () => {
    const fn = trace("my-func", (x: number) => x * 2);
    const result = fn(5);

    expect(result).toBe(10);
    expect(mock.events).toHaveLength(1);
    expect(mock.events[0].type).toBe("trace-create");
    expect(mock.events[0].body.name).toBe("my-func");
    expect(mock.events[0].body.input).toBe(5);
    expect(mock.events[0].body.output).toBe(10);
  });

  it("creates a trace event for async function", async () => {
    const fn = trace("async-func", async (x: number) => x * 3);
    const result = await fn(4);

    expect(result).toBe(12);
    expect(mock.events).toHaveLength(1);
    expect(mock.events[0].body.output).toBe(12);
  });

  it("records errors", () => {
    const fn = trace("failing", () => {
      throw new Error("boom");
    });

    expect(() => fn()).toThrow("boom");
    expect(mock.events).toHaveLength(1);
    expect(mock.events[0].body.level).toBeUndefined(); // root traces don't have level
  });
});

describe("trace() - observations", () => {
  it("creates span observation", () => {
    const fn = trace("search", { type: "span" }, (q: string) => ["result"]);
    const result = fn("hello");

    expect(result).toEqual(["result"]);
    expect(mock.events).toHaveLength(1);
    expect(mock.events[0].type).toBe("span-create");
    expect(mock.events[0].body.name).toBe("search");
    expect(mock.events[0].body.type).toBe("SPAN");
  });

  it("creates generation with model", () => {
    const fn = trace("gen", { type: "generation", model: "gpt-4o" }, () => "answer");
    fn();

    expect(mock.events[0].type).toBe("generation-create");
    expect(mock.events[0].body.model).toBe("gpt-4o");
  });

  it("creates tool with invoke=true (default)", () => {
    const fn = trace("weather", { type: "tool" }, (city: string) => ({
      temp: 72,
    }));
    const result = fn("NYC");

    expect(result).toEqual({ temp: 72 });
    expect(mock.events[0].type).toBe("tool-create");

    // Tool should be registered
    const registry = _getToolRegistry();
    expect(registry.has("weather")).toBe(true);
  });

  it("creates tool with invoke=false", () => {
    const fn = trace("read-file", { type: "tool", invoke: false }, (path: string) => "contents");
    fn("/tmp/test");

    expect(mock.events[0].type).toBe("tool-create");

    // Tool should NOT be registered
    const registry = _getToolRegistry();
    expect(registry.has("read-file")).toBe(false);
  });

  it("handles errors in observations", () => {
    const fn = trace("failing-span", { type: "span" }, () => {
      throw new Error("span error");
    });

    expect(() => fn()).toThrow("span error");
    expect(mock.events[0].body.level).toBe("ERROR");
    expect(mock.events[0].body.statusMessage).toBe("span error");
  });
});

describe("trace() - context propagation", () => {
  it("links child spans to parent trace", () => {
    const child = trace("child", { type: "span" }, () => 42);
    const parent = trace("parent", () => child());

    const result = parent();
    expect(result).toBe(42);
    expect(mock.events).toHaveLength(2);

    // Child emitted first (it completes first)
    const childEvent = mock.events[0];
    const parentEvent = mock.events[1];

    // Child should reference the parent's trace ID
    expect(childEvent.body.traceId).toBe(parentEvent.body.id);
  });

  it("links nested async spans", async () => {
    const innerSpan = trace("inner", { type: "span" }, async () => "inner-result");
    const outerTrace = trace("outer", async () => innerSpan());

    const result = await outerTrace();
    expect(result).toBe("inner-result");
    expect(mock.events).toHaveLength(2);

    const innerEvent = mock.events[0];
    const outerEvent = mock.events[1];
    expect(innerEvent.body.traceId).toBe(outerEvent.body.id);
  });
});

describe("trace() - custom name", () => {
  it("uses custom name from options", () => {
    const fn = trace("original", { type: "span", name: "custom" }, () => null);
    fn();
    expect(mock.events[0].body.name).toBe("custom");
  });
});
