/**
 * @file test/session.test.js — snapshot / restore checkpointing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgent } from '../src/agent.js';
import { restore, snapshot, SNAPSHOT_VERSION } from '../src/session.js';
import { defineTool } from '../src/tool.js';
import { SnapshotVersionError, ScriptAIError } from '../src/errors.js';
import { MockProvider } from './helpers.js';

const provider = () =>
  new MockProvider([
    [{ type: 'text', delta: 'first' }, { type: 'done', finishReason: 'stop' }],
    [{ type: 'text', delta: 'second' }, { type: 'done', finishReason: 'stop' }],
  ]);

test('snapshot captures messages, steps and provider identity', async () => {
  const agent = createAgent({ provider: provider(), model: 'qwen2.5' });
  await agent.run('hi');
  const snap = snapshot(agent);

  assert.equal(snap.version, SNAPSHOT_VERSION);
  assert.equal(snap.steps, 1);
  assert.equal(snap.provider.id, 'mock');
  assert.equal(snap.provider.model, 'qwen2.5');
  assert.equal(snap.messages.length, 2);
  assert.deepEqual(snap.messages[0], { role: 'user', content: 'hi' });
});

test('snapshot is JSON-serializable and detached from the agent', async () => {
  const agent = createAgent({ provider: provider() });
  await agent.run('hi');
  const snap = snapshot(agent);
  const round = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(round, snap);

  snap.messages.push({ role: 'user', content: 'injected' });
  assert.equal(agent.messages.length, 2); // mutating the snapshot must not touch the agent
});

test('restore continues a killed session (mobile checkpoint scenario)', async () => {
  const p = provider(); // one provider instance across both agent generations
  const agent = createAgent({ provider: p, systemPrompt: 'sys' });
  await agent.run('first question');
  const snap = JSON.parse(JSON.stringify(snapshot(agent)));

  // simulate: process died, new agent instance restored from storage
  const revived = createAgent({ provider: p });
  restore(revived, snap);
  assert.equal(revived.messages.length, 3);
  assert.equal(revived.messages[0].content, 'sys');
  assert.equal(revived.steps, 1);

  const result = await revived.run('second question');
  assert.equal(result.text, 'second');
  assert.equal(result.messages.length, 5); // sys, u, a, u, a
});

test('restore rejects a foreign snapshot version', () => {
  const agent = createAgent({ provider: provider() });
  assert.throws(
    () => restore(agent, { version: 999, messages: [] }),
    (err) => err instanceof SnapshotVersionError && err.expected === SNAPSHOT_VERSION && err.actual === 999
  );
});

test('restore rejects malformed snapshots', () => {
  const agent = createAgent({ provider: provider() });
  assert.throws(() => restore(agent, null), (err) => err instanceof ScriptAIError && err.code === 'INVALID_SNAPSHOT');
  assert.throws(() => restore(agent, { version: SNAPSHOT_VERSION, messages: 'nope' }), ScriptAIError);
  assert.throws(() => restore(agent, { version: SNAPSHOT_VERSION, messages: [{ nope: 1 }] }), ScriptAIError);
});

test('tool-call conversations survive a snapshot roundtrip', async () => {
  const tool = defineTool({
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    permission: 'allow',
    execute: ({ text }) => text,
  });
  const p = new MockProvider([
    [{ type: 'toolCall', index: 0, id: 'c1', name: 'echo', argsDelta: '{"text":"hi"}' }, { type: 'done', finishReason: 'toolCalls' }],
    [{ type: 'text', delta: 'echoed' }, { type: 'done', finishReason: 'stop' }],
  ]);
  const agent = createAgent({ provider: p, tools: [tool] });
  await agent.run('go');
  const snap = JSON.parse(JSON.stringify(snapshot(agent)));
  assert.equal(snap.messages[1].tool_calls[0].function.name, 'echo');

  const revived = createAgent({ provider: p, tools: [tool] });
  restore(revived, snap);
  const result = await revived.run('again');
  assert.equal(result.text, 'echoed');
});
