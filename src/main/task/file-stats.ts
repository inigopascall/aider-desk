import fs from 'fs/promises';

// @ts-expect-error istextorbinary is not typed properly
import { isBinary } from 'istextorbinary';
import { encode } from 'gpt-tokenizer/model/gpt-4o';

export interface TextFileStats {
  lines: number;
  tokens: number;
}

interface CacheEntry extends TextFileStats {
  mtimeMs: number;
  size: number;
}

const MAX_CACHE_ENTRIES = 500;
const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const LARGE_TEXT_BYTES = 2 * 1024 * 1024;
const cache = new Map<string, CacheEntry>();

/** Line and token counts of a text file, cached by path, mtime and size. null when missing, a directory, binary, or unreadable. */
export const getTextFileStats = async (absolutePath: string): Promise<TextFileStats | null> => {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return null;
    }
    const cached = cache.get(absolutePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { lines: cached.lines, tokens: cached.tokens };
    }

    let result: TextFileStats;
    if (stat.size > LARGE_FILE_BYTES) {
      result = { lines: Math.ceil(stat.size / 40), tokens: Math.ceil(stat.size / 4) };
    } else {
      const buffer = await fs.readFile(absolutePath);
      if (isBinary(absolutePath, buffer)) {
        return null;
      }
      const text = buffer.toString('utf8');
      let tokens: number;
      if (text.length > LARGE_TEXT_BYTES) {
        tokens = Math.ceil(text.length / 4);
      } else {
        try {
          tokens = encode(text, { disallowedSpecial: new Set() }).length;
        } catch {
          tokens = Math.ceil(text.length / 3);
        }
      }
      result = { lines: text.split('\n').length, tokens };
    }
    cache.set(absolutePath, { ...result, mtimeMs: stat.mtimeMs, size: stat.size });
    if (cache.size > MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value!);
    }
    return result;
  } catch {
    return null;
  }
};
