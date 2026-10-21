import { describe, it, expect, vi } from 'vitest';

import { McpManager } from '../mcp-manager';

import type { McpServerConfig } from '@common/types';

vi.mock('../mcp-secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp-secrets')>();
  return { ...actual, loadMcpSecrets: () => ({ KB_TOKEN: 'secret-kb', API_KEY: 'secret-api' }) };
});

describe('McpManager secret interpolation', () => {
  const projectDir = '/proj';
  const taskDir = '/proj/task';

  it('headers and url are resolved', () => {
    const manager = new McpManager();
    const config: McpServerConfig = {
      url: 'https://example.test/mcp?key=${API_KEY}',
      headers: { Authorization: 'Bearer ${KB_TOKEN}', 'X-Plain': 'plain' },
    };

    const result = (manager as any).interpolateServerConfig(config, projectDir, taskDir);

    expect(result.url).toBe('https://example.test/mcp?key=secret-api');
    expect(result.headers).toEqual({ Authorization: 'Bearer secret-kb', 'X-Plain': 'plain' });
  });

  it('env and args are resolved alongside path placeholders', () => {
    const manager = new McpManager();
    const config: McpServerConfig = {
      command: 'node',
      args: ['${projectDir}/server.js', '--token=${KB_TOKEN}'],
      env: { TOKEN: '${API_KEY}', WORKDIR: '${taskDir}' },
    };

    const result = (manager as any).interpolateServerConfig(config, projectDir, taskDir);

    expect(result.args).toEqual(['/proj/server.js', '--token=secret-kb']);
    expect(result.env).toEqual({ TOKEN: 'secret-api', WORKDIR: '/proj/task' });
    expect(result.command).toBe('node');
  });

  it('the raw config keeps its placeholders', () => {
    const manager = new McpManager();
    const config: McpServerConfig = {
      url: 'https://example.test/mcp?key=${API_KEY}',
      headers: { Authorization: 'Bearer ${KB_TOKEN}', 'X-Plain': 'plain' },
    };
    const saved = JSON.stringify(config);

    (manager as any).interpolateServerConfig(config, projectDir, taskDir);

    expect(JSON.stringify(config)).toBe(saved);
  });

  it('an unknown placeholder throws by name', () => {
    const manager = new McpManager();
    const config: McpServerConfig = {
      url: 'https://example.test',
      headers: { Authorization: 'Bearer ${NOT_SET}' },
    };

    expect(() => (manager as any).interpolateServerConfig(config, projectDir, taskDir)).toThrow(
      'Unresolved MCP secret: NOT_SET',
    );
  });
});
