// The Lite import as seen by the desktop main process (design §5.1–5.4, 5.10): a small state machine
// that produces the shared `LiteImportState` for the web screens. No electron import: main.ts injects
// the file system, the server CLI, the health probe and the own-server stop/start.
//
// scan():  find Lite's data (a folder this user may not read → phase 'protected') → `--lite-summary` → checks (Lite running, Lite's service running, disk).
// unlock(): phase 'protected' → scan again (freed by hand?) → one admin prompt runs Lite's own "Remove
//          service" (data to Lite's user folder) → scan. Refused or failed: phase stays 'protected'.
// start(): re-check Lite is stopped → stop our server → `--import-lite` (plan in a temp file) with its
//          progress lines → copy mode: take over Lite's port → start our server.
// The CLI owns everything that touches data, including the checks it can only make with the databases
// (same_number, no_slot, lite_newer): it refuses with exit 5 and the code, mapped to an issue here.
import type {
  LiteCheckIssue,
  LiteImportMode,
  LiteImportPlan,
  LiteImportProgress,
  LiteImportState,
  LiteImportStep,
  LiteImportStepId,
  LiteSummary,
} from '@ezychat/shared';
import type { ServiceState } from '../service/windows.js';
import { EXIT_OK, EXIT_REFUSED, readLiteSummary, runLiteImport, type ServerCli } from './cli.js';
import type { LiteLocation } from './detect.js';

const ISSUES: readonly LiteCheckIssue[] = [
  'lite_running',
  'lite_newer',
  'disk',
  'same_number',
  'no_slot',
  'lite_service',
];
/** Free space needed on our volume: the copied items × 1.1 (design §5.2). */
export const DISK_MARGIN = 1.1;

const COPY_STEPS: readonly LiteImportStepId[] = ['stop', 'copy', 'verify', 'handover', 'start'];
const MERGE_STEPS: readonly LiteImportStepId[] = [
  'stop',
  'copy',
  'migrate',
  'merge',
  'verify',
  'handover',
  'start',
];

export interface LiteImportDeps {
  /** False when the product has no `adoptFrom`: every scan answers phase 'none'. */
  enabled: boolean;
  /** Our data folder (the import target). */
  ownDataDir: string;
  /** Lite's data folder to import, or null (detect.ts chooseLiteFolder). */
  findLite(): Promise<LiteLocation | null>;
  /** Ports Lite may answer on, most likely first (detect.ts litePorts). */
  litePorts(): number[];
  /** Lite's OS service state (the adopted product's service). */
  liteServiceState(): Promise<ServiceState>;
  /**
   * Frees Lite's locked service folder with one admin prompt: Lite's own "Remove service" moves the data
   * to Lite's user folder. 'cancelled': the prompt was refused; 'target_has_data': Lite's user folder
   * already holds an app.db, so nothing ran. Nothing changed in both. Throws when the step failed.
   */
  unlockLite(): Promise<'done' | 'cancelled' | 'target_has_data'>;
  /** True when Lite's server answers /api/health on that port (app and edition match). */
  liteAnswers(port: number): Promise<boolean>;
  /** Whether this install already has data (decides the shown mode; the CLI decides the real one). */
  ownHasData(): Promise<boolean>;
  /** Free bytes on the volume of a folder, or null when unknown. */
  freeBytes(dir: string): Promise<number | null>;
  cli: ServerCli;
  /** Writes the plan to a private temp file; dispose removes it. */
  writePlan(plan: LiteImportPlan): Promise<{ file: string; dispose(): Promise<void> }>;
  /** Stops our own server (throws when it cannot, e.g. it runs as an OS service). */
  stopOwnServer(): Promise<void>;
  /** Starts our server again and reloads the window; resolves whether it answers. */
  startOwnServer(): Promise<boolean>;
  /** Copy mode: our server takes over Lite's port (desktop.json) before it starts (design §2). */
  takeOverPort(port: number): void;
  onChanged?(state: LiteImportState): void;
  /** Structured log: step, counts and ms only (never names, numbers or text). */
  log?(fields: Record<string, unknown>): void;
  now?(): number;
}

function initialState(): LiteImportState {
  return {
    phase: 'idle',
    mode: null,
    lite: null,
    liteService: false,
    unlock: 'idle',
    enterprise: null,
    issues: [],
    steps: [],
    result: null,
    failure: null,
  };
}

function isIssue(code: string): code is LiteCheckIssue {
  return (ISSUES as readonly string[]).includes(code);
}

export class LiteImportController {
  private state: LiteImportState = initialState();
  private location: LiteLocation | null = null;
  private busy: Promise<unknown> | null = null;
  private readonly records: string[] = [];

  constructor(private readonly deps: LiteImportDeps) {}

  getState(): LiteImportState {
    return structuredClone(this.state);
  }

  private set(patch: Partial<LiteImportState>): LiteImportState {
    this.state = { ...this.state, ...patch };
    const copy = this.getState();
    this.deps.onChanged?.(copy);
    return copy;
  }

  private log(fields: Record<string, unknown>): void {
    const record = { mod: 'lite-import', ...fields };
    this.records.push(JSON.stringify(record));
    if (this.records.length > 200) this.records.shift();
    this.deps.log?.(record);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** One operation at a time: a second scan/start while one runs gets the current state. */
  private exclusive(task: () => Promise<LiteImportState>): Promise<LiteImportState> {
    if (this.busy) return Promise.resolve(this.getState());
    const run = task().finally(() => {
      this.busy = null;
    });
    this.busy = run;
    return run;
  }

  /** Lite's server or service still running: the issues that block the import. */
  private async runningIssues(): Promise<{ issues: LiteCheckIssue[]; liteService: boolean }> {
    const service: ServiceState = await this.deps
      .liteServiceState()
      .catch((): ServiceState => 'not-installed');
    const liteService = service !== 'not-installed';
    if (service === 'running') return { issues: ['lite_service'], liteService };
    for (const port of this.deps.litePorts()) {
      if (await this.deps.liteAnswers(port)) return { issues: ['lite_running'], liteService };
    }
    return { issues: [], liteService };
  }

  scan(): Promise<LiteImportState> {
    return this.exclusive(() => this.doScan());
  }

  /**
   * The "Allow" step of phase 'protected'. Scans first: the folder may have been freed by hand, which
   * needs no prompt. Without Lite's service there is nothing to remove, so only the manual way is left.
   */
  unlock(): Promise<LiteImportState> {
    return this.exclusive(async () => {
      if (this.state.phase !== 'protected') return this.getState();
      const before = await this.doScan();
      if (before.phase !== 'protected') return before;
      const started = this.now();
      if (!before.liteService) {
        this.log({ step: 'unlock', outcome: 'no_service' });
        return this.set({ unlock: 'failed' });
      }
      this.set({ unlock: 'waiting' });
      let outcome: 'done' | 'cancelled' | 'target_has_data' | 'error';
      try {
        outcome = await this.deps.unlockLite();
      } catch {
        // The error text can carry folder paths (a user name): log the outcome only.
        outcome = 'error';
      }
      this.log({ step: 'unlock', outcome, ms: this.now() - started });
      if (outcome === 'cancelled') return this.set({ unlock: 'declined' });
      if (outcome !== 'done') return this.set({ unlock: 'failed' });
      const after = await this.doScan();
      return after.phase === 'protected' ? this.set({ unlock: 'failed' }) : after;
    });
  }

  private async doScan(): Promise<LiteImportState> {
    if (this.state.phase === 'running') return this.getState();
    if (!this.deps.enabled) return this.set({ ...initialState(), phase: 'none' });
    const started = this.now();
    const location = await this.deps.findLite().catch(() => null);
    this.location = location;
    if (!location) {
      this.log({ step: 'scan', found: false, ms: this.now() - started });
      return this.set({ ...initialState(), phase: 'none' });
    }
    if (!location.readable) {
      // Lite's service folder: found, but only an elevated step may read it (design §5.5).
      const service = await this.deps.liteServiceState().catch((): ServiceState => 'not-installed');
      this.location = null;
      this.log({ step: 'scan', found: true, readable: false, ms: this.now() - started });
      return this.set({
        ...initialState(),
        phase: 'protected',
        liteService: service !== 'not-installed',
      });
    }
    let lite: LiteSummary;
    try {
      lite = await readLiteSummary(this.deps.cli, location.dataDir);
    } catch {
      this.log({ step: 'scan', found: true, summary: false, ms: this.now() - started });
      return this.set({ ...initialState(), phase: 'failed', failure: 'summary_failed' });
    }
    const [running, hasData, freeBytes] = await Promise.all([
      this.runningIssues(),
      this.deps.ownHasData().catch(() => false),
      this.deps.freeBytes(this.deps.ownDataDir).catch(() => null),
    ]);
    const issues = [...running.issues];
    if (freeBytes !== null && freeBytes < lite.totalBytes * DISK_MARGIN) issues.push('disk');
    const mode: LiteImportMode = hasData ? 'merge' : 'copy';
    this.log({
      step: 'scan',
      found: true,
      kind: location.kind,
      chats: lite.chats,
      users: lite.users.length,
      bytes: lite.totalBytes,
      issues,
      mode,
      ms: this.now() - started,
    });
    return this.set({
      ...initialState(),
      phase: issues.length ? 'blocked' : 'found',
      mode,
      lite,
      liteService: running.liteService,
      // Inbox counts are not known to the desktop; the web reads them from its own API.
      enterprise: { hasData, inboxes: 0, maxInboxes: 0, freeBytes: freeBytes ?? 0 },
      issues,
    });
  }

  private stepsFor(mode: LiteImportMode): LiteImportStep[] {
    return (mode === 'merge' ? MERGE_STEPS : COPY_STEPS).map((id) => ({
      id,
      state: 'waiting',
      progress: null,
    }));
  }

  private step(id: LiteImportStepId, state: LiteImportStep['state'], progress?: number | null) {
    const steps = this.state.steps.map((s) => ({ ...s }));
    let step = steps.find((s) => s.id === id);
    if (!step) {
      // A step the CLI reports that this mode did not list: show it before "start".
      step = { id, state: 'waiting', progress: null };
      const at = steps.findIndex((s) => s.id === 'start');
      steps.splice(at < 0 ? steps.length : at, 0, step);
    }
    step.state = state;
    if (progress !== undefined) step.progress = progress;
    this.set({ steps });
  }

  private onProgress(p: LiteImportProgress): void {
    const fraction =
      p.total && p.total > 0 && p.done !== undefined
        ? Math.min(1, Math.max(0, p.done / p.total))
        : null;
    this.step(p.step, p.state, p.step === 'copy' ? (p.state === 'done' ? 1 : fraction) : null);
    if (p.state !== 'running') this.log({ step: p.step, state: p.state });
  }

  start(plan: LiteImportPlan): Promise<LiteImportState> {
    return this.exclusive(async () => {
      if (this.state.phase !== 'found' || !this.location || !this.state.lite || !this.state.mode)
        throw new Error('Nothing to import: scan first');
      const location = this.location;
      const mode = this.state.mode;
      const started = this.now();
      // Lite may have been opened again since the scan (design §5.2: checked again right before).
      const running = await this.runningIssues();
      if (running.issues.length) {
        this.log({ step: 'start', issues: running.issues });
        return this.set({
          phase: 'blocked',
          issues: running.issues,
          liteService: running.liteService,
        });
      }
      this.set({ phase: 'running', steps: this.stepsFor(mode), issues: [], failure: null });
      this.step('stop', 'running');
      try {
        await this.deps.stopOwnServer();
      } catch {
        this.step('stop', 'failed');
        this.log({ step: 'stop', state: 'failed' });
        return this.fail('own_server_stop');
      }
      this.step('stop', 'done');
      let written: { file: string; dispose(): Promise<void> } | null = null;
      let run;
      try {
        written = mode === 'merge' ? await this.deps.writePlan(plan) : null;
        run = await runLiteImport(
          this.deps.cli,
          { target: this.deps.ownDataDir, liteDir: location.dataDir, planFile: written?.file },
          (p) => this.onProgress(p),
        );
      } catch {
        run = { code: 1, outcome: null };
      } finally {
        await written?.dispose().catch(() => undefined);
      }
      const outcome = run.outcome;
      if (run.code === EXIT_OK && outcome && 'result' in outcome) {
        const result = outcome.result;
        // Copy mode: Lite's number keeps its address, so phones, PWAs and bookmarks keep working.
        if (result.mode === 'copy') {
          const port = this.deps.litePorts()[0];
          if (port !== undefined) this.deps.takeOverPort(port);
        }
        this.step('start', 'running');
        const ok = await this.deps.startOwnServer().catch(() => false);
        this.step('start', ok ? 'done' : 'failed');
        this.log({
          step: 'done',
          mode: result.mode,
          chats: result.chats,
          usersAdded: result.usersAdded,
          usersMatched: result.usersMatched,
          started: ok,
          ms: this.now() - started,
        });
        // A later start failure is an ordinary start error (the window shows it); the data is in.
        return this.set({ phase: 'done', result, mode: result.mode });
      }
      const code = outcome && 'error' in outcome ? outcome.error.code : null;
      this.log({ step: 'import', exit: run.code, code, ms: this.now() - started });
      if (run.code === EXIT_REFUSED && code && isIssue(code)) {
        await this.deps.startOwnServer().catch(() => false);
        return this.set({ phase: 'blocked', issues: [code], steps: [] });
      }
      return this.fail(code ?? 'import_failed');
    });
  }

  /** Failed import: Lite is untouched (the CLI rolled back); our server runs again. */
  private async fail(failure: string): Promise<LiteImportState> {
    const steps = this.state.steps.map((s) =>
      s.state === 'running' ? { ...s, state: 'failed' as const } : s,
    );
    this.set({ steps });
    await this.deps.startOwnServer().catch(() => false);
    return this.set({ phase: 'failed', failure });
  }

  /** Back to the start after a failure or a blocked check (never while an import runs). */
  reset(): Promise<LiteImportState> {
    if (this.state.phase === 'running' || this.busy) return Promise.resolve(this.getState());
    this.location = null;
    return Promise.resolve(this.set(initialState()));
  }

  /** Text of the support file: state without Lite's summary, and this run's log records. */
  supportReport(meta: Record<string, string>): string {
    // Lite's summary and the result carry names and the number: only counts go in the file.
    const { lite, result, ...state } = this.state;
    return [
      'EzyChat Lite import support file (no chat data, names or numbers)',
      ...Object.entries(meta).map(([k, v]) => `${k}: ${v}`),
      `lite summary: ${lite ? `schema ${lite.schemaVersion}, ${lite.chats} chats, ${lite.users.length} users, ${lite.totalBytes} bytes` : 'none'}`,
      `result: ${result ? `${result.mode}, ${result.chats} chats, ${result.usersAdded} added, ${result.usersMatched} matched` : 'none'}`,
      `state: ${JSON.stringify(state)}`,
      '',
      ...this.records,
      '',
    ].join('\n');
  }
}
