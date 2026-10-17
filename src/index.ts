import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createApprovalCodec } from './approval.js';
import { errorMessage } from './errors.js';
import { DEFAULT_TTL_MS, TokenStore, createFilesRoute } from './downloads.js';
import { createLogger, resolveLogLevel, type Logger, type LogLevel } from './log.js';
import { createMcpConnection } from './mcp-client.js';
import { McpManager } from './mcp-manager.js';
import { McpTrustStore } from './mcp-trust.js';
import { buildHandler, type Deps } from './server.js';
import { SessionStore } from './session.js';
import { SkillIndex, SKILLS_SUBDIR } from './skills.js';
import { createSystemTrashBackend } from './trash.js';
import { closeServer, startRuntimeControl, stopRuntime } from './runtime-control.js';
import { startDaemon } from './daemon.js';

export interface Config {
  host: string;
  port: number;
  home: string;
  globalSkillsDir: string;
  downloadTtlMs: number;
  logLevel: LogLevel;
  approvalsEnabled: boolean;
}

export type CliMode = 'foreground' | 'daemon' | 'stop' | 'daemon-child';

export function parseCliArgs(args: string[]): { mode: CliMode; port?: number; approvalsEnabled?: false } {
  const modes: Record<string, CliMode> = {
    '--daemon': 'daemon',
    '-d': 'daemon',
    '--stop': 'stop',
    '--daemon-child': 'daemon-child',
  };
  let mode: CliMode = 'foreground';
  let port: number | undefined;
  let approvalsEnabled: false | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--no-approval') {
      approvalsEnabled = false;
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}; valid port range is 1-65535`);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid port: ${value}; valid port range is 1-65535`);
      }
      port = parsed;
      index += 1;
      continue;
    }

    const next = modes[arg];
    if (!next) throw new Error(`Unknown argument: ${arg}`);
    if (mode !== 'foreground') throw new Error('Runtime arguments cannot be combined');
    mode = next;
  }

  return {
    mode,
    ...(port === undefined ? {} : { port }),
    ...(approvalsEnabled === undefined ? {} : { approvalsEnabled }),
  };
}

export function getCliArgs(argv: string[] = process.argv): string[] {
  const entryIndex = argv.findIndex((arg) => basename(arg).toLowerCase() === 'bin.ts');
  if (entryIndex >= 1) return argv.slice(entryIndex + 1);
  if (/(?:^|[/\\])(?:\$bunfs|~BUN)[/\\]root[/\\]/i.test(argv[1] ?? '')) return argv.slice(2);
  return argv.slice(1);
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 29090;
const DEFAULT_HOME = join(homedir(), '.mcpx-lite');

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  portOverride?: number,
  approvalsOverride?: false,
): Config {
  const port = Number.parseInt(env['MCPX_LITE_PORT'] ?? '', 10);
  const approvalsEnabled = approvalsOverride ?? env['MCPX_LITE_APPROVALS']?.trim().toLowerCase() !== 'off';

  return {
    host: env['MCPX_LITE_HOST']?.trim() || DEFAULT_HOST,
    port: portOverride ?? (Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT),
    home: env['MCPX_LITE_HOME']?.trim() || DEFAULT_HOME,
    globalSkillsDir: env['MCPX_LITE_GLOBAL_SKILLS']?.trim() || join(homedir(), SKILLS_SUBDIR),
    downloadTtlMs: DEFAULT_TTL_MS,
    logLevel: resolveLogLevel(env['MCPX_LITE_LOG']),
    approvalsEnabled,
  };
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function header(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(',');
  return value ?? '';
}

/**
 * 一个端口同时提供两个入口：
 * - POST /mcp         → MCP 2026-07-28（Streamable HTTP）
 * - GET  /files/:token → fetch 工具签发的一次性文件链接
 * 其余路径 404。回环绑定启用 Host / Origin 校验，防止 DNS rebinding。
 */
export function createHttpServer(deps: Deps): Server {
  const handler = buildHandler(deps);
  const nodeHandler = toNodeHandler(handler);
  const filesRoute = createFilesRoute({ tokens: deps.downloads, logger: deps.logger });
  const loopback = isLoopback(deps.config.host);
  const validateHost = loopback ? localhostHostValidation() : undefined;
  const validateOrigin = loopback ? localhostOriginValidation() : undefined;

  return createServer((req, res) => {
    if (validateHost && !validateHost(req, res)) return;
    if (validateOrigin && !validateOrigin(req, res)) return;

    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
    if (pathname === '/mcp') {
      // 入站观测：谁在用、调哪个方法/工具、什么状态、耗时多久（debug 级诊断，不淹没工具卡片）
      const startedAt = Date.now();
      res.once('finish', () => {
        deps.logger.event(
          'mcp-request',
          {
            method: req.method ?? '',
            rpc: header(req.headers['mcp-method']),
            name: header(req.headers['mcp-name']),
            protocol: header(req.headers['mcp-protocol-version']),
            status: res.statusCode,
            ms: Date.now() - startedAt,
          },
          'debug',
        );
      });
      void nodeHandler(req, res);
      return;
    }

    void filesRoute(req, res)
      .then((handled) => {
        if (handled) return;
        deps.logger.event('http-not-found', { method: req.method ?? '', path: pathname });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      })
      .catch((error: unknown) => {
        deps.logger.event('files-route-error', { error: errorMessage(error) });
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal error"}');
      });
  });
}

function createDeps(config: Config, logger?: Logger): { deps: Deps; logger: Logger } {
  const resolvedLogger = logger ?? createLogger({ level: config.logLevel });

  return {
    logger: resolvedLogger,
    deps: {
      sessions: new SessionStore({ home: config.home }),
      skills: new SkillIndex({ globalSkillsDir: config.globalSkillsDir }),
      downloads: new TokenStore({ ttlMs: config.downloadTtlMs }),
      logger: resolvedLogger,
      approvals: createApprovalCodec({ enabled: config.approvalsEnabled }),
      mcpManager: new McpManager({ connect: createMcpConnection }),
      mcpTrust: new McpTrustStore(),
      mcpGlobalPath: join(homedir(), '.agents', 'mcp.json'),
      trashBackend: createSystemTrashBackend(),
      config: { host: config.host, port: config.port, approvalsEnabled: config.approvalsEnabled },
    },
  };
}

export function createShutdownHandler(opts: {
  logger: Pick<Logger, 'event'>;
  manager: { closeAll(): Promise<void> };
  server: { close(done: (error?: Error) => void): unknown };
  control?: { close(): Promise<void> };
  exit: (code: number) => void;
}) {
  let shutdownPromise: Promise<void> | undefined;
  return (signal: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      opts.logger.event('shutdown', { signal });
      await opts.manager.closeAll();
      await closeServer(opts.server);
      await opts.control?.close();
      opts.exit(0);
    })();
    return shutdownPromise;
  };
}

export async function main(args: string[] = getCliArgs()): Promise<void> {
  const cli = parseCliArgs(args);
  const config = loadConfig(process.env, cli.port, cli.approvalsEnabled);
  if (cli.mode === 'stop') {
    const stopped = await stopRuntime(config.home);
    process.stdout.write(stopped ? 'mcpx-lite stopped\n' : 'mcpx-lite is not running\n');
    return;
  }
  if (cli.mode === 'daemon') {
    await startDaemon(args, config);
    return;
  }

  await stopRuntime(config.home);
  const { deps, logger } = createDeps(config);
  const server = createHttpServer(deps);

  await new Promise<void>((ready, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', onError);
      ready();
    });
  });

  let shutdown: (signal: string) => Promise<void> = async () => undefined;
  let control: Awaited<ReturnType<typeof startRuntimeControl>>;
  try {
    control = await startRuntimeControl(config.home, () => shutdown('CONTROL'));
  } catch (error) {
    await deps.mcpManager.closeAll();
    await closeServer(server);
    throw error;
  }

  logger.event('listening', {
    host: config.host,
    port: config.port,
    home: config.home,
    skills: config.globalSkillsDir,
    log: logger.level,
  });
  if (!config.approvalsEnabled) {
    logger.event('warning', {
      message: '审批已关闭：危险 shell、越界文件操作、trash 与 MCP 首次连接/调用将不再等待确认',
    });
  }
  if (!isLoopback(config.host)) {
    logger.event('warning', {
      message: '绑定非回环地址且无鉴权：任何能访问该端口的客户端都可以读写本机文件',
    });
  }

  shutdown = createShutdownHandler({
    logger,
    manager: deps.mcpManager,
    server,
    control,
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
