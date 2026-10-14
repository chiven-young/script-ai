/**
 * @file index.js — the only public entry point.
 *
 * Five concepts, that's the whole API:
 *   createProvider   — { ollama, openaiCompatible } adapter factories
 *   defineTool       — validate a host-injected tool
 *   createAgent      — build an agent (provider + tools + loop options)
 *   ToolRegistry     — the host's tool surface (advanced)
 *   snapshot/restore — checkpointing (advanced)
 */

export { defineTool, toolToSpec } from './src/tool.js';
export { ToolRegistry } from './src/registry.js';
export { Agent, createAgent } from './src/agent.js';
export { snapshot, restore, SNAPSHOT_VERSION } from './src/session.js';
export { createProvider } from './src/providers/index.js';
export { OllamaProvider } from './src/providers/ollama.js';
export { OpenAICompatibleProvider } from './src/provider.js';
export {
  ScriptAIError,
  ProviderError,
  ToolExecutionError,
  SnapshotVersionError,
  AgentBusyError,
  AbortedError,
  isAbortError,
} from './src/errors.js';
export { ToolCallAssembler, ChunkAccumulator, parseSSE, parseNDJSON } from './src/stream.js';
export { Emitter } from './src/events.js';
