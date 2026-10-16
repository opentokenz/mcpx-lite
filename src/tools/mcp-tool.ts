import * as z from 'zod/v4';
import {
  APPROVAL_INPUT_FIELDS,
  enforceApproval,
  hashArgs,
  isApprovalRequiredResult,
  type ApprovalCodec,
  type ApprovalRequiredResult,
} from '../approval.js';
import { errorMessage, ToolError } from '../errors.js';
import {
  loadMcpConfig,
  resolveMcpServerConfig,
  type EffectiveMcpServer,
  type ResolvedMcpServer,
} from '../mcp-config.js';
import type { McpConnection } from '../mcp-client.js';
import type { McpManager } from '../mcp-manager.js';
import type { McpTrustStore } from '../mcp-trust.js';
import { defineTool, withGoalReason, type ToolDef } from '../registry.js';

const MCP_ACTIONS = [
  'list',
  'inspect',
  'call',
  'read_resource',
  'get_prompt',
  'status',
  'reload',
] as const;

export const mcpToolSchema = withGoalReason({
  action: z.enum(MCP_ACTIONS),
  sessionId: z.string().min(1),
  server: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  uri: z.string().min(1).optional(),
  ...APPROVAL_INPUT_FIELDS,
});

export const MCP_TOOL_DESCRIPTION = [
  '下游 MCP 网关：list / inspect / call / read_resource / get_prompt / status / reload。',
  '',
  '配置来源：',
  '- 全局：~/.agents/mcp.json',
  '- 项目：<session.workspace>/.mcp.json',
  '- project 同名 server 整项覆盖 global',
  '',
  '用途：',
  '- list：只读取 effective MCP 配置摘要，不连接下游',
  '- inspect：连接指定 server 并返回 server metadata 与 tools/resources/prompts catalog',
  '- call：调用下游 tool',
  '- read_resource：读取下游 resource',
  '- get_prompt：读取下游 prompt',
  '- status：查看当前连接状态，不主动连接',
  '- reload：重新读取 global + project 配置并关闭当前 session 不再使用的 stale connection',
  '',
  '首版支持 stdio（command/args/env）与 Streamable HTTP（url/headers）。',
  'env/header secret 不会出现在 list/status/history/log 中。',
  'call：首次调用某个 server 时返回 approval_required；批准后同 session + server + resolved config 免审批。',
  'read_resource / get_prompt：连接建立后直接执行。',
  'project 配置首次连接仍按门禁审批；若首次操作就是 call，同一张审批卡同时绑定首次 tool + arguments。',
  'goal / reason：可选审计字段；提供时写入 session history。',
  '',
  '示例：',
  '{ "action": "list", "sessionId": "ses_ab12cd34ef56" }',
  '{ "action": "inspect", "sessionId": "ses_ab12cd34ef56", "server": "github" }',
  '{ "action": "call", "sessionId": "ses_ab12cd34ef56", "server": "github", "name": "search", "arguments": { "q": "mcp" } }',
].join('\n');

export function createMcpTool(deps: {
  manager: McpManager<McpConnection>;
  trust: McpTrustStore;
  approvals: ApprovalCodec;
  globalPath: string;
}): ToolDef {
  const { manager, trust, approvals, globalPath } = deps;

  return defineTool({
    name: 'mcp_tool',
    title: 'MCP Tool（下游 MCP 网关）',
    description: MCP_TOOL_DESCRIPTION,
    schema: mcpToolSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    requiresSession: true,
    describeCall: (args) => ({
      target: args.server
        ? 'mcp:' + args.server + ' ' + args.action + (args.name ? ' ' + args.name : '')
        : 'mcp:' + args.action,
      fields: {
        action: args.action,
        ...(args.server ? { server: args.server } : {}),
        ...(args.name ? { name: args.name } : {}),
      },
    }),
    handler: async (args, ctx, session, observe) => {
      if (!session) throw new ToolError('mcp_tool 需要有效 sessionId');

      const config = await loadMcpConfig({ workspace: session.workspace, globalPath });

      switch (args.action) {
        case 'list':
          return { servers: listServers(config.servers) };

        case 'status':
          return {
            servers: Object.values(config.servers)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((server) => {
                try {
                  const resolved = resolveMcpServerConfig(server);
                  return {
                    ...displayServer(server),
                    ...manager.status(resolved),
                  };
                } catch (error) {
                  return {
                    ...displayServer(server),
                    state: 'failed',
                    error: errorMessage(error),
                  };
                }
              }),
          };

        case 'reload': {
          const resolved = Object.values(config.servers).map((server) =>
            resolveMcpServerConfig(server),
          );
          await manager.reload(session.id, resolved);
          return { servers: listServers(config.servers) };
        }

        case 'inspect': {
          const prepared = await getApprovedConnection({
            server: requireServer(config.servers, args.server),
            sessionId: session.id,
            manager,
            trust,
            approvals,
            approvalToken: args.approvalToken,
            approvalDecision: args.approvalDecision,
            observe,
          });
          if (isApprovalRequiredResult(prepared)) return prepared;
          const { server, connection } = prepared;
          const info = connection.info();
          const [toolsResult, resourcesResult, templatesResult, promptsResult] = await Promise.all([
            hasCapability(info.capabilities, 'tools')
              ? connection.client.listTools()
              : Promise.resolve({ tools: [] }),
            hasCapability(info.capabilities, 'resources')
              ? connection.client.listResources()
              : Promise.resolve({ resources: [] }),
            hasCapability(info.capabilities, 'resources')
              ? connection.client.listResourceTemplates()
              : Promise.resolve({ resourceTemplates: [] }),
            hasCapability(info.capabilities, 'prompts')
              ? connection.client.listPrompts()
              : Promise.resolve({ prompts: [] }),
          ]);

          return {
            server: displayServer(server),
            ...info,
            tools: arrayField(toolsResult, 'tools'),
            resources: arrayField(resourcesResult, 'resources'),
            resourceTemplates: arrayField(templatesResult, 'resourceTemplates'),
            prompts: arrayField(promptsResult, 'prompts'),
          };
        }

        case 'call': {
          const server = requireServer(config.servers, args.server);
          if (!args.name) throw new ToolError('mcp_tool call 需要 name');
          const prepared = await getApprovedConnection({
            server,
            sessionId: session.id,
            manager,
            trust,
            approvals,
            approvalToken: args.approvalToken,
            approvalDecision: args.approvalDecision,
            observe,
            firstCall: {
              name: args.name,
              ...(args.arguments ? { arguments: args.arguments } : {}),
            },
          });
          if (isApprovalRequiredResult(prepared)) return prepared;
          const { resolved, connection } = prepared;

          const tools = arrayField(await connection.client.listTools(), 'tools');
          const tool = tools.find(
            (value) =>
              value !== null &&
              typeof value === 'object' &&
              (value as Record<string, unknown>)['name'] === args.name,
          ) as Record<string, unknown> | undefined;
          if (!tool) throw new ToolError('unknown downstream MCP tool: ' + args.name);

          if (!trust.isCallsTrusted(session.id, server.name, resolved.hash)) {
            const toolApproval = await enforceApproval({
              codec: approvals,
              sessionId: session.id,
              tool: 'mcp_tool',
              argsHash: hashArgs([
                'call',
                resolved.hash,
                args.name,
                args.arguments ?? {},
              ]),
              ...(args.approvalToken ? { approvalToken: args.approvalToken } : {}),
              ...(args.approvalDecision ? { approvalDecision: args.approvalDecision } : {}),
              observer: observe,
              prompt: {
                risk:
                  ((tool['annotations'] as Record<string, unknown> | undefined)?.[
                    'destructiveHint'
                  ] === true)
                    ? 'dangerous'
                    : 'unknown',
                riskLabel: 'mcp.tool · 首次调用该 server 的工具',
                summary: server.name + ':' + args.name,
                message: [
                  '首次调用这个 MCP server 的工具。',
                  '确认后，当前 session 对该 server 的后续 mcp_tool 调用将不再逐次审批。',
                  '',
                  'server：' + server.name,
                  'tool：' + args.name,
                  ...(typeof tool['description'] === 'string'
                    ? ['description：' + tool['description']]
                    : []),
                  'argument keys：' + Object.keys(args.arguments ?? {}).sort().join(', '),
                ].join('\n'),
                fields: {
                  server: server.name,
                  tool: args.name,
                  argumentKeys: Object.keys(args.arguments ?? {}).sort(),
                },
              },
            });
            if (toolApproval) return toolApproval;
            trust.trustCalls(session.id, server.name, resolved.hash);
          }

          const requestState = ctx.mcpReq.requestState<string>();
          const inputResponses = ctx.mcpReq.inputResponses;
          return connection.client.callTool(
            {
              name: args.name,
              arguments: args.arguments ?? {},
              ...(inputResponses ? { inputResponses } : {}),
              ...(requestState !== undefined ? { requestState } : {}),
            },
            { allowInputRequired: true, toolDefinition: tool },
          );
        }

        case 'read_resource': {
          const prepared = await getApprovedConnection({
            server: requireServer(config.servers, args.server),
            sessionId: session.id,
            manager,
            trust,
            approvals,
            approvalToken: args.approvalToken,
            approvalDecision: args.approvalDecision,
            observe,
            beforeConnect: () => {
              if (!args.uri) throw new ToolError('mcp_tool read_resource 需要 uri');
            },
          });
          if (isApprovalRequiredResult(prepared)) return prepared;
          const { connection } = prepared;
          const requestState = ctx.mcpReq.requestState<string>();
          const inputResponses = ctx.mcpReq.inputResponses;
          return connection.client.readResource(
            {
              uri: args.uri!,
              ...(inputResponses ? { inputResponses } : {}),
              ...(requestState !== undefined ? { requestState } : {}),
            },
            { allowInputRequired: true },
          );
        }

        case 'get_prompt': {
          const prepared = await getApprovedConnection({
            server: requireServer(config.servers, args.server),
            sessionId: session.id,
            manager,
            trust,
            approvals,
            approvalToken: args.approvalToken,
            approvalDecision: args.approvalDecision,
            observe,
            beforeConnect: () => {
              if (!args.name) throw new ToolError('mcp_tool get_prompt 需要 name');
            },
          });
          if (isApprovalRequiredResult(prepared)) return prepared;
          const { connection } = prepared;
          const requestState = ctx.mcpReq.requestState<string>();
          const inputResponses = ctx.mcpReq.inputResponses;
          return connection.client.getPrompt(
            {
              name: args.name!,
              ...(args.arguments ? { arguments: args.arguments } : {}),
              ...(inputResponses ? { inputResponses } : {}),
              ...(requestState !== undefined ? { requestState } : {}),
            },
            { allowInputRequired: true },
          );
        }

        default:
          throw new ToolError('unsupported action: ' + String(args.action));
      }
    },
  });
}


async function getApprovedConnection(opts: {
  server: EffectiveMcpServer;
  sessionId: string;
  manager: McpManager<McpConnection>;
  trust: McpTrustStore;
  approvals: ApprovalCodec;
  approvalToken?: string;
  approvalDecision?: 'approve' | 'cancel';
  observe?: Parameters<typeof enforceApproval>[0]['observer'];
  firstCall?: { name: string; arguments?: Record<string, unknown> };
  beforeConnect?: () => void;
}): Promise<ApprovalRequiredResult | { server: EffectiveMcpServer; resolved: ResolvedMcpServer; connection: McpConnection }> {
  const { server, sessionId, manager, trust, approvals, approvalToken, approvalDecision, observe, firstCall } = opts;
  const resolved = resolveMcpServerConfig(server);
  const projectConnectionUntrusted = server.source === 'project' && !trust.isTrusted(sessionId, resolved.hash);
  const approval = await ensureProjectConnectionApproved({
    server,
    resolved,
    sessionId,
    trust,
    approvals,
    ...(approvalToken ? { approvalToken } : {}),
    ...(approvalDecision ? { approvalDecision } : {}),
    ...(observe ? { observe } : {}),
    ...(projectConnectionUntrusted && firstCall ? { firstCall } : {}),
  });
  if (approval) return approval;

  if (projectConnectionUntrusted && firstCall) trust.trustCalls(sessionId, server.name, resolved.hash);
  opts.beforeConnect?.();

  return { server, resolved, connection: await manager.get(sessionId, resolved) };
}

function requireServer(
  servers: Record<string, EffectiveMcpServer>,
  name: string | undefined,
): EffectiveMcpServer {
  if (!name) throw new ToolError('mcp_tool action 需要 server');
  const server = servers[name];
  if (!server) throw new ToolError('unknown MCP server: ' + name);
  return server;
}

async function ensureProjectConnectionApproved(opts: {
  server: EffectiveMcpServer;
  resolved: ResolvedMcpServer;
  sessionId: string;
  trust: McpTrustStore;
  approvals: ApprovalCodec;
  approvalToken?: string;
  approvalDecision?: 'approve' | 'cancel';
  observe?: Parameters<typeof enforceApproval>[0]['observer'];
  firstCall?: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}) {
  const {
    server,
    resolved,
    sessionId,
    trust,
    approvals,
    approvalToken,
    approvalDecision,
    observe,
    firstCall,
  } = opts;

  if (server.source !== 'project' || trust.isTrusted(sessionId, resolved.hash)) return null;

  const approvalArgs = firstCall
    ? ['connect-call', server.name, resolved.hash, firstCall.name, firstCall.arguments ?? {}]
    : ['connect', server.name, resolved.hash];
  const argumentKeys = Object.keys(firstCall?.arguments ?? {}).sort();
  const riskLabel = firstCall
    ? 'mcp.tool · 项目配置首次连接并调用下游工具'
    : resolved.transport === 'stdio'
      ? 'mcp.connect · 项目配置将启动本机 MCP 进程'
      : 'mcp.connect · 项目配置将连接外部 MCP 服务';
  const summary = firstCall
    ? server.name + ':' + firstCall.name
    : server.name + ' (' + resolved.transport + ')';
  const message = firstCall
    ? [
        '项目级 .mcp.json 首次连接，并准备调用下游 MCP 工具。',
        '确认后会产生真实副作用：stdio 会启动本机进程；HTTP 会连接网络服务；随后执行本次工具调用。',
        '',
        'server：' + server.name,
        'transport：' + resolved.transport,
        'config：' + JSON.stringify(resolved.display),
        'tool：' + firstCall.name,
        'argument keys：' + argumentKeys.join(', '),
      ].join('\n')
    : [
        '项目级 .mcp.json 请求首次连接下游 MCP。',
        '确认后会产生真实副作用：stdio 会启动本机进程；HTTP 会连接网络服务。',
        '',
        'server：' + server.name,
        'transport：' + resolved.transport,
        'config：' + JSON.stringify(resolved.display),
      ].join('\n');

  const approval = await enforceApproval({
    codec: approvals,
    sessionId,
    tool: 'mcp_tool',
    argsHash: hashArgs(approvalArgs),
    ...(approvalToken ? { approvalToken } : {}),
    ...(approvalDecision ? { approvalDecision } : {}),
    ...(observe ? { observer: observe } : {}),
    prompt: {
      risk: resolved.transport === 'stdio' ? 'dangerous' : 'unknown',
      riskLabel,
      summary,
      message,
      fields: {
        server: server.name,
        source: server.source,
        transport: resolved.transport,
        ...(firstCall
          ? {
              tool: firstCall.name,
              argumentKeys,
            }
          : {}),
      },
    },
  });

  if (approval) return approval;
  trust.trust(sessionId, resolved.hash);
  return null;
}

function hasCapability(value: unknown, key: string): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, key),
  );
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

function listServers(
  servers: Record<string, EffectiveMcpServer>,
): ReturnType<typeof displayServer>[] {
  return Object.values(servers)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(displayServer);
}

function displayServer(server: EffectiveMcpServer) {
  if (server.transport === 'stdio') {
    const config = server.config as {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
    return {
      name: server.name,
      source: server.source,
      transport: server.transport,
      config: {
        command: config.command,
        args: config.args ?? [],
        env: Object.keys(config.env ?? {}).sort(),
      },
    };
  }

  const config = server.config as {
    url: string;
    headers?: Record<string, string>;
  };
  return {
    name: server.name,
    source: server.source,
    transport: server.transport,
    config: {
      url: config.url,
      headers: Object.keys(config.headers ?? {}).sort(),
    },
  };
}
