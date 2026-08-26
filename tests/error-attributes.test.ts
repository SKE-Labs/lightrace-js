import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { trace, _setOtelExporter, _getToolRegistry } from "../src/trace.js";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  context as otelContext,
  ROOT_CONTEXT,
  type ContextManager,
  type Context,
} from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";

class TestContextManager implements ContextManager {
  private _als = new AsyncLocalStorage<Context>();
  active(): Context {
    return this._als.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this._als.run(ctx, () => fn.call(thisArg, ...args)) as ReturnType<F>;
  }
  bind<T>(ctx: Context, fn: T): T {
    const als = this._als;
    return ((...args: unknown[]) => als.run(ctx, () => (fn as Function)(...args))) as unknown as T;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

let provider: BasicTracerProvider;
let memoryExporter: InMemorySpanExporter;

beforeAll(() => {
  otelContext.setGlobalContextManager(new TestContextManager());
});
afterAll(() => {
  otelContext.disable();
});

beforeEach(() => {
  memoryExporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
  const tracer = provider.getTracer("test");
  // @ts-ignore
  _setOtelExporter({ tracer });
  _getToolRegistry().clear();
});

afterEach(async () => {
  _setOtelExporter(null);
  _getToolRegistry().clear();
  await provider.shutdown();
});

function getAttrs(span: any): Record<string, any> {
  return span.attributes || {};
}

describe("trace error attributes", () => {
  it("captures error_type, stacktrace, handled for span error", () => {
    const failing = trace("failing", { type: "span" }, () => {
      throw new Error("boom");
    });

    expect(() => failing()).toThrow("boom");

    const spans = memoryExporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    const attrs = getAttrs(spans[0]);
    expect(attrs["lightrace.observation.error_type"]).toBe("Error");
    // For generic Error, name is Error
    expect(attrs["lightrace.observation.error_stacktrace"]).toContain("failing");
    expect(attrs["lightrace.observation.error_handled"]).toBe("false");
    expect(attrs["lightrace.observation.level"]).toBe("ERROR");
  });

  it("captures ValueError type and truncates stacktrace", () => {
    const failing = trace("tool-failing", { type: "tool" }, () => {
      const err = new Error("x".repeat(10000));
      err.name = "RuntimeError";
      throw err;
    });

    expect(() => failing()).toThrow();

    const spans = memoryExporter.getFinishedSpans();
    const attrs = getAttrs(spans[0]);
    const stack = attrs["lightrace.observation.error_stacktrace"] as string;
    expect(stack.length).toBeLessThanOrEqual(8000);
    expect(attrs["lightrace.observation.error_type"]).toBe("RuntimeError");
  });

  it("captures async error type", async () => {
    const failing = trace("async-failing", { type: "span" }, async () => {
      throw new TypeError("async boom");
    });

    await expect(failing()).rejects.toThrow("async boom");

    const spans = memoryExporter.getFinishedSpans();
    const attrs = getAttrs(spans[0]);
    expect(attrs["lightrace.observation.error_type"]).toBe("TypeError");
    expect(attrs["lightrace.observation.error_handled"]).toBe("false");
  });
});
