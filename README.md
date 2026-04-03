# lightrace-js

Lightweight LLM tracing SDK for TypeScript/JavaScript with remote tool invocation.

## Install

```bash
yarn add lightrace
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

## Compatibility

Lightrace server also accepts traces from Langfuse Python/JS SDKs.

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
