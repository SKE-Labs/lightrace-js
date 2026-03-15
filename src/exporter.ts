import type { TraceEvent } from "./types.js";

/**
 * Batch exporter that sends events to the lightrace ingestion endpoint.
 */
export class BatchExporter {
  private queue: TraceEvent[] = [];
  private endpoint: string;
  private authHeader: string;
  private flushAt: number;
  private flushInterval: number;
  private timeout: number;
  private maxRetries: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = true;

  constructor(options: {
    host: string;
    publicKey: string;
    secretKey: string;
    flushAt?: number;
    flushInterval?: number;
    timeout?: number;
    maxRetries?: number;
  }) {
    const host = options.host.replace(/\/$/, "");
    this.endpoint = `${host}/api/public/ingestion`;
    this.authHeader = `Basic ${btoa(`${options.publicKey}:${options.secretKey}`)}`;
    this.flushAt = options.flushAt ?? 50;
    this.flushInterval = options.flushInterval ?? 5.0;
    this.timeout = options.timeout ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;

    this.timer = setInterval(() => {
      if (this.running) this.doFlush();
    }, this.flushInterval * 1000);

    // Don't keep the process alive just for flushing
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  enqueue(event: TraceEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.flushAt) {
      this.doFlush();
    }
  }

  flush(): void {
    this.doFlush();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.doFlush();
  }

  private doFlush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    const payload = { batch };

    // Fire and forget with retry
    this.sendWithRetry(payload, 0);
  }

  private async sendWithRetry(payload: { batch: TraceEvent[] }, attempt: number): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const resp = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (resp.ok || resp.status < 500) return;
      if (attempt < this.maxRetries) {
        await this.delay(2 ** attempt * 1000);
        return this.sendWithRetry(payload, attempt + 1);
      }
    } catch {
      if (attempt < this.maxRetries) {
        await this.delay(2 ** attempt * 1000);
        return this.sendWithRetry(payload, attempt + 1);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
