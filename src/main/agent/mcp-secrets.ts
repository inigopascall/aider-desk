import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import logger from '@/logger';

/** Holds the values for `${NAME}` placeholders in MCP server configs. KEY=value lines; never loaded into process.env. */
export const MCP_SECRETS_FILE = path.join(homedir(), '.config', 'aider-desk-secrets', 'mcp.env');

const SECRET_PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export const parseMcpSecrets = (content: string): Record<string, string> => {
  const secrets: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    secrets[key] = value;
  }
  return secrets;
};

export const loadMcpSecrets = (filePath: string = MCP_SECRETS_FILE): Record<string, string> => {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`Could not read MCP secrets file ${filePath}: ${code ?? 'unknown error'}`);
    }
    return {};
  }

  try {
    if ((statSync(filePath).mode & 0o077) !== 0) {
      logger.warn(`MCP secrets file ${filePath} is readable by group or others; run chmod 600 on it`);
    }
  } catch {
    // The file was readable a moment ago; a failed stat only skips the permission warning.
  }

  return parseMcpSecrets(content);
};

/** Replaces every `${NAME}` (uppercase name) with its secret. Throws, naming the placeholder only, when a name has no value. */
export const resolveMcpSecrets = (value: string, secrets: Record<string, string>): string =>
  value.replace(SECRET_PLACEHOLDER, (_match: string, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(secrets, name)) {
      throw new Error(`Unresolved MCP secret: ${name}`);
    }
    return secrets[name];
  });
