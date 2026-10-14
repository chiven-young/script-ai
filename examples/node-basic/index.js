/**
 * examples/node-basic — the 30-second getting started.
 *
 * A desktop-style host injects ONE tool (list_dir) into script-ai and lets a
 * local Ollama model drive it. No framework, no build step:
 *
 *   node examples/node-basic/index.js "看看 /tmp 里有什么"
 *
 * Requires Ollama running locally with a tool-capable model, e.g.:
 *   ollama pull qwen2.5
 */

import { createAgent, createProvider, defineTool } from '../../index.js';

// ---------------------------------------------------------------------------
// 1. Host-injected tools. The library never touches the filesystem itself —
//    this `execute` is the host's own code (here: a deliberately tiny stand-in
//    for the real thing, so the example has no side effects).
// ---------------------------------------------------------------------------
const listDir = defineTool({
  name: 'list_dir',
  description: '列出目录内容',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '目录路径' } },
    required: ['path'],
  },
  permission: 'allow', // read-only: auto-approve
  execute: ({ path }) => ['report.pdf', 'notes.md', 'photos/'],
});

// ---------------------------------------------------------------------------
// 2. Provider + agent.
// ---------------------------------------------------------------------------
const agent = createAgent({
  provider: createProvider.ollama({
    baseURL: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'qwen2.5',
  }),
  tools: [listDir],
  systemPrompt: '你是一个文件整理助手，简洁回答。',
  maxSteps: 8,
  // A real host would open a dialog here. This example auto-approves.
  onBeforeToolCall: async ({ name, args }) => {
    console.log(`\n[审批] 工具 ${name} 参数 ${JSON.stringify(args)} → 允许`);
    return true;
  },
});

// ---------------------------------------------------------------------------
// 3. Render the event stream (a host would feed these into its UI).
// ---------------------------------------------------------------------------
agent.on('text', ({ delta }) => process.stdout.write(delta));
agent.on('reasoning', ({ delta }) => process.stdout.write(`💭 ${delta}`));
agent.on('toolResult', ({ name, result, ok, durationMs }) => {
  console.log(`\n[工具] ${name} → ${ok ? JSON.stringify(result) : '失败'} (${durationMs}ms)`);
});

// ---------------------------------------------------------------------------
// 4. Run.
// ---------------------------------------------------------------------------
const input = process.argv[2] ?? '看看 /tmp 里有什么';
console.log(`用户: ${input}\n助手: `);

try {
  const { text, steps, reason, usage } = await agent.run(input);
  console.log(`\n\n— ${steps} 步 · ${reason} · tokens ${usage.inputTokens}/${usage.outputTokens}`);
  console.log(`最终答复: ${text}`);
} catch (err) {
  if (err.code === 'PROVIDER_ERROR') {
    console.error('\n连不上 Ollama？请先安装并启动：https://ollama.com  然后 ollama pull qwen2.5');
  }
  console.error(err);
  process.exitCode = 1;
}
