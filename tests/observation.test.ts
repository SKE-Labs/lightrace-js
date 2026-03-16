import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Observation } from "../src/observation.js";
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
});

afterEach(() => {
  mock.events = [];
});

describe("Observation - span", () => {
  it("creates a span, updates, and ends it", () => {
    const obs = new Observation({
      traceId: "trace-1",
      type: "span",
      name: "search",
      exporter: mock as any,
      input: { query: "hello" },
    });

    obs.update({ output: { results: ["a", "b"] } });
    obs.end();

    expect(mock.events).toHaveLength(1);
    const event = mock.events[0];
    expect(event.type).toBe("span-create");
    expect(event.body.name).toBe("search");
    expect(event.body.traceId).toBe("trace-1");
    expect(event.body.type).toBe("SPAN");
    expect(event.body.input).toEqual({ query: "hello" });
    expect(event.body.output).toEqual({ results: ["a", "b"] });
    expect(event.body.startTime).toBeDefined();
    expect(event.body.endTime).toBeDefined();
    expect(event.body.level).toBe("DEFAULT");
  });

  it("end() is idempotent", () => {
    const obs = new Observation({
      traceId: "trace-1",
      type: "span",
      name: "test",
      exporter: mock as any,
    });

    obs.end();
    obs.end();

    expect(mock.events).toHaveLength(1);
  });
});

describe("Observation - generation with usage", () => {
  it("includes token usage fields", () => {
    const obs = new Observation({
      traceId: "trace-2",
      type: "generation",
      name: "llm-call",
      exporter: mock as any,
      input: "prompt text",
      model: "gpt-4o",
    });

    obs.update({
      output: "response text",
      usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 },
    });
    obs.end();

    expect(mock.events).toHaveLength(1);
    const event = mock.events[0];
    expect(event.type).toBe("generation-create");
    expect(event.body.model).toBe("gpt-4o");
    expect(event.body.input).toBe("prompt text");
    expect(event.body.output).toBe("response text");
    expect(event.body.promptTokens).toBe(10);
    expect(event.body.completionTokens).toBe(50);
    expect(event.body.totalTokens).toBe(60);
  });

  it("allows partial usage", () => {
    const obs = new Observation({
      traceId: "trace-2",
      type: "generation",
      name: "gen",
      exporter: mock as any,
      usage: { totalTokens: 100 },
    });
    obs.end();

    expect(mock.events[0].body.totalTokens).toBe(100);
    expect(mock.events[0].body.promptTokens).toBeUndefined();
  });
});

describe("Observation - event (auto-ended)", () => {
  it("is emitted immediately when auto-ended", () => {
    // Simulating what Lightrace.event() does
    const obs = new Observation({
      traceId: "trace-3",
      type: "event",
      name: "user-click",
      exporter: mock as any,
      input: { button: "submit" },
    });
    obs.end();

    expect(mock.events).toHaveLength(1);
    const event = mock.events[0];
    expect(event.type).toBe("event-create");
    expect(event.body.type).toBe("EVENT");
    expect(event.body.name).toBe("user-click");
    expect(event.body.input).toEqual({ button: "submit" });
  });
});

describe("Observation - nested spans", () => {
  it("creates a child span with correct parentObservationId", () => {
    const parent = new Observation({
      traceId: "trace-4",
      type: "span",
      name: "parent-span",
      exporter: mock as any,
      input: "parent-input",
    });

    const child = parent.span({
      name: "child-span",
      input: "child-input",
    });

    child.update({ output: "child-output" });
    child.end();
    parent.update({ output: "parent-output" });
    parent.end();

    expect(mock.events).toHaveLength(2);

    const childEvent = mock.events[0];
    const parentEvent = mock.events[1];

    // Child should share the same traceId
    expect(childEvent.body.traceId).toBe("trace-4");
    expect(parentEvent.body.traceId).toBe("trace-4");

    // Child should have parent's id as parentObservationId
    expect(childEvent.body.parentObservationId).toBe(parent.id);
    expect(parentEvent.body.parentObservationId).toBeNull();

    expect(childEvent.body.name).toBe("child-span");
    expect(childEvent.body.output).toBe("child-output");
    expect(parentEvent.body.name).toBe("parent-span");
    expect(parentEvent.body.output).toBe("parent-output");
  });

  it("supports multiple levels of nesting", () => {
    const root = new Observation({
      traceId: "trace-5",
      type: "span",
      name: "root",
      exporter: mock as any,
    });

    const mid = root.span({ name: "mid" });
    const leaf = mid.span({ name: "leaf" });

    leaf.end();
    mid.end();
    root.end();

    expect(mock.events).toHaveLength(3);

    const leafEvent = mock.events[0];
    const midEvent = mock.events[1];
    const rootEvent = mock.events[2];

    expect(leafEvent.body.parentObservationId).toBe(mid.id);
    expect(midEvent.body.parentObservationId).toBe(root.id);
    expect(rootEvent.body.parentObservationId).toBeNull();
  });
});

describe("Observation - update fields", () => {
  it("merges metadata on update", () => {
    const obs = new Observation({
      traceId: "trace-6",
      type: "span",
      name: "meta-test",
      exporter: mock as any,
      metadata: { key1: "val1" },
    });

    obs.update({ metadata: { key2: "val2" } });
    obs.end();

    expect(mock.events[0].body.metadata).toEqual({ key1: "val1", key2: "val2" });
  });

  it("supports level and statusMessage", () => {
    const obs = new Observation({
      traceId: "trace-7",
      type: "span",
      name: "error-span",
      exporter: mock as any,
    });

    obs.update({ level: "ERROR", statusMessage: "something went wrong" });
    obs.end();

    expect(mock.events[0].body.level).toBe("ERROR");
    expect(mock.events[0].body.statusMessage).toBe("something went wrong");
  });
});
