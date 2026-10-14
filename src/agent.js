/**
 * @file agent.js — the ReAct loop.
 *
 * One step: stream the model → merge tool-call fragments → run each tool
 * through its lifecycle → feed results back as `role:"tool"` messages →
 * repeat until the model answers without tools or `maxSteps` is hit.
 *
 * Three iron rules (ported from Gemini CLI's scheduler semantics):
 *  1. A failing tool never breaks the loop — the error goes back to the
 *     model as a tool result so it can retry or change course. Only an
 *     abort or a fatal provider error interrupts `run()`.
 *  2. Every tool call passes the approval hook (or the tool's own
 *     `permission` when no hook is installed).
 *  3. `maxSteps` is a hard boundary.
 */

import { Emitter } from './events.js';
import { ChunkAccumulator } from './stream.js';
import { ToolRegistry } from './registry.js';
import {
  AbortedError,
  AgentBusyError,
  ProviderError,
  ScriptAIError,
  ToolExecutionError,
  isAbortError,
} from './errors.js';

/**
 * @typedef {object} ToolDecision
 * @property {string} id
 * @property {string} name
 * @property {any} args
 * @property {'allow' | 'deny'} decision final outcome for this call
 * @property {'hook' | 'permission' | 'registry' | 'validation'} by who decided
 */

/**
 * @typedef {object} RunResult
 * @property {string} text last assistant text ('' when the run ended on tools/abort)
 * @property {import('./provider.js').Message[]} messages full conversation
 * @property {number} steps steps executed
 * @property {'done' | 'maxSteps' | 'aborted'} reason
 * @property {{ inputTokens: number, outputTokens: number }} usage
 */

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * @param {unknown} m
 * @returns {m is import('./provider.js').Message}
 */
function isValidMessage(m) {
  if (!m || typeof m !== 'object') return false;
  const msg = /** @type {Record<string, any>} */ (m);
  return (
    typeof msg.role === 'string' &&
    MESSAGE_ROLES.has(msg.role) &&
    (typeof msg.content === 'string' || msg.content === null || Array.isArray(msg.tool_calls))
  );
}

/**
 * @param {any} result
 * @returns {string}
 */
function stringifyResult(result) {
  if (result === undefined) return 'null';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * @param {unknown} err
 * @returns {Error}
 */
function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

export class Agent {
  /**
   * @param {object} options
   * @param {import('./provider.js').ModelProvider} options.provider
   * @param {import('./tool.js').Tool[]} [options.tools] host-injected tool surface
   * @param {string} [options.systemPrompt] prepended as the system message
   * @param {number} [options.maxSteps] hard loop bound, default 10
   * @param {(call: { id: string, name: string, args: any, tool: import('./tool.js').Tool, step: number, signal: AbortSignal, context: Record<string, any> }) => boolean | Promise<boolean>} [options.onBeforeToolCall]
   *   return false (or throw) to cancel the call; called for every non-denied tool
   * @param {Record<string, any>} [options.context] merged into every ToolContext
   * @param {string} [options.model] overrides the provider default
   * @param {number} [options.temperature]
   * @param {number} [options.maxTokens]
   * @param {boolean} [options.reasoning] request a thinking chain when supported
   */
  constructor(options) {
    const {
      provider,
      tools = [],
      systemPrompt,
      maxSteps = 10,
      onBeforeToolCall,
      context,
      model,
      temperature,
      maxTokens,
      reasoning,
    } = options ?? {};

    if (!provider || typeof provider.chat !== 'function') {
      throw new ScriptAIError('createAgent: provider must implement chat(request, signal)', 'INVALID_PROVIDER');
    }
    if (typeof maxSteps !== 'number' || maxSteps < 1) {
      throw new ScriptAIError('createAgent: maxSteps must be a positive number', 'INVALID_OPTIONS');
    }
    if (onBeforeToolCall !== undefined && typeof onBeforeToolCall !== 'function') {
      throw new ScriptAIError('createAgent: onBeforeToolCall must be a function', 'INVALID_OPTIONS');
    }

    this.provider = provider;
    this.systemPrompt = systemPrompt ?? null;
    this.maxSteps = maxSteps;
    this.onBeforeToolCall = onBeforeToolCall ?? null;
    this.context = context ?? {};
    this.model = model ?? null;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.reasoning = reasoning ?? false;

    /** @type {import('./provider.js').Message[]} */
    this.messages = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
    this.steps = 0;

    this.#registry = new ToolRegistry(tools);
    this.#emitter = new Emitter();
  }

  /** @type {ToolRegistry} */
  #registry;
  /** @type {Emitter} */
  #emitter;
  /** @type {boolean} */
  #running = false;
  /** @type {AbortController | null} */
  #controller = null;
  /** @type {{ inputTokens: number, outputTokens: number }} */
  #usage = { inputTokens: 0, outputTokens: 0 };

  /** The host's tool surface. Register/unregister at runtime. */
  get tools() {
    return this.#registry;
  }

  /**
   * Subscribe to an agent event. See the event table in the README.
   * @param {string} type
   * @param {(payload: any) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(type, fn) {
    return this.#emitter.on(type, fn);
  }

  /** @param {string} type @param {(payload: any) => void} fn */
  off(type, fn) {
    this.#emitter.off(type, fn);
  }

  /** @param {string} type @param {(payload: any) => void} fn */
  once(type, fn) {
    this.#emitter.once(type, fn);
  }

  /** Abort the current run (if any). Safe to call when idle. */
  abort() {
    this.#controller?.abort(new AbortedError('run aborted via agent.abort()'));
  }

  /**
   * Run the loop until the model answers without tool calls.
   * @param {string | import('./provider.js').Message[]} input user text, or raw messages to append
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<RunResult>}
   * @throws {AgentBusyError} when a run is already in flight
   * @throws {AbortedError} when aborted (after emitting `run:end` with reason 'aborted')
   * @throws {ProviderError} on fatal provider failures
   */
  async run(input, options = {}) {
    if (this.#running) throw new AgentBusyError();
    this.#running = true;

    const controller = new AbortController();
    this.#controller = controller;
    const externalSignal = options.signal;
    const onExternalAbort = () => controller.abort(new AbortedError('run aborted via signal'));
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const throwIfAborted = () => {
      if (controller.signal.aborted) throw new AbortedError();
    };

    try {
      /** @type {import('./provider.js').Message[]} */
      let inputs;
      if (typeof input === 'string') {
        if (input.length === 0) {
          throw new ScriptAIError('run(): input must be a non-empty string or message array', 'INVALID_INPUT');
        }
        inputs = [{ role: 'user', content: input }];
      } else if (Array.isArray(input) && input.length > 0 && input.every(isValidMessage)) {
        inputs = input;
      } else {
        throw new ScriptAIError('run(): input must be a non-empty string or message array', 'INVALID_INPUT');
      }
      this.messages.push(...inputs);
      this.#emitter.emit('run:start', { input });

      let lastText = '';
      /** @type {'done' | 'maxSteps' | 'aborted'} */
      let reason = 'maxSteps';

      for (;;) {
        throwIfAborted();
        if (this.steps >= this.maxSteps) {
          reason = 'maxSteps';
          break;
        }
        const step = this.steps + 1;
        this.#emitter.emit('step:start', { step, maxSteps: this.maxSteps });

        const acc = new ChunkAccumulator();
        for await (const chunk of this.provider.chat(this.#buildRequest(), controller.signal)) {
          throwIfAborted();
          if (chunk.type === 'text') this.#emitter.emit('text', { delta: chunk.delta });
          else if (chunk.type === 'reasoning') this.#emitter.emit('reasoning', { delta: chunk.delta });
          acc.feed(chunk);
        }
        throwIfAborted();
        if (acc.finishReason === 'error') {
          throw new ProviderError('provider reported an error finish reason');
        }

        this.steps = step;
        lastText = acc.text;
        this.#usage.inputTokens += acc.usage.inputTokens;
        this.#usage.outputTokens += acc.usage.outputTokens;

        const calls = acc.toolCalls;
        if (calls.length === 0) {
          reason = 'done';
          this.messages.push(this.#assistantMessage(acc, []));
          break;
        }

        const toolMessages = await this.#executeToolCalls(calls, step, controller.signal);
        this.messages.push(this.#assistantMessage(acc, calls), ...toolMessages);
        this.#emitter.emit('step:end', { step, toolCalls: calls.length });
      }

      const result = {
        text: lastText,
        messages: this.messages,
        steps: this.steps,
        reason,
        usage: { ...this.#usage },
      };
      this.#emitter.emit('run:end', result);
      return result;
    } catch (err) {
      if (isAbortError(err)) {
        this.#emitter.emit('run:end', {
          text: '',
          messages: this.messages,
          steps: this.steps,
          reason: 'aborted',
          usage: { ...this.#usage },
        });
        throw err instanceof AbortedError ? err : new AbortedError(toError(err).message);
      }
      const error = toError(err);
      this.#emitter.emit('error', { error, fatal: true });
      throw error;
    } finally {
      this.#running = false;
      this.#controller = null;
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * @returns {import('./provider.js').ChatRequest}
   */
  #buildRequest() {
    /** @type {import('./provider.js').ChatRequest} */
    const request = {
      model: this.model ?? this.provider.model ?? undefined,
      messages: this.messages,
      tools: this.#registry.toSpecs(),
    };
    if (this.temperature != null) request.temperature = this.temperature;
    if (this.maxTokens != null) request.maxTokens = this.maxTokens;
    if (this.reasoning) request.reasoning = true;
    return request;
  }

  /**
   * @param {ChunkAccumulator} acc
   * @param {Array<{ id: string, name: string, arguments: string }>} calls
   * @returns {import('./provider.js').Message}
   */
  #assistantMessage(acc, calls) {
    /** @type {import('./provider.js').Message} */
    const message = { role: 'assistant', content: acc.text || null };
    if (acc.reasoning) message.reasoning = acc.reasoning;
    if (calls.length > 0) {
      message.tool_calls = calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return message;
  }

  /**
   * Run one step's tool calls through the lifecycle
   * (validating → awaitingApproval → executing → success | error | cancelled)
   * and return the `role:"tool"` messages to append.
   *
   * @param {Array<{ id: string, name: string, arguments: string }>} calls
   * @param {number} step
   * @param {AbortSignal} signal
   * @returns {Promise<import('./provider.js').Message[]>}
   */
  async #executeToolCalls(calls, step, signal) {
    /** @type {import('./provider.js').Message[]} */
    const toolMessages = [];

    for (const call of calls) {
      const { id, name } = call;
      const argsText = call.arguments;

      /** @type {any} */
      let args = null;
      let argsError = null;
      if (!argsText) {
        args = {};
      } else {
        try {
          args = JSON.parse(argsText);
        } catch (err) {
          argsError = toError(err).message;
        }
      }

      this.#emitter.emit('toolCall', { id, name, args, arguments: argsText });

      /**
       * @param {any} result
       * @param {boolean} ok
       * @param {ToolDecision['by']} by
       * @param {'allow' | 'deny'} decision
       * @param {number} startedAt
       */
      const finish = (result, ok, by, decision, startedAt) => {
        this.#emitter.emit('toolDecision', { id, name, args, decision, by });
        this.#emitter.emit('toolResult', {
          id,
          name,
          result,
          ok,
          durationMs: Date.now() - startedAt,
        });
        toolMessages.push({
          role: 'tool',
          tool_call_id: id,
          name,
          content: stringifyResult(result),
        });
      };

      const startedAt = Date.now();

      // — validating —
      if (argsError) {
        const result = { error: `invalid arguments JSON for tool "${name}": ${argsError}` };
        this.#emitter.emit('error', {
          error: new ToolExecutionError(`tool "${name}" received invalid arguments JSON`, name),
          fatal: false,
        });
        finish(result, false, 'validation', 'deny', startedAt);
        continue;
      }
      const tool = this.#registry.get(name);
      if (!tool) {
        finish(
          { error: `tool "${name}" is not available on this host` },
          false,
          'registry',
          'deny',
          startedAt
        );
        continue;
      }
      if (tool.permission === 'deny') {
        finish(
          { error: `tool "${name}" is denied by host policy` },
          false,
          'permission',
          'deny',
          startedAt
        );
        continue;
      }

      // — awaitingApproval —
      if (this.onBeforeToolCall) {
        /** @type {boolean} */
        let allowed;
        try {
          allowed = await this.onBeforeToolCall({
            id,
            name,
            args,
            tool,
            step,
            signal,
            context: this.context,
          });
        } catch (err) {
          finish(
            { error: `approval hook failed for tool "${name}": ${toError(err).message}` },
            false,
            'hook',
            'deny',
            startedAt
          );
          continue;
        }
        if (!allowed) {
          finish({ error: `tool call "${name}" was denied by the host approval hook` }, false, 'hook', 'deny', startedAt);
          continue;
        }
      } else if (tool.permission === 'ask') {
        // No hook installed: refuse rather than silently execute (safe default).
        finish(
          { error: `tool "${name}" requires approval but no onBeforeToolCall hook is installed` },
          false,
          'permission',
          'deny',
          startedAt
        );
        continue;
      }

      // — executing —
      if (signal.aborted) throw new AbortedError();
      try {
        const result = await tool.execute(args, { ...this.context, signal, step });
        finish(result, true, this.onBeforeToolCall ? 'hook' : 'permission', 'allow', startedAt);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw new AbortedError(toError(err).message);
        const error = toError(err);
        this.#emitter.emit('error', {
          error: new ToolExecutionError(error.message, name, { cause: err }),
          fatal: false,
        });
        // Approval was granted; the failure is reported through toolResult.ok.
        finish({ error: error.message }, false, this.onBeforeToolCall ? 'hook' : 'permission', 'allow', startedAt);
      }
    }

    return toolMessages;
  }
}

/**
 * @param {ConstructorParameters<typeof Agent>[0]} options
 * @returns {Agent}
 */
export function createAgent(options) {
  return new Agent(options);
}
