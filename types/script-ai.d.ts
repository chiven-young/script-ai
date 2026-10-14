/**
 * Hand-written type definitions for script-ai 2.x.
 * Kept in sync with the JSDoc in `src/` (CI: `tsc --allowJs --checkJs`).
 */

// ---------------------------------------------------------------------------
// Tool — the smallest unit of host-injected capability
// ---------------------------------------------------------------------------

export interface JSONSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export type ToolPermission = 'allow' | 'ask' | 'deny';

export interface ToolContext {
  /** Aborts together with the run. */
  signal: AbortSignal;
  /** 1-based loop iteration this call belongs to. */
  step: number;
  /** Host-defined context (merged from `createAgent({ context })`). */
  [key: string]: unknown;
}

export interface Tool<TArgs = any, TResult = any> {
  /** Unique. `server__tool` naming recommended when bridging MCP. */
  name: string;
  /** Shown to the model — treat as prompt surface. */
  description: string;
  /** JSON Schema with an object root (same shape as MCP `inputSchema`). */
  parameters: JSONSchema;
  /** Default `'ask'`. `'deny'` tools are never sent to the model. */
  permission?: ToolPermission;
  execute(args: TArgs, ctx: ToolContext): TResult | Promise<TResult>;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export function defineTool<TArgs = any, TResult = any>(spec: Tool<TArgs, TResult>): Readonly<Tool<TArgs, TResult>>;
export function toolToSpec(tool: Tool): ToolSpec;

// ---------------------------------------------------------------------------
// ToolRegistry — the host's tool surface
// ---------------------------------------------------------------------------

export class ToolRegistry {
  constructor(tools?: Tool[]);
  register(tool: Tool | Tool[]): this;
  unregister(name: string): boolean;
  get(name: string): Readonly<Tool> | undefined;
  has(name: string): boolean;
  list(): Readonly<Tool>[];
  names(): string[];
  readonly size: number;
  /** Specs for the provider payload; excludes `permission: 'deny'` tools. */
  toSpecs(): ToolSpec[];
}

// ---------------------------------------------------------------------------
// Messages & providers
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string | null;
  /** Assistant thinking chain; kept across turns for context. */
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  model?: string;
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for a thinking chain when the provider supports it. */
  reasoning?: boolean;
}

export interface TextChunk {
  type: 'text';
  delta: string;
}
export interface ReasoningChunk {
  type: 'reasoning';
  delta: string;
}
export interface ToolCallChunk {
  type: 'toolCall';
  index?: number;
  id?: string;
  name?: string;
  /** String slice of the arguments JSON. */
  argsDelta?: string;
  /** Partial arguments object (Ollama native). */
  args?: Record<string, unknown>;
}
export interface UsageChunk {
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
}
export interface DoneChunk {
  type: 'done';
  finishReason: 'stop' | 'toolCalls' | 'length' | 'error';
}

export type ChatChunk = TextChunk | ReasoningChunk | ToolCallChunk | UsageChunk | DoneChunk;

export interface ModelProvider {
  /** Stable identifier; stored in snapshots. */
  id: string;
  model?: string | null;
  chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk>;
}

export interface OpenAICompatibleProviderOptions {
  /** e.g. `https://api.example.com/v1` */
  baseURL: string;
  apiKey?: string;
  model?: string;
  path?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  id?: string;
  includeUsage?: boolean;
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(options: OpenAICompatibleProviderOptions);
  id: string;
  model: string | null;
  chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk>;
}

export interface OllamaProviderOptions {
  baseURL?: string;
  model?: string;
  /** `'native'` (default, /api/chat) or `'compat'` (/v1/chat/completions). */
  api?: 'native' | 'compat';
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  id?: string;
}

export class OllamaProvider implements ModelProvider {
  constructor(options?: OllamaProviderOptions);
  id: string;
  api: 'native' | 'compat';
  model: string | null;
  chat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatChunk>;
}

export const createProvider: {
  ollama(options?: OllamaProviderOptions): OllamaProvider;
  openaiCompatible(options: OpenAICompatibleProviderOptions): OpenAICompatibleProvider;
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface BeforeToolCallPayload {
  id: string;
  name: string;
  args: any;
  tool: Readonly<Tool>;
  step: number;
  signal: AbortSignal;
  context: Record<string, unknown>;
}

export interface AgentOptions {
  provider: ModelProvider;
  tools?: Tool[];
  systemPrompt?: string;
  /** Hard loop bound. Default 10. */
  maxSteps?: number;
  /** Return false (or throw) to cancel the call. */
  onBeforeToolCall?: (call: BeforeToolCallPayload) => boolean | Promise<boolean>;
  context?: Record<string, any>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface AgentEvents {
  'run:start': { input: string | Message[] };
  'step:start': { step: number; maxSteps: number };
  text: { delta: string };
  reasoning: { delta: string };
  toolCall: { id: string; name: string; args: any; arguments: string };
  toolDecision: {
    id: string;
    name: string;
    args: any;
    decision: 'allow' | 'deny';
    by: 'hook' | 'permission' | 'registry' | 'validation';
  };
  toolResult: { id: string; name: string; result: any; ok: boolean; durationMs: number };
  'step:end': { step: number; toolCalls: number };
  'run:end': RunResult;
  error: { error: Error; fatal: boolean };
}

export type RunEndReason = 'done' | 'maxSteps' | 'aborted';

export interface RunResult {
  text: string;
  messages: Message[];
  steps: number;
  reason: RunEndReason;
  usage: { inputTokens: number; outputTokens: number };
}

export class Agent {
  constructor(options: AgentOptions);
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  systemPrompt: string | null;
  maxSteps: number;
  onBeforeToolCall: ((call: BeforeToolCallPayload) => boolean | Promise<boolean>) | null;
  context: Record<string, any>;
  model: string | null;
  messages: Message[];
  steps: number;

  on<K extends keyof AgentEvents>(type: K, fn: (payload: AgentEvents[K]) => void): () => void;
  on(type: '*', fn: (type: string, payload: any) => void): () => void;
  on(type: string, fn: (payload: any) => void): () => void;
  off(type: string, fn: (payload: any) => void): void;
  once(type: string, fn: (payload: any) => void): void;
  abort(): void;
  run(input: string | Message[], options?: { signal?: AbortSignal }): Promise<RunResult>;
}

export function createAgent(options: AgentOptions): Agent;

// ---------------------------------------------------------------------------
// Session — snapshot / restore
// ---------------------------------------------------------------------------

export const SNAPSHOT_VERSION: number;

export interface AgentSnapshot {
  version: number;
  createdAt: string;
  steps: number;
  maxSteps: number;
  provider: { id: string; model: string | null };
  messages: Message[];
}

export function snapshot(agent: Agent): AgentSnapshot;
export function restore(agent: Agent, snap: AgentSnapshot): Agent;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ScriptAIError extends Error {
  code: string;
  constructor(message: string, code?: string, options?: { cause?: unknown });
}
export class ProviderError extends ScriptAIError {
  status?: number;
}
export class ToolExecutionError extends ScriptAIError {
  toolName?: string;
}
export class SnapshotVersionError extends ScriptAIError {
  expected?: number;
  actual?: unknown;
}
export class AgentBusyError extends ScriptAIError {}
export class AbortedError extends ScriptAIError {}
export function isAbortError(err: unknown): boolean;

// ---------------------------------------------------------------------------
// Stream internals (exported for testing and advanced hosts)
// ---------------------------------------------------------------------------

export class ToolCallAssembler {
  add(fragment: {
    index?: number;
    id?: string;
    name?: string;
    argsDelta?: string;
    args?: Record<string, unknown>;
  }): void;
  readonly size: number;
  finalize(): ToolCall[];
}

export class ChunkAccumulator {
  text: string;
  reasoning: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'toolCalls' | 'length' | 'error' | null;
  feed(chunk: ChatChunk): void;
  readonly toolCalls: ToolCall[];
}

export function parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<any>;
export function parseNDJSON(body: ReadableStream<Uint8Array>): AsyncGenerator<any>;
export function mergeDeep(target: Record<string, any>, src: Record<string, any>): Record<string, any>;

export class Emitter {
  on(type: string, fn: (payload: any) => void): () => void;
  off(type: string, fn: (payload: any) => void): void;
  once(type: string, fn: (payload: any) => void): void;
  emit(type: string, payload: unknown): void;
  removeAllListeners(type?: string): void;
}
