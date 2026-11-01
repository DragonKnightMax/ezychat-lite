// Starts a downloaded installer the normal, visible way (no silent install). No electron import: the
// macOS opener (shell.openPath) and the spawn are injected.
import { spawn as nodeSpawn } from 'node:child_process';

interface Spawned {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

export function createInstallerLauncher(o: {
  platform: NodeJS.Platform;
  /** shell.openPath: resolves '' on success, else an error message. */
  openPath(path: string): Promise<string>;
  spawn?: (file: string, args: string[], options: { detached: true; stdio: 'ignore' }) => Spawned;
}): (filePath: string) => Promise<void> {
  const spawn = o.spawn ?? (nodeSpawn as unknown as NonNullable<typeof o.spawn>);
  return async (filePath) => {
    if (o.platform === 'win32') {
      // The NSIS installer runs on its own; this app keeps running until Enterprise asks it to close.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(filePath, [], { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      return;
    }
    if (o.platform === 'darwin') {
      const error = await o.openPath(filePath);
      if (error) throw new Error(error);
      return;
    }
    throw new Error('No installer for this system');
  };
}
