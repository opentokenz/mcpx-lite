import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startRuntimeControl, stopRuntime } from '../src/runtime-control.js';

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('runtime control channel', () => {
  it('stops only the registered runtime through its private control endpoint', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcpx-lite-control-'));
    temporaryDirs.push(home);
    let shutdownRequests = 0;
    let control: Awaited<ReturnType<typeof startRuntimeControl>>;
    control = await startRuntimeControl(home, async () => {
      shutdownRequests += 1;
      await control.close();
    });

    const state = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8')) as {
      pid: number;
      controlPort: number;
      token: string;
    };
    expect(state.pid).toBe(process.pid);
    expect(state.controlPort).toBe(control.port);
    expect(state.token).toBeTruthy();

    await expect(stopRuntime(home, 2_000)).resolves.toBe(true);
    expect(shutdownRequests).toBe(1);
    await expect(readFile(join(home, 'runtime.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not signal any process when no runtime is registered', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcpx-lite-control-'));
    temporaryDirs.push(home);

    await expect(stopRuntime(home, 100)).resolves.toBe(false);
  });
});
