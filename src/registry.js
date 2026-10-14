/**
 * @file registry.js — the host's tool surface.
 *
 * The registry is the single place tools enter the core. Hosts register
 * whatever their platform allows (filesystem on desktop, camera on mobile,
 * nothing in the browser) and the agent loop stays identical.
 *
 * Note on `permission: 'deny'`: such tools are excluded from the provider
 * payload entirely — the model never sees them. If the model calls one anyway
 * (hallucination, stale prompt), the agent answers with a policy error instead
 * of executing.
 */

import { defineTool, toolToSpec } from './tool.js';

export class ToolRegistry {
  /** @type {Map<string, Readonly<import('./tool.js').Tool>>} */
  #tools = new Map();

  /**
   * @param {import('./tool.js').Tool[]} [tools]
   */
  constructor(tools) {
    if (tools) this.register(tools);
  }

  /**
   * Register one tool or an array. Accepts raw specs (validated via
   * `defineTool`) as well as already-defined tools.
   * @param {import('./tool.js').Tool | import('./tool.js').Tool[]} tool
   * @returns {this}
   */
  register(tool) {
    const list = Array.isArray(tool) ? tool : [tool];
    for (const item of list) {
      const defined = defineTool(item);
      this.#tools.set(defined.name, defined);
    }
    return this;
  }

  /**
   * @param {string} name
   * @returns {boolean} true when a tool was removed
   */
  unregister(name) {
    return this.#tools.delete(name);
  }

  /**
   * @param {string} name
   * @returns {Readonly<import('./tool.js').Tool> | undefined}
   */
  get(name) {
    return this.#tools.get(name);
  }

  /** @param {string} name */
  has(name) {
    return this.#tools.has(name);
  }

  /** @returns {Readonly<import('./tool.js').Tool>[]} */
  list() {
    return [...this.#tools.values()];
  }

  /** @returns {string[]} */
  names() {
    return [...this.#tools.keys()];
  }

  /** @returns {number} */
  get size() {
    return this.#tools.size;
  }

  /**
   * Provider-facing specs, excluding `permission: 'deny'` tools.
   * @returns {Array<{ name: string, description: string, parameters: import('./tool.js').JSONSchema }>}
   */
  toSpecs() {
    return this.list()
      .filter((tool) => tool.permission !== 'deny')
      .map(toolToSpec);
  }
}
