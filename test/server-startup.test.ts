import { mkdtemp, rm } from 'node:fs/promises';
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

  it.skipIf(!process.env['MINI_PI_MCP_BINARY'])('starts the packaged executable and serves MCP over HTTP', async () => {
    await smokeRuntime(process.env['MINI_PI_MCP_BINARY']!, []);
  });
});

async function smokeRuntime(command: string, args: string[]): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'mini-pi-startup-'));
  const port = await availablePort();
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      MINI_PI_MCP_PORT: String(port),
      MINI_PI_MCP_HOME: join(temp, 'home'),
      MINI_PI_MCP_GLOBAL_SKILLS: join(temp, 'skills'),
      MINI_PI_MCP_LOG: 'off',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

  try {
    await waitForServer(port, child);
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
      expect(connection.info().serverInfo).toMatchObject({ name: 'mini-pi-mcp' });
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

async function waitForServer(port: number, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      await fetch(`http://127.0.0.1:${port}/startup-probe`);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`MCP server did not start; exit code ${child.exitCode}`);
}
