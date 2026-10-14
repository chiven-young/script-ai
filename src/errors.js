/**
 * @file errors.js — script-ai error hierarchy.
 * Every error carries a machine-readable `code` so hosts can branch on it
 * without string-matching messages.
 */

/** Base class for all script-ai errors. */
export class ScriptAIError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, code = 'SCRIPT_AI_ERROR', options) {
    super(message, options);
    this.name = 'ScriptAIError';
    this.code = code;
  }
}

/** A model provider request failed (network, non-2xx, malformed stream). */
export class ProviderError extends ScriptAIError {
  /**
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, 'PROVIDER_ERROR', { cause: details.cause });
    this.name = 'ProviderError';
    this.status = details.status;
  }
}

/** A tool's `execute()` threw. Reported as a tool result; never breaks the loop. */
export class ToolExecutionError extends ScriptAIError {
  /**
   * @param {string} message
   * @param {string} [toolName]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, toolName, options) {
    super(message, 'TOOL_EXECUTION_ERROR', options);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
  }
}

/** `restore()` received a snapshot whose version does not match this build. */
export class SnapshotVersionError extends ScriptAIError {
  /**
   * @param {string} message
   * @param {{ expected?: number, actual?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, 'SNAPSHOT_VERSION_ERROR');
    this.name = 'SnapshotVersionError';
    this.expected = details.expected;
    this.actual = details.actual;
  }
}

/** `run()` was called while the agent is already running. */
export class AgentBusyError extends ScriptAIError {
  constructor(message = 'agent is already running; await the current run() or abort() it first') {
    super(message, 'AGENT_BUSY');
    this.name = 'AgentBusyError';
  }
}

/** The run was aborted via signal or `agent.abort()`. */
export class AbortedError extends ScriptAIError {
  constructor(message = 'run aborted') {
    super(message, 'ABORTED');
    this.name = 'AbortedError';
  }
}

/**
 * True when an error represents cancellation rather than a real failure.
 * Covers DOMException AbortError (fetch), our own AbortedError, and the
 * `AbortError` name used across runtimes.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  const e = /** @type {any} */ (err);
  return e instanceof AbortedError || e.name === 'AbortError' || e.code === 'ABORTED' || e.code === 20;
}
