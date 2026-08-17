/**
 * Walks a unified git diff and collects the added lines per file path.
 * A `diff --git a/... b/<path>` header sets the current file; a `+++ /dev/null`
 * header clears it (deleted file); while a file is current, lines starting
 * with `+` (after the `+++ ` header check) are collected with the leading
 * `+` stripped.
 */
export function extractAddedLinesByFile(diffText: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let currentFile: string | null = null;

  for (const line of diffText.split('\n')) {
    const headerMatch = line.match(/^diff --git a\/.* b\/(.*)$/);
    if (headerMatch) {
      currentFile = headerMatch[1];
      result.set(currentFile, []);
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      currentFile = null;
      continue;
    }
    if (currentFile && line.startsWith('+') && !line.startsWith('+++')) {
      result.get(currentFile)!.push(line.slice(1));
    }
  }

  return result;
}

export function isTransientGitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /index\.lock|\.lock': File exists|Unable to create|could not lock|cannot lock ref|Another git process/i.test(message);
}

export const GIT_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

export async function withGitRetry<T>(
  operation: () => Promise<T>,
  options: { name: string; onRetry?: (attempt: number, message: string) => void },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= GIT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientGitError(error) || attempt === GIT_RETRY_DELAYS_MS.length) throw error;
      const message = error instanceof Error ? error.message : String(error);
      options.onRetry?.(attempt + 1, message);
      await new Promise((resolve) => setTimeout(resolve, GIT_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}
