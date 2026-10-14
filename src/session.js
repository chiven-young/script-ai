/**
 * @file session.js — snapshot / restore for checkpointing.
 *
 * `messages` is the entire agent state (OpenAI-compatible array plus optional
 * `reasoning` fields), so it is trivially JSON-serializable. Where it is
 * stored (cells-db, idb, a file) is the host's business; the core only
 * guarantees that a restored agent behaves identically.
 *
 * `restore()` validates the snapshot version and throws
 * `SnapshotVersionError` on mismatch instead of guessing.
 */

import { ScriptAIError, SnapshotVersionError } from './errors.js';

/** Bump when the snapshot shape changes incompatibly. */
export const SNAPSHOT_VERSION = 1;

/**
 * @param {import('./agent.js').Agent} agent
 * @returns {{
 *   version: number,
 *   createdAt: string,
 *   steps: number,
 *   maxSteps: number,
 *   provider: { id: string, model: string | null },
 *   messages: import('./provider.js').Message[]
 * }}
 */
export function snapshot(agent) {
  return {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    steps: agent.steps,
    maxSteps: agent.maxSteps,
    provider: {
      id: agent.provider?.id ?? 'unknown',
      model: agent.model ?? agent.provider?.model ?? null,
    },
    messages: structuredClone(agent.messages),
  };
}

/**
 * @param {import('./agent.js').Agent} agent
 * @param {ReturnType<typeof snapshot>} snap
 * @returns {import('./agent.js').Agent} the same agent, for chaining
 */
export function restore(agent, snap) {
  if (!snap || typeof snap !== 'object') {
    throw new ScriptAIError('restore: snapshot must be an object', 'INVALID_SNAPSHOT');
  }
  if (snap.version !== SNAPSHOT_VERSION) {
    throw new SnapshotVersionError(
      `snapshot version ${String(snap.version)} cannot be read by script-ai ${SNAPSHOT_VERSION}`,
      { expected: SNAPSHOT_VERSION, actual: snap.version }
    );
  }
  if (!Array.isArray(snap.messages) || snap.messages.some((m) => !m || typeof m.role !== 'string')) {
    throw new ScriptAIError('restore: snapshot.messages must be an array of messages', 'INVALID_SNAPSHOT');
  }
  agent.messages = structuredClone(snap.messages);
  if (typeof snap.steps === 'number' && snap.steps >= 0) agent.steps = snap.steps;
  if (typeof snap.maxSteps === 'number' && snap.maxSteps >= 1) agent.maxSteps = snap.maxSteps;
  return agent;
}
