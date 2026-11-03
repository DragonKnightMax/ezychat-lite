// The AI agent limit (docs/features/group-agents/design.md, Part B): `runCli({ maxAgents })` from
// the edition, `--max-agents` only in dev with fake WhatsApp, absent = one per inbox.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/config.js';

const started = vi.hoisted(() => [] as Array<{ maxAgents?: number }>);
vi.mock('../src/main.js', () => ({
  startServer: vi.fn(async (cfg: { maxAgents?: number }) => {
    started.push(cfg);
    return {};
  }),
}));
const { runCli } = await import('../src/run-cli.js');

const dirs: string[] = [];
afterEach(() => {
  started.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('--max-agents', () => {
  it('is accepted only in dev with fake WhatsApp, as a whole number 1–100', () => {
    const dev = ['--data', 'x', '--fake-wa', '--mode', 'dev'];
    expect(parseArgs([...dev, '--max-agents', '4'], {}).maxAgents).toBe(4);
    expect(parseArgs(dev, {}).maxAgents).toBeUndefined();
    expect(() => parseArgs(['--data', 'x', '--max-agents', '4'], {})).toThrow(/max-agents/);
    expect(() => parseArgs(['--data', 'x', '--fake-wa', '--max-agents', '4'], {})).toThrow(
      /max-agents/,
    );
    expect(() => parseArgs([...dev, '--max-agents', '0'], {})).toThrow(/max-agents/);
    expect(() => parseArgs([...dev, '--max-agents', 'two'], {})).toThrow(/max-agents/);
    expect(() => parseArgs([...dev, '--max-agents', '101'], {})).toThrow(/max-agents/);
  });
});

describe('runCli maxAgents', () => {
  const data = () => {
    const dir = mkdtempSync(join(tmpdir(), 'wati-agents-'));
    dirs.push(dir);
    return dir;
  };

  it('passes the edition limit, lets the dev flag override it and adds nothing for Lite', async () => {
    await runCli(['--data', data()], {}, { maxAgents: 5 });
    await runCli(
      ['--data', data(), '--fake-wa', '--mode', 'dev', '--max-agents', '2'],
      {},
      { maxAgents: 5 },
    );
    await runCli(['--data', data()], {});
    expect(started.map((cfg) => cfg.maxAgents)).toEqual([5, 2, undefined]);
    expect('maxAgents' in started[2]!).toBe(false);
  });
});
