import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorMessage, ToolError } from './errors.js';

export type McpConfigSource = 'global' | 'project';
export type McpTransport = 'stdio' | 'http';

export interface StdioMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface EffectiveMcpServer {
  name: string;
  source: McpConfigSource;
  transport: McpTransport;
  config: McpServerConfig;
}

export interface EffectiveMcpConfig {
  globalPath: string;
  projectPath: string;
  servers: Record<string, EffectiveMcpServer>;
}

export type ResolvedMcpServer =
  | {
      name: string;
      source: McpConfigSource;
      transport: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
      display: { command: string; args: string[]; env: string[] };
      hash: string;
    }
  | {
      name: string;
      source: McpConfigSource;
      transport: 'http';
      url: string;
      headers: Record<string, string>;
      display: { url: string; headers: string[] };
      hash: string;
    };

export async function loadMcpConfig(opts: {
  workspace: string;
  globalPath?: string;
}): Promise<EffectiveMcpConfig> {
  const globalPath = opts.globalPath ?? join(homedir(), '.agents', 'mcp.json');
  const projectPath = join(opts.workspace, '.mcp.json');

  const globalServers = await readConfigFile(globalPath, 'global');
  const projectServers = await readConfigFile(projectPath, 'project');

  return {
    globalPath,
    projectPath,
    servers: { ...globalServers, ...projectServers },
  };
}

export function resolveMcpServerConfig(
  server: EffectiveMcpServer,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMcpServer {
  if (server.transport === 'stdio') {
    const config = server.config as StdioMcpServerConfig;
    const command = expand(config.command, env);
    const args = (config.args ?? []).map((value) => expand(value, env));
    const resolvedEnv = expandRecord(config.env ?? {}, env);
    const hash = hashResolved({ command, args, env: resolvedEnv });

    return {
      name: server.name,
      source: server.source,
      transport: 'stdio',
      command,
      args,
      env: resolvedEnv,
      display: {
        command: config.command,
        args: config.args ?? [],
        env: Object.keys(resolvedEnv).sort(),
      },
      hash,
    };
  }

  const config = server.config as HttpMcpServerConfig;
  const url = expand(config.url, env);
  const headers = expandRecord(config.headers ?? {}, env);
  const hash = hashResolved({ url, headers });

  return {
    name: server.name,
    source: server.source,
    transport: 'http',
    url,
    headers,
    display: { url: config.url, headers: Object.keys(headers).sort() },
    hash,
  };
}

async function readConfigFile(
  path: string,
  source: McpConfigSource,
): Promise<Record<string, EffectiveMcpServer>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return {};
    throw new ToolError(`could not read MCP config ${path}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ToolError(`invalid MCP config JSON ${path}: ${errorMessage(error)}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) {
    throw new ToolError(`invalid MCP config ${path}: mcpServers must be an object`);
  }

  const result: Record<string, EffectiveMcpServer> = {};
  for (const [name, value] of Object.entries(parsed['mcpServers'])) {
    result[name] = normalizeServer(name, value, source, path);
  }
  return result;
}

function normalizeServer(
  name: string,
  value: unknown,
  source: McpConfigSource,
  path: string,
): EffectiveMcpServer {
  if (!name.trim()) throw new ToolError(`invalid MCP config ${path}: server name must not be empty`);
  if (!isRecord(value)) throw new ToolError(`invalid MCP server ${name}: config must be an object`);

  const hasCommand = typeof value['command'] === 'string' && value['command'].trim().length > 0;
  const hasUrl = typeof value['url'] === 'string' && value['url'].trim().length > 0;

  if (hasCommand && hasUrl) {
    throw new ToolError(`invalid MCP server ${name}: command and url are mutually exclusive`);
  }
  if (!hasCommand && !hasUrl) {
    throw new ToolError(`invalid MCP server ${name}: exactly one of command or url is required`);
  }

  if (hasCommand) {
    const args = optionalStringArray(value['args'], `${name}.args`);
    const env = optionalStringRecord(value['env'], `${name}.env`);

    return {
      name,
      source,
      transport: 'stdio',
      config: {
        command: value['command'] as string,
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
      },
    };
  }

  const url = value['url'] as string;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ToolError(`invalid MCP server ${name}: url must be a valid http/https URL`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ToolError(`invalid MCP server ${name}: url must use http or https`);
  }

  const headers = optionalStringRecord(value['headers'], `${name}.headers`);
  return {
    name,
    source,
    transport: 'http',
    config: {
      url,
      ...(headers ? { headers } : {}),
    },
  };
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ToolError(`invalid MCP config: ${field} must be a string array`);
  }
  return value;
}

function optionalStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === 'string')) {
    throw new ToolError(`invalid MCP config: ${field} must be a string map`);
  }
  return value as Record<string, string>;
}

function expandRecord(record: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value, env)]));
}

function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) throw new ToolError(`missing environment variable: ${name}`);
    return replacement;
  });
}

function hashResolved(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}
