/**
 * examples/host-injection — what a real host looks like.
 *
 * Runs WITHOUT Ollama: a scripted mock provider plays a model that
 *   1. calls `list_dir`          → allowed by hook
 *   2. calls `bash` (permission: 'deny') → blocked by policy
 *   3. answers with a summary    → done
 *
 * Study this file to see the whole host contract: inject tools, implement the
 * approval dialog, render events, checkpoint with snapshot/restore.
 *
 *   node examples/host-injection/index.js
 */

import { createAgent, defineTool, restore, snapshot } from '../../index.js';

// ---------------------------------------------------------------------------
// A scripted stand-in for a model. `chunksFor(step)` is what the provider
// would stream on its Nth call. Swap for createProvider.ollama({…}) to go live.
// ---------------------------------------------------------------------------
const scriptedProvider = {
  id: 'scripted-demo',
  model: 'demo-model',
  calls: 0,
  async *chat(request) {
    this.calls += 1;
    const step = this.calls;
    const ask = (name, args) => [
      { type: 'toolCall', index: 0, id: `call_${step}`, name, argsDelta: JSON.stringify(args) },
      { type: 'done', finishReason: 'toolCalls' },
    ];
    const say = (text) => [
      { type: 'reasoning', delta: '（整理一下思路）' },
      { type: 'text', delta: text },
      { type: 'usage', inputTokens: 40, outputTokens: 12 },
      { type: 'done', finishReason: 'stop' },
    ];
    if (step === 1) {
      yield* ask('list_dir', { path: '/projects' });
    } else if (step === 2) {
      // The model, seeing the listing, tries to run a shell command…
      yield* ask('bash', { command: 'rm -rf /projects/old' });
    } else {
      // …gets the policy error back, and course-corrects:
      yield* say('当前无法执行 shell 命令（被宿主策略拒绝）。/projects 下有 3 个条目，建议你在文件管理器里手动清理 old 目录。');
    }
  },
};

// ---------------------------------------------------------------------------
// The host's tool surface. Permissions are the host's policy statement:
//   list_dir  → 'allow' : read-only, auto-approved
//   bash      → 'deny'  : never even offered to the model
//   write_file→ 'ask'   : always goes through the dialog
// ---------------------------------------------------------------------------
const hostTools = [
  defineTool({
    name: 'list_dir',
    description: '列出目录内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'allow',
    execute: ({ path }) => ['app/', 'docs/', 'old/', 'README.md'].map((n) => `${path}/${n}`),
  }),
  defineTool({
    name: 'bash',
    description: '执行 shell 命令',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    permission: 'deny',
    execute: () => {
      throw new Error('must never run');
    },
  }),
  defineTool({
    name: 'write_file',
    description: '写文件（需用户确认）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    permission: 'ask',
    execute: ({ path, content }) => `已写入 ${path}（${content.length} 字符）`,
  }),
];

// ---------------------------------------------------------------------------
// The host's approval dialog. This is where a real host renders UI; here we
// print to the console and auto-answer by policy. Note the "remember" cache —
// exactly how Gemini CLI / OpenCode hosts implement "always allow".
// ---------------------------------------------------------------------------
const remember = new Map();
async function approvalDialog({ name, args, tool }) {
  // A sensible host auto-approves its own 'allow'-grade tools (read-only)
  // and only opens a dialog for 'ask'-grade ones.
  if (tool.permission === 'allow') {
    console.log(`  [审批] ${name} → 允许（只读工具自动放行）`);
    return true;
  }
  if (remember.has(name)) {
    console.log(`  [审批] ${name} → ${remember.get(name)}（记住的选择）`);
    return remember.get(name);
  }
  if (name === 'write_file') {
    console.log(`  [审批] 模型想写文件 ${args.path}（${args.content.length} 字符）→ 允许并记住`);
    remember.set(name, true);
    return true;
  }
  console.log(`  [审批] ${name} ${JSON.stringify(args)} → 拒绝`);
  return false;
}

const agent = createAgent({
  provider: scriptedProvider,
  tools: hostTools,
  systemPrompt: '你是一个谨慎的文件整理助手。不能执行 shell 时就向用户说明。',
  maxSteps: 6,
  onBeforeToolCall: approvalDialog,
  context: { host: 'demo-host', platform: 'desktop' },
});

// ---------------------------------------------------------------------------
// Event rendering — a host feeds these into its UI. Structured events replace
// v1's private marker language (<think> / ¶ / ♦).
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padStart(n);
agent.on('run:start', () => console.log('▶ run:start'));
agent.on('step:start', ({ step, maxSteps }) => console.log(`▶ step:start ${pad(step)}/${maxSteps}`));
agent.on('reasoning', ({ delta }) => console.log(`  💭 ${delta}`));
agent.on('text', ({ delta }) => process.stdout.write(delta));
agent.on('toolCall', ({ name, args }) => console.log(`\n  🔧 ${name}(${JSON.stringify(args)})`));
agent.on('toolDecision', ({ name, decision, by }) => console.log(`  ⚖️  ${name} → ${decision} (by ${by})`));
agent.on('toolResult', ({ name, result, ok, durationMs }) =>
  console.log(`  ${ok ? '✅' : '❌'} ${name} → ${JSON.stringify(result)} (${durationMs}ms)`)
);
agent.on('step:end', ({ step, toolCalls }) => console.log(`◀ step:end ${step} (${toolCalls} tools)`));
agent.on('run:end', ({ steps, reason, usage }) =>
  console.log(`\n◀ run:end — ${steps} 步 · ${reason} · tokens ${usage.inputTokens}/${usage.outputTokens}`)
);
agent.on('error', ({ error, fatal }) => console.log(`  [error${fatal ? ' fatal' : ''}] ${error.message}`));

// ---------------------------------------------------------------------------
// Run, then demonstrate checkpointing: snapshot → kill → restore → continue.
// ---------------------------------------------------------------------------
console.log('用户: 整理一下 /projects\n');

const result = await agent.run('整理一下 /projects');
console.log(`\n最终答复: ${result.text}`);

console.log('\n——— checkpoint 演示 ———');
const snap = JSON.parse(JSON.stringify(snapshot(agent))); // as a host would persist it
console.log(`snapshot: v${snap.version} · ${snap.messages.length} 条消息 · steps=${snap.steps}`);

// "Kill" the agent: a brand-new instance restored from storage.
const revived = createAgent({
  provider: scriptedProvider, // same scripted provider: next chunk is the final answer
  tools: hostTools,
  systemPrompt: agent.systemPrompt,
});
restore(revived, snap);
console.log(`restore 后消息数: ${revived.messages.length}（会话原样恢复，可继续 run()）`);
