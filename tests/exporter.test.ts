import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatchExporter } from "../src/exporter.js";

describe("BatchExporter", () => {
  it("enqueues and flushes events", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 207 }));

    const exporter = new BatchExporter({
      host: "http://localhost:3000",
      publicKey: "pk-test",
      secretKey: "sk-test",
      flushAt: 100,
      flushInterval: 9999,
    });

    exporter.enqueue({
      id: "evt-1",
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: "trace-1", name: "test" },
    });

    exporter.flush();

    // Give async send time to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/public/ingestion");
    expect(opts?.method).toBe("POST");

    const body = JSON.parse(opts?.body as string);
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].type).toBe("trace-create");

    await exporter.shutdown();
    fetchSpy.mockRestore();
  });

  it("auto-flushes at threshold", () => {
    const exporter = new BatchExporter({
      host: "http://localhost:3000",
      publicKey: "pk-test",
      secretKey: "sk-test",
      flushAt: 2,
      flushInterval: 9999,
    });

    const flushSpy = vi.spyOn(exporter as any, "doFlush");

    exporter.enqueue({
      id: "1",
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: "t1" },
    });
    expect(flushSpy).not.toHaveBeenCalled();

    exporter.enqueue({
      id: "2",
      type: "trace-create",
      timestamp: new Date().toISOString(),
      body: { id: "t2" },
    });
    expect(flushSpy).toHaveBeenCalledOnce();

    flushSpy.mockRestore();
  });

  it("sets correct auth header", () => {
    const exporter = new BatchExporter({
      host: "http://localhost:3000",
      publicKey: "pk-test",
      secretKey: "sk-test",
    });

    const expected = `Basic ${btoa("pk-test:sk-test")}`;
    expect((exporter as any).authHeader).toBe(expected);
  });
});
