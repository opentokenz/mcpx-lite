import {
  Client,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type Implementation,
  type Transport,
} from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/client/stdio';
import type { ResolvedMcpServer } from './mcp-config.js';
import type { ManagedMcpConnection } from './mcp-manager.js';

export interface McpClientAdapter {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  getServerCapabilities(): unknown;
  getServerVersion(): unknown;
  getNegotiatedProtocolVersion(): string | undefined;
  getInstructions(): string | undefined;
  listTools(): Promise<unknown>;
  listResources(): Promise<unknown>;
  listResourceTemplates(): Promise<unknown>;
  listPrompts(): Promise<unknown>;
  callTool(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  readResource(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  getPrompt(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export interface McpClientFactory {
  getDefaultEnvironment(): Record<string, string>;
  createClient(info: Implementation, options: ClientOptions): McpClientAdapter;
  createStdioTransport(options: StdioServerParameters): unknown;
  createHttpTransport(
    url: URL,
    options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
  ): unknown;
}

export interface McpConnectionInfo {
  protocolVersion?: string;
  serverInfo?: unknown;
  instructions?: string;
  capabilities?: unknown;
}

export interface McpConnection extends ManagedMcpConnection {
  client: McpClientAdapter;
  info(): McpConnectionInfo;
}

const DEFAULT_CLIENT_INFO = { name: 'mini-pi-mcp-gateway', version: '0.1.0' };

export async function createMcpConnection(
  server: ResolvedMcpServer,
  factory: McpClientFactory = defaultFactory,
): Promise<McpConnection> {
  const client = factory.createClient(DEFAULT_CLIENT_INFO, {
    capabilities: { elicitation: { form: {} } },
    versionNegotiation: { mode: 'auto' },
    inputRequired: { autoFulfill: false },
  });

  const transport =
    server.transport === 'stdio'
      ? factory.createStdioTransport({
          command: server.command,
          args: server.args,
          env: { ...factory.getDefaultEnvironment(), ...server.env },
          stderr: 'pipe',
        })
      : factory.createHttpTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        });

  await client.connect(transport);

  return {
    client,
    info: () => ({
      protocolVersion: client.getNegotiatedProtocolVersion(),
      serverInfo: client.getServerVersion(),
      instructions: client.getInstructions(),
      capabilities: client.getServerCapabilities(),
    }),
    close: () => client.close(),
  };
}

const defaultFactory: McpClientFactory = {
  getDefaultEnvironment,
  createClient(info, options) {
    const client = new Client(info, options);
    return adaptClient(client);
  },
  createStdioTransport(options) {
    return new StdioClientTransport(options);
  },
  createHttpTransport(url, options) {
    return new StreamableHTTPClientTransport(url, options);
  },
};

function manualInputRequiredCallOptions(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (options?.['allowInputRequired'] !== true) return options;
  const tool = options['toolDefinition'];
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return options;

  const { outputSchema: _outputSchema, ...manualTool } = tool as Record<string, unknown>;
  return { ...options, toolDefinition: manualTool };
}

function adaptClient(client: Client): McpClientAdapter {
  return {
    connect: (transport) => client.connect(transport as Transport),
    close: () => client.close(),
    getServerCapabilities: () => client.getServerCapabilities(),
    getServerVersion: () => client.getServerVersion(),
    getNegotiatedProtocolVersion: () => client.getNegotiatedProtocolVersion(),
    getInstructions: () => client.getInstructions(),
    listTools: () => client.listTools(),
    listResources: () => client.listResources(),
    listResourceTemplates: () => client.listResourceTemplates(),
    listPrompts: () => client.listPrompts(),
    callTool: (params, options) => {
      const callOptions = manualInputRequiredCallOptions(options);
      return client.callTool(
        params as Parameters<Client['callTool']>[0],
        callOptions as Parameters<Client['callTool']>[1],
      );
    },
    readResource: (params, options) =>
      client.readResource(
        params as Parameters<Client['readResource']>[0],
        options as Parameters<Client['readResource']>[1],
      ),
    getPrompt: (params, options) =>
      client.getPrompt(
        params as Parameters<Client['getPrompt']>[0],
        options as Parameters<Client['getPrompt']>[1],
      ),
  };
}
