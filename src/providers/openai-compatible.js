/**
 * @file providers/openai-compatible.js — factory for any OpenAI-compatible endpoint.
 */

import { OpenAICompatibleProvider } from '../provider.js';

/**
 * @param {ConstructorParameters<typeof OpenAICompatibleProvider>[0]} options
 * @returns {OpenAICompatibleProvider}
 */
export function createOpenAICompatibleProvider(options) {
  return new OpenAICompatibleProvider(options);
}
