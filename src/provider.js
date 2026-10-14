/**
 * @file provider.js — the ModelProvider contract and the OpenAI-compatible base.
 *
 * The core speaks exactly one wire protocol: OpenAI-compatible
 * `tools` / `tool_calls` / `role:"tool"`. Every endpoint (Ollama, a gateway,
 * DeepSeek, …) is adapted to it here. Adapters are async generators of
 * normalized `ChatChunk`s — the agent loop never sees raw provider JSON.
 */

import { ProviderError, ScriptAIError, isAbortError } from './errors.js';
import { parseSSE, ToolCallAssembler, randomId } from './stream.js';

/**
 * @typedef {object} Message
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string | null} content
 * @property {string} [reasoning] assistant thinking chain, kept for context
 * @property {ToolCall[]} [tool_calls] assistant
 * @property {string} [tool_call_id] tool
 * @property {string} [name] tool
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {'function'} type
 * @property {{ name: string, arguments: string }} function arguments is a JSON string
 */

/**
 * @typedef {object} ToolSpec
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} parameters JSON Schema (object root)
 */

/**
 * @typedef {object} ChatRequest
 * @property {string} [model]
 * @property {Message[]} messages
 * @property {ToolSpec[]} [tools]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {boolean} [reasoning] ask for a thinking chain when supported
 */

/**
 * @typedef {object} TextChunk
 * @property {'text'} type
 * @property {string} delta
 */
/**
 * @typedef {object} ReasoningChunk
 * @property {'reasoning'} type
 * @property {string} delta
 */
/**
 * @typedef {object} ToolCallChunk
 * @property {'toolCall'} type
 * @property {number} [index]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [argsDelta] string slice of arguments
 * @property {Record<string, any>} [args] partial arguments object (Ollama native)
 */
/**
 * @typedef {object} UsageChunk
 * @property {'usage'} type
 * @property {number} inputTokens
 * @property {number} outputTokens
 */
/**
 * @typedef {object} DoneChunk
 * @property {'done'} type
 * @property {'stop' | 'toolCalls' | 'length' | 'error'} finishReason
 */

/**
 * @typedef {TextChunk | ReasoningChunk | ToolCallChunk | UsageChunk | DoneChunk} ChatChunk
 */

/**
 * @typedef {object} ModelProvider
 * @property {string} id stable identifier, stored in snapshots
 * @property {string} [model] default model
 * @property {(request: ChatRequest, signal?: AbortSignal) => AsyncGenerator<ChatChunk>} chat
 */

/**
 * @param {string | null | undefined} reason
 * @param {boolean} hasToolCalls
 * @returns {'stop' | 'toolCalls' | 'length' | 'error'}
 */
export function mapFinishReason(reason, hasToolCalls) {
  if (hasToolCalls) return 'toolCalls';
  switch (reason) {
    case 'length':
      return 'length';
    case 'stop':
    case 'end_turn':
    case null:
    case undefined:
      return 'stop';
    default:
      return 'error';
  }
}

/**
 * Any OpenAI-compatible `/chat/completions` endpoint: a gateway, DeepSeek,
 * Moonshot, vLLM, Ollama's own `/v1`, …
 *
 * Tool calls are emitted as complete chunks once the stream ends (fragments
 * are merged internally) so consumers can never double-count arguments.
 */
export class OpenAICompatibleProvider {
  /**
   * @param {object} options
   * @param {string} options.baseURL e.g. `https://api.example.com/v1`
   * @param {string} [options.apiKey] sent as `Authorization: Bearer …`
   * @param {string} [options.model]
   * @param {string} [options.path] default `/chat/completions`
   * @param {Record<string, string>} [options.headers] merged last, can override auth
   * @param {typeof fetch} [options.fetch] injectable for tests / custom transports
   * @param {string} [options.id] default `openai-compatible`
   * @param {boolean} [options.includeUsage] send `stream_options.include_usage` (default true)
   */
  constructor(options) {
    const {
      baseURL,
      apiKey,
      model,
      path = '/chat/completions',
      headers = {},
      fetch: fetchImpl,
      id = 'openai-compatible',
      includeUsage = true,
    } = options ?? {};
    if (!baseURL || typeof baseURL !== 'string') {
      throw new ScriptAIError('openaiCompatible provider requires a baseURL string', 'INVALID_PROVIDER');
    }
    this.id = id;
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.apiKey = apiKey ?? null;
    this.model = model ?? null;
    this.path = path;
    this.headers = headers;
    this.includeUsage = includeUsage;
    this.fetch = fetchImpl ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new ScriptAIError('no fetch available: pass options.fetch explicitly', 'NO_FETCH');
    }
  }

  /** @returns {Record<string, string>} */
  #headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.headers,
    };
  }

  /**
   * @param {ChatRequest} request
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<ChatChunk>}
   */
  async *chat(request, signal) {
    const url = `${this.baseURL}${this.path}`;
    /** @type {Record<string, any>} */
    const body = {
      model: request.model ?? this.model,
      messages: request.messages,
      stream: true,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((spec) => ({
        type: 'function',
        function: { name: spec.name, description: spec.description, parameters: spec.parameters },
      }));
    }
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.maxTokens != null) body.max_tokens = request.maxTokens;
    if (this.includeUsage) body.stream_options = { include_usage: true };

    /** @type {Response} */
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err;
      const e = /** @type {any} */ (err);
      throw new ProviderError(`request to ${url} failed: ${e && e.message ? e.message : String(err)}`, {
        cause: err,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`${url} responded ${res.status}: ${text.slice(0, 500)}`, { status: res.status });
    }
    if (!res.body) {
      throw new ProviderError(`${url} responded without a stream body`, { status: res.status });
    }

    const assembler = new ToolCallAssembler();
    let finishReason = null;
    /** @type {null | { prompt_tokens?: number, completion_tokens?: number, input_tokens?: number, output_tokens?: number }} */
    let usage = null;

    for await (const json of parseSSE(res.body)) {
      const choice = json.choices && json.choices[0];
      const delta = choice && choice.delta;
      if (delta && typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', delta: delta.content };
      }
      const reasoning = delta && (delta.reasoning_content ?? delta.reasoning);
      if (typeof reasoning === 'string' && reasoning) {
        yield { type: 'reasoning', delta: reasoning };
      }
      if (delta && Array.isArray(delta.tool_calls)) {
        for (let i = 0; i < delta.tool_calls.length; i++) {
          const tc = delta.tool_calls[i] ?? {};
          assembler.add({
            index: typeof tc.index === 'number' ? tc.index : i,
            id: tc.id,
            name: tc.function && tc.function.name,
            argsDelta: tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : undefined,
          });
        }
      }
      if (json.usage) usage = json.usage;
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    }

    const calls = assembler.finalize();
    for (let i = 0; i < calls.length; i++) {
      yield { type: 'toolCall', index: i, id: calls[i].id, name: calls[i].name, argsDelta: calls[i].arguments };
    }
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      };
    }
    yield { type: 'done', finishReason: mapFinishReason(finishReason, calls.length > 0) };
  }
}

/**
 * Shared POST helper for non-SSE (NDJSON) providers. Returns the response
 * body stream (already validated as present).
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {Record<string, any>} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<ReadableStream<Uint8Array>>}
 */
export async function postJSON(fetchImpl, url, headers, body, signal) {
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    const e = /** @type {any} */ (err);
    throw new ProviderError(`request to ${url} failed: ${e && e.message ? e.message : String(err)}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(`${url} responded ${res.status}: ${text.slice(0, 500)}`, { status: res.status });
  }
  if (!res.body) {
    throw new ProviderError(`${url} responded without a stream body`, { status: res.status });
  }
  return res.body;
}

export { randomId };
