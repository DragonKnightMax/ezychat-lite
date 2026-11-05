// Keeps a Mac from idle sleep while the inbox server runs: a sleeping Mac drops WhatsApp, so customers
// and AI replies wait until someone wakes it. caffeinate -i allows the display to sleep and the lid to
// put the Mac to sleep; -w ends the assertion when this server process exits, even after a crash.
import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore' },
) => { kill(): unknown; unref(): unknown; on(event: 'error', fn: (err: Error) => void): unknown };

export function startKeepAwake(opts: {
  mode: 'standalone' | 'service' | 'dev';
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: SpawnFn;
}): { stop(): void } {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' || opts.mode === 'dev') return { stop() {} };
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(opts.pid ?? process.pid)], {
    stdio: 'ignore',
  });
  child.on('error', (err) => opts.log.warn({ err }, 'could not keep the Mac awake'));
  child.unref();
  opts.log.info({}, 'keeping the Mac awake while the server runs');
  return {
    stop() {
      child.kill();
    },
  };
}
