/**
 * @file test/tool.test.js + registry.test.js — tool contract and tool surface.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { defineTool, toolToSpec } from '../src/tool.js';
import { ToolRegistry } from '../src/registry.js';
import { ScriptAIError } from '../src/errors.js';

const validSpec = () => ({
  name: 'list_dir',
  description: '列出目录内容',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: () => ['a.txt'],
});

test('defineTool accepts a valid spec and defaults permission to ask', () => {
  const tool = defineTool(validSpec());
  assert.equal(tool.name, 'list_dir');
  assert.equal(tool.permission, 'ask');
  assert.equal(typeof tool.execute, 'function');
  assert.ok(Object.isFrozen(tool));
});

test('defineTool accepts MCP-style server__tool names', () => {
  const tool = defineTool({ ...validSpec(), name: 'fs__read_file' });
  assert.equal(tool.name, 'fs__read_file');
});

test('defineTool rejects bad shapes with INVALID_TOOL', () => {
  const cases = [
    [null, 'spec must be an object'],
    [{ ...validSpec(), name: '' }, 'name must be a non-empty string'],
    [{ ...validSpec(), name: 'has space' }, 'must start alphanumeric'],
    [{ ...validSpec(), name: '-leading' }, 'must start alphanumeric'],
    [{ ...validSpec(), description: '' }, 'needs a description'],
    [{ ...validSpec(), parameters: { properties: {} } }, 'parameters.type must be "object"'],
    [{ ...validSpec(), parameters: 'nope' }, 'parameters must be a JSON Schema object'],
    [{ ...validSpec(), execute: 'nope' }, 'needs an execute() function'],
    [{ ...validSpec(), permission: 'maybe' }, 'permission must be one of'],
  ];
  for (const [spec, fragment] of cases) {
    assert.throws(() => defineTool(spec), (err) => err instanceof ScriptAIError && err.code === 'INVALID_TOOL' && err.message.includes(fragment), `expected rejection for ${fragment}`);
  }
});

test('toolToSpec strips behavior, keeps schema', () => {
  const tool = defineTool({ ...validSpec(), permission: 'allow' });
  assert.deepEqual(toolToSpec(tool), {
    name: 'list_dir',
    description: '列出目录内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  });
});

test('ToolRegistry registers, replaces, unregisters', () => {
  const registry = new ToolRegistry();
  registry.register(validSpec());
  assert.equal(registry.size, 1);
  assert.ok(registry.has('list_dir'));

  // same name replaces
  const v2 = defineTool({ ...validSpec(), description: 'v2' });
  registry.register(v2);
  assert.equal(registry.size, 1);
  assert.equal(registry.get('list_dir').description, 'v2');

  assert.equal(registry.unregister('list_dir'), true);
  assert.equal(registry.unregister('list_dir'), false);
  assert.equal(registry.size, 0);
});

test('ToolRegistry accepts arrays and raw specs', () => {
  const registry = new ToolRegistry([validSpec(), { ...validSpec(), name: 'read_file' }]);
  assert.deepEqual(registry.names().sort(), ['list_dir', 'read_file']);
});

test('ToolRegistry.toSpecs excludes permission:deny tools', () => {
  const registry = new ToolRegistry([
    validSpec(),
    { ...validSpec(), name: 'bash', description: 'run shell', permission: 'deny', execute: () => '' },
    { ...validSpec(), name: 'ask_tool', permission: 'ask', execute: () => '' },
  ]);
  assert.deepEqual(
    registry.toSpecs().map((s) => s.name),
    ['list_dir', 'ask_tool']
  );
  // denied tools are still registered (so the model gets a policy error, not "unknown tool")
  assert.ok(registry.has('bash'));
});

test('ToolRegistry.register validates through defineTool', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register({ name: 'bad name' }), ScriptAIError);
});
