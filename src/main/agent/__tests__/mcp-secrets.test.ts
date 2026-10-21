import { readFileSync } from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadMcpSecrets, parseMcpSecrets, resolveMcpSecrets } from '../mcp-secrets';

vi.mock('@/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

describe('parseMcpSecrets', () => {
  it('parses KEY=value lines, skipping blanks, comments and lines without a key', () => {
    const content = ['# a comment', '', 'KB_TOKEN=abc123', '  SPACED  =  padded  ', 'DOUBLE="quoted value"', "SINGLE='single'", 'WITH_EQUALS=a=b=c', 'no separator here', '=missingkey'].join('\n');

    expect(parseMcpSecrets(content)).toEqual({
      KB_TOKEN: 'abc123',
      SPACED: 'padded',
      DOUBLE: 'quoted value',
      SINGLE: 'single',
      WITH_EQUALS: 'a=b=c',
    });
  });

  it('handles CRLF line endings', () => {
    expect(parseMcpSecrets('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('resolveMcpSecrets', () => {
  const secrets = { KB_TOKEN: 'secret-kb', OTHER_TOKEN: 'secret-other' };

  it('replaces every uppercase placeholder', () => {
    expect(resolveMcpSecrets('Bearer ${KB_TOKEN}', secrets)).toBe('Bearer secret-kb');
    expect(resolveMcpSecrets('${KB_TOKEN}:${OTHER_TOKEN}:${KB_TOKEN}', secrets)).toBe('secret-kb:secret-other:secret-kb');
  });

  it('leaves camelCase path placeholders and plain strings untouched', () => {
    expect(resolveMcpSecrets('${projectDir}/x/${taskDir}', secrets)).toBe('${projectDir}/x/${taskDir}');
    expect(resolveMcpSecrets('no placeholders', secrets)).toBe('no placeholders');
  });

  it('throws naming the missing placeholder and no secret value', () => {
    let message = '';
    try {
      resolveMcpSecrets('Bearer ${KB_TOKEN} ${MISSING_TOKEN}', secrets);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Unresolved MCP secret: MISSING_TOKEN');
    expect(message).not.toContain('secret-kb');
  });
});

// src/main/__tests__/setup.ts replaces fs.readFileSync with a mock for every node test, so file contents are supplied through it.
describe('loadMcpSecrets', () => {
  const filePath = '/nonexistent/aider-desk-secrets/mcp.env';

  beforeEach(() => {
    vi.mocked(readFileSync).mockReset();
  });

  it('returns an empty map when the file does not exist', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });

    expect(loadMcpSecrets(filePath)).toEqual({});
  });

  it('reads the file without touching process.env', () => {
    vi.mocked(readFileSync).mockReturnValue('MCP_SECRETS_TEST_TOKEN=from-file\n');
    const envKeysBefore = Object.keys(process.env).sort();

    expect(loadMcpSecrets(filePath)).toEqual({ MCP_SECRETS_TEST_TOKEN: 'from-file' });
    expect(process.env.MCP_SECRETS_TEST_TOKEN).toBeUndefined();
    expect(Object.keys(process.env).sort()).toEqual(envKeysBefore);
  });
});
