/**
 * @file test/agent.test.js — the ReAct loop, approval hook, lifecycle, events.
 * Uses a scripted mock provider; provider adapters are tested separately
 * against mock HTTP servers in test/providers.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgent } from '../src/agent.js';
import { defineTool } from '../src/tool.js';
import { AgentBusyError, AbortedError, ProviderError } from '../src/errors.js';
import { MockProvider } from './helpers.js';

const listDir = () =>
  defineTool({
    name: 'list_dir',
    description: '列出目录内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'allow',
    execute: ({ path }) => [`${path}/a.txt`, `${path}/b.md`],
  });

/** Build a scripted provider whose Nth call emits `chunksN`. */
function scriptedProvider(...steps) {
  return new MockProvider(steps);
}

test('text-only run: streams text, ends with reason done', async () => {
  const events = [];
  const provider = scriptedProvider([
    { type: 'text', delta: '你好' },
    { type: 'text', delta: '，世界' },
    { type: 'usage', inputTokens: 3, outputTokens: 4 },
    { type: 'done', finishReason: 'stop' },
  ]);
  const agent = createAgent({ provider });
  for (const type of ['run:start', 'step:start', 'text', 'run:end']) {
    agent.on(type, (payload) => events.push([type, payload]));
  }

  const result = await agent.run('hi');

  assert.equal(result.text, '你好，世界');
  assert.equal(result.reason, 'done');
  assert.equal(result.steps, 1);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4 });
  assert.deepEqual(result.messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '你好，世界' },
  ]);
  assert.deepEqual(
    events.map(([t]) => t),
    ['run:start', 'step:start', 'text', 'text', 'run:end']
  );
});

test('systemPrompt becomes the first message and is sent every request', async () => {
  const provider = scriptedProvider([{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]);
  const agent = createAgent({ provider, systemPrompt: '你是助手' });
  await agent.run('hi');
  assert.equal(agent.messages[0].role, 'system');
  assert.equal(provider.requests[0].messages[0].content, '你是助手');
  assert.deepEqual(provider.requests[0].tools, []);
});

test('full tool loop: call → result fed back → final answer', async () => {
  const provider = scriptedProvider(
    [
      { type: 'toolCall', index: 0, id: 'call_1', name: 'list_dir', argsDelta: '{"path":"/tmp"}' },
      { type: 'done', finishReason: 'toolCalls' },
    ],
    [{ type: 'text', delta: '目录里有 2 个文件' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({ provider, tools: [listDir()] });
  const decisions = [];
  agent.on('toolDecision', (d) => decisions.push(d));
  agent.on('toolResult', (r) => assert.equal(r.ok, true));

  const result = await agent.run('看看 /tmp');

  assert.equal(result.text, '目录里有 2 个文件');
  assert.equal(result.reason, 'done');
  assert.equal(result.steps, 2);
  // message shape: user, assistant(tool_calls), tool, assistant
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[1].role, 'assistant');
  assert.deepEqual(result.messages[1].tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"/tmp"}' } },
  ]);
  assert.equal(result.messages[1].content, null);
  assert.deepEqual(result.messages[2], {
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'list_dir',
    content: '["/tmp/a.txt","/tmp/b.md"]',
  });
  // the tool result must reach the provider on the second request
  assert.equal(provider.requests[1].messages[2].role, 'tool');
  assert.deepEqual(provider.requests[1].messages[2].content, '["/tmp/a.txt","/tmp/b.md"]');
  // tools spec is sent on every request
  assert.deepEqual(provider.requests[1].tools, [
    { name: 'list_dir', description: '列出目录内容', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ]);
  assert.deepEqual(decisions, [
    { id: 'call_1', name: 'list_dir', args: { path: '/tmp' }, decision: 'allow', by: 'permission' },
  ]);
});

test('tool failure goes back as a tool result and the loop continues', async () => {
  const boom = defineTool({
    name: 'boom',
    description: '总是失败',
    parameters: { type: 'object', properties: {} },
    permission: 'allow',
    execute: () => {
      throw new Error('disk on fire');
    },
  });
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'boom', argsDelta: '{}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: '工具挂了，我直接说明' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({ provider, tools: [boom] });
  const errors = [];
  const results = [];
  agent.on('error', (e) => errors.push(e));
  agent.on('toolResult', (r) => results.push(r));

  const result = await agent.run('go');

  assert.equal(result.reason, 'done');
  assert.equal(result.text, '工具挂了，我直接说明');
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.deepEqual(results[0].result, { error: 'disk on fire' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, false);
  // error text is what the model sees
  assert.match(provider.requests[1].messages[2].content, /disk on fire/);
});

test('invalid arguments JSON is reported as a tool failure', async () => {
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'list_dir', argsDelta: '{"path":' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: '参数坏了' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({ provider, tools: [listDir()] });
  const results = [];
  agent.on('toolResult', (r) => results.push(r));
  await agent.run('go');
  assert.equal(results[0].ok, false);
  assert.match(results[0].result.error, /invalid arguments JSON/);
});

test('unknown tool returns a policy error, not a crash', async () => {
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'nope', argsDelta: '{}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: '没有这个工具' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({ provider, tools: [listDir()] });
  const decisions = [];
  agent.on('toolDecision', (d) => decisions.push(d));
  await agent.run('go');
  assert.equal(decisions[0].by, 'registry');
  assert.equal(decisions[0].decision, 'deny');
  assert.match(provider.requests[1].messages[2].content, /not available on this host/);
});

test('permission deny blocks the call and never reaches the model', async () => {
  const denied = defineTool({
    name: 'bash',
    description: 'run shell',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
    permission: 'deny',
    execute: () => {
      throw new Error('must never run');
    },
  });
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'bash', argsDelta: '{"cmd":"rm -rf /"}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: '不允许' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({ provider, tools: [denied] });
  const results = [];
  agent.on('toolResult', (r) => results.push(r));
  await agent.run('go');
  // denied tools are not even offered to the model
  assert.deepEqual(provider.requests[0].tools, []);
  assert.equal(results[0].ok, false);
  assert.match(results[0].result.error, /denied by host policy/);
});

test('approval hook: false cancels, true allows', async () => {
  const calls = [];
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'list_dir', argsDelta: '{"path":"/a"}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'toolCall', index: 0, id: 'c2', name: 'list_dir', argsDelta: '{"path":"/b"}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({
    provider,
    tools: [listDir()],
    onBeforeToolCall: ({ name, args }) => {
      calls.push({ name, args });
      return args.path !== '/a'; // deny the first, allow the second
    },
  });
  const decisions = [];
  agent.on('toolDecision', (d) => decisions.push(d));
  const result = await agent.run('go');

  assert.equal(result.reason, 'done');
  assert.deepEqual(calls, [
    { name: 'list_dir', args: { path: '/a' } },
    { name: 'list_dir', args: { path: '/b' } },
  ]);
  assert.deepEqual(
    decisions.map((d) => [d.decision, d.by]),
    [
      ['deny', 'hook'],
      ['allow', 'hook'],
    ]
  );
});

test('approval hook throwing cancels the call', async () => {
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'list_dir', argsDelta: '{"path":"/a"}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({
    provider,
    tools: [listDir()],
    onBeforeToolCall: () => {
      throw new Error('dialog crashed');
    },
  });
  const results = [];
  agent.on('toolResult', (r) => results.push(r));
  await agent.run('go');
  assert.equal(results[0].ok, false);
  assert.match(results[0].result.error, /approval hook failed/);
});

test('ask permission without a hook is refused (safe default)', async () => {
  const tool = defineTool({
    name: 'list_dir',
    description: '列出目录内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    // permission defaults to 'ask'
    execute: () => ['x'],
  });
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'list_dir', argsDelta: '{"path":"/a"}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({ provider, tools: [tool] });
  const results = [];
  agent.on('toolResult', (r) => results.push(r));
  await agent.run('go');
  assert.equal(results[0].ok, false);
  assert.match(results[0].result.error, /requires approval/);
});

test('maxSteps is a hard boundary', async () => {
  // provider always asks for a tool → loop must stop at maxSteps
  const provider = new MockProvider([
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'list_dir', argsDelta: '{"path":"/"}' }, { type: 'done', finishReason: 'toolCalls' }],
  ]);
  const agent = createAgent({ provider, tools: [listDir()], maxSteps: 3 });
  const ends = [];
  agent.on('run:end', (r) => ends.push(r));
  const result = await agent.run('go');
  assert.equal(result.reason, 'maxSteps');
  assert.equal(result.steps, 3);
  assert.equal(provider.requests.length, 3);
  assert.equal(ends[0].reason, 'maxSteps');
});

test('reasoning streams are surfaced and kept on the assistant message', async () => {
  const provider = scriptedProvider([
    { type: 'reasoning', delta: '让我想想' },
    { type: 'text', delta: '答案' },
    { type: 'done', finishReason: 'stop' },
  ]);
  const agent = createAgent({ provider, reasoning: true });
  const reasoning = [];
  agent.on('reasoning', (r) => reasoning.push(r.delta));
  const result = await agent.run('go');
  assert.deepEqual(reasoning, ['让我想想']);
  assert.equal(result.messages[1].reasoning, '让我想想');
  assert.equal(provider.requests[0].reasoning, true);
});

test('abort mid-run emits run:end(aborted) and rejects with AbortedError', async () => {
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'list_dir', argsDelta: '{"path":"/"}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: 'never' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({
    provider,
    tools: [listDir()],
    onBeforeToolCall: () => {
      agent.abort(); // host cancels from inside the dialog
      return true;
    },
  });
  const ends = [];
  agent.on('run:end', (r) => ends.push(r));
  await assert.rejects(() => agent.run('go'), AbortedError);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'aborted');
});

test('external signal aborts the run', async () => {
  const controller = new AbortController();
  const provider = new MockProvider([
    (request, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
        // never resolves on its own
      }),
  ]);
  const agent = createAgent({ provider });
  const promise = agent.run('go', { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => promise, AbortedError);
});

test('provider fatal error interrupts the run and emits error(fatal)', async () => {
  const provider = {
    id: 'broken',
    model: 'm',
    // eslint-disable-next-line require-yield
    async *chat() {
      throw new ProviderError('502 bad gateway', { status: 502 });
    },
  };
  const agent = createAgent({ provider });
  const errors = [];
  agent.on('error', (e) => errors.push(e));
  await assert.rejects(() => agent.run('go'), ProviderError);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, true);
});

test('provider error finish reason is fatal', async () => {
  const provider = scriptedProvider([{ type: 'done', finishReason: 'error' }]);
  const agent = createAgent({ provider });
  await assert.rejects(() => agent.run('go'), ProviderError);
});

test('concurrent run() throws AgentBusyError', async () => {
  const provider = new MockProvider([
    (request, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  ]);
  const agent = createAgent({ provider });
  const first = agent.run('one');
  await assert.rejects(() => agent.run('two'), AgentBusyError);
  agent.abort();
  await assert.rejects(() => first, AbortedError);
});

test('run() input validation', async () => {
  const agent = createAgent({ provider: scriptedProvider([{ type: 'done', finishReason: 'stop' }]) });
  await assert.rejects(() => agent.run(''), (err) => err.code === 'INVALID_INPUT');
  await assert.rejects(() => agent.run([{ role: 'user' }]), (err) => err.code === 'INVALID_INPUT');
});

test('tool context carries signal, step and host context', async () => {
  /** @type {any[]} */
  const seen = [];
  const spy = defineTool({
    name: 'spy',
    description: '记录上下文',
    parameters: { type: 'object', properties: {} },
    permission: 'allow',
    execute: (args, ctx) => {
      seen.push({ step: ctx.step, hasSignal: ctx.signal instanceof AbortSignal, platform: ctx.platform });
      return 'ok';
    },
  });
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'spy', argsDelta: '{}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({ provider, tools: [spy], context: { platform: 'electron' } });
  await agent.run('go');
  assert.deepEqual(seen, [{ step: 1, hasSignal: true, platform: 'electron' }]);
});

test('runtime registry mutation affects the next step', async () => {
  const provider = scriptedProvider(
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'later', argsDelta: '{}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
  );
  const agent = createAgent({ provider });
  agent.tools.register({
    name: 'later',
    description: '后来注册的工具',
    parameters: { type: 'object', properties: {} },
    permission: 'allow',
    execute: () => 'late',
  });
  const result = await agent.run('go');
  assert.equal(result.reason, 'done');
  assert.match(provider.requests[1].messages[2].content, /late/);
});
