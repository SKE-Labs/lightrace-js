/**
 * Main LightRace SDK client.
 */
import { BatchExporter } from "./exporter.js";
import { _setExporter } from "./trace.js";

export interface LightRaceOptions {
  publicKey: string;
  secretKey: string;
  host?: string;
  flushAt?: number;
  flushInterval?: number;
  timeout?: number;
  enabled?: boolean;
}

export class LightRace {
  private static instance: LightRace | null = null;

  private exporter: BatchExporter | null = null;
  private enabled: boolean;
  private host: string;
  private publicKey: string;
  private secretKey: string;

  constructor(options: LightRaceOptions) {
    this.publicKey = options.publicKey;
    this.secretKey = options.secretKey;
    this.host = (options.host ?? "http://localhost:3002").replace(/\/$/, "");
    this.enabled = options.enabled !== false;

    if (!this.enabled) return;

    this.exporter = new BatchExporter({
      host: this.host,
      publicKey: this.publicKey,
      secretKey: this.secretKey,
      flushAt: options.flushAt,
      flushInterval: options.flushInterval,
      timeout: options.timeout,
    });

    _setExporter(this.exporter);
    LightRace.instance = this;
  }

  static getInstance(): LightRace | null {
    return LightRace.instance;
  }

  flush(): void {
    this.exporter?.flush();
  }

  async shutdown(): Promise<void> {
    if (this.exporter) {
      await this.exporter.shutdown();
      _setExporter(null);
    }
    LightRace.instance = null;
  }
}
