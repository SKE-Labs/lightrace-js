import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Create HMAC-SHA256 signature for a tool invocation.
 */
export function sign(
  sessionToken: string,
  nonce: string,
  tool: string,
  inputData: unknown,
): string {
  const payload =
    nonce + tool + JSON.stringify(inputData, Object.keys((inputData as object) ?? {}).sort());
  return createHmac("sha256", sessionToken).update(payload).digest("hex");
}

/**
 * Verify HMAC-SHA256 signature.
 */
export function verify(
  sessionToken: string,
  nonce: string,
  tool: string,
  inputData: unknown,
  signature: string,
): boolean {
  const expected = sign(sessionToken, nonce, tool, inputData);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/**
 * Tracks single-use nonces with TTL to prevent replay attacks.
 */
export class NonceTracker {
  private seen = new Map<string, number>();
  private ttlMs: number;

  constructor(ttlSeconds = 60) {
    this.ttlMs = ttlSeconds * 1000;
  }

  /** Returns true if the nonce is fresh (not seen before). Marks it as used. */
  checkAndMark(nonce: string): boolean {
    this.cleanup();
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, Date.now());
    return true;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [nonce, time] of this.seen) {
      if (time < cutoff) this.seen.delete(nonce);
    }
  }
}
