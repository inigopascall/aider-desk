import { createHash } from 'crypto';

export interface OutlineDirectory {
  /** Project-relative, forward slashes, no trailing slash; '' for the project root. */
  dir: string;
  /** File names (not paths), sorted, or subtree-relative paths for rule-collapsed entries. */
  files: string[];
  collapsed?: boolean;
  folderCount?: number;
  fileCount?: number;
}

const excludedDirectories = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '__tests__',
  '__mocks__',
  '__snapshots__',
  'test',
  'tests',
  'spec',
  'specs',
  'e2e',
  'fixtures',
  'locales',
  'locale',
  'lang',
  'i18n',
]);
const excludedExtensions = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'bmp',
  'tiff',
  'psd',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'webm',
  'mov',
  'avi',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'tar',
  'rar',
  '7z',
  'jar',
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'dat',
  'db',
  'sqlite',
  'sqlite3',
  'pyc',
  'class',
]);
const lockFiles = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);

export const isOutlinePath = (relativePath: string): boolean => {
  if (!relativePath) {
    return false;
  }
  const parts = relativePath.split('/');
  const file = parts[parts.length - 1];
  const directories = parts.slice(0, -1);
  if (directories.some((directory) => directory.startsWith('.') || excludedDirectories.has(directory))) {
    return false;
  }
  if (['storage/', 'bootstrap/cache/', 'public/build/', 'public/vendor/'].some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }
  if (/\.test\.|\.spec\.|\.snap$|\.map$|\.min\.(js|css)$/.test(file)) {
    return false;
  }
  if (file.endsWith('.lock') || lockFiles.has(file)) {
    return false;
  }
  const extension = file.includes('.') ? (file.split('.').pop()?.toLowerCase() ?? '') : '';
  return !excludedExtensions.has(extension);
};

const compareOutlinePaths = (a: string, b: string): number => {
  if (a === '' || b === '') {
    return a.length - b.length;
  }
  const aParts = a.split('/');
  const bParts = b.split('/');
  for (let index = 0; index < Math.min(aParts.length, bParts.length); index += 1) {
    const comparison = aParts[index].localeCompare(bParts[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return aParts.length - bParts.length;
};

export const groupOutlineDirectories = (relativePaths: string[]): OutlineDirectory[] => {
  const grouped = new Map<string, Set<string>>();
  for (const relativePath of relativePaths) {
    if (!isOutlinePath(relativePath)) {
      continue;
    }
    const parts = relativePath.split('/');
    const dir = parts.slice(0, -1).join('/');
    if (!grouped.has(dir)) {
      grouped.set(dir, new Set<string>());
    }
    grouped.get(dir)?.add(parts[parts.length - 1]);
  }
  return [...grouped.entries()].sort(([a], [b]) => compareOutlinePaths(a, b)).map(([dir, files]) => ({ dir, files: [...files].sort() }));
};

const compileOutlineRule = (rule: string): { exclude: boolean; directoriesOnly: boolean; matcher: RegExp } | undefined => {
  let value = rule.trim();
  if (!value || value.startsWith('#')) {
    return undefined;
  }
  const exclude = value.startsWith('!');
  if (exclude) {
    value = value.slice(1).trim();
  }
  const directoriesOnly = value.endsWith('/');
  value = value.replace(/\/$/, '');
  const anchored = value.startsWith('/') || value.includes('/');
  if (value.startsWith('/')) {
    value = value.slice(1);
  }
  if (!value) {
    return undefined;
  }
  const escape = (character: string): string => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) {
      pattern += escape(value[++index]);
    } else if (character === '*') {
      let end = index;
      while (value[end + 1] === '*') {
        end += 1;
      }
      const globstar = end > index && (index === 0 || value[index - 1] === '/') && (end === value.length - 1 || value[end + 1] === '/');
      if (globstar && value[end + 1] === '/') {
        pattern += '(?:[^/]+/)*';
        end += 1;
      } else {
        pattern += globstar ? '.*' : '[^/]*';
      }
      index = end;
    } else if (character === '?') {
      pattern += '[^/]';
    } else {
      pattern += escape(character);
    }
  }
  return { exclude, directoriesOnly, matcher: new RegExp(anchored ? `^${pattern}$` : `(?:^|/)${pattern}$`) };
};

export const applyOutlineRules = (directories: OutlineDirectory[], rules: string[]): { directories: OutlineDirectory[]; rulesApplied: boolean } => {
  const compiled = rules.map(compileOutlineRule).filter((rule): rule is { exclude: boolean; directoriesOnly: boolean; matcher: RegExp } => !!rule);
  const copied = directories.map((directory) => ({ ...directory, files: [...directory.files] }));
  if (!compiled.length) {
    copied.sort((a, b) => compareOutlinePaths(a.dir, b.dir));
    return { directories: copied, rulesApplied: false };
  }
  const retained: OutlineDirectory[] = [];
  let changed = false;
  for (const input of copied) {
    const ancestors = input.dir ? input.dir.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')) : [];
    if (compiled.some(({ exclude: isExclude, matcher }) => isExclude && ancestors.some((ancestor) => matcher.test(ancestor)))) {
      changed = true;
      continue;
    }
    const files = input.files.filter((file) => {
      const path = input.dir ? `${input.dir}/${file}` : file;
      const excluded = compiled.some(({ exclude: isExclude, directoriesOnly, matcher }) => isExclude && !directoriesOnly && matcher.test(path));
      if (excluded) {
        changed = true;
      }
      return !excluded;
    });
    retained.push({ ...input, files });
  }
  const nonempty = retained.filter((directory, index, all) => {
    if (directory.files.length) {
      return true;
    }
    const prefix = directory.dir ? `${directory.dir}/` : '';
    return all.some((other, otherIndex) => otherIndex !== index && other.files.length > 0 && other.dir.startsWith(prefix));
  });
  const collapsed = new Map<string, OutlineDirectory>();
  const output: OutlineDirectory[] = [];
  for (const input of nonempty) {
    const ancestors = input.dir ? input.dir.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')) : [];
    const collapseAt = ancestors.find((ancestor) => compiled.some(({ exclude: isExclude, matcher }) => !isExclude && matcher.test(ancestor)));
    if (!collapseAt) {
      output.push(input);
      continue;
    }
    changed = true;
    const prefix = input.dir === collapseAt ? '' : `${input.dir.slice(collapseAt.length + 1)}/`;
    const files = input.files.map((file) => `${prefix}${file}`);
    const entry = collapsed.get(collapseAt) ?? { dir: collapseAt, files: [], collapsed: true, folderCount: 0, fileCount: 0 };
    entry.files.push(...files);
    entry.fileCount = (entry.fileCount ?? 0) + input.files.length;
    if (input.files.length) {
      entry.folderCount = (entry.folderCount ?? 0) + 1;
    }
    collapsed.set(collapseAt, entry);
  }
  const result = [...output, ...collapsed.values()].map((directory) => ({ ...directory, files: [...directory.files].sort() }));
  result.sort((a, b) => compareOutlinePaths(a.dir, b.dir));
  return { directories: result, rulesApplied: changed };
};

const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');

export const directoryFingerprint = (directory: OutlineDirectory): string =>
  sha1(directory.collapsed ? `collapsed:${[...directory.files].sort().join('\n')}` : directory.files.join('\n'));

export const outlineFingerprint = (directories: OutlineDirectory[], extra: string): string =>
  sha1(`${directories.map((directory) => `${directory.dir}\n${directory.files.join('\n')}`).join('\n')}\n${extra}`);

export interface RenderOutlineOptions {
  header: string;
  directories: OutlineDirectory[];
  descriptions: Record<string, string>;
  maxTokens: number;
  countTokens: (text: string) => number;
  rulesApplied?: boolean;
}

export const renderOutline = (options: RenderOutlineOptions): { text: string; collapsed: string[] } => {
  let preamble = `# Codebase outline\n${options.header}\nEvery source directory is listed with its files. Tests, locales, generated files and assets are left out; search the code for anything more.${options.rulesApplied ? '\nSome folders are summarised or left out by outline rules; search the code for their contents.' : ''}`;
  const budgetNote = 'Some large folders show only a file count to fit the size limit; search the code for their files.';
  const collapsed = new Set<number>();
  const collapsedDirectories: string[] = [];
  const fileLineTokens = options.directories.map((directory) => (directory.collapsed ? 0 : options.countTokens(`  ${directory.files.join(', ')}`)));
  const collapsedLineTokens = options.directories.map((directory) => options.countTokens(directory.collapsed ? '' : `  (${directory.files.length} files)`));
  const directoryLineTokens = options.directories.map((directory) =>
    options.countTokens(
      `${directory.dir || '.'}/${options.descriptions[directory.dir] ? ` — ${options.descriptions[directory.dir]}` : ''}${directory.collapsed ? ` (${directory.folderCount} folders, ${directory.fileCount} files)` : ''}`,
    ),
  );
  let total =
    options.countTokens(preamble) + directoryLineTokens.reduce((sum, value) => sum + value, 0) + fileLineTokens.reduce((sum, value) => sum + value, 0);
  while (total > options.maxTokens) {
    const candidates = options.directories
      .map((directory, index) => ({ directory, index }))
      .filter(({ directory, index }) => directory.files.length > 1 && !directory.collapsed && !collapsed.has(index));
    if (!candidates.length) {
      break;
    }
    candidates.sort((a, b) => fileLineTokens[b.index] - fileLineTokens[a.index]);
    const chosen = candidates[0];
    collapsed.add(chosen.index);
    collapsedDirectories.push(chosen.directory.dir);
    total += collapsedLineTokens[chosen.index] - fileLineTokens[chosen.index];
    if (collapsed.size === 1) {
      total += options.countTokens(preamble + '\n' + budgetNote) - options.countTokens(preamble);
      preamble += `\n${budgetNote}`;
    }
  }
  const blocks = options.directories.map((directory, index) => {
    const label = `${directory.dir || '.'}/${options.descriptions[directory.dir] ? ` — ${options.descriptions[directory.dir]}` : ''}${directory.collapsed ? ` (${directory.folderCount} folders, ${directory.fileCount} files)` : ''}`;
    const files = directory.collapsed ? '' : collapsed.has(index) ? `  (${directory.files.length} files)` : `  ${directory.files.join(', ')}`;
    return files ? `${label}\n${files}` : label;
  });
  return { text: `${preamble}\n\n${blocks.join('\n')}\n`, collapsed: collapsedDirectories };
};

const BADGE_LINE = /^(?:\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)|!?\[[^\]]*\]\([^)]*\)|\s)+$/;
const MARKDOWN_LINK = /!?\[([^\]]*)\]\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;

/** Drops a YAML front matter block at the very start of a Markdown file. */
const stripFrontMatter = (markdown: string): string => {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? markdown.slice(match[0].length) : markdown;
};

const isSkippableReadmeLine = (line: string): boolean =>
  !line || /^#{1,6}\s/.test(line) || /^!\[/.test(line) || /^</.test(line) || /^>/.test(line) || BADGE_LINE.test(line) || /^(?:={3,}|-{3,})$/.test(line);

export const readmeDescription = (markdown: string): string | undefined => {
  let inFence = false;
  const paragraph: string[] = [];
  for (const rawLine of stripFrontMatter(markdown).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) {
      if (paragraph.length) {
        break;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (isSkippableReadmeLine(line)) {
      if (paragraph.length) {
        break;
      }
      continue;
    }
    paragraph.push(line);
  }
  if (!paragraph.length) {
    return undefined;
  }
  const text = paragraph
    .join(' ')
    .replace(MARKDOWN_LINK, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return undefined;
  }
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0];
  if (!sentence || /^(This|It) /.test(sentence) || sentence.split(/\s+/).length > 20) {
    return undefined;
  }
  return sentence;
};

export interface DescriptionRequest {
  dir: string;
  files: string[];
  excerpts: { file: string; text: string }[];
}

export const buildDescriptionPrompt = (requests: DescriptionRequest[]): { systemPrompt: string; prompt: string } => ({
  systemPrompt:
    'You write one-line descriptions of source code directories for a codebase outline read by AI coding agents. For each directory, say what it is for in at most 15 words: its responsibility, not a list of its files. Do not start with "This directory" or "Contains". Reply with only a JSON object mapping each directory path exactly as given to its description.',
  prompt: requests
    .map((request) =>
      [
        `## ${request.dir || '.'}`,
        `Files: ${request.files.slice(0, 60).join(', ')}${request.files.length > 60 ? ', …' : ''}`,
        ...request.excerpts.map((excerpt) => `--- ${excerpt.file}\n${excerpt.text}`),
      ].join('\n'),
    )
    .join('\n\n'),
});

export const parseDescriptionResponse = (text: string, dirs: string[]): Record<string, string> => {
  const candidates = [text.trim(), ...(text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.slice(1) ?? [])];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue;
      }
      const result: Record<string, string> = {};
      for (const [key, rawValue] of Object.entries(value)) {
        const dir = key === '.' ? '' : key;
        const description = typeof rawValue === 'string' ? rawValue.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
        if (dirs.includes(dir) && description) {
          result[dir] = description;
        }
      }
      return result;
    } catch {
      continue;
    }
  }
  return {};
};
