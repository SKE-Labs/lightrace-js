import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { registerContext, captureContext, restoreContext } from "../src/context.js";
import { DevServer } from "../src/dev-server.js";
import { _setOtelExporter, _getToolRegistry, trace } from "../src/trace.js";

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
  provider.shutdown();
});

describe("context registry", () => {
  it("registers and captures context values", () => {
    let userId: string | null = "user-1";
    registerContext(
      "user_id",
      () => userId,
      (v) => {
        userId = v as string;
      },
    );

    const captured = captureContext();
    expect(captured).toEqual({ user_id: "user-1" });
  });

  it("skips null/undefined values in capture", () => {
    let val: string | null = null;
    registerContext(
      "nullable_val",
      () => val,
      (v) => {
        val = v as string;
      },
    );

    const captured = captureContext();
    expect(captured["nullable_val"]).toBeUndefined();
  });

  it("restores context from a captured dict", () => {
    let userId = "old";
    registerContext(
      "user_id",
      () => userId,
      (v) => {
        userId = v as string;
      },
    );

    restoreContext({ user_id: "new" });
    expect(userId).toBe("new");
  });

  it("skips reserved keys starting with __", () => {
    let x = "original";
    registerContext(
      "x",
      () => x,
      (v) => {
        x = v as string;
      },
    );

    restoreContext({ __internal: "secret", x: "updated" });
    expect(x).toBe("updated");
  });

  it("skips unregistered context keys", () => {
    // Should not throw
    restoreContext({ unregistered: "value" });
  });

  it("capture and restore roundtrip", () => {
    let a = "1";
    let b = "2";
    registerContext(
      "a",
      () => a,
      (v) => {
        a = v as string;
      },
    );
    registerContext(
      "b",
      () => b,
      (v) => {
        b = v as string;
      },
    );

    const captured = captureContext();
    a = "changed";
    b = "changed";
    restoreContext(captured);

    expect(a).toBe("1");
    expect(b).toBe("2");
  });
});

describe("context with dev server", () => {
  let server: DevServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("restores context during tool invocation", async () => {
    let userId = "default";
    registerContext(
      "user_id",
      () => userId,
      (v) => {
        userId = v as string;
      },
    );

    trace("get-user", { type: "tool" }, () => {
      return { user_id: userId };
    });

    server = new DevServer();
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "get-user",
        input: null,
        context: { user_id: "injected-user" },
      }),
    });

    const body = await res.json();
    expect(body.response.output.user_id).toBe("injected-user");
    expect(userId).toBe("default");
  });
});
