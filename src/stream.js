/**
 * @file stream.js — line parsing (SSE / NDJSON) and tool_call fragment merging.
 *
 * This is the most bug-prone part of any OpenAI-compatible client, so it lives
 * in its own module with dedicated unit tests:
 *
 *  - `tool_calls` arrive as *fragments*: the first piece carries `id` and
 *    `function.name`, later pieces carry only string slices of
 *    `function.arguments`. Ollama's native API instead streams *partial
 *    objects* for `arguments`. Both shapes are merged here.
 *  - SSE frames (`data: {...}`) and Ollama's bare NDJSON lines are both
 *    supported.
 *
 * Everything here is Web-standard only: `TextDecoder` + `ReadableStream`.
 */

/**
 * Iterate the lines of a response body stream. Handles `\n` and `\r\n`,
 * and keeps multi-byte UTF-8 characters split across chunks intact.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<string>}
 */
export async function* iterateBodyLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        yield buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released / stream errored — nothing to do
    }
  }
}

/**
 * Parse an SSE body into JSON objects. Skips comments, `event:`/`id:` lines
 * and the terminating `data: [DONE]` sentinel; malformed `data:` payloads are
 * skipped rather than thrown (servers use them as keep-alives).
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<any>}
 */
export async function* parseSSE(body) {
  for await (const line of iterateBodyLines(body)) {
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue; // event:, id:, retry: — ignored
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') return;
      continue;
    }
    try {
      yield JSON.parse(data);
    } catch {
      // keep-alive or malformed frame — ignore
    }
  }
}

/**
 * Parse an NDJSON body (one JSON object per line — Ollama's native format).
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<any>}
 */
export async function* parseNDJSON(body) {
  for await (const line of iterateBodyLines(body)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // partial trailing line or garbage — ignore
    }
  }
}

/**
 * Deep-merge `src` into `target` (plain objects recurse; everything else,
 * including arrays, is replaced). Used for Ollama's cumulative partial
 * argument objects.
 * @param {Record<string, any>} target
 * @param {Record<string, any>} src
 * @returns {Record<string, any>}
 */
export function mergeDeep(target, src) {
  for (const [key, value] of Object.entries(src)) {
    const existing = target[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      mergeDeep(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Stable-ish unique id for tool calls that arrive without one (Ollama).
 * @param {string} [prefix]
 * @returns {string}
 */
export function randomId(prefix = 'call') {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Merges streamed tool-call fragments into complete calls.
 *
 * Two fragment shapes are supported:
 *  - string deltas (`argsDelta`) — OpenAI-compatible SSE;
 *  - partial objects (`args`)     — Ollama native NDJSON.
 *
 * `finalize()` returns OpenAI-compatible calls:
 * `[{ id, name, arguments }]` where `arguments` is always a JSON *string*.
 */
export class ToolCallAssembler {
  /** @type {Map<number, { id?: string, name?: string, argsText: string, argsObj: Record<string, any> | null }>} */
  #calls = new Map();

  /**
   * @param {object} fragment
   * @param {number} [fragment.index] parallel tool-call slot (default 0)
   * @param {string} [fragment.id] present on the first fragment
   * @param {string} [fragment.name] present on the first fragment
   * @param {string} [fragment.argsDelta] string slice of arguments
   * @param {Record<string, any>} [fragment.args] partial arguments object
   */
  add(fragment) {
    const index = fragment.index ?? 0;
    let call = this.#calls.get(index);
    if (!call) {
      call = { argsText: '', argsObj: null };
      this.#calls.set(index, call);
    }
    if (fragment.id) call.id = fragment.id;
    if (fragment.name) call.name = fragment.name;
    if (typeof fragment.argsDelta === 'string') call.argsText += fragment.argsDelta;
    if (fragment.args && typeof fragment.args === 'object' && !Array.isArray(fragment.args)) {
      call.argsObj = call.argsObj ? mergeDeep(call.argsObj, fragment.args) : { ...fragment.args };
    }
  }

  /** @returns {number} number of distinct tool-call slots seen */
  get size() {
    return this.#calls.size;
  }

  /**
   * @returns {Array<{ id: string, name: string, arguments: string }>}
   *   complete calls, ordered by index. `arguments` is a JSON string (possibly
   *   invalid JSON — callers decide how to handle that).
   */
  finalize() {
    return [...this.#calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        id: call.id ?? randomId('call'),
        name: call.name ?? '',
        arguments: call.argsObj ? JSON.stringify(call.argsObj) : call.argsText,
      }));
  }
}

/**
 * Accumulates a `ChatChunk` stream into text, reasoning, tool calls, usage
 * and a finish reason. Used by the agent loop; providers stay dumb.
 */
export class ChunkAccumulator {
  constructor() {
    /** @type {string} */
    this.text = '';
    /** @type {string} */
    this.reasoning = '';
    /** @type {{ inputTokens: number, outputTokens: number }} */
    this.usage = { inputTokens: 0, outputTokens: 0 };
    /** @type {'stop' | 'toolCalls' | 'length' | 'error' | null} */
    this.finishReason = null;
    this.#assembler = new ToolCallAssembler();
  }

  /** @type {ToolCallAssembler} */
  #assembler;

  /**
   * @param {import('./provider.js').ChatChunk} chunk
   */
  feed(chunk) {
    switch (chunk.type) {
      case 'text':
        this.text += chunk.delta ?? '';
        break;
      case 'reasoning':
        this.reasoning += chunk.delta ?? '';
        break;
      case 'toolCall':
        this.#assembler.add(chunk);
        break;
      case 'usage':
        this.usage.inputTokens += chunk.inputTokens ?? 0;
        this.usage.outputTokens += chunk.outputTokens ?? 0;
        break;
      case 'done':
        if (chunk.finishReason) this.finishReason = chunk.finishReason;
        break;
      default:
        break;
    }
  }

  /**
   * @returns {Array<{ id: string, name: string, arguments: string }>}
   */
  get toolCalls() {
    return this.#assembler.finalize();
  }
}
