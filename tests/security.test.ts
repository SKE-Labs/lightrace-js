import { describe, it, expect } from "vitest";
import { sign, verify, NonceTracker } from "../src/security.js";

describe("HMAC signing", () => {
  it("sign and verify roundtrip", () => {
    const token = "test-session-token";
    const nonce = "nonce-123";
    const tool = "weather";
    const input = { city: "NYC" };

    const signature = sign(token, nonce, tool, input);
    expect(typeof signature).toBe("string");
    expect(signature).toHaveLength(64); // SHA-256 hex

    expect(verify(token, nonce, tool, input, signature)).toBe(true);
  });

  it("wrong token fails", () => {
    const sig = sign("correct-token", "nonce", "tool", { a: 1 });
    expect(verify("wrong-token", "nonce", "tool", { a: 1 }, sig)).toBe(false);
  });

  it("wrong nonce fails", () => {
    const sig = sign("token", "nonce-1", "tool", { a: 1 });
    expect(verify("token", "nonce-2", "tool", { a: 1 }, sig)).toBe(false);
  });

  it("wrong input fails", () => {
    const sig = sign("token", "nonce", "tool", { a: 1 });
    expect(verify("token", "nonce", "tool", { a: 2 }, sig)).toBe(false);
  });
});

describe("NonceTracker", () => {
  it("accepts fresh nonce", () => {
    const tracker = new NonceTracker();
    expect(tracker.checkAndMark("nonce-1")).toBe(true);
  });

  it("rejects duplicate nonce", () => {
    const tracker = new NonceTracker();
    expect(tracker.checkAndMark("nonce-1")).toBe(true);
    expect(tracker.checkAndMark("nonce-1")).toBe(false);
  });

  it("cleans up expired nonces", async () => {
    const tracker = new NonceTracker(0.1);
    tracker.checkAndMark("nonce-1");
    await new Promise((r) => setTimeout(r, 150));
    // New nonce should still work after cleanup
    expect(tracker.checkAndMark("nonce-2")).toBe(true);
  });
});
