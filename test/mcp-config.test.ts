import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadMcpConfig,
  resolveMcpServerConfig,
  type EffectiveMcpServer,
} from '../src/mcp-config.js';

describe('MCP config loader', () => {
  let root: string;
  let globalPath: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mini-pi-mcp-config-'));
    globalPath = join(root, 'home', '.agents', 'mcp.json');
    workspace = join(root, 'project');
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value), 'utf8');
  }

  it('配置文件都不存在时返回空 effective server map', async () => {
    const config = await loadMcpConfig({ workspace, globalPath });

    expect(config.servers).toEqual({});
    expect(config.projectPath).toBe(join(workspace, '.mcp.json'));
  });

  it('project 同名 server 整项覆盖 global，保留各自 source', async () => {
    await writeJson(globalPath, {
      mcpServers: {
        github: { command: 'global-github', args: ['--global'] },
        docs: { url: 'https://docs.example.test/mcp' },
      },
    });
    await writeJson(join(workspace, '.mcp.json'), {
      mcpServers: {
        github: { command: 'project-github', args: ['--project'] },
      },
    });

    const config = await loadMcpConfig({ workspace, globalPath });

    expect(config.servers.github).toMatchObject({
      name: 'github',
      source: 'project',
      transport: 'stdio',
      config: { command: 'project-github', args: ['--project'] },
    });
    expect(config.servers.docs).toMatchObject({
      name: 'docs',
      source: 'global',
      transport: 'http',
      config: { url: 'https://docs.example.test/mcp' },
    });
  });

  it('拒绝同时声明 command 与 url 的 server', async () => {
    await writeJson(globalPath, {
      mcpServers: {
        broken: { command: 'x', url: 'https://example.test/mcp' },
      },
    });

    await expect(loadMcpConfig({ workspace, globalPath })).rejects.toThrow(/broken.*command.*url/i);
  });

  it('只展开 ${NAME} 环境变量，并在缺失变量时给出变量名', async () => {
    await writeJson(globalPath, {
      mcpServers: {
        remote: {
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
        },
      },
    });

    const config = await loadMcpConfig({ workspace, globalPath });
    const remote = config.servers.remote as EffectiveMcpServer;

    expect(resolveMcpServerConfig(remote, { MCP_TOKEN: 'secret-value' })).toMatchObject({
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret-value' },
    });
    expect(() => resolveMcpServerConfig(remote, {})).toThrow(/MCP_TOKEN/);
  });

  it('display metadata 保留环境变量占位符且不泄漏解析后的 secret', async () => {
    await writeJson(globalPath, {
      mcpServers: {
        local: {
          command: 'runner',
          args: ['--token', '${MCP_TOKEN}'],
        },
        remote: {
          url: 'https://example.test/mcp?token=${MCP_TOKEN}',
        },
      },
    });

    const config = await loadMcpConfig({ workspace, globalPath });
    const local = resolveMcpServerConfig(config.servers.local as EffectiveMcpServer, {
      MCP_TOKEN: 'secret-value',
    });
    const remote = resolveMcpServerConfig(config.servers.remote as EffectiveMcpServer, {
      MCP_TOKEN: 'secret-value',
    });

    expect(JSON.stringify(local.display)).toContain('${MCP_TOKEN}');
    expect(JSON.stringify(remote.display)).toContain('${MCP_TOKEN}');
    expect(JSON.stringify(local.display)).not.toContain('secret-value');
    expect(JSON.stringify(remote.display)).not.toContain('secret-value');
  });

  it('display metadata 与 hash 不泄漏 secret，hash 对真实配置变化敏感', async () => {
    await writeJson(globalPath, {
      mcpServers: {
        remote: {
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
        },
      },
    });

    const config = await loadMcpConfig({ workspace, globalPath });
    const remote = config.servers.remote as EffectiveMcpServer;
    const a = resolveMcpServerConfig(remote, { MCP_TOKEN: 'secret-a' });
    const b = resolveMcpServerConfig(remote, { MCP_TOKEN: 'secret-b' });

    expect(a.display).toEqual({
      url: 'https://example.test/mcp',
      headers: ['Authorization'],
    });
    expect(JSON.stringify(a.display)).not.toContain('secret-a');
    expect(a.hash).not.toContain('secret-a');
    expect(a.hash).not.toBe(b.hash);
  });
});
