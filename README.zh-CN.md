# script-ai

**零依赖、纯 JS 的 Agent 核心。** 模型 provider 归一化、宿主注入工具、ReAct 循环——约 700 行代码，跑在任何 JavaScript 运行时：浏览器、WebView、Node、Worker。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org) ![dependencies](https://img.shields.io/badge/运行时依赖-0-success.svg)

```js
import { createAgent, createProvider, defineTool } from 'script-ai';

const listDir = defineTool({
  name: 'list_dir',
  description: '列出目录内容',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  permission: 'allow',
  async execute({ path }) { return ['a.txt', 'b.md']; }, // 你自己的代码——库不碰文件系统
});

const agent = createAgent({
  provider: createProvider.ollama({ baseURL: 'http://localhost:11434', model: 'qwen2.5' }),
  tools: [listDir],
  systemPrompt: '你是一个文件整理助手。',
  maxSteps: 8,
  onBeforeToolCall: async ({ name, args }) => confirm(`执行 ${name}？`), // 宿主审批
});

agent.on('text', ({ delta }) => process.stdout.write(delta));
const { text } = await agent.run('看看当前目录有什么');
```

English version: [README.md](README.md)

## 设计理念

大多数 Agent 库自带一套工具（bash / 文件系统 / 浏览器）并拖入一个框架。
script-ai 反过来：**核心只做编排，能力全部由宿主注入。**

- **一个核心，全平台。** 同一个循环驱动 Electron 桌面端（经 IPC 注入 bash /
  文件系统）、Capacitor 移动端（相机、扫码）、纯浏览器标签页（仅对话）。
  平台差异体现为**工具面**差异，而不是代码分叉。
- **零依赖，只用 Web 标准**（`fetch`、`ReadableStream`、`TextDecoder`、
  `AbortSignal`）。无需构建；CDN、WebView、`node` 里直接跑。
- **只有一种线协议。** 核心只认 OpenAI 兼容的 `tools` / `tool_calls` /
  `role:"tool"`。Ollama（原生或 `/v1`）、任意网关、DeepSeek、vLLM 都适配到它。
- **安全是结构性的。** 没有工具能绕开审批钩子（或工具自身的 `permission`）
  执行；`permission: 'deny'` 的工具根本不会下发给模型；工具失败作为结果回传
  给模型，循环不会崩。

架构参考了 Google Gemini CLI（核心引擎 + 宿主注入 + 审批策略）、Vercel AI SDK
的 `maxSteps` 循环、OpenCode 的 per-tool 权限模型，提炼为一个无依赖库。

## 安装

```bash
npm install script-ai        # Node ≥ 20，仅 ESM
```

不用打包器？直接拿走 `index.js` + `src/` 即可 import——没有任何其他需要安装的东西。

## API——五个概念

| 导出 | 说明 |
|---|---|
| `createProvider` | `{ ollama, openaiCompatible }` 两个适配器工厂 |
| `defineTool` | 校验一个宿主注入的工具 `{ name, description, parameters, permission, execute }` |
| `createAgent` | 创建 Agent：`{ provider, tools, systemPrompt, maxSteps, onBeforeToolCall, … }` |
| `ToolRegistry` | 宿主的工具面：运行时 `agent.tools.register(…)` |
| `snapshot` / `restore` | 会话检查点（移动端杀后台恢复） |

### 工具

```js
const tool = defineTool({
  name: 'fs__read_file',                 // 唯一；桥接 MCP 时用 server__tool 命名
  description: '读取 UTF-8 文本文件',      // 模型会读它——视作 prompt 的一部分
  parameters: {                          // JSON Schema，object 根（与 MCP inputSchema 同形）
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  permission: 'ask',                     // 'allow' | 'ask'（默认） | 'deny'
  execute(args, ctx) {                   // ctx: { signal, step, ...宿主上下文 }
    return fs.readFileSync(args.path, 'utf8');
  },
});
```

| `permission` | 含义 |
|---|---|
| `allow` | 只读级。无审批钩子时自动放行。 |
| `ask` | 默认。必须经 `onBeforeToolCall` 批准；**没有钩子时拒绝执行**（安全默认，绝不静默执行）。 |
| `deny` | 根本不下发给模型。模型执意调用也只会拿到策略错误，不会执行。 |

### 审批钩子

```js
const agent = createAgent({
  provider,
  tools,
  onBeforeToolCall: async ({ id, name, args, tool, step, signal }) => {
    if (tool.permission === 'allow') return true;        // 宿主通常对自己的 allow 级自动放行
    return await myConfirmDialog({ name, args });        // 返回 false（或抛错）即取消
  },
});
```

### Provider

```js
// Ollama——默认走原生 /api/chat（自动处理 thinking 与分片对象参数）
createProvider.ollama({ baseURL: 'http://localhost:11434', model: 'qwen2.5' });
createProvider.ollama({ model: 'qwen2.5', api: 'compat' }); // Ollama 的 /v1 端点

// 任意 OpenAI 兼容端点（网关、DeepSeek、Moonshot、vLLM……）
createProvider.openaiCompatible({
  baseURL: 'https://api.example.com/v1',
  apiKey: process.env.API_KEY,      // 可选
  model: 'deepseek-chat',
  headers: { 'X-Tenant': 't1' },    // 可选，最后合并（可覆盖鉴权头）
  fetch: myFetch,                   // 可选，测试 / 自定义传输用
});
```

### 事件

Agent 发射结构化事件，UI 随意渲染。

| 事件 | 载荷 | 用途 |
|---|---|---|
| `run:start` | `{ input }` | 进入运行态 |
| `step:start` | `{ step, maxSteps }` | 进度 |
| `text` | `{ delta }` | 流式正文 |
| `reasoning` | `{ delta }` | 思考链折叠面板 |
| `toolCall` | `{ id, name, args, arguments }` | 工具调用卡片（参数预览） |
| `toolDecision` | `{ id, name, args, decision, by }` | 审计日志 |
| `toolResult` | `{ id, name, result, ok, durationMs }` | 结果折叠展示 |
| `step:end` | `{ step, toolCalls }` | — |
| `run:end` | `{ text, messages, steps, reason, usage }` | 落库、结束运行态 |
| `error` | `{ error, fatal }` | 非致命错误不中断循环 |

`reason` 取值 `'done' | 'maxSteps' | 'aborted'`。订阅 `'*'` 可收
`(type, payload)` 全量事件。

### 检查点

`messages` 即全部状态，天然可序列化：

```js
const snap = agent.snapshot();          // { version, messages, steps, maxSteps, provider, … }
localStorage.setItem('chat', JSON.stringify(snap));

// 之后——新进程、恢复的 Agent 从断点精确继续：
restore(agent, JSON.parse(localStorage.getItem('chat')));
await agent.run('然后呢？');
```

版本不匹配会抛 `SnapshotVersionError`——核心从不猜测。

## 写一个宿主

宿主 = 三件事：**工具**、**审批策略**、**渲染器**。

```js
// 1. 工具面——平台允许什么就注入什么
const tools = isDesktop
  ? [fsReadTool, fsWriteTool, bashTool]      // 经 IPC 到主进程
  : isMobile
    ? [cameraTool, scanTool, deviceInfoTool]  // 经 Capacitor 插件
    : [];                                      // 浏览器：仅对话

// 2. 审批策略——同一个循环，不同的面
const agent = createAgent({
  provider,
  tools,
  onBeforeToolCall: isMobile ? mobileWhitelistPolicy : desktopDialogPolicy,
});

// 3. 渲染器——订阅事件，永远不要解析字符串
for (const [type, render] of Object.entries(renderers)) agent.on(type, render);
```

关于桌面端 bash 需要特别强调：注入 shell 能力等于授予任意代码执行。用
`permission: 'ask'`、每次调用都确认，并把约束（工作目录、超时、输出截断）
做实**主进程**里，而不是渲染层。

## 错误处理

所有错误继承 `ScriptAIError`，带机器可读的 `code`：`ProviderError`（含
`.status`）、`ToolExecutionError`、`SnapshotVersionError`、`AgentBusyError`、
`AbortedError`。

```js
try {
  await agent.run('…');
} catch (err) {
  if (err instanceof AbortedError) { /* 用户取消 */ }
  else if (err instanceof ProviderError) { /* 网络 / 鉴权 / 限流 */ }
}
```

工具失败**不是**异常——它以 `ok: false` 的 `toolResult` 到达，并回传给模型，
模型可以重试或说明原因。只有中止和致命 provider 错误会让 `run()`  reject。

## 从 v1 迁移

v1 是一组 LLM 调用助手（`static ollama/chiven/tools`、DOM 耦合的
`compose.js` 渲染、私有 `<think>` / `¶` / `♦` 消息标记）。没有任何东西需要
保留——2.0.0 是一次彻底的重写。

| v1 | v2 |
|---|---|
| `ScriptAI.ollama.chat(…)` 静态类 | `createProvider.ollama({ model }).chat(request, signal)` |
| `renderChat` + `compose.js` DOM 渲染 | 订阅 `text` / `reasoning` 事件，在 UI 层渲染 |
| `<think>` / `¶` / `♦` 私有标记 | 结构化事件：`reasoning` / `text` / `toolCall` / `toolResult` |
| `Tools.renderMarkdown`（window 全局、katex CSS） | 在宿主应用渲染（参考 AI-Workshop 的 `src/render/markdown.js`） |
| 无工具支持 | `defineTool` + `ToolRegistry` + 审批钩子 |
| axios / marked / highlight.js 依赖 | 零依赖 |

## 开发

```bash
node --test            # 54 个测试，零开发依赖
npm run typecheck      # tsc --allowJs --checkJs（需：npm i -D typescript）
```

示例：[`node-basic`](examples/node-basic)（Ollama）、
[`browser-basic`](examples/browser-basic)（浏览器零构建）、
[`host-injection`](examples/host-injection)（完整宿主契约，离线可跑）。

## 许可证

MIT © Chiven Young
