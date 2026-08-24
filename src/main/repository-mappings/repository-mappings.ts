import fs from 'fs/promises';
import path from 'path';

import type { ContextFile, RegenerateRepositoryMappingsResult } from '@common/types';

import { AIDER_DESK_GENERATE_REPO_MAP_SCRIPT, AIDER_DESK_MAPPINGS_SCRIPT, AIDER_DESK_PROJECT_MAPPINGS_DIR } from '@/constants';
import { execWithShellPath } from '@/utils';

export const getDefaultMappingsScript = (): string => `#!/usr/bin/env bash
#
# AiderDesk repository-mapping generator.
#
# Files written to ${AIDER_DESK_PROJECT_MAPPINGS_DIR}/ become read-only agent
# context when "Include repository mappings" is enabled in an agent profile. Regenerate
# them from the Repository Mappings Workspace section.
#
# Prefer writing temporary files and moving them into place so readers never
# observe a partially generated mapping file.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

OUTPUT_DIR="${AIDER_DESK_PROJECT_MAPPINGS_DIR}"
mkdir -p "$OUTPUT_DIR"

# Optional: generate Aider's repository map with AiderDesk's managed Aider runtime.
# Uncomment this line to write "$OUTPUT_DIR/repo-map.txt".
# bash "${AIDER_DESK_GENERATE_REPO_MAP_SCRIPT}"

# Example: generate framework-specific mappings.
# php artisan atlas:export --type=models --format=json --output="$OUTPUT_DIR/models.json"
# npm run export:architecture > "$OUTPUT_DIR/architecture.md"
`;

export const getDefaultGenerateRepoMapScript = (): string => `#!/usr/bin/env bash
# Generate an Aider repository map for AiderDesk Agent profiles.
# This optional helper is invoked from .aider-desk/mappings.sh when its example
# command is uncommented. It imports AiderDesk's managed Aider Python library
# directly: it does not launch the Aider CLI, call an LLM provider, or create
# Aider chat history. Its only generated output is .aider-desk/mappings/repo-map.txt.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

OUTPUT_DIR="${AIDER_DESK_PROJECT_MAPPINGS_DIR}"
OUTPUT_FILE="$OUTPUT_DIR/repo-map.txt"
PYTHON_BIN="$HOME/.local/share/aider-desk-nodejs/python-venv/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
  printf 'AiderDesk-managed Python was not found at: %s\\n' "$PYTHON_BIN" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
tmp_file="$(mktemp "$OUTPUT_DIR/.repo-map.txt.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT

# Python stdout is redirected to the temporary map file; all diagnostics must use stderr.
timeout 120s "$PYTHON_BIN" - "$ROOT" > "$tmp_file" <<'PYTHON'
from pathlib import Path
import sys

from aider.models import Model
from aider.repo import GitRepo
from aider.repomap import RepoMap


# GitRepo and RepoMap need an object matching the Aider IO methods they use.
# Do not use Aider's InputOutput: it initializes interactive prompt_toolkit, whose
# warnings can be written to stdout without a TTY and corrupt repo-map.txt.
class NonInteractiveIO:
    # Encoding metadata expected by Aider internals.
    encoding = 'utf-8'

    # Aider's file-read callback. Return None for unreadable files so one file
    # cannot abort generation of the rest of the repository map.
    @staticmethod
    def read_text(filename):
        try:
            return Path(filename).read_text(encoding='utf-8', errors='replace')
        except OSError:
            return None

    # Send all Aider operational messages to stderr, reserving stdout exclusively
    # for the completed repository map consumed by the shell redirection above.
    @staticmethod
    def tool_output(*args, **kwargs):
        print(*args, file=sys.stderr, **kwargs)

    @staticmethod
    def tool_error(*args, **kwargs):
        print(*args, file=sys.stderr, **kwargs)

    @staticmethod
    def tool_warning(*args, **kwargs):
        print(*args, file=sys.stderr, **kwargs)


# The shell passes the already-resolved project root as the sole argument.
root = Path(sys.argv[1]).resolve()
# Use the non-interactive IO adapter described above.
io = NonInteractiveIO()
# This provides model/token metadata to Aider's map engine only; it makes no API request.
model = Model('gpt-4o')
# Discover Git-tracked files while respecting the project's .aiderignore when present.
repo = GitRepo(io, [], str(root), aider_ignore_file=root / '.aiderignore', models=[model])
# Generate the map from the complete tracked-file set.
files = set(repo.get_tracked_files())
# Aider's repository-map engine parses source relationships into an 8192-token map,
# using 128000-token context metadata for its sizing calculations.
repo_map = RepoMap(
    map_tokens=8192,
    root=str(root),
    main_model=model,
    io=io,
    max_context_window=128000,
    refresh='always',
)
# No chat files requests a repository-wide map; force a fresh map for every explicit Refresh.
result = repo_map.get_repo_map(set(), files, force_refresh=True)
if not result:
    raise SystemExit('Aider produced an empty repository map.')
# This is the only intended stdout payload: the shell writes it directly to repo-map.txt.
print(result)
PYTHON

mv "$tmp_file" "$OUTPUT_FILE"
trap - EXIT
`;

export const ensureRepositoryMappingsInitialized = async (baseDir: string): Promise<void> => {
  await fs.mkdir(path.join(baseDir, AIDER_DESK_PROJECT_MAPPINGS_DIR), { recursive: true });

  const ensureScript = async (scriptPath: string, contents: string): Promise<void> => {
    try {
      await fs.access(scriptPath);
    } catch {
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(scriptPath, contents, 'utf8');
    }
  };

  await ensureScript(path.join(baseDir, AIDER_DESK_MAPPINGS_SCRIPT), getDefaultMappingsScript());
  await ensureScript(path.join(baseDir, AIDER_DESK_GENERATE_REPO_MAP_SCRIPT), getDefaultGenerateRepoMapScript());
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
