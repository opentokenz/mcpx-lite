import { describe, expect, it } from 'vitest';
import type { ResolvedMcpServer } from '../src/mcp-config.js';
import {
  createMcpConnection,
  type McpClientAdapter,
  type McpClientFactory,
} from '../src/mcp-client.js';

function stdio(): ResolvedMcpServer {
  return {
    name: 'local',
    source: 'global',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    env: { TOKEN: 'secret' },
    display: { command: 'node', args: ['server.mjs'], env: ['TOKEN'] },
    hash: 'stdio-hash',
  };
}

function http(): ResolvedMcpServer {
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

function fakeFactory(log: {
  clientInfo?: unknown;
  clientOptions?: unknown;
  stdio?: unknown;
  http?: unknown;
  connected?: unknown;
  closed?: boolean;
}): McpClientFactory {
  const client: McpClientAdapter = {
    connect: async (transport) => {
      log.connected = transport;
    },
    close: async () => {
      log.closed = true;
    },
    getServerCapabilities: () => ({ tools: {} }),
    getServerVersion: () => ({ name: 'fixture', version: '1.0.0' }),
    getNegotiatedProtocolVersion: () => '2026-07-28',
    getInstructions: () => 'fixture instructions',
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    listPrompts: async () => ({ prompts: [] }),
    callTool: async () => ({ content: [] }),
    readResource: async () => ({ contents: [] }),
    getPrompt: async () => ({ messages: [] }),
  };

  return {
    getDefaultEnvironment: () => ({ PATH: '/safe/bin', HOME: '/safe/home' }),
    createClient: (info, options) => {
      log.clientInfo = info;
      log.clientOptions = options;
      return client;
    },
    createStdioTransport: (options) => {
      log.stdio = options;
      return { kind: 'stdio' };
    },
    createHttpTransport: (url, options) => {
      log.http = { url: String(url), options };
      return { kind: 'http' };
    },
  };
}

describe('MCP client connector', () => {
  it('stdio 映射 command/args/env，并启用 auto negotiation + manual MRTR', async () => {
    const log: Record<string, unknown> = {};
    const connection = await createMcpConnection(stdio(), fakeFactory(log));

    expect(log.clientInfo).toEqual({ name: 'mcpx-lite-gateway', version: '0.1.0' });
    expect(log.clientOptions).toMatchObject({
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: false },
    });
    expect(log.stdio).toEqual({
      command: 'node',
      args: ['server.mjs'],
      env: { PATH: '/safe/bin', HOME: '/safe/home', TOKEN: 'secret' },
      stderr: 'pipe',
    });
    expect(log.connected).toEqual({ kind: 'stdio' });

    await connection.close();
    expect(log.closed).toBe(true);
  });

  it('HTTP 把 headers 放进 requestInit，不改变 URL', async () => {
    const log: Record<string, unknown> = {};
    await createMcpConnection(http(), fakeFactory(log));

    expect(log.http).toEqual({
      url: 'https://example.test/mcp',
      options: {
        requestInit: {
          headers: { Authorization: 'Bearer secret' },
        },
      },
    });
    expect(log.connected).toEqual({ kind: 'http' });
  });

  it('connection 暴露 inspect 所需 server metadata', async () => {
    const connection = await createMcpConnection(stdio(), fakeFactory({}));

    expect(connection.info()).toEqual({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'fixture', version: '1.0.0' },
      instructions: 'fixture instructions',
      capabilities: { tools: {} },
    });
  });
});
