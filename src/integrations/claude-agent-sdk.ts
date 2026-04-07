/**
 * Claude Agent SDK integration for Lightrace.
 *
 * Wraps the `query()` async iterator from `@anthropic-ai/claude-agent-sdk`
 * to emit OTel spans for each generation, tool call, and the overall agent run.
 *
 * @example Wrapper (recommended)
 * ```ts
 * import { Lightrace } from "lightrace";
 * import { tracedQuery } from "lightrace/integrations/claude-agent-sdk";
 *
 * const lt = new Lightrace({ publicKey: "pk-lt-demo", secretKey: "sk-lt-demo" });
 *
 * for await (const message of tracedQuery({
 *   prompt: "What files are in the current directory?",
 *   client: lt,
 *   traceName: "file-lister",
 * })) {
 *   if (message.type === "result") console.log(message.result);
 * }
 * ```
 *
 * @example Manual handler
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { LightraceAgentHandler } from "lightrace/integrations/claude-agent-sdk";
 *
 * const handler = new LightraceAgentHandler({ client: lt });
 *
 * for await (const message of query({ prompt: "Hello" })) {
 *   handler.handle(message);
 * }
 * ```
 */

import { generateId, jsonSerializable } from "../utils.js";
import { TracingMixin, normalizeUsage, type TracingMixinOptions } from "./_base.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Minimal message shape — avoids hard dependency on @anthropic-ai/claude-agent-sdk. */
interface SDKMessageLike {
  type: string;
  [key: string]: unknown;
}

export interface LightraceAgentHandlerOptions extends TracingMixinOptions {
  /** The prompt sent to the agent (captured as root trace input). */
  prompt?: string;
}

export interface TracedQueryOptions extends TracingMixinOptions {
  /** The prompt to send to the agent. */
  prompt: string;
  /** `ClaudeAgentOptions` to pass through to `query()`. */
  options?: unknown;
}

// ── Handler ────────────────────────────────────────────────────────────────

/**
 * Processes Claude Agent SDK messages to create Lightrace traces.
 *
 * Call {@link handle} for each message yielded by `query()`. The handler
 * automatically creates a root agent span, child generation spans for each
 * `AssistantMessage`, and child tool spans for each tool call.
 */
export class LightraceAgentHandler extends TracingMixin {
  private prompt: string | undefined;
  private agentRunId: string | null = null;
  private toolRunIds = new Map<string, string>(); // tool_use_id → runId
  private turnCount = 0;

  constructor(opts?: LightraceAgentHandlerOptions) {
    super(opts);
    this.prompt = opts?.prompt;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Process a single message from the agent SDK stream. */
  handle(message: SDKMessageLike): void {
    try {
      switch (message.type) {
        case "assistant":
          this.onAssistant(message);
          break;
        case "user":
          this.onUser(message);
          break;
        case "result":
          this.onResult(message);
          break;
        case "system":
          this.onSystem(message);
          break;
      }
    } catch {
      // Tracing errors should never break the agent loop
    }
  }

  // ── Message handlers ───────────────────────────────────────────────

  private onSystem(msg: SDKMessageLike): void {
    // Capture model from init message for the root span name
    if (msg.subtype === "init" && !this.agentRunId) {
      // We'll use the model info when the first assistant message arrives
    }
  }

  private onAssistant(msg: SDKMessageLike): void {
    // Start root agent span on first assistant message
    if (this.agentRunId === null) {
      this.agentRunId = generateId();
      this.registerRun(this.agentRunId, undefined, {
        type: "span",
        name: this.traceName ?? "claude-agent",
        startTime: new Date(),
        input: this.prompt,
      });
    }

    this.turnCount++;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = msg as any;
    const betaMessage = raw.message;
    const model: string | undefined = raw.model ?? betaMessage?.model;
    const usage = betaMessage?.usage;

    // Create a generation span for this turn
    const genRunId = generateId();
    this.registerRun(genRunId, this.agentRunId, {
      type: "generation",
      name: model ?? "claude",
      startTime: new Date(),
      input: undefined,
      model,
    });

    // Extract content blocks
    const content: unknown[] = betaMessage?.content ?? raw.content ?? [];
    const outputBlocks: Record<string, unknown>[] = [];

    for (const block of content) {
      const b = block as Record<string, unknown>;
      const blockType = b.type as string | undefined;

      if (blockType === "text") {
        outputBlocks.push({ type: "text", text: b.text ?? "" });
      } else if (blockType === "tool_use") {
        const toolId = b.id as string;
        const toolName = b.name as string;
        const toolInput = b.input;

        outputBlocks.push({
          type: "tool_use",
          id: toolId,
          name: toolName,
          input: jsonSerializable(toolInput),
        });

        // Start a tool span (ended when matching user message arrives)
        const toolRunId = generateId();
        this.toolRunIds.set(toolId, toolRunId);
        this.registerRun(toolRunId, this.agentRunId, {
          type: "tool",
          name: toolName,
          startTime: new Date(),
          input: toolInput,
        });
      } else {
        outputBlocks.push(jsonSerializable(b) as Record<string, unknown>);
      }
    }

    // End the generation span (the LLM call itself is complete)
    const normalizedUsage = usage ? normalizeUsage(usage as Record<string, unknown>) : null;
    this.endRun(genRunId, outputBlocks, "DEFAULT", null, normalizedUsage ?? undefined);
  }

  private onUser(msg: SDKMessageLike): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = msg as any;
    const userMessage = raw.message;

    // User messages contain tool results as content blocks
    const content: unknown[] = Array.isArray(userMessage?.content)
      ? userMessage.content
      : Array.isArray(raw.content)
        ? raw.content
        : [];

    for (const block of content) {
      const b = block as Record<string, unknown>;

      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const toolUseId = b.tool_use_id as string;
        const toolRunId = this.toolRunIds.get(toolUseId);
        if (toolRunId) {
          this.toolRunIds.delete(toolUseId);
          const isError = Boolean(b.is_error);
          const output = b.content;
          if (isError) {
            this.endRun(toolRunId, jsonSerializable(output), "ERROR", String(output));
          } else {
            this.endRun(toolRunId, jsonSerializable(output));
          }
        }
      }
    }
  }

  private onResult(msg: SDKMessageLike): void {
    // End any remaining tool spans
    for (const [, toolRunId] of this.toolRunIds) {
      this.endRun(toolRunId, null);
    }
    this.toolRunIds.clear();

    if (this.agentRunId === null) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = msg as any;

    const output: Record<string, unknown> = {};
    if (raw.result !== undefined) output.result = raw.result;
    if (raw.num_turns !== undefined) output.num_turns = raw.num_turns;
    if (raw.total_cost_usd !== undefined) output.total_cost_usd = raw.total_cost_usd;
    if (raw.duration_ms !== undefined) output.duration_ms = raw.duration_ms;
    if (raw.subtype !== undefined) output.subtype = raw.subtype;

    const usage = raw.usage ? normalizeUsage(raw.usage as Record<string, unknown>) : null;
    const isError = Boolean(raw.is_error);

    if (isError) {
      const errorMsg = raw.result ?? raw.subtype ?? "Agent error";
      this.endRun(this.agentRunId, output, "ERROR", String(errorMsg), usage ?? undefined);
    } else {
      this.endRun(this.agentRunId, output, "DEFAULT", null, usage ?? undefined);
    }

    this.agentRunId = null;
    this.turnCount = 0;
  }
}

// ── Wrapper ────────────────────────────────────────────────────────────────

/**
 * Drop-in wrapper around `query()` that adds Lightrace tracing.
 *
 * Messages are yielded through unchanged. Requires `@anthropic-ai/claude-agent-sdk`
 * to be installed.
 */
export async function* tracedQuery(opts: TracedQueryOptions): AsyncGenerator<SDKMessageLike, void> {
  // Dynamic import to avoid hard dependency
  let queryFn: (args: { prompt: string; options?: unknown }) => AsyncIterable<SDKMessageLike>;
  try {
    // Use a variable to prevent TypeScript from resolving the optional peer dep
    const modName = "@anthropic-ai/claude-agent-sdk";
    const mod = await import(/* webpackIgnore: true */ modName);
    queryFn = mod.query;
  } catch {
    throw new Error(
      "@anthropic-ai/claude-agent-sdk is required for this integration. " +
        "Install it with: npm install @anthropic-ai/claude-agent-sdk",
    );
  }

  const handler = new LightraceAgentHandler({
    prompt: opts.prompt,
    client: opts.client,
    userId: opts.userId,
    sessionId: opts.sessionId,
    traceName: opts.traceName,
    metadata: opts.metadata,
  });

  for await (const message of queryFn({ prompt: opts.prompt, options: opts.options })) {
    handler.handle(message as SDKMessageLike);
    yield message as SDKMessageLike;
  }
}
