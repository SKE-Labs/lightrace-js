<p align="center">
  <img src="https://raw.githubusercontent.com/SKE-Labs/lightrace/main/packages/frontend/public/white_transparent.png" alt="LightRace" width="280" />
</p>

<h1 align="center">lightrace-js</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/lightrace"><img src="https://img.shields.io/npm/v/lightrace?style=flat-square&color=ff1a1a" alt="npm version" /></a>
  <a href="https://github.com/SKE-Labs/lightrace-js/stargazers"><img src="https://img.shields.io/github/stars/SKE-Labs/lightrace-js?style=flat-square" alt="GitHub stars" /></a>
  <a href="https://github.com/SKE-Labs/lightrace-js/blob/main/LICENSE"><img src="https://img.shields.io/github/license/SKE-Labs/lightrace-js?style=flat-square" alt="License" /></a>
</p>

<p align="center">Lightweight LLM tracing SDK for TypeScript/JavaScript with remote tool invocation.</p>

---

## Install

```bash
npm install lightrace
# or
yarn add lightrace
# or
pnpm add lightrace
```

## Quick Start

```typescript
import { Lightrace, trace } from "lightrace";

const lt = new Lightrace({
  publicKey: "pk-lt-demo",
  secretKey: "sk-lt-demo",
  host: "http://localhost:3000",
});

// Root trace
const runAgent = trace("run-agent", async (query: string) => {
  const results = await search(query);
  return results;
});

// Span
const search = trace("search", { type: "span" }, async (query: string) => {
  return ["result1", "result2"];
});

// Generation (LLM call)
const generate = trace(
  "generate",
  { type: "generation", model: "gpt-4o" },
  async (prompt: string) => {
    return "LLM response";
  },
);

// Tool — remotely invocable from the Lightrace UI
const weatherLookup = trace("weather", { type: "tool" }, async (input: { city: string }) => {
  return { temp: 72, unit: "F" };
});

// Tool — traced but NOT remotely invocable
const readFile = trace("read-file", { type: "tool", invoke: false }, async (path: string) => {
  return "file contents";
});

await runAgent("hello");
lt.flush();
await lt.shutdown();
```

## `trace()` API

```typescript
// Root trace (no options)
trace(name, fn);

// With options
trace(name, options, fn);
```

### Options

| Option        | Type      | Default     | Description                                              |
| ------------- | --------- | ----------- | -------------------------------------------------------- |
| `type`        | `string`  | `undefined` | `"span"`, `"generation"`, `"tool"`, `"chain"`, `"event"` |
| `invoke`      | `boolean` | `true`      | For `type: "tool"`: register for remote invocation       |
| `model`       | `string`  | `undefined` | For `type: "generation"`: LLM model name                 |
| `inputSchema` | `ZodType` | `undefined` | Optional Zod schema for tool input                       |
| `metadata`    | `Record`  | `undefined` | Static metadata attached to every call                   |

## Integrations

### Anthropic

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { Lightrace, trace } from "lightrace";
import { LightraceAnthropicInstrumentor } from "lightrace/integrations/anthropic";

const lt = new Lightrace({ publicKey: "pk-lt-demo", secretKey: "sk-lt-demo" });

const anthropic = new Anthropic();
const instrumentor = new LightraceAnthropicInstrumentor({ client: lt });
instrumentor.instrument(anthropic);

const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 256,
  messages: [{ role: "user", content: "What is the capital of Mongolia?" }],
});

lt.flush();
await lt.shutdown();
```

### OpenAI

```typescript
import OpenAI from "openai";
import { Lightrace, trace } from "lightrace";
import { LightraceOpenAIInstrumentor } from "lightrace/integrations/openai";

const lt = new Lightrace({ publicKey: "pk-lt-demo", secretKey: "sk-lt-demo" });

const openai = new OpenAI();
const instrumentor = new LightraceOpenAIInstrumentor({ client: lt });
instrumentor.instrument(openai);

const response = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  max_tokens: 256,
  messages: [{ role: "user", content: "What is the speed of light?" }],
});

lt.flush();
await lt.shutdown();
```

### LangChain

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { Lightrace } from "lightrace";
import { LightraceCallbackHandler } from "lightrace/integrations/langchain";

const lt = new Lightrace({ publicKey: "pk-lt-demo", secretKey: "sk-lt-demo" });

const handler = new LightraceCallbackHandler({ client: lt });
const model = new ChatOpenAI({ model: "gpt-4o-mini", maxTokens: 256 });

const response = await model.invoke("What is the speed of light?", {
  callbacks: [handler],
});

lt.flush();
await lt.shutdown();
```

### Claude Agent SDK

```typescript
import { Lightrace } from "lightrace";
import { tracedQuery } from "lightrace/integrations/claude-agent-sdk";

const lt = new Lightrace({ publicKey: "pk-lt-demo", secretKey: "sk-lt-demo" });

for await (const message of tracedQuery({
  prompt: "What files are in the current directory?",
  options: { maxTurns: 3 },
  client: lt,
  traceName: "file-lister",
})) {
  if (message.type === "result") {
    const r = message as Record<string, unknown>;
    console.log(r.result);
    console.log(`Cost: $${r.total_cost_usd}`);
  }
}

lt.flush();
await lt.shutdown();
```

You can also use the handler directly for more control:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { LightraceAgentHandler } from "lightrace/integrations/claude-agent-sdk";

const handler = new LightraceAgentHandler({ prompt: "Hello", client: lt, traceName: "my-agent" });

for await (const message of query({ prompt: "Hello" })) {
  handler.handle(message);
}
```

## Compatibility

Lightrace server also accepts traces from Langfuse Python/JS SDKs.

## Related

- [Lightrace](https://github.com/SKE-Labs/lightrace) — the main platform (backend + frontend)
- [Lightrace CLI](https://github.com/SKE-Labs/lightrace-cli) — self-host with a single command
- [lightrace-python](https://github.com/SKE-Labs/lightrace-python) — Python SDK

## Development

```bash
yarn install
yarn test
yarn typecheck
yarn lint
yarn format
```

## License

MIT
