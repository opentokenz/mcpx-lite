import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMcpConnection } from '../src/mcp-client.js';
import type { ResolvedMcpServer } from '../src/mcp-config.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe('source runtime entry', () => {
  it('starts the MCP server from the shared CLI entry', async () => {
    await smokeRuntime(process.execPath, [
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'src', 'bin.ts'),
    ]);
  });

  it.skipIf(!process.env['MCPX_LITE_BINARY'])('starts the packaged executable and serves MCP over HTTP', async () => {
    await smokeRuntime(process.env['MCPX_LITE_BINARY']!, []);
  });

  it.skipIf(!process.env['MCPX_LITE_BINARY'])('manages a background process from the packaged executable', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mcpx-lite-binary-daemon-'));
    const home = join(temp, 'home');
    const port = await availablePort();
    const env = {
      ...process.env,
      MCPX_LITE_HOME: home,
      MCPX_LITE_GLOBAL_SKILLS: join(temp, 'skills'),
      MCPX_LITE_LOG: 'off',
    };
    let activePid: number | undefined;

    try {
      const started = await runBinaryCli(['-d', '-p', String(port)], env);
      expect(started.code).toBe(0);
      const state = await readRuntimeState(home);
      activePid = state.pid;
      await waitForEndpoint(port);

      const stopped = await runBinaryCli(['--stop'], env);
      expect(stopped.code).toBe(0);
      expect(isProcessAlive(state.pid)).toBe(false);
    } finally {
      if (activePid && isProcessAlive(activePid)) process.kill(activePid, 'SIGTERM');
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('starts in the background, replaces the previous runtime, and stops it through --stop', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mcpx-lite-daemon-'));
    const home = join(temp, 'home');
    const port = await availablePort();
    const env = {
      ...process.env,
      MCPX_LITE_HOME: home,
      MCPX_LITE_GLOBAL_SKILLS: join(temp, 'skills'),
      MCPX_LITE_LOG: 'off',
    };
    let activePid: number | undefined;

    try {
      const first = await runCli(['-d', '--port', String(port)], env);
      expect(first.code).toBe(0);
      const firstState = await readRuntimeState(home);
      activePid = firstState.pid;
      await waitForEndpoint(port);

      const second = await runCli(['--daemon', '-p', String(port)], env);
      expect(second.code).toBe(0);
      const secondState = await readRuntimeState(home);
      expect(secondState.pid).not.toBe(firstState.pid);
      activePid = secondState.pid;
      expect(isProcessAlive(firstState.pid)).toBe(false);

      const stopped = await runCli(['--stop'], env);
      expect(stopped.code).toBe(0);
      expect(isProcessAlive(secondState.pid)).toBe(false);
      await expect(readFile(join(home, 'runtime.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (activePid && isProcessAlive(activePid)) process.kill(activePid, 'SIGTERM');
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('审批关闭时 daemon 日志输出显式安全警告', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mcpx-lite-no-approval-'));
    const home = join(temp, 'home');
    const port = await availablePort();
    const env = {
      ...process.env,
      MCPX_LITE_HOME: home,
      MCPX_LITE_GLOBAL_SKILLS: join(temp, 'skills'),
      MCPX_LITE_LOG: 'info',
    };
    let activePid: number | undefined;

    try {
      const started = await runCli(['--daemon', '--no-approval', '--port', String(port)], env);
      expect(started.code).toBe(0);
      const state = await readRuntimeState(home);
      activePid = state.pid;
      await waitForEndpoint(port);

      const log = await readFile(join(home, 'daemon.log'), 'utf8');
      expect(log).toMatch(/审批已关闭/);

      const stopped = await runCli(['--stop'], env);
      expect(stopped.code).toBe(0);
      activePid = undefined;
    } finally {
      if (activePid && isProcessAlive(activePid)) process.kill(activePid, 'SIGTERM');
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('leaves an unrelated listener running when its port is requested', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mcpx-lite-port-in-use-'));
    const home = join(temp, 'home');
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('could not allocate a test port');

    try {
      const result = await runCli(['--port', String(address.port)], {
        ...process.env,
        MCPX_LITE_HOME: home,
        MCPX_LITE_GLOBAL_SKILLS: join(temp, 'skills'),
        MCPX_LITE_LOG: 'off',
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/EADDRINUSE/);
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
      await rm(temp, { recursive: true, force: true });
    }
  });
});

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return runCommand(process.execPath, [
    join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(root, 'src', 'bin.ts'),
    ...args,
  ], env);
}

async function runBinaryCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return runCommand(env['MCPX_LITE_BINARY']!, args, env);
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI command did not exit: ${args.join(' ')}`));
    }, 8_000);
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return { code, stderr };
}

async function readRuntimeState(home: string): Promise<{ pid: number }> {
  return JSON.parse(await readFile(join(home, 'runtime.json'), 'utf8')) as { pid: number };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function smokeRuntime(command: string, args: string[]): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'mcpx-lite-startup-'));
  const port = await availablePort();
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      MCPX_LITE_PORT: String(port),
      MCPX_LITE_HOME: join(temp, 'home'),
      MCPX_LITE_GLOBAL_SKILLS: join(temp, 'skills'),
      MCPX_LITE_LOG: 'off',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

  try {
    await waitForServer(port, child, () => stderr);
    const server: ResolvedMcpServer = {
      name: 'source-smoke',
      source: 'global',
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: {},
      display: { url: `http://127.0.0.1:${port}/mcp`, headers: [] },
      hash: 'source-smoke',
    };
    const connection = await createMcpConnection(server);
    try {
      expect(connection.info().serverInfo).toMatchObject({ name: 'mcpx-lite' });
    } finally {
      await connection.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([closed, delay(3_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(temp, { recursive: true, force: true });
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForServer(
  port: number,
  child: ReturnType<typeof spawn>,
  getStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      await fetch(`http://127.0.0.1:${port}/startup-probe`);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`MCP server did not start; exit code ${child.exitCode}; stderr: ${getStderr()}`);
}

async function waitForEndpoint(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/startup-probe`);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`MCP server did not start on port ${port}`);
}
