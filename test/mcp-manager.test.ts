import { describe, expect, it } from 'vitest';
import { McpManager, type ManagedMcpConnection } from '../src/mcp-manager.js';
import type { ResolvedMcpServer } from '../src/mcp-config.js';

function stdio(name: string, hash: string, command = name): ResolvedMcpServer {
  return {
    name,
    source: 'global',
    transport: 'stdio',
    command,
    args: [],
    env: {},
    display: { command, args: [], env: [] },
    hash,
  };
}

describe('McpManager', () => {
  it('lazy connect 且同一 scope/config 的并发 get 只建立一个连接', async () => {
    let connects = 0;
    const connection: ManagedMcpConnection = { close: async () => undefined };
    const manager = new McpManager({
      connect: async () => {
        connects += 1;
        await Promise.resolve();
        return connection;
      },
    });

    expect(connects).toBe(0);
    const server = stdio('github', 'hash-a');
    const [a, b] = await Promise.all([
      manager.get('ses-a', server),
      manager.get('ses-a', server),
    ]);

    expect(connects).toBe(1);
    expect(a).toBe(connection);
    expect(b).toBe(connection);
  });

  it('同名 server 的不同 config hash 使用不同连接', async () => {
    let connects = 0;
    const manager = new McpManager({
      connect: async () => {
        connects += 1;
        return { close: async () => undefined };
      },
    });

    const a = await manager.get('ses-a', stdio('github', 'hash-a', 'github-a'));
    const b = await manager.get('ses-b', stdio('github', 'hash-b', 'github-b'));

    expect(connects).toBe(2);
    expect(a).not.toBe(b);
  });

  it('reload 关闭当前 scope 已失效且无人引用的连接，但不影响其它 scope', async () => {
    const closed: string[] = [];
    const manager = new McpManager({
      connect: async (server) => ({
        close: async () => {
          closed.push(server.hash);
        },
      }),
    });

    const shared = stdio('shared', 'hash-shared');
    const oldProject = stdio('project', 'hash-old');
    await manager.get('ses-a', shared);
    await manager.get('ses-a', oldProject);
    await manager.get('ses-b', shared);

    await manager.reload('ses-a', [shared]);

    expect(closed).toEqual(['hash-old']);
    expect(manager.status(shared).state).toBe('connected');
  });

  it('reload 后 config hash 改变会关闭旧连接并延迟创建新连接', async () => {
    let connects = 0;
    const closed: string[] = [];
    const manager = new McpManager({
      connect: async (server) => {
        connects += 1;
        return {
          close: async () => {
            closed.push(server.hash);
          },
        };
      },
    });

    const oldServer = stdio('github', 'hash-old', 'old');
    const newServer = stdio('github', 'hash-new', 'new');
    await manager.get('ses-a', oldServer);

    await manager.reload('ses-a', [newServer]);

    expect(closed).toEqual(['hash-old']);
    expect(connects).toBe(1);
    expect(manager.status(newServer).state).toBe('disconnected');

    await manager.get('ses-a', newServer);
    expect(connects).toBe(2);
  });

  it('连接失败只标记该 config failed，closeAll 会关闭其余连接', async () => {
    const closed: string[] = [];
    const manager = new McpManager({
      connect: async (server) => {
        if (server.name === 'broken') throw new Error('boom secret-token');
        return {
          close: async () => {
            closed.push(server.name);
          },
        };
      },
      sanitizeError: (error) => String(error).replace('secret-token', '[redacted]'),
    });

    await manager.get('ses-a', stdio('ok', 'ok-hash'));
    await expect(manager.get('ses-a', stdio('broken', 'bad-hash'))).rejects.toThrow(/boom/);

    expect(manager.status(stdio('broken', 'bad-hash'))).toEqual({
      state: 'failed',
      error: 'Error: boom [redacted]',
    });

    await manager.closeAll();
    expect(closed).toEqual(['ok']);
  });
});
