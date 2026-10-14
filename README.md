# script-ai

**A zero-dependency, pure-JS agent core.** Normalized model providers, host-injected tools, and a ReAct loop — in ~700 lines that run anywhere JavaScript runs: browser, WebView, Node, Worker.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org) ![dependencies](https://img.shields.io/badge/runtime_dependencies-0-success.svg)

```js
import { createAgent, createProvider, defineTool } from 'script-ai';

const listDir = defineTool({
  name: 'list_dir',
  description: 'List directory contents',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  permission: 'allow',
  async execute({ path }) { return ['a.txt', 'b.md']; }, // your code — the library never touches the fs
});

const agent = createAgent({
  provider: createProvider.ollama({ baseURL: 'http://localhost:11434', model: 'qwen2.5' }),
  tools: [listDir],
  systemPrompt: 'You are a file organizing assistant.',
  maxSteps: 8,
  onBeforeToolCall: async ({ name, args }) => confirm(`run ${name}?`), // host approval
});

agent.on('text', ({ delta }) => process.stdout.write(delta));
const { text } = await agent.run('what is in this directory?');
```

## Why

Most agent libraries ship *their* tools (bash, fs, browser) and drag in a
framework. script-ai inverts this: **the core only orchestrates — the host
injects capability.**

- **One core, every platform.** The same loop powers an Electron desktop app
  (bash + filesystem via IPC), a Capacitor mobile app (camera, scanner), and a
  plain browser tab (conversation only). Platform differences become *tool
  surface* differences, not code forks.
- **Zero dependencies, Web-standard only** (`fetch`, `ReadableStream`,
  `TextDecoder`, `AbortSignal`). No build step; it runs straight from a CDN,
  a WebView, or `node`.
- **One wire protocol.** The core speaks OpenAI-compatible
  `tools` / `tool_calls` / `role:"tool"` only. Ollama (native or `/v1`), any
  gateway, DeepSeek, vLLM — all adapt to it.
- **Safe by construction.** No tool runs without passing the approval hook
  (or the tool's own `permission`). `permission: 'deny'` tools are never even
  sent to the model. Tool failures are fed back to the model as results —
  they never crash the loop.

Inspired by the architecture of Google's Gemini CLI (core engine + host
injection + approval policy), Vercel AI SDK's `maxSteps` loop, and OpenCode's
per-tool permissions — distilled into a dependency-free library.

## Install

```bash
npm install script-ai        # Node ≥ 20, ESM only
```

No bundler? Grab `index.js` + `src/` and import directly — there is nothing
else to install.

## The API — five concepts

| Export | What it is |
|---|---|
| `createProvider` | `{ ollama, openaiCompatible }` — adapter factories |
| `defineTool` | Validate a host-injected tool `{ name, description, parameters, permission, execute }` |
| `createAgent` | Build an agent: `{ provider, tools, systemPrompt, maxSteps, onBeforeToolCall, … }` |
| `ToolRegistry` | The host's tool surface: `agent.tools.register(…)` at runtime |
| `snapshot` / `restore` | Checkpoint the conversation (mobile background kills) |

### Tools

```js
const tool = defineTool({
  name: 'fs__read_file',                 // unique; `server__tool` when bridging MCP
  description: 'Read a UTF-8 text file', // the model reads this — treat as prompt surface
  parameters: {                          // JSON Schema, object root (same shape as MCP inputSchema)
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  permission: 'ask',                     // 'allow' | 'ask' (default) | 'deny'
  execute(args, ctx) {                   // ctx: { signal, step, ...hostContext }
    return fs.readFileSync(args.path, 'utf8');
  },
});
```

| `permission` | Meaning |
|---|---|
| `allow` | Read-only-grade. Auto-approved when no hook is installed. |
| `ask` | Default. Requires `onBeforeToolCall` to approve; **without a hook it is refused** (safe default, never silently executed). |
| `deny` | Never sent to the model. If the model calls it anyway, it gets a policy error back — not execution. |

### The approval hook

```js
const agent = createAgent({
  provider,
  tools,
  onBeforeToolCall: async ({ id, name, args, tool, step, signal }) => {
    if (tool.permission === 'allow') return true;       // hosts typically auto-approve their own allow-grade
    return await myConfirmDialog({ name, args });       // false (or a throw) cancels the call
  },
});
```

### Providers

```js
// Ollama — native /api/chat by default (thinking chains, partial-object tool args handled)
createProvider.ollama({ baseURL: 'http://localhost:11434', model: 'qwen2.5' });
createProvider.ollama({ model: 'qwen2.5', api: 'compat' }); // Ollama's /v1 endpoint

// Any OpenAI-compatible endpoint (gateway, DeepSeek, Moonshot, vLLM, …)
createProvider.openaiCompatible({
  baseURL: 'https://api.example.com/v1',
  apiKey: process.env.API_KEY,      // optional
  model: 'deepseek-chat',
  headers: { 'X-Tenant': 't1' },    // optional, merged last (can override auth)
  fetch: myFetch,                   // optional, for tests / custom transports
});
```

### Events

The agent emits structured events; render them however your UI wants.

| Event | Payload | Use |
|---|---|---|
| `run:start` | `{ input }` | enter running state |
| `step:start` | `{ step, maxSteps }` | progress |
| `text` | `{ delta }` | stream the answer |
| `reasoning` | `{ delta }` | collapsible thinking panel |
| `toolCall` | `{ id, name, args, arguments }` | tool card with argument preview |
| `toolDecision` | `{ id, name, args, decision, by }` | audit log |
| `toolResult` | `{ id, name, result, ok, durationMs }` | collapsible result |
| `step:end` | `{ step, toolCalls }` | — |
| `run:end` | `{ text, messages, steps, reason, usage }` | persist, exit running state |
| `error` | `{ error, fatal }` | non-fatal errors never interrupt the loop |

`reason` is `'done' | 'maxSteps' | 'aborted'`. Subscribe to `'*'` for
`(type, payload)` on every event.

### Checkpointing

`messages` is the entire state, so it is trivially serializable:

```js
const snap = agent.snapshot();          // { version, messages, steps, maxSteps, provider, … }
localStorage.setItem('chat', JSON.stringify(snap));

// later — new process, restored agent continues exactly where it stopped:
restore(agent, JSON.parse(localStorage.getItem('chat')));
await agent.run('and then?');
```

Version mismatches throw `SnapshotVersionError` — the core never guesses.

## Writing a host

A host is three pieces: **tools**, an **approval policy**, and a **renderer**.

```js
// 1. tool surface — whatever the platform allows
const tools = isDesktop
  ? [fsReadTool, fsWriteTool, bashTool]     // via IPC to the main process
  : isMobile
    ? [cameraTool, scanTool, deviceInfoTool] // via Capacitor plugins
    : [];                                     // browser: conversation only

// 2. approval policy — the same loop, different surfaces
const agent = createAgent({
  provider,
  tools,
  onBeforeToolCall: isMobile ? mobileWhitelistPolicy : desktopDialogPolicy,
});

// 3. renderer — subscribe to events, never parse strings
for (const [type, render] of Object.entries(renderers)) agent.on(type, render);
```

Desktop bash deserves emphasis: injecting shell access means arbitrary code
execution. Use `permission: 'ask'`, confirm every call, and constrain the
implementation (working directory, timeout, output truncation) in the **main
process**, not the renderer.

## Error handling

All errors extend `ScriptAIError` with a machine-readable `code`:
`ProviderError` (has `.status`), `ToolExecutionError`, `SnapshotVersionError`,
`AgentBusyError`, `AbortedError`.

```js
try {
  await agent.run('…');
} catch (err) {
  if (err instanceof AbortedError) { /* user cancelled */ }
  else if (err instanceof ProviderError) { /* network / auth / rate limit */ }
}
```

Tool failures are **not** exceptions — they arrive as `toolResult` with
`ok: false` and are fed back to the model, which can retry or explain. Only
aborts and fatal provider errors reject `run()`.

## Migrating from v1

v1 was a collection of LLM-calling helpers (`static ollama/chiven/tools`,
DOM-coupled `compose.js` markdown rendering, private `<think>` / `¶` / `♦`
message markers). Nothing carries over; 2.0.0 is a deliberate rewrite.

| v1 | v2 |
|---|---|
| `ScriptAI.ollama.chat(…)` static class | `createProvider.ollama({ model }).chat(request, signal)` |
| `renderChat` + `compose.js` DOM renderer | subscribe to `text` / `reasoning` events; render in your UI |
| `<think>` / `¶` / `♦` private markers | structured events: `reasoning` / `text` / `toolCall` / `toolResult` |
| `Tools.renderMarkdown` (window globals, katex CSS) | render in the host app (see `src/render/markdown.js` in AI-Workshop) |
| no tools support | `defineTool` + `ToolRegistry` + approval hook |
| axios / marked / highlight.js deps | zero dependencies |

## Development

```bash
node --test            # 54 tests, zero dev dependencies
npm run typecheck      # tsc --allowJs --checkJs (needs: npm i -D typescript)
```

Examples: [`node-basic`](examples/node-basic) (Ollama),
[`browser-basic`](examples/browser-basic) (zero-build browser),
[`host-injection`](examples/host-injection) (full host contract, runs offline).

## License

MIT © Chiven Young
