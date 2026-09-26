import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createApprovalCodec } from './approval.js';
import { DEFAULT_TTL_MS, TokenStore, createFilesRoute } from './downloads.js';
import { createLogger, resolveLogLevel, type Logger, type LogLevel } from './log.js';
import { buildHandler, type Deps } from './server.js';
import { SessionStore } from './session.js';
import { SkillIndex, SKILLS_SUBDIR } from './skills.js';

export interface Config {
  host: string;
  port: number;
  home: string;
  globalSkillsDir: string;
  downloadTtlMs: number;
  logLevel: LogLevel;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_HOME = join(homedir(), '.mini-pi-mcp');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env['MINI_PI_MCP_PORT'] ?? '', 10);

  return {
    host: env['MINI_PI_MCP_HOST']?.trim() || DEFAULT_HOST,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    home: env['MINI_PI_MCP_HOME']?.trim() || DEFAULT_HOME,
    globalSkillsDir: env['MINI_PI_MCP_GLOBAL_SKILLS']?.trim() || join(homedir(), SKILLS_SUBDIR),
    downloadTtlMs: DEFAULT_TTL_MS,
    logLevel: resolveLogLevel(env['MINI_PI_MCP_LOG']),
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
 * - GET  /files/:token → export 工具签发的一次性文件链接
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
        deps.logger.event('files-route-error', { error: error instanceof Error ? error.message : String(error) });
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
      approvals: createApprovalCodec(),
      config: { host: config.host, port: config.port },
    },
  };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const { deps, logger } = createDeps(config);
  const server = createHttpServer(deps);

  await new Promise<void>((ready) => server.listen(config.port, config.host, ready));

  logger.event('listening', {
    host: config.host,
    port: config.port,
    home: config.home,
    skills: config.globalSkillsDir,
    log: logger.level,
  });
  if (!isLoopback(config.host)) {
    logger.event('warning', {
      message: '绑定非回环地址且无鉴权：任何能访问该端口的客户端都可以读写本机文件',
    });
  }

  const shutdown = (signal: string) => {
    logger.event('shutdown', { signal });
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
