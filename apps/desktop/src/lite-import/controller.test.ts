import { describe, expect, it, vi } from 'vitest';
import type { LiteImportState } from '@ezychat/shared';
import type { ServiceState } from '../service/windows.js';
import type { ServerCli } from './cli.js';
import { LiteImportController, type LiteImportDeps } from './controller.js';

const summary = {
  dataDir: '/lite',
  schemaVersion: 28,
  number: '+60123456789',
  ownJid: '60123456789@s.whatsapp.net',
  chats: 12,
  customers: 10,
  messages: 400,
  mediaBytes: 1000,
  totalBytes: 1000,
  users: [{ id: 1, username: 'owner', displayName: 'Owner Name', role: 'admin' }],
  aiAgents: [],
  quickReplyShortcuts: [],
  tokens: [],
  remote: 'lan',
  address: null,
  port: 7420,
};
const result = {
  mode: 'copy',
  inboxId: 1,
  inboxName: 'Lite – +60123456789',
  chats: 12,
  usersAdded: 0,
  usersMatched: 0,
  agentImported: true,
  agentOff: false,
  renamedShortcuts: [],
};

type Script = Record<string, { code: number; lines: unknown[] }>;

function fakeCli(script: Script) {
  const calls: string[][] = [];
  const cli: ServerCli = {
    run: vi.fn(async (args: string[], onLine?: (line: string) => void) => {
      calls.push(args);
      const key = args.includes('--lite-summary') ? 'summary' : 'import';
      const step = script[key] ?? { code: 1, lines: [] };
      const lines = step.lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
      for (const l of lines) onLine?.(l);
      return { code: step.code, lines };
    }),
  };
  return { cli, calls };
}

function setup(
  over: Partial<LiteImportDeps> & {
    script?: Script;
    service?: ServiceState;
    answers?: number[];
  } = {},
) {
  const { cli, calls } = fakeCli(
    over.script ?? {
      summary: { code: 0, lines: [summary] },
      import: {
        code: 0,
        lines: [
          { step: 'copy', state: 'running', done: 1, total: 4 },
          { step: 'copy', state: 'done' },
          { step: 'verify', state: 'done' },
          { result },
        ],
      },
    },
  );
  const changes: LiteImportState[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: LiteImportDeps = {
    enabled: true,
    ownDataDir: '/ent',
    findLite: async () => ({ dataDir: '/lite', kind: 'user', profile: '/profile', readable: true }),
    litePorts: () => [7431, 7420],
    liteServiceState: async () => over.service ?? 'not-installed',
    unlockLite: vi.fn(async () => 'done' as const),
    liteAnswers: async (port) => (over.answers ?? []).includes(port),
    ownHasData: async () => false,
    freeBytes: async () => 10_000,
    cli,
    writePlan: vi.fn(async () => ({ file: '/work/plan.json', dispose: vi.fn(async () => {}) })),
    stopOwnServer: vi.fn(async () => {}),
    startOwnServer: vi.fn(async () => true),
    takeOverPort: vi.fn(),
    onChanged: (s) => changes.push(s),
    log: (f) => logs.push(f),
    now: () => 1000,
    ...over,
  };
  return { controller: new LiteImportController(deps), deps, calls, changes, logs };
}

describe('scan', () => {
  it('answers none when the product adopts nothing or no Lite data is found', async () => {
    expect((await setup({ enabled: false }).controller.scan()).phase).toBe('none');
    const { controller, calls } = setup({ findLite: async () => null });
    expect((await controller.scan()).phase).toBe('none');
    expect(calls).toEqual([]);
  });

  it('answers protected for a locked service folder: no summary read, no start possible', async () => {
    const { controller, calls, logs } = setup({
      service: 'running',
      findLite: async () => ({
        dataDir: 'C:\\ProgramData\\wa-team-inbox',
        kind: 'machine',
        profile: '/profile',
        readable: false,
      }),
    });
    expect(await controller.scan()).toMatchObject({
      phase: 'protected',
      lite: null,
      liteService: true,
      issues: [],
    });
    expect(calls).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ step: 'scan', readable: false }));
    await expect(controller.start({ team: [] })).rejects.toThrow('scan first');
  });

  it('reads the summary and passes the checks: found, copy mode on an empty install', async () => {
    const { controller, calls, logs } = setup();
    expect(controller.getState().phase).toBe('idle');
    const state = await controller.scan();
    expect(state).toMatchObject({
      phase: 'found',
      mode: 'copy',
      lite: summary,
      liteService: false,
      enterprise: { hasData: false, inboxes: 0, maxInboxes: 0, freeBytes: 10_000 },
      issues: [],
    });
    expect(calls[0]).toEqual(['--lite-summary', '/lite']);
    // Logs carry counts only: never the number or names.
    expect(JSON.stringify(logs)).not.toContain('60123456789');
    expect(JSON.stringify(logs)).not.toContain('Owner Name');
    expect(logs[0]).toMatchObject({ mod: 'lite-import', step: 'scan', chats: 12, users: 1 });
  });

  it('shows merge mode when this install already has data', async () => {
    const { controller } = setup({ ownHasData: async () => true });
    expect((await controller.scan()).mode).toBe('merge');
  });

  it('blocks while Lite runs, while its service runs, or without disk space', async () => {
    expect((await setup({ answers: [7420] }).controller.scan()).issues).toEqual(['lite_running']);
    const service = await setup({ service: 'running', answers: [7420] }).controller.scan();
    expect(service).toMatchObject({
      phase: 'blocked',
      issues: ['lite_service'],
      liteService: true,
    });
    const stopped = await setup({ service: 'stopped' }).controller.scan();
    expect(stopped).toMatchObject({ phase: 'found', liteService: true });
    const disk = await setup({ freeBytes: async () => 1050 }).controller.scan();
    expect(disk).toMatchObject({ phase: 'blocked', issues: ['disk'] });
    // 1000 bytes × 1.1 fit exactly; unknown free space never blocks.
    expect((await setup({ freeBytes: async () => 1100 }).controller.scan()).phase).toBe('found');
    expect((await setup({ freeBytes: async () => null }).controller.scan()).phase).toBe('found');
    const broken = await setup({
      liteServiceState: async () => {
        throw new Error('sc failed');
      },
    }).controller.scan();
    expect(broken.phase).toBe('found');
  });

  it('fails with summary_failed when the CLI cannot read Lite’s folder', async () => {
    const { controller } = setup({ script: { summary: { code: 2, lines: [] } } });
    expect(await controller.scan()).toMatchObject({ phase: 'failed', failure: 'summary_failed' });
  });
});

describe('unlock', () => {
  /** Lite's service folder stays locked until `free()` (what Lite's "Remove service" does). */
  function locked(over: Parameters<typeof setup>[0] = {}) {
    let isLocked = true;
    const free = () => {
      isLocked = false;
    };
    const ctx = setup({
      // "Remove service" also removes the service itself.
      liteServiceState: async () => (isLocked ? 'running' : 'not-installed'),
      findLite: async () =>
        isLocked
          ? {
              dataDir: 'C:\\ProgramData\\wa-team-inbox',
              kind: 'machine',
              profile: '/profile',
              readable: false,
            }
          : { dataDir: '/lite', kind: 'user', profile: '/profile', readable: true },
      ...over,
    });
    return { ...ctx, free };
  }

  it('asks once, then scans the freed folder: Found with the summary', async () => {
    const ctx = locked();
    ctx.deps.unlockLite = vi.fn(async () => {
      ctx.free();
      return 'done' as const;
    });
    await ctx.controller.scan();
    const state = await ctx.controller.unlock();
    expect(state).toMatchObject({ phase: 'found', unlock: 'idle', lite: summary });
    expect(ctx.deps.unlockLite).toHaveBeenCalledTimes(1);
    // The page saw "waiting" while the prompt was open.
    expect(ctx.changes.map((s) => s.unlock)).toContain('waiting');
    expect(ctx.logs).toContainEqual({ mod: 'lite-import', step: 'unlock', outcome: 'done', ms: 0 });
  });

  it('a refused prompt is declined and stays protected; nothing else runs', async () => {
    const ctx = locked();
    ctx.deps.unlockLite = vi.fn(async () => 'cancelled' as const);
    await ctx.controller.scan();
    expect(await ctx.controller.unlock()).toMatchObject({
      phase: 'protected',
      unlock: 'declined',
      lite: null,
    });
    expect(ctx.calls).toEqual([]);
  });

  it('a failed step, a user folder that already has data, or a folder still locked: failed', async () => {
    for (const run of [
      async () => {
        throw new Error('Move-Item failed in C:\\Users\\someone');
      },
      async () => 'target_has_data' as const,
      async () => 'done' as const, // reported done, but the folder is still locked
    ]) {
      const ctx = locked();
      ctx.deps.unlockLite = vi.fn(run);
      await ctx.controller.scan();
      expect(await ctx.controller.unlock()).toMatchObject({ phase: 'protected', unlock: 'failed' });
      // The log never carries the error text (it can hold a user name).
      expect(JSON.stringify(ctx.logs)).not.toContain('someone');
    }
  });

  it('freed by hand meanwhile: scans without asking Windows', async () => {
    const ctx = locked();
    await ctx.controller.scan();
    ctx.free();
    expect((await ctx.controller.unlock()).phase).toBe('found');
    expect(ctx.deps.unlockLite).not.toHaveBeenCalled();
  });

  it('without Lite’s service there is nothing to remove: failed, no prompt', async () => {
    const ctx = locked({ liteServiceState: async () => 'not-installed' });
    await ctx.controller.scan();
    expect(await ctx.controller.unlock()).toMatchObject({ phase: 'protected', unlock: 'failed' });
    expect(ctx.deps.unlockLite).not.toHaveBeenCalled();
  });

  it('does nothing outside phase protected, and a new scan clears the last answer', async () => {
    const plain = setup();
    await plain.controller.scan();
    expect((await plain.controller.unlock()).phase).toBe('found');
    expect(plain.deps.unlockLite).not.toHaveBeenCalled();

    const ctx = locked();
    ctx.deps.unlockLite = vi.fn(async () => 'cancelled' as const);
    await ctx.controller.scan();
    await ctx.controller.unlock();
    expect((await ctx.controller.scan()).unlock).toBe('idle');
  });
});

describe('start', () => {
  it('refuses without a successful scan', async () => {
    await expect(setup().controller.start({ team: [] })).rejects.toThrow(/scan first/);
  });

  it('copy: stops our server, streams steps, takes over Lite’s port and starts again', async () => {
    const { controller, deps, calls, changes } = setup();
    await controller.scan();
    const done = await controller.start({ team: [] });
    expect(done).toMatchObject({ phase: 'done', mode: 'copy', result });
    expect(done.steps).toEqual([
      { id: 'stop', state: 'done', progress: null },
      { id: 'copy', state: 'done', progress: 1 },
      { id: 'verify', state: 'done', progress: null },
      { id: 'handover', state: 'waiting', progress: null },
      { id: 'start', state: 'done', progress: null },
    ]);
    expect(changes.some((s) => s.steps.find((x) => x.id === 'copy')?.progress === 0.25)).toBe(true);
    expect(deps.stopOwnServer).toHaveBeenCalledOnce();
    expect(deps.takeOverPort).toHaveBeenCalledWith(7431);
    expect(deps.startOwnServer).toHaveBeenCalledOnce();
    // Copy mode needs no plan file.
    expect(deps.writePlan).not.toHaveBeenCalled();
    expect(calls[1]).toEqual(['--data', '/ent', '--import-lite', '/lite']);
  });

  it('merge: writes the plan to a temp file, removes it, keeps our port', async () => {
    const dispose = vi.fn(async () => {});
    const { controller, deps, calls } = setup({
      ownHasData: async () => true,
      writePlan: vi.fn(async () => ({ file: '/work/p.json', dispose })),
      script: {
        summary: { code: 0, lines: [summary] },
        import: {
          code: 0,
          lines: [{ step: 'merge', state: 'done' }, { result: { ...result, mode: 'merge' } }],
        },
      },
    });
    await controller.scan();
    const plan = {
      team: [{ liteUserId: 1, action: 'add' as const, matchUserId: null, role: 'admin' as const }],
    };
    const state = await controller.start(plan);
    expect(state.phase).toBe('done');
    expect(deps.writePlan).toHaveBeenCalledWith(plan);
    expect(dispose).toHaveBeenCalled();
    expect(calls[1]).toContain('/work/p.json');
    expect(deps.takeOverPort).not.toHaveBeenCalled();
    expect(state.steps.map((s) => s.id)).toEqual([
      'stop',
      'copy',
      'migrate',
      'merge',
      'verify',
      'handover',
      'start',
    ]);
  });

  it('shows a step the CLI reports outside this mode’s list before "start"', async () => {
    const { controller } = setup({
      script: {
        summary: { code: 0, lines: [summary] },
        import: { code: 0, lines: [{ step: 'migrate', state: 'done' }, { result }] },
      },
    });
    await controller.scan();
    const state = await controller.start({ team: [] });
    expect(state.steps.map((s) => s.id)).toEqual([
      'stop',
      'copy',
      'verify',
      'handover',
      'migrate',
      'start',
    ]);
  });

  it('re-checks Lite right before: blocked without stopping anything', async () => {
    let answers: number[] = [];
    const { controller, deps } = setup({ liteAnswers: async (p) => answers.includes(p) });
    await controller.scan();
    answers = [7420];
    expect(await controller.start({ team: [] })).toMatchObject({
      phase: 'blocked',
      issues: ['lite_running'],
    });
    expect(deps.stopOwnServer).not.toHaveBeenCalled();
  });

  it('maps a refusal (exit 5) to a blocked issue and starts our server again', async () => {
    const { controller, deps } = setup({
      script: {
        summary: { code: 0, lines: [summary] },
        import: { code: 5, lines: [{ error: { code: 'same_number' } }] },
      },
    });
    await controller.scan();
    expect(await controller.start({ team: [] })).toMatchObject({
      phase: 'blocked',
      issues: ['same_number'],
      steps: [],
    });
    expect(deps.startOwnServer).toHaveBeenCalledOnce();
  });

  it('fails with the CLI code (or import_failed), restarts our server, never takes the port', async () => {
    for (const [code, lines, failure] of [
      [
        1,
        [{ step: 'copy', state: 'running' }, { error: { code: 'verify_failed' } }],
        'verify_failed',
      ],
      [5, [{ error: { code: 'something_new' } }], 'something_new'],
      [1, [], 'import_failed'],
      [0, [], 'import_failed'],
    ] as const) {
      const { controller, deps } = setup({
        script: { summary: { code: 0, lines: [summary] }, import: { code, lines: [...lines] } },
      });
      await controller.scan();
      const state = await controller.start({ team: [] });
      expect(state).toMatchObject({ phase: 'failed', failure });
      expect(state.steps.some((s) => s.state === 'running')).toBe(false);
      expect(deps.startOwnServer).toHaveBeenCalledOnce();
      expect(deps.takeOverPort).not.toHaveBeenCalled();
    }
  });

  it('fails when our server cannot be stopped (e.g. it runs as a service)', async () => {
    const { controller, calls } = setup({
      stopOwnServer: async () => {
        throw new Error('service mode');
      },
    });
    await controller.scan();
    const state = await controller.start({ team: [] });
    expect(state).toMatchObject({ phase: 'failed', failure: 'own_server_stop' });
    expect(state.steps[0]).toEqual({ id: 'stop', state: 'failed', progress: null });
    expect(calls).toHaveLength(1); // the import never ran
  });

  it('treats a CLI that throws as a failure and a failed restart as a failed start step', async () => {
    const { controller, deps } = setup();
    await controller.scan();
    deps.cli.run = vi.fn(async () => {
      throw new Error('spawn');
    });
    expect((await controller.start({ team: [] })).failure).toBe('import_failed');

    const second = setup({ startOwnServer: vi.fn(async () => false) });
    await second.controller.scan();
    const state = await second.controller.start({ team: [] });
    expect(state.phase).toBe('done');
    expect(state.steps.at(-1)).toEqual({ id: 'start', state: 'failed', progress: null });
  });

  it('runs one operation at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { controller } = setup({ stopOwnServer: () => gate });
    await controller.scan();
    const running = controller.start({ team: [] });
    await vi.waitFor(() => expect(controller.getState().phase).toBe('running'));
    expect((await controller.scan()).phase).toBe('running');
    expect((await controller.reset()).phase).toBe('running');
    release();
    expect((await running).phase).toBe('done');
    expect((await controller.scan()).phase).toBe('found');
  });
});

describe('reset and support file', () => {
  it('reset goes back to idle', async () => {
    const { controller } = setup({ answers: [7420] });
    await controller.scan();
    expect(await controller.reset()).toMatchObject({ phase: 'idle', lite: null, issues: [] });
    await expect(controller.start({ team: [] })).rejects.toThrow(/scan first/);
  });

  it('the support file has counts and steps, never the number or names', async () => {
    const { controller } = setup();
    await controller.scan();
    await controller.start({ team: [] });
    const text = controller.supportReport({ version: '1.0.0' });
    expect(text).toContain('version: 1.0.0');
    expect(text).toContain('12 chats');
    expect(text).toContain('"phase":"done"');
    expect(text).not.toContain('60123456789');
    expect(text).not.toContain('Owner Name');
    expect(setup().controller.supportReport({})).toContain('lite summary: none');
  });
});
