/**
 * @file test/providers.test.js — provider adapters against mock HTTP servers.
 * Validates both real wire formats end-to-end without needing Ollama:
 *  - OpenAI-compatible SSE (string tool_call fragments)
 *  - Ollama native NDJSON (partial *object* tool_call arguments)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAICompatibleProvider } from '../src/provider.js';
import { OllamaProvider, toOllamaMessages } from '../src/providers/ollama.js';
import { ProviderError } from '../src/errors.js';
import { startServer } from './helpers.js';

async function collectChunks(provider, request, signal) {
  /** @type {any[]} */
  const chunks = [];
  for await (const chunk of provider.chat(request, signal)) chunks.push(chunk);
  return chunks;
}

const baseRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
  ],
};

test('openai-compatible: SSE stream with tool_call fragments, usage and finish', async () => {
  /** @type {any} */
  let capturedBody;
  /** @type {any} */
  let capturedHeaders;
  const server = await startServer((req, res, body) => {
    capturedBody = JSON.parse(body);
    capturedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_dir","arguments":"{\\"pa"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/tmp\\"}"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    res.write('data: {"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const provider = new OpenAICompatibleProvider({
      baseURL: server.url + '/v1',
      apiKey: 'secret',
      model: 'ignored-when-request-has-model',
    });
    const chunks = await collectChunks(provider, {
      ...baseRequest,
      tools: [{ name: 'list_dir', description: 'ls', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      temperature: 0.5,
      maxTokens: 100,
    });

    assert.deepEqual(chunks, [
      { type: 'text', delta: 'Hello' },
      { type: 'toolCall', index: 0, id: 'call_1', name: 'list_dir', argsDelta: '{"path":"/tmp"}' },
      { type: 'usage', inputTokens: 12, outputTokens: 7 },
      { type: 'done', finishReason: 'toolCalls' },
    ]);

    // wire format checks
    assert.equal(capturedBody.model, 'test-model');
    assert.equal(capturedBody.stream, true);
    assert.equal(capturedBody.temperature, 0.5);
    assert.equal(capturedBody.max_tokens, 100);
    assert.deepEqual(capturedBody.tools, [
      { type: 'function', function: { name: 'list_dir', description: 'ls', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ]);
    assert.equal(capturedHeaders.authorization, 'Bearer secret');
  } finally {
    await server.close();
  }
});

test('openai-compatible: reasoning_content maps to reasoning chunks', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"reasoning_content":"hard"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const provider = new OpenAICompatibleProvider({ baseURL: server.url, model: 'm' });
    const chunks = await collectChunks(provider, baseRequest);
    assert.deepEqual(chunks, [
      { type: 'reasoning', delta: 'think ' },
      { type: 'reasoning', delta: 'hard' },
      { type: 'text', delta: 'answer' },
      { type: 'done', finishReason: 'stop' },
    ]);
  } finally {
    await server.close();
  }
});

test('openai-compatible: HTTP error becomes ProviderError with status', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
  });
  try {
    const provider = new OpenAICompatibleProvider({ baseURL: server.url, model: 'm' });
    await assert.rejects(
      () => collectChunks(provider, baseRequest),
      (err) => err instanceof ProviderError && err.status === 401 && err.message.includes('401')
    );
  } finally {
    await server.close();
  }
});

test('openai-compatible: custom headers can override auth', async () => {
  /** @type {any} */
  let capturedHeaders;
  const server = await startServer((req, res) => {
    capturedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const provider = new OpenAICompatibleProvider({
      baseURL: server.url,
      model: 'm',
      apiKey: 'secret',
      headers: { Authorization: 'Bearer custom', 'X-Tenant': 't1' },
    });
    await collectChunks(provider, baseRequest);
    assert.equal(capturedHeaders.authorization, 'Bearer custom');
    assert.equal(capturedHeaders['x-tenant'], 't1');
  } finally {
    await server.close();
  }
});

test('ollama native: NDJSON with thinking and partial object tool calls', async () => {
  /** @type {any} */
  let capturedBody;
  const server = await startServer((req, res, body) => {
    capturedBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const write = (obj) => res.write(JSON.stringify(obj) + '\n');
    write({ model: 'qwen', message: { role: 'assistant', content: '让我看看', thinking: 'think a' }, done: false });
    write({ model: 'qwen', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_dir', arguments: { path: '/tm' } } }] }, done: false });
    write({ model: 'qwen', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_dir', arguments: { path: '/tmp' } } }] }, done: false });
    write({ model: 'qwen', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5 });
    res.end();
  });

  try {
    const provider = new OllamaProvider({ baseURL: server.url, model: 'qwen' });
    const chunks = await collectChunks(provider, {
      ...baseRequest,
      tools: [{ name: 'list_dir', description: 'ls', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      reasoning: true,
      temperature: 0.3,
      maxTokens: 42,
    });

    assert.equal(chunks[0].type, 'text');
    assert.equal(chunks[0].delta, '让我看看');
    assert.equal(chunks[1].type, 'reasoning');
    assert.equal(chunks[1].delta, 'think a');
    const toolChunk = chunks.find((c) => c.type === 'toolCall');
    assert.equal(toolChunk.name, 'list_dir');
    assert.match(toolChunk.id, /^call_/); // Ollama sends no ids — we synthesize
    assert.equal(toolChunk.argsDelta, '{"path":"/tmp"}'); // partial objects merged
    const usage = chunks.find((c) => c.type === 'usage');
    assert.deepEqual(usage, { type: 'usage', inputTokens: 10, outputTokens: 5 });
    assert.deepEqual(chunks[chunks.length - 1], { type: 'done', finishReason: 'toolCalls' });

    // native request shape (request.model wins over the provider default)
    assert.equal(capturedBody.model, 'test-model');
    assert.equal(capturedBody.stream, true);
    assert.equal(capturedBody.think, true);
    assert.deepEqual(capturedBody.options, { temperature: 0.3, num_predict: 42 });
    assert.deepEqual(capturedBody.tools, [
      { type: 'function', function: { name: 'list_dir', description: 'ls', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ]);
  } finally {
    await server.close();
  }
});

test('ollama native: assistant tool_calls and tool results are converted', async () => {
  /** @type {any} */
  let capturedBody;
  const server = await startServer((req, res, body) => {
    capturedBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }) + '\n');
    res.end();
  });
  try {
    const provider = new OllamaProvider({ baseURL: server.url, model: 'qwen' });
    await collectChunks(provider, {
      model: 'qwen',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          reasoning: 'my thinking',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"path":"/tmp"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', name: 'ls', content: '["a.txt"]' },
      ],
    });
    assert.deepEqual(capturedBody.messages, [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        thinking: 'my thinking',
        tool_calls: [{ function: { name: 'ls', arguments: { path: '/tmp' } } }],
      },
      { role: 'tool', tool_name: 'ls', content: '["a.txt"]' },
    ]);
  } finally {
    await server.close();
  }
});

test('ollama compat mode delegates to /v1/chat/completions', async () => {
  let hitCompat = false;
  const server = await startServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      hitCompat = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"compat"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const provider = new OllamaProvider({ baseURL: server.url, model: 'qwen', api: 'compat' });
    const chunks = await collectChunks(provider, baseRequest);
    assert.ok(hitCompat);
    assert.deepEqual(chunks, [
      { type: 'text', delta: 'compat' },
      { type: 'done', finishReason: 'stop' },
    ]);
  } finally {
    await server.close();
  }
});

test('toOllamaMessages handles plain, assistant and tool roles', () => {
  assert.deepEqual(toOllamaMessages([{ role: 'system', content: 's' }, { role: 'user', content: null }]), [
    { role: 'system', content: 's' },
    { role: 'user', content: '' },
  ]);
  // malformed arguments degrade to {} instead of throwing
  assert.deepEqual(
    toOllamaMessages([
      { role: 'assistant', content: 'x', tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: 'not json' } }] },
    ]),
    [{ role: 'assistant', content: 'x', tool_calls: [{ function: { name: 'f', arguments: {} } }] }]
  );
});

test('providers reject construction without fetch/baseURL', () => {
  assert.throws(() => new OpenAICompatibleProvider({}), (err) => err.code === 'INVALID_PROVIDER');
  assert.throws(() => new OllamaProvider({ api: 'bogus' }), TypeError);
});
