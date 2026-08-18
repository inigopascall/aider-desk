import fs from 'fs/promises';
import path from 'path';

import type { ContextFile, RegenerateRepositoryMappingsResult } from '@common/types';

import { AIDER_DESK_MAPPINGS_SCRIPT, AIDER_DESK_PROJECT_MAPPINGS_DIR } from '@/constants';
import { execWithShellPath } from '@/utils';

export const DEFAULT_MAPPINGS_SCRIPT = `#!/usr/bin/env bash
#
# AiderDesk repository-mapping generator.
#
# Files written to .aider-desk/mappings/ become read-only agent context when
# "Include repository mappings" is enabled in an agent profile. Regenerate
# them from the Repository Mappings Workspace section.
#
# Prefer writing temporary files and moving them into place so readers never
# observe a partially generated mapping file.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

OUTPUT_DIR=".aider-desk/mappings"
mkdir -p "$OUTPUT_DIR"

# Example: generate Aider's repository map.
# aider --show-repo-map > "$OUTPUT_DIR/repo-map.txt"

# Example: generate framework-specific mappings.
# php artisan atlas:export --type=models --format=json --output="$OUTPUT_DIR/models.json"
# npm run export:architecture > "$OUTPUT_DIR/architecture.md"
`;

export const ensureRepositoryMappingsInitialized = async (baseDir: string): Promise<void> => {
  await fs.mkdir(path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR), { recursive: true });

  const scriptPath = path.join(baseDir, AIDER_DESK_MAPPINGS_SCRIPT);
  try {
    await fs.access(scriptPath);
  } catch {
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.writeFile(scriptPath, DEFAULT_MAPPINGS_SCRIPT, 'utf8');
  }
};

export const listRepositoryMappingFiles = async (baseDir: string): Promise<ContextFile[]> => {
  const mappingsDir = path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR);

  const walk = async (dir: string): Promise<string[]> => {
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(entryPath)));
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
    return files;
  };

  const files = await walk(mappingsDir);
  return files
    .map((filePath) => ({
      path: path.relative(baseDir, filePath).split(path.sep).join('/'),
      readOnly: true,
      source: 'repo-mapping' as const,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
};

export const runRepositoryMappingsGenerator = async (baseDir: string): Promise<RegenerateRepositoryMappingsResult> => {
  try {
    await ensureRepositoryMappingsInitialized(baseDir);
    await execWithShellPath(`bash "${path.join(baseDir, AIDER_DESK_MAPPINGS_SCRIPT)}"`, { cwd: baseDir });
    return { success: true };
  } catch (error) {
    const err = error as Error & { stderr?: string };
    return {
      success: false,
      error: [err.message, err.stderr].filter(Boolean).join('\n'),
    };
  }
};
