/**
 * @file test/helpers.js — shared test doubles (mock provider, mock HTTP).
 */

import { createServer } from 'node:http';

/**
 * A provider driven by a script: one entry per expected `chat()` call.
 * Each entry is an array of ChatChunks (or a function returning them, given
 * the request and signal — for abort tests).
 */
export class MockProvider {
  constructor(scripts, { id = 'mock', model = 'mock-model' } = {}) {
    this.scripts = scripts;
    this.id = id;
    this.model = model;
    /** @type {any[]} */
    this.requests = [];
  }

  async *chat(request, signal) {
    this.requests.push(JSON.parse(JSON.stringify(request)));
    const index = Math.min(this.requests.length - 1, this.scripts.length - 1);
    const entry = this.scripts[index];
    if (typeof entry === 'function') {
      // Function entries may return chunks (sync array / async iterable) or a
      // promise that only settles on abort (never-resolving stream tests).
      const produced = await entry(request, signal);
      if (produced && typeof produced[Symbol.asyncIterator] === 'function') {
        yield* produced;
      } else if (produced && typeof produced[Symbol.iterator] === 'function') {
        yield* produced;
      }
      return;
    }
    for (const chunk of entry) {
      yield chunk;
    }
  }
}

/** Build a web ReadableStream from string chunks (tests split-JSON buffering). */
export function streamFrom(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/**
 * Start a local HTTP server. `handler(req, res, body)` replies raw.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        await handler(req, res, body);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
