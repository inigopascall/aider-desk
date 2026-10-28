import path from 'path';

import type { RepositoryMappingsPathRule } from '@common/types';

/** Applies the first matching path rule. */
export const mapProjectPath = (baseDir: string, rules: RepositoryMappingsPathRule[], homeDir: string): string => {
  for (const rule of rules) {
    const from = rule.from.startsWith('~') ? path.join(homeDir, rule.from.slice(1)) : rule.from;
    const normalizedFrom = path.resolve(from);
    const normalizedBase = path.resolve(baseDir);
    if (normalizedBase === normalizedFrom || normalizedBase.startsWith(`${normalizedFrom}${path.sep}`)) {
      const rest = normalizedBase.slice(normalizedFrom.length).replace(/^[/\\]/, '');
      return `${rule.to.replace(/[/\\]+$/, '')}${rest ? `/${rest.split(path.sep).join('/')}` : ''}`;
    }
  }
  return baseDir;
};

/** Major version of laravel/framework installed according to composer.lock text; null when it cannot be determined. Never throws. */
export const getLaravelMajorVersion = (composerLockText: string): number | null => {
  try {
    const lock = JSON.parse(composerLockText) as { packages?: { name?: unknown; version?: unknown }[] };
    const laravel = (lock.packages ?? []).find((pkg) => pkg?.name === 'laravel/framework');
    const match = typeof laravel?.version === 'string' ? laravel.version.match(/^v?(\d+)\./) : null;
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

/** Replaces known command placeholders. */
export const fillCommandTemplate = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{([^}]+)\}/g, (match, name: string) => vars[name] ?? match);

/** Returns whether composer JSON requires Laravel. */
export const isLaravelComposerJson = (text: string): boolean => {
  try {
    const value: unknown = JSON.parse(text);
    const require = typeof value === 'object' && value !== null ? (value as { require?: unknown }).require : undefined;
    return typeof require === 'object' && require !== null && Object.prototype.hasOwnProperty.call(require, 'laravel/framework');
  } catch {
    return false;
  }
};
