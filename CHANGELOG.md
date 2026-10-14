# Changelog

All notable changes to script-ai are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-10-14

**A complete rewrite.** v1 was a collection of LLM-calling helpers; v2 is an
embeddable agent core. No v1 API is preserved.

### Added

- **Agent loop** (`createAgent`): streaming ReAct loop with `maxSteps` hard
  boundary; tool failures are fed back to the model as `role:"tool"` results
  and never break the loop; only aborts and fatal provider errors reject
  `run()`.
- **Host-injected tools** (`defineTool`, `ToolRegistry`): MCP-shaped schemas
  (`name` / `description` / `parameters`), per-tool `permission`
  (`allow` / `ask` / `deny`), runtime `register` / `unregister`.
- **Approval hook** (`onBeforeToolCall`): consulted for every non-denied call;
  without a hook, `ask`-grade tools are refused (safe default).
- **Provider normalization**: `createProvider.ollama` (native `/api/chat`
  NDJSON with `thinking` and partial-object tool arguments, or `api: 'compat'`
  for `/v1`) and `createProvider.openaiCompatible` (any OpenAI-compatible
  gateway). One wire protocol: `tools` / `tool_calls` / `role:"tool"`.
- **Structured event stream**: `run:start`, `step:start`, `text`,
  `reasoning`, `toolCall`, `toolDecision`, `toolResult`, `step:end`,
  `run:end`, `error` (plus `'*'` catch-all).
- **Checkpointing**: `snapshot()` / `restore()` with version validation
  (`SnapshotVersionError` on mismatch).
- **Stream robustness**: SSE + NDJSON parsing, tool-call fragment merging for
  both OpenAI string deltas and Ollama partial objects.
- Type definitions (`types/script-ai.d.ts`), bilingual READMEs, three
  examples, 54 `node:test` tests (mock providers + mock HTTP servers — no live
  model required).

### Changed

- Zero runtime dependencies (v1 shipped axios / marked / highlight.js).
- ESM only, Node ≥ 20, explicit `exports` field.
- Instance-based API (factory functions + classes) replaces static classes;
  multiple agents can run concurrently in one process.

### Removed

- `ScriptAI.ollama` / `ScriptAI.chiven` / `ScriptAI.tools` static classes.
- `compose.js` DOM renderer and its private message markers
  (`<think>` thinking blocks, `¶` separators, `♦` stickers) — replaced by
  structured `reasoning` / `text` events and host-side message blocks.
- `utils/markdown.js` (window globals, bundled katex CSS, localStorage reads)
  — markdown rendering belongs to the host application.
- `imageSynthesis` polling — a supplier增值 capability, not core.

### Migration

See the v1 → v2 table in the README. The npm package name is unchanged
(`script-ai`); this is a breaking major version.

## [1.0.0] — 2025-02-28

Initial release: supplier wrappers (Ollama, Chiven gateway), streaming chat
rendering helpers, markdown/image utilities.
