import { describe, it, expect, afterEach, vi } from "vitest";
import { Lightrace } from "../src/client.js";

describe("Lightrace client", () => {
  afterEach(async () => {
    const instance = Lightrace.getInstance();
    if (instance) await instance.shutdown();
  });

  it("initializes with default options", () => {
    const lt = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "http://localhost:9999",
      devServer: false,
    });

    expect(Lightrace.getInstance()).toBe(lt);
    expect(lt.getOtelExporter()).not.toBeNull();
    expect(lt.getDevServer()).toBeNull();
  });

  it("does nothing when disabled", () => {
    const lt = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      enabled: false,
    });

    expect(lt.getOtelExporter()).toBeNull();
    expect(lt.getDevServer()).toBeNull();
  });

  it("starts dev server when devServer=true", async () => {
    // Mock fetch to prevent actual HTTP calls to register tools
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

    const lt = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "http://localhost:9999",
      devServer: true,
    });

    // Wait for async dev server startup
    await new Promise((r) => setTimeout(r, 100));

    expect(lt.getDevServer()).not.toBeNull();
    expect(lt.getDevServer()!.getPort()).toBeGreaterThan(0);

    fetchSpy.mockRestore();
  });

  it("does not start dev server when devServer=false", () => {
    const lt = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "http://localhost:9999",
      devServer: false,
    });

    expect(lt.getDevServer()).toBeNull();
  });

  it("stores userId and sessionId", () => {
    const lt = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "http://localhost:9999",
      devServer: false,
      userId: "user-1",
      sessionId: "sess-1",
    });

    expect(lt.userId).toBe("user-1");
    expect(lt.sessionId).toBe("sess-1");
  });

  it("shuts down cleanly", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

    const lt = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "http://localhost:9999",
      devServer: true,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(lt.getDevServer()!.getPort()).toBeGreaterThan(0);

    await lt.shutdown();
    expect(Lightrace.getInstance()).toBeNull();
    expect(lt.getOtelExporter()).toBeNull();
    expect(lt.getDevServer()).toBeNull();

    fetchSpy.mockRestore();
  });

  it("singleton pattern works", () => {
    const lt1 = new Lightrace({
      publicKey: "pk-test",
      secretKey: "sk-test",
      host: "http://localhost:9999",
      devServer: false,
    });

    expect(Lightrace.getInstance()).toBe(lt1);

    const lt2 = new Lightrace({
      publicKey: "pk-test2",
      secretKey: "sk-test2",
      host: "http://localhost:9999",
      devServer: false,
    });

    // Second instance replaces the first
    expect(Lightrace.getInstance()).toBe(lt2);
  });
});
