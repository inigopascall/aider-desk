import { spawn } from 'child_process';

import { getShellPath } from '@/utils';

const MAX_STDOUT_BYTES = 50 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;

export interface ShellResult {
  /** Exit code; null when the process was killed or could not start. */
  code: number | null;
  stdout: string;
  /** The last characters of stderr, plus the start error when the process could not start. */
  stderrTail: string;
  timedOut: boolean;
  /** stdout passed the size limit and the process was killed. */
  overflow: boolean;
}

/**
 * Runs `sh -c command` in cwd with the user's shell PATH, writing stdin when given. Never rejects.
 * The command runs in its own process group so that a timeout kills everything it started (php, ssh).
 */
export const runShell = (command: string, cwd: string, stdin: string | null, timeoutMs: number): Promise<ShellResult> =>
  new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = '';
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const settle = (code: number | null, startError?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const tail = startError ? `${stderrTail}${startError}` : stderrTail;
      resolve({ code, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderrTail: tail.slice(-STDERR_TAIL_CHARS), timedOut, overflow });
    };

    const child = spawn('sh', ['-c', command], { cwd, detached: true, env: { ...process.env, PATH: getShellPath() } });

    const killAll = (): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
          return;
        }
      } catch {
        // The group is already gone; fall back to the direct child.
      }
      child.kill('SIGKILL');
    };

    const timer = setTimeout(
      () => {
        timedOut = true;
        killAll();
        settle(null);
      },
      Math.max(1, timeoutMs),
    );

    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) {
        return;
      }
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        overflow = true;
        killAll();
        settle(null);
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (error: Error) => settle(null, error.message));
    child.on('close', (code: number | null) => settle(code));

    // The command may exit without reading its input; a broken pipe is not an error here.
    child.stdin.on('error', () => undefined);
    if (stdin === null) {
      child.stdin.end();
    } else {
      child.stdin.end(stdin);
    }
  });
