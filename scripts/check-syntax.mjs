#!/usr/bin/env node
/**
 * Parser-only syntax validation for the AiderDesk source tree.
 *
 * Runs every source file through Prettier's parser without writing or
 * reformatting anything, so malformed JSX/TypeScript/JavaScript/JSON is caught
 * early — before any build or deployment step. Files listed in `.prettierignore`
 * (such as the deliberately invalid extension fixture) are skipped.
 *
 * Prints nothing on success and exits 0. On failure, prints a concise error
 * (with file, line/column and a small code frame) for each offending file and
 * exits 1.
 */
import { globSync } from 'glob';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import prettier from 'prettier';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'src');

// File extensions that Prettier can parse for syntax validation.
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.cjs'];

// Collect every source file under src/ that matches a parseable extension.
const files = globSync('**/*', { cwd: SRC, nodir: true, absolute: true }).filter((file) =>
  EXTENSIONS.some((ext) => file.endsWith(ext)),
);

const failures = [];

for (const file of files) {
  // Skip files ignored via .prettierignore (e.g. the invalid extension fixture).
  const info = prettier.getFileInfo.sync(file, { ignorePath: resolve(ROOT, '.prettierignore') });
  if (info.ignored) {
    continue;
  }

  const source = readFileSync(file, 'utf8');
  try {
    // Parse-only: format() throws on syntax errors but never rewrites the file.
    await prettier.format(source, { filepath: file });
  } catch (error) {
    failures.push({ file, source, error });
  }
}

if (failures.length > 0) {
  console.error('❌ Syntax check failed\n');
  for (const { file, source, error } of failures) {
    const rel = relative(ROOT, file);
    console.error(rel);

    const loc = error.loc?.start;
    if (loc) {
      console.error(`  ${error.message} (${loc.line}:${loc.column + 1})`);
      // Print a small code frame around the offending line.
      const lines = source.split('\n');
      const start = Math.max(0, loc.line - 2);
      const end = Math.min(lines.length, loc.line + 1);
      for (let i = start; i < end; i++) {
        const marker = i === loc.line - 1 ? '>' : ' ';
        console.error(`  ${marker} ${String(i + 1).padStart(4)} | ${lines[i]}`);
      }
      console.error(`       | ${' '.repeat(loc.column)}^`);
    } else {
      console.error(`  ${error.message}`);
    }
    console.error('');
  }
  console.error(`${failures.length} syntax error${failures.length === 1 ? '' : 's'} found.`);
  process.exit(1);
}

process.exit(0);
