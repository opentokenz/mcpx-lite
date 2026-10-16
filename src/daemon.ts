import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './index.js';

const START_TIMEOUT_MS = 15_000;

export async function startDaemon(args: string[], config: Config): Promise<void> {
  mkdirSync(config.home, { recursive: true });
  const logPath = join(config.home, 'daemon.log');
  const logFd = openSync(logPath, 'a');
  const childArgs = args.filter((arg) => arg !== '--daemon' && arg !== '-d' && arg !== '--daemon-child');
  childArgs.push('--daemon-child');
  const launch = daemonCommand(childArgs);
  let child;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }

  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not start background process: ${spawnError.message}`);
    if (child.exitCode !== null) {
      throw new Error(`Background process exited with code ${child.exitCode}; see ${logPath}`);
    }
    const runtimePid = await readRuntimePid(config.home);
    if (runtimePid === child.pid) {
      process.stdout.write(`mcpx-lite started in background (pid ${child.pid}); log: ${logPath}\n`);
      return;
    }
    await delay(50);
  }

  if (child.pid && isAlive(child.pid)) child.kill('SIGTERM');
  throw new Error(`Timed out waiting for the background server to start; see ${logPath}`);
}

function daemonCommand(childArgs: string[]): { command: string; args: string[] } {
  if (process.versions['bun']) return { command: process.execPath, args: childArgs };

  const argv = process.argv;
  const entryIndex = argv.findIndex((arg) => basename(arg).toLowerCase() === 'bin.ts');
  if (entryIndex > 1) {
    return {
      command: process.execPath,
      args: [argv[1]!, argv[entryIndex]!, ...childArgs],
    };
  }
  if (entryIndex === 1) {
    return { command: process.execPath, args: [...process.execArgv, argv[entryIndex]!, ...childArgs] };
  }
  return { command: process.execPath, args: childArgs };
}

async function readRuntimePid(home: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8')) as { pid?: unknown };
    return typeof value.pid === 'number' ? value.pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
