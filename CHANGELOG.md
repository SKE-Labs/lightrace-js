# Changelog

## 0.1.0

- Initial release
- Unified `trace()` wrapper for all observation types (span, generation, tool, chain, event)
- Batch exporter compatible with Langfuse v3 ingestion format
- Remote tool invocation via WebSocket (HMAC-SHA256 signed)
- Context propagation via `AsyncLocalStorage`
- Optional Zod schema support for tool input validation
