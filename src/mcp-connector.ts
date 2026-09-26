import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type Implementation,
  type ProtocolEra,
  type ServerCapabilities,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { ResolvedMcpServer } from './mcp-config.js';
import type { ManagedMcpConnection } from './mcp-manager.js';

export type McpTransportLike = object;

export interface McpClientLike {
  connect(transport: McpTransportLike): Promise<void>;
  close(): Promise<void>;
  getNegotiatedProtocolVersion(): string | undefined;
  getProtocolEra(): ProtocolEra | undefined;
  getServerVersion(): Implementation | undefined;
  getServerCapabilities(): ServerCapabilities | undefined;
  getInstructions(): string | undefined;
  listTools(): Promise<unknown>;
  listResources(): Promise<unknown>;
  listResourceTemplates(): Promise<unknown>;
  listPrompts(): Promise<unknown>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  readResource(params: { uri: string }): Promise<unknown>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<unknown>;
}

export interface DownstreamMcpConnection extends ManagedMcpConnection {
  metadata(): {
    protocolVersion: string | undefined;
    protocolEra: ProtocolEra | undefined;
    serverInfo: Implementation | undefined;
    capabilities: ServerCapabilities | undefined;
    instructions: string | undefined;
  };
  listTools(): Promise<unknown>;
  listResources(): Promise<unknown>;
  listResourceTemplates(): Promise<unknown>;
  listPrompts(): Promise<unknown>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  readResource(params: { uri: string }): Promise<unknown>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<unknown>;
}

interface ConnectorDeps {
  defaultEnvironment(): Record<string, string>;
  createStdioTransport(options: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): McpTransportLike;
  createHttpTransport(
    url: URL,
    options: { requestInit: { headers: Record<string, string> } },
  ): McpTransportLike;
  createClient(info: Implementation, options: ClientOptions): McpClientLike;
}

const DEFAULT_DEPS: ConnectorDeps = {
  defaultEnvironment: getDefaultEnvironment,
  createStdioTransport: (options) => new StdioClientTransport(options),
  createHttpTransport: (url, options) => new StreamableHTTPClientTransport(url, options),
  createClient: (info, options) => {
    const client = new Client(info, options);
    return {
      connect: (transport) => client.connect(transport as Transport),
      close: () => client.close(),
      getNegotiatedProtocolVersion: () => client.getNegotiatedProtocolVersion(),
      getProtocolEra: () => client.getProtocolEra(),
      getServerVersion: () => client.getServerVersion(),
      getServerCapabilities: () => client.getServerCapabilities(),
      getInstructions: () => client.getInstructions(),
      listTools: () => client.listTools(),
      listResources: () => client.listResources(),
      listResourceTemplates: () => client.listResourceTemplates(),
      listPrompts: () => client.listPrompts(),
      callTool: (params) => client.callTool(params),
      readResource: (params) => client.readResource(params),
      getPrompt: (params) => client.getPrompt(params),
    };
  },
};

export async function connectMcpServer(
  server: ResolvedMcpServer,
  deps: ConnectorDeps = DEFAULT_DEPS,
): Promise<DownstreamMcpConnection> {
  const transport =
    server.transport === 'stdio'
      ? deps.createStdioTransport({
          command: server.command,
          args: server.args,
          env: { ...deps.defaultEnvironment(), ...server.env },
        })
      : deps.createHttpTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        });

  const client = deps.createClient(
    { name: 'mini-pi-mcp', version: '0.1.0' },
    {
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: false },
    },
  );

  await client.connect(transport);

  return {
    metadata: () => ({
      protocolVersion: client.getNegotiatedProtocolVersion(),
      protocolEra: client.getProtocolEra(),
      serverInfo: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
    }),
    listTools: () => client.listTools(),
    listResources: () => client.listResources(),
    listResourceTemplates: () => client.listResourceTemplates(),
    listPrompts: () => client.listPrompts(),
    callTool: (params) => client.callTool(params),
    readResource: (params) => client.readResource(params),
    getPrompt: (params) => client.getPrompt(params),
    close: () => client.close(),
  };
}
