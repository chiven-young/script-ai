/**
 * examples/browser-basic — the same core, straight in a browser.
 *
 * No bundler, no dependencies: any static server works.
 *
 *   npx serve .            # or: python3 -m http.server
 *   open http://localhost:3000/examples/browser-basic/
 *
 * Point it at any CORS-enabled OpenAI-compatible endpoint (a local gateway,
 * Ollama's /v1 with OLLAMA_ORIGINS=*, …). No tools here: the browser host
 * injects an empty tool surface — conversation only.
 */

import { createAgent, createProvider } from '../../index.js';

const $ = (id) => document.getElementById(id);
const log = (line) => {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
};

$('run').addEventListener('click', async () => {
  const provider = createProvider.openaiCompatible({
    baseURL: $('baseURL').value.replace(/\/+$/, ''),
    apiKey: $('apiKey').value || undefined,
    model: $('model').value,
  });

  const agent = createAgent({
    provider,
    systemPrompt: $('system').value || 'You are a helpful assistant.',
    maxSteps: 4,
  });

  $('log').textContent = '';
  agent.on('text', ({ delta }) => log(delta));
  agent.on('run:end', ({ steps, reason, usage }) =>
    log(`\n— ${steps} 步 · ${reason} · tokens ${usage.inputTokens}/${usage.outputTokens}`)
  );
  agent.on('error', ({ error, fatal }) => log(`\n[error${fatal ? ' fatal' : ''}] ${error.message}`));

  $('run').disabled = true;
  try {
    await agent.run($('prompt').value || '用一句话介绍你自己');
  } finally {
    $('run').disabled = false;
  }
});
