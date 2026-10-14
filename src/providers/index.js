/**
 * @file providers/index.js — `createProvider` factories.
 */

import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { OllamaProvider } from './ollama.js';

/**
 * Built-in provider factories.
 *
 * ```js
 * createProvider.ollama({ baseURL: 'http://localhost:11434', model: 'qwen2.5' })
 * createProvider.openaiCompatible({ baseURL: 'https://api.example.com/v1', apiKey: '…', model: '…' })
 * ```
 */
export const createProvider = {
  /**
   * Ollama. Defaults to the native `/api/chat` endpoint; pass `api: 'compat'`
   * for Ollama's OpenAI-compatible `/v1/chat/completions`.
   * @param {ConstructorParameters<typeof OllamaProvider>[0]} [options]
   */
  ollama(options) {
    return new OllamaProvider(options);
  },
  /**
   * Any OpenAI-compatible endpoint (gateway, DeepSeek, vLLM, …).
   * @param {ConstructorParameters<typeof import('../provider.js').OpenAICompatibleProvider>[0]} options
   */
  openaiCompatible(options) {
    return createOpenAICompatibleProvider(options);
  },
};

export { OllamaProvider } from './ollama.js';
export { OpenAICompatibleProvider } from '../provider.js';
