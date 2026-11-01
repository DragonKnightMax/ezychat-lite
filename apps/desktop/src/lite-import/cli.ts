// Runs the server bundle's one-shot Lite commands (no electron import; the spawn is injected for tests):
//   --lite-summary <liteDir>                                   one LiteSummary JSON line, exit 0 (else 2)
//   --data <target> --import-lite <liteDir> [--import-plan f]  LiteImportProgress lines, then a final
//                                                              LiteImportOutcome; exit 0 ok, 5 refused, 1 failed
//   --data <liteDir> --restore-moved                           removes moved.json, restores wa-auth, exit 0
// Like runServerCommand: the Electron binary with ELECTRON_RUN_AS_NODE=1 (or the system node in dev).
import { spawn as nodeSpawn } from 'node:child_process';
import type { LiteImportOutcome, LiteImportProgress, LiteSummary } from '@ezychat/shared';
import {
  jsonLine,
  parseLiteImportOutcome,
  parseLiteImportProgress,
  parseLiteSummary,
} from './parse.js';

/** The subset of a ChildProcess the runner uses. */
export interface ChildLike {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean },
) => ChildLike;

export interface ServerCli {
  /** Runs the server entry with `args`; each complete stdout line goes to onLine. */
  run(args: string[], onLine?: (line: string) => void): Promise<{ code: number; lines: string[] }>;
}

export const EXIT_OK = 0;
/** The import refused before changing anything (outcome `error.code`, e.g. same_number). */
export const EXIT_REFUSED = 5;

const MAX_LINES = 2000;

export function createServerCli(o: {
  entry: string;
  runtime: 'utility' | 'node';
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  /** Kills a command that hangs (default 2 hours: a large media folder takes long to copy). */
  timeoutMs?: number;
}): ServerCli {
  const spawn = o.spawn ?? (nodeSpawn as unknown as SpawnLike);
  return {
    run(args, onLine) {
      return new Promise((resolve) => {
        const exe = o.runtime === 'node' ? 'node' : (o.execPath ?? process.execPath);
        const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env) };
        if (o.runtime === 'utility') env.ELECTRON_RUN_AS_NODE = '1';
        else delete env.ELECTRON_RUN_AS_NODE;
        const lines: string[] = [];
        let pending = '';
        let settled = false;
        const push = (line: string) => {
          if (!line.trim()) return;
          lines.push(line);
          if (lines.length > MAX_LINES) lines.shift();
          onLine?.(line);
        };
        const finish = (code: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (pending) push(pending);
          pending = '';
          resolve({ code, lines });
        };
        let child: ChildLike;
        try {
          child = spawn(exe, [o.entry, ...args], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch {
          resolve({ code: 1, lines });
          return;
        }
        // Declared after spawn: finish() only runs from the child's events, after this line.
        const timer = setTimeout(
          () => {
            child.kill();
            finish(1);
          },
          o.timeoutMs ?? 2 * 60 * 60 * 1000,
        );
        timer.unref?.();
        child.stdout?.on('data', (chunk) => {
          pending += chunk.toString();
          const parts = pending.split(/\r?\n/);
          pending = parts.pop() ?? '';
          for (const line of parts) push(line);
        });
        // stderr carries pino logs (step/counts only); it is not parsed.
        child.stderr?.on('data', () => undefined);
        child.on('error', () => finish(1));
        child.on('exit', (code) => finish(code ?? 1));
      });
    },
  };
}

export class LiteCliError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
  ) {
    super(`Lite command failed: ${code} (exit ${exitCode})`);
  }
}

/** `--lite-summary`: the read-only summary of a Lite data folder. Throws LiteCliError('summary_failed'). */
export async function readLiteSummary(cli: ServerCli, liteDir: string): Promise<LiteSummary> {
  const { code, lines } = await cli.run(['--lite-summary', liteDir]);
  if (code === EXIT_OK) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const summary = parseLiteSummary(jsonLine(lines[i]!));
      if (summary) return summary;
    }
  }
  throw new LiteCliError('summary_failed', code);
}

export interface LiteImportRun {
  code: number;
  outcome: LiteImportOutcome | null;
}

/** `--import-lite`: streams progress lines and returns the exit code with the final outcome. */
export async function runLiteImport(
  cli: ServerCli,
  o: { target: string; liteDir: string; planFile?: string | null },
  onProgress: (progress: LiteImportProgress) => void,
): Promise<LiteImportRun> {
  let outcome: LiteImportOutcome | null = null;
  const args = ['--data', o.target, '--import-lite', o.liteDir];
  if (o.planFile) args.push('--import-plan', o.planFile);
  const { code } = await cli.run(args, (line) => {
    const value = jsonLine(line);
    const progress = parseLiteImportProgress(value);
    if (progress) {
      onProgress(progress);
      return;
    }
    const parsed = parseLiteImportOutcome(value);
    if (parsed) outcome = parsed;
  });
  return { code, outcome };
}

/** `--restore-moved`: lets Lite use its data folder again. True when the server says it is done. */
export async function restoreMoved(cli: ServerCli, liteDir: string): Promise<boolean> {
  const { code } = await cli.run(['--data', liteDir, '--restore-moved']);
  return code === EXIT_OK;
}
