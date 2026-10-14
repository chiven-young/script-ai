/**
 * @file tool.js — the Tool contract: the smallest unit of host-injected capability.
 *
 * A tool is *data* (name / description / parameters) plus *behavior*
 * (`execute`). The core never runs a tool it was not given; hosts decide what
 * exists on their platform. The schema shape matches MCP's `inputSchema` so
 * tool definitions can later be bridged to MCP servers without translation.
 */

import { ScriptAIError } from './errors.js';

/**
 * @typedef {object} JSONSchema
 * @property {string} [type]
 * @property {Record<string, any>} [properties]
 * @property {string[]} [required]
 */

/**
 * @typedef {object} ToolContext
 * @property {AbortSignal} signal aborts with the run
 * @property {number} step 1-based loop iteration this call belongs to
 * @property {Record<string, any>} [extra] host-defined context, merged from `createAgent({ context })`
 */

/**
 * @typedef {object} Tool
 * @property {string} name unique; `server__tool` naming recommended when bridging MCP
 * @property {string} description shown to the model — treat as prompt surface
 * @property {JSONSchema} parameters JSON Schema with an object root
 * @property {'allow' | 'ask' | 'deny'} permission default 'ask'; 'deny' tools are never sent to the model
 * @property {(args: any, ctx: ToolContext) => any} execute may be sync or async
 */

const PERMISSIONS = new Set(['allow', 'ask', 'deny']);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Validate and normalize a tool spec. Throws `ScriptAIError` (code
 * `INVALID_TOOL`) with a precise message on any violation.
 * @param {Tool} spec
 * @returns {Readonly<Tool>}
 */
export function defineTool(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ScriptAIError('defineTool: spec must be an object', 'INVALID_TOOL');
  }
  const { name, description, parameters, execute, permission = 'ask' } = spec;

  if (typeof name !== 'string' || name.length === 0) {
    throw new ScriptAIError('defineTool: name must be a non-empty string', 'INVALID_TOOL');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ScriptAIError(
      `defineTool: name "${name}" must start alphanumeric and contain only letters, digits, "_", ".", "-"`,
      'INVALID_TOOL'
    );
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new ScriptAIError(`defineTool: "${name}" needs a description (the model reads it)`, 'INVALID_TOOL');
  }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new ScriptAIError(`defineTool: "${name}" parameters must be a JSON Schema object`, 'INVALID_TOOL');
  }
  if (parameters.type !== 'object') {
    throw new ScriptAIError(`defineTool: "${name}" parameters.type must be "object"`, 'INVALID_TOOL');
  }
  if (typeof execute !== 'function') {
    throw new ScriptAIError(`defineTool: "${name}" needs an execute() function`, 'INVALID_TOOL');
  }
  if (!PERMISSIONS.has(permission)) {
    throw new ScriptAIError(`defineTool: "${name}" permission must be one of ${[...PERMISSIONS].join(' | ')}`, 'INVALID_TOOL');
  }

  return Object.freeze({ name, description, parameters, permission, execute });
}

/**
 * Neutral provider-facing view of a tool (MCP-shaped, no behavior).
 * @param {Tool} tool
 * @returns {{ name: string, description: string, parameters: JSONSchema }}
 */
export function toolToSpec(tool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
