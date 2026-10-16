import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from './errors.js';

interface RuntimeState {
  pid: number;
  controlPort: number;
  token: string;
}

export interface RuntimeControl {
  readonly port: number;
  close(): Promise<void>;
}

const STATE_FILE = 'runtime.json';
const CONTROL_PATH = '/__mcpx_lite_shutdown';

export async function startRuntimeControl(
  home: string,
  onShutdown: () => void | Promise<void>,
): Promise<RuntimeControl> {
  await mkdir(home, { recursive: true });
  const token = randomBytes(32).toString('hex');
  let shutdownRequested = false;
  let server: Server;
  server = createServer((req, res) => {
    const supplied = req.headers['x-mcpx-lite-token'];
    const suppliedToken = Array.isArray(supplied) ? supplied[0] : supplied;
    const expected = Buffer.from(token);
    const actual = Buffer.from(suppliedToken ?? '');
    const authorized = req.method === 'POST' && req.url === CONTROL_PATH &&
      actual.length === expected.length && timingSafeEqual(actual, expected);

    if (!authorized) {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(202).end();
    if (!shutdownRequested) {
      shutdownRequested = true;
      setImmediate(() => {
        void Promise.resolve(onShutdown()).catch((error: unknown) => {
          const message = errorMessage(error);
          process.stderr.write(`mcpx-lite shutdown failed: ${message}\n`);
        });
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Could not bind runtime control endpoint');
  }

  const state: RuntimeState = { pid: process.pid, controlPort: address.port, token };
  const statePath = join(home, STATE_FILE);
  try {
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    close() {
      closePromise ??= (async () => {
        await closeServer(server);
        await removeStateIfCurrent(statePath, state);
      })();
      return closePromise;
    },
  };
}

export async function stopRuntime(home: string, timeoutMs = 10_000): Promise<boolean> {
  const statePath = join(home, STATE_FILE);
  const state = await readState(statePath);
  if (!state) return false;

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${state.controlPort}${CONTROL_PATH}`, {
      method: 'POST',
      headers: { 'x-mcpx-lite-token': state.token },
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Timed out contacting the registered mcpx-lite process (pid ${state.pid})`, { cause: error });
    }
    await removeStateIfCurrent(statePath, state);
    return false;
  }

  if (response.status !== 202) {
    throw new Error(`The registered mcpx-lite process rejected shutdown (HTTP ${response.status})`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readState(statePath);
    if (!current || !sameState(current, state)) return true;
    await delay(50);
  }
  throw new Error(`Timed out waiting for mcpx-lite process ${state.pid} to stop`);
}

async function readState(path: string): Promise<RuntimeState | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error('Runtime state file is invalid JSON', { cause: error });
  }
  if (
    typeof value !== 'object' || value === null ||
    !Number.isInteger((value as RuntimeState).pid) || (value as RuntimeState).pid < 1 ||
    !Number.isInteger((value as RuntimeState).controlPort) || (value as RuntimeState).controlPort < 1 || (value as RuntimeState).controlPort > 65535 ||
    typeof (value as RuntimeState).token !== 'string' || (value as RuntimeState).token.length !== 64
  ) {
    throw new Error('Runtime state file is invalid');
  }
  return value as RuntimeState;
}

async function removeStateIfCurrent(path: string, state: RuntimeState): Promise<void> {
  const current = await readState(path);
  if (current && sameState(current, state)) await rm(path, { force: true });
}

function sameState(a: RuntimeState, b: RuntimeState): boolean {
  return a.pid === b.pid && a.controlPort === b.controlPort && a.token === b.token;
}

export function closeServer(server: { close(done: (error?: Error) => void): unknown }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
