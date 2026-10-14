/**
 * @file providers/ollama.js — Ollama adapter.
 *
 * Two modes:
 *  - `api: 'native'` (default) — Ollama's own `/api/chat` NDJSON endpoint.
 *    Handles the Ollama-specifics: `thinking` → reasoning chunks, partial
 *    *object* tool-call arguments, `think: true`, `num_predict`, and message
 *    shape conversion (arguments as objects, tool results as `tool_name`).
 *  - `api: 'compat'` — Ollama's OpenAI-compatible `/v1/chat/completions`.
 *
 * Local models with reliable tool calling are recommended: Qwen2.5+, Llama 3.1+,
 * Mistral Small, DeepSeek.
 */

import { OpenAICompatibleProvider, postJSON } from '../provider.js';
import { parseNDJSON, ToolCallAssembler, mergeDeep } from '../stream.js';

/**
 * Convert core (OpenAI-shaped) messages into Ollama native messages.
 * @param {import('../provider.js').Message[]} messages
 * @returns {Record<string, any>[]}
 */
export function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      /** @type {Record<string, any>} */
      const out = { role: 'assistant', content: m.content ?? '' };
      if (m.reasoning) out.thinking = m.reasoning;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          function: {
            name: (tc.function && tc.function.name) || '',
            arguments: safeParseObject(tc.function && tc.function.arguments),
          },
        }));
      }
      return out;
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_name: m.name ?? '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

/**
 * @param {string | undefined} text
 * @returns {Record<string, any>}
 */
function safeParseObject(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class OllamaProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.baseURL] default `http://localhost:11434`
   * @param {string} [options.model]
   * @param {'native' | 'compat'} [options.api] default `native`
   * @param {Record<string, string>} [options.headers]
   * @param {typeof fetch} [options.fetch]
   * @param {string} [options.id] default `ollama`
   */
  constructor(options = {}) {
    const {
      baseURL = 'http://localhost:11434',
      model,
      api = 'native',
      headers = {},
      fetch: fetchImpl,
      id = 'ollama',
    } = options;
    if (api !== 'native' && api !== 'compat') {
      throw new TypeError(`ollama provider: api must be "native" or "compat", got "${api}"`);
    }
    this.id = id;
    this.api = api;
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.model = model ?? null;
    this.headers = headers;
    this.fetch = fetchImpl ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new TypeError('ollama provider: no fetch available; pass options.fetch');
    }
    this.#compat = new OpenAICompatibleProvider({
      baseURL: `${this.baseURL}/v1`,
      apiKey: undefined,
      model: this.model ?? undefined,
      headers,
      fetch: this.fetch,
      id,
    });
  }

  /** @type {OpenAICompatibleProvider} */
  #compat;

  /**
   * @param {import('../provider.js').ChatRequest} request
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<import('../provider.js').ChatChunk>}
   */
  async *chat(request, signal) {
    if (this.api === 'compat') {
      yield* this.#compat.chat(request, signal);
      return;
    }

    /** @type {Record<string, any>} */
    const body = {
      model: request.model ?? this.model,
      messages: toOllamaMessages(request.messages),
      stream: true,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((spec) => ({
        type: 'function',
        function: { name: spec.name, description: spec.description, parameters: spec.parameters },
      }));
    }
    if (request.reasoning) body.think = true;
    /** @type {Record<string, any>} */
    const options = {};
    if (request.temperature != null) options.temperature = request.temperature;
    if (request.maxTokens != null) options.num_predict = request.maxTokens;
    if (Object.keys(options).length > 0) body.options = options;

    const stream = await postJSON(
      this.fetch,
      `${this.baseURL}/api/chat`,
      { 'Content-Type': 'application/json', ...this.headers },
      body,
      signal
    );

    const assembler = new ToolCallAssembler();
    let doneReason = null;
    let usage = null;

    for await (const json of parseNDJSON(stream)) {
      const msg = json.message;
      if (msg && typeof msg.content === 'string' && msg.content) {
        yield { type: 'text', delta: msg.content };
      }
      if (msg && typeof msg.thinking === 'string' && msg.thinking) {
        yield { type: 'reasoning', delta: msg.thinking };
      }
      if (msg && Array.isArray(msg.tool_calls)) {
        for (let i = 0; i < msg.tool_calls.length; i++) {
          const tc = msg.tool_calls[i] ?? {};
          const fn = tc.function ?? {};
          assembler.add({
            index: typeof tc.index === 'number' ? tc.index : i,
            id: tc.id,
            name: fn.name,
            // Ollama streams *partial objects*; the assembler deep-merges them.
            args: fn.arguments && typeof fn.arguments === 'object' ? fn.arguments : undefined,
          });
        }
      }
      if (json.done) {
        doneReason = json.done_reason ?? null;
        if (json.prompt_eval_count != null || json.eval_count != null) {
          usage = { inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 };
        }
      }
    }

    const calls = assembler.finalize();
    for (let i = 0; i < calls.length; i++) {
      yield { type: 'toolCall', index: i, id: calls[i].id, name: calls[i].name, argsDelta: calls[i].arguments };
    }
    if (usage) yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    yield {
      type: 'done',
      finishReason: calls.length > 0 ? 'toolCalls' : doneReason === 'length' ? 'length' : 'stop',
    };
  }
}

export { mergeDeep };
