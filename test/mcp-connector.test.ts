import { describe, expect, it } from 'vitest';
import {
  connectMcpServer,
  type McpClientLike,
  type McpTransportLike,
} from '../src/mcp-connector.js';
import type { ResolvedMcpServer } from '../src/mcp-config.js';

function stdioServer(): ResolvedMcpServer {
  return {
    name: 'local',
    source: 'global',
    transport: 'stdio',
    command: 'demo-mcp',
    args: ['--serve'],
    env: { TOKEN: 'secret' },
    display: { command: 'demo-mcp', args: ['--serve'], env: ['TOKEN'] },
    hash: 'stdio-hash',
  };
}

function httpServer(): ResolvedMcpServer {
  return {
    name: 'remote',
    source: 'global',
    transport: 'http',
    url: 'https://example.test/mcp',
    headers: { Authorization: 'Bearer secret' },
    display: { url: 'https://example.test/mcp', headers: ['Authorization'] },
    hash: 'http-hash',
  };
}

describe('MCP downstream connector', () => {
  it('stdio 使用安全默认环境 + 配置覆盖，并启用 auto version negotiation / manual MRTR', async () => {
    const calls: unknown[] = [];
    const transport: McpTransportLike = {};
    const client = fakeClient(calls);

    const connection = await connectMcpServer(stdioServer(), {
      defaultEnvironment: () => ({ PATH: '/safe/bin', HOME: '/safe/home' }),
      createStdioTransport: (options) => {
        calls.push(['stdio', options]);
        return transport;
      },
      createHttpTransport: () => {
        throw new Error('unexpected http');
      },
      createClient: (info, options) => {
        calls.push(['client', info, options]);
        return client;
      },
    });

    expect(calls[0]).toEqual([
      'stdio',
      {
        command: 'demo-mcp',
        args: ['--serve'],
        env: { PATH: '/safe/bin', HOME: '/safe/home', TOKEN: 'secret' },
      },
    ]);
    expect(calls[1]).toEqual([
      'client',
      { name: 'mini-pi-mcp', version: '0.1.0' },
      {
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: false },
      },
    ]);
    expect(calls[2]).toEqual(['connect', transport]);

    expect(connection.metadata()).toEqual({
      protocolVersion: '2026-07-28',
      protocolEra: 'modern',
      serverInfo: { name: 'fixture', version: '1.0.0' },
      capabilities: { tools: {} },
      instructions: 'fixture instructions',
    });
  });

  it('HTTP 通过 requestInit headers 创建 Streamable HTTP transport', async () => {
    const calls: unknown[] = [];
    const transport: McpTransportLike = {};
    const client = fakeClient(calls);

    await connectMcpServer(httpServer(), {
      defaultEnvironment: () => ({}),
      createStdioTransport: () => {
        throw new Error('unexpected stdio');
      },
      createHttpTransport: (url, options) => {
        calls.push(['http', url.toString(), options]);
        return transport;
      },
      createClient: () => client,
    });

    expect(calls[0]).toEqual([
      'http',
      'https://example.test/mcp',
      { requestInit: { headers: { Authorization: 'Bearer secret' } } },
    ]);
    expect(calls[1]).toEqual(['connect', transport]);
  });

  it('primitive wrappers 保留下游返回结构，close 交给 Client', async () => {
    const calls: unknown[] = [];
    const connection = await connectMcpServer(stdioServer(), {
      defaultEnvironment: () => ({}),
      createStdioTransport: () => ({}),
      createHttpTransport: () => ({}),
      createClient: () => fakeClient(calls),
    });

    await expect(connection.listTools()).resolves.toEqual({ tools: [{ name: 'echo' }] });
    await expect(connection.listResources()).resolves.toEqual({ resources: [{ uri: 'demo://one' }] });
    await expect(connection.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
    await expect(connection.listPrompts()).resolves.toEqual({ prompts: [{ name: 'review' }] });
    await expect(connection.callTool({ name: 'echo', arguments: { value: 1 } })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 1 },
    });
    await expect(connection.readResource({ uri: 'demo://one' })).resolves.toEqual({
      contents: [{ uri: 'demo://one', text: 'body' }],
    });
    await expect(connection.getPrompt({ name: 'review', arguments: { kind: 'short' } })).resolves.toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: 'review' } }],
    });

    await connection.close();

    expect(calls).toContainEqual(['close']);
  });
});

function fakeClient(calls: unknown[]): McpClientLike {
  return {
    connect: async (transport) => {
      calls.push(['connect', transport]);
    },
    close: async () => {
      calls.push(['close']);
    },
    getNegotiatedProtocolVersion: () => '2026-07-28',
    getProtocolEra: () => 'modern',
    getServerVersion: () => ({ name: 'fixture', version: '1.0.0' }),
    getServerCapabilities: () => ({ tools: {} }),
    getInstructions: () => 'fixture instructions',
    listTools: async () => ({ tools: [{ name: 'echo' }] }),
    listResources: async () => ({ resources: [{ uri: 'demo://one' }] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    listPrompts: async () => ({ prompts: [{ name: 'review' }] }),
    callTool: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 1 },
    }),
    readResource: async () => ({ contents: [{ uri: 'demo://one', text: 'body' }] }),
    getPrompt: async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'review' } }],
    }),
  };
}
