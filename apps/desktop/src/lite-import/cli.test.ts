import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createServerCli,
  LiteCliError,
  readLiteSummary,
  restoreMoved,
  runLiteImport,
  type SpawnLike,
} from './cli.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

/** A spawn that writes `chunks` to stdout and exits with `code`. */
function fakeSpawn(chunks: string[], code: number | null = 0) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child = new FakeChild();
    setImmediate(() => {
      for (const c of chunks) child.stdout.emit('data', Buffer.from(c));
      child.stderr.emit('data', Buffer.from('{"level":30,"mod":"lite-import"}\n'));
      child.emit('exit', code);
    });
    return child;
  };
  return { spawn, calls };
}

const summary = {
  dataDir: '/lite',
  schemaVersion: 28,
  number: null,
  ownJid: null,
  chats: 1,
  customers: 1,
  messages: 2,
  mediaBytes: 0,
  totalBytes: 10,
  users: [],
  aiAgents: [],
  quickReplyShortcuts: [],
  tokens: [],
  remote: 'lan',
  address: null,
  port: null,
};

describe('server CLI runner', () => {
  it('runs the bundle under Electron as Node and splits stdout into lines across chunks', async () => {
    const { spawn, calls } = fakeSpawn(['first li', 'ne\r\nsecond\n\nthird']);
    const cli = createServerCli({
      entry: '/app/server.cjs',
      runtime: 'utility',
      execPath: '/e',
      spawn,
      env: {},
    });
    const seen: string[] = [];
    const r = await cli.run(['--x'], (l) => seen.push(l));
    expect(r).toEqual({ code: 0, lines: ['first line', 'second', 'third'] });
    expect(seen).toEqual(r.lines);
    expect(calls[0]).toMatchObject({ command: '/e', args: ['/app/server.cjs', '--x'] });
    expect(calls[0]!.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('uses the system node in dev without ELECTRON_RUN_AS_NODE, and maps a null exit to 1', async () => {
    const { spawn, calls } = fakeSpawn([], null);
    const cli = createServerCli({
      entry: '/s.cjs',
      runtime: 'node',
      spawn,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect((await cli.run([])).code).toBe(1);
    expect(calls[0]!.command).toBe('node');
    expect(calls[0]!.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('reports a spawn that throws or errors as exit 1', async () => {
    const throwing = createServerCli({
      entry: '/s.cjs',
      runtime: 'node',
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    expect(await throwing.run([])).toEqual({ code: 1, lines: [] });
    const erroring = createServerCli({
      entry: '/s.cjs',
      runtime: 'node',
      spawn: () => {
        const child = new FakeChild();
        setImmediate(() => {
          child.emit('error', new Error('boom'));
          child.emit('exit', 0); // ignored: already settled
        });
        return child;
      },
    });
    expect((await erroring.run([])).code).toBe(1);
  });

  it('kills a command that hangs', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const cli = createServerCli({
        entry: '/s.cjs',
        runtime: 'node',
        spawn: () => child,
        timeoutMs: 1000,
      });
      const run = cli.run([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await run).toEqual({ code: 1, lines: [] });
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Lite commands', () => {
  it('reads the summary from the last valid JSON line', async () => {
    const { spawn, calls } = fakeSpawn([`log line\n${JSON.stringify(summary)}\n`]);
    const cli = createServerCli({ entry: '/s.cjs', runtime: 'node', spawn });
    expect(await readLiteSummary(cli, '/lite')).toEqual(summary);
    expect(calls[0]!.args).toEqual(['/s.cjs', '--lite-summary', '/lite']);
  });

  it('throws summary_failed on exit 2 or without a summary line', async () => {
    for (const [chunks, code] of [
      [[JSON.stringify(summary)], 2],
      [['nothing\n'], 0],
    ] as const) {
      const cli = createServerCli({
        entry: '/s.cjs',
        runtime: 'node',
        spawn: fakeSpawn([...chunks], code).spawn,
      });
      await expect(readLiteSummary(cli, '/lite')).rejects.toMatchObject({
        code: 'summary_failed',
        exitCode: code,
      });
    }
    expect(new LiteCliError('x', 5).message).toContain('exit 5');
  });

  it('streams import progress and returns the final outcome', async () => {
    const lines = [
      { step: 'copy', state: 'running', done: 1, total: 4 },
      { step: 'copy', state: 'done' },
      { error: { code: 'same_number' } },
    ].map((l) => JSON.stringify(l));
    const { spawn, calls } = fakeSpawn([lines.join('\n') + '\nnot json\n'], 5);
    const cli = createServerCli({ entry: '/s.cjs', runtime: 'node', spawn });
    const progress = vi.fn();
    const run = await runLiteImport(
      cli,
      { target: '/ent', liteDir: '/lite', planFile: '/p.json' },
      progress,
    );
    expect(run).toEqual({ code: 5, outcome: { error: { code: 'same_number' } } });
    expect(progress.mock.calls.map((c) => c[0])).toEqual([
      { step: 'copy', state: 'running', done: 1, total: 4 },
      { step: 'copy', state: 'done' },
    ]);
    expect(calls[0]!.args).toEqual([
      '/s.cjs',
      '--data',
      '/ent',
      '--import-lite',
      '/lite',
      '--import-plan',
      '/p.json',
    ]);
  });

  it('runs the import without a plan file and restores a moved folder', async () => {
    const a = fakeSpawn([]);
    await runLiteImport(
      createServerCli({ entry: '/s.cjs', runtime: 'node', spawn: a.spawn }),
      { target: '/e', liteDir: '/l' },
      () => {},
    );
    expect(a.calls[0]!.args).toEqual(['/s.cjs', '--data', '/e', '--import-lite', '/l']);
    const ok = fakeSpawn([], 0);
    expect(
      await restoreMoved(
        createServerCli({ entry: '/s.cjs', runtime: 'node', spawn: ok.spawn }),
        '/l',
      ),
    ).toBe(true);
    expect(ok.calls[0]!.args).toEqual(['/s.cjs', '--data', '/l', '--restore-moved']);
    const bad = fakeSpawn([], 1);
    expect(
      await restoreMoved(
        createServerCli({ entry: '/s.cjs', runtime: 'node', spawn: bad.spawn }),
        '/l',
      ),
    ).toBe(false);
  });
});
