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
