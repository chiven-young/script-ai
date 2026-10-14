/**
 * @file test/stream.test.js — line parsing + tool_call fragment merging.
 * The single most bug-prone area of the library; tested against both real
 * wire formats (OpenAI SSE string fragments, Ollama NDJSON object fragments).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChunkAccumulator,
  ToolCallAssembler,
  mergeDeep,
  parseNDJSON,
  parseSSE,
  randomId,
} from '../src/stream.js';
import { streamFrom } from './helpers.js';

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('ToolCallAssembler merges OpenAI string fragments', () => {
  const asm = new ToolCallAssembler();
  asm.add({ index: 0, id: 'call_1', name: 'get_weather', argsDelta: '{"ci' });
  asm.add({ index: 0, argsDelta: 'ty":"SF"}' });
  assert.equal(asm.size, 1);
  assert.deepEqual(asm.finalize(), [
    { id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
  ]);
});

test('ToolCallAssembler keeps parallel calls separate and ordered', () => {
  const asm = new ToolCallAssembler();
  asm.add({ index: 0, id: 'call_a', name: 'ls', argsDelta: '{"path":' });
  asm.add({ index: 1, id: 'call_b', name: 'cat', argsDelta: '{"file":' });
  asm.add({ index: 1, argsDelta: '"a.txt"}' });
  asm.add({ index: 0, argsDelta: '"/tmp"}' });
  assert.deepEqual(asm.finalize(), [
    { id: 'call_a', name: 'ls', arguments: '{"path":"/tmp"}' },
    { id: 'call_b', name: 'cat', arguments: '{"file":"a.txt"}' },
  ]);
});

test('ToolCallAssembler merges Ollama partial argument objects', () => {
  const asm = new ToolCallAssembler();
  asm.add({ index: 0, name: 'ls', args: { path: '/tm' } });
  asm.add({ index: 0, args: { path: '/tmp', all: true } });
  asm.add({ index: 0, args: { opts: { long: true } } });
  const [call] = asm.finalize();
  assert.match(call.id, /^call_/);
  assert.equal(call.name, 'ls');
  assert.equal(call.arguments, '{"path":"/tmp","all":true,"opts":{"long":true}}');
});

test('ToolCallAssembler generates ids when the provider omits them', () => {
  const asm = new ToolCallAssembler();
  asm.add({ index: 0, name: 'ls', args: { path: '.' } });
  const [call] = asm.finalize();
  assert.match(call.id, /^call_/);
  assert.equal(call.name, 'ls');
});

test('ToolCallAssembler tolerates empty and null arguments', () => {
  const asm = new ToolCallAssembler();
  asm.add({ index: 0, id: 'call_1', name: 'now', argsDelta: '' });
  asm.add({ index: 1, id: 'call_2', name: 'now' });
  assert.deepEqual(asm.finalize(), [
    { id: 'call_1', name: 'now', arguments: '' },
    { id: 'call_2', name: 'now', arguments: '' },
  ]);
});

test('parseSSE handles data frames, comments, [DONE] and split JSON', async () => {
  const body = streamFrom([
    ': keep-alive\n\n',
    'event: message\n',
    'data: {"choices":[{"delta":{"content":"he',
    'llo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\r\n\r\n',
    'data: [DONE]\n\n',
    'data: {"ignored":"after done"}\n\n',
  ]);
  const frames = await collect(parseSSE(body));
  assert.deepEqual(frames, [
    { choices: [{ delta: { content: 'hello' } }] },
    { choices: [{ delta: { content: ' world' } }] },
  ]);
});

test('parseNDJSON reads bare JSON lines and skips junk', async () => {
  const body = streamFrom(['{"done":false}\n', '\n', 'not json\n', '{"done":true}\n', '{"partial"']);
  const frames = await collect(parseNDJSON(body));
  assert.deepEqual(frames, [{ done: false }, { done: true }]);
});

test('mergeDeep replaces scalars/arrays and recurses objects', () => {
  const target = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] };
  mergeDeep(target, { a: 2, nested: { y: 3, z: 4 }, list: [9] });
  assert.deepEqual(target, { a: 2, nested: { x: 1, y: 3, z: 4 }, list: [9] });
});

test('randomId is unique-ish', () => {
  const ids = new Set(Array.from({ length: 100 }, () => randomId('call')));
  assert.equal(ids.size, 100);
  assert.match([...ids][0], /^call_/);
});

test('ChunkAccumulator aggregates a full stream', () => {
  const acc = new ChunkAccumulator();
  acc.feed({ type: 'text', delta: 'Hello' });
  acc.feed({ type: 'reasoning', delta: 'think ' });
  acc.feed({ type: 'reasoning', delta: 'more' });
  acc.feed({ type: 'toolCall', index: 0, id: 'c1', name: 'ls', argsDelta: '{"path":"."}' });
  acc.feed({ type: 'usage', inputTokens: 10, outputTokens: 5 });
  acc.feed({ type: 'usage', inputTokens: 1, outputTokens: 2 });
  acc.feed({ type: 'done', finishReason: 'toolCalls' });

  assert.equal(acc.text, 'Hello');
  assert.equal(acc.reasoning, 'think more');
  assert.deepEqual(acc.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(acc.finishReason, 'toolCalls');
  assert.deepEqual(acc.toolCalls, [{ id: 'c1', name: 'ls', arguments: '{"path":"."}' }]);
});
