import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { ApprovalCodec } from './approval.js';
import type { TokenStore } from './downloads.js';
import type { Logger } from './log.js';
import type { McpConnection } from './mcp-client.js';
import type { McpManager } from './mcp-manager.js';
import type { McpTrustStore } from './mcp-trust.js';
import { registerTools, type ToolDef } from './registry.js';
import { createGatewayInstructions, type SessionStore } from './session.js';
import type { SkillIndex } from './skills.js';
import type { TrashBackend } from './trash.js';
import { createMcpTool } from './tools/mcp-tool.js';
import { createSessionTool } from './tools/session.js';
import { createSkillsTool } from './tools/skills.js';
import { createShellTool } from './tools/shell.js';
import { createFetchTool } from './tools/fetch.js';
import { createEditTool } from './tools/edit.js';
import { readTool } from './tools/read.js';
import { createWriteTool } from './tools/write.js';
import { createTrashTool } from './tools/trash.js';

const SERVER_INFO = { name: 'mcpx-lite', version: '0.1.0' };

export interface Deps {
  sessions: SessionStore;
  skills: SkillIndex;
  downloads: TokenStore;
  logger: Logger;
  /** 进程级一次性 approval token 存储；所有按请求创建的 server 实例共享 */
  approvals: ApprovalCodec;
  mcpManager: McpManager<McpConnection>;
  mcpTrust: McpTrustStore;
  mcpGlobalPath: string;
  trashBackend: TrashBackend;
  config: { host: string; port: number; approvalsEnabled: boolean };
}

/** 9 个工具的装配点（工具模块只依赖自己需要的协作者）。 */
export function createTools(deps: Deps): ToolDef[] {
  return [
    createSessionTool(deps),
    createSkillsTool(deps),
    createMcpTool({
      manager: deps.mcpManager,
      trust: deps.mcpTrust,
      approvals: deps.approvals,
      globalPath: deps.mcpGlobalPath,
    }),
    readTool,
    createWriteTool(deps.approvals),
    createTrashTool(deps.approvals, deps.trashBackend),
    createEditTool(deps.approvals),
    createShellTool(deps.approvals),
    createFetchTool({
      tokens: deps.downloads,
      logger: deps.logger,
      config: deps.config,
      approvals: deps.approvals,
    }),
  ];
}

export function buildServer(deps: Deps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: createGatewayInstructions(deps.config.approvalsEnabled),
  });
  registerTools(server, { tools: createTools(deps), sessions: deps.sessions, logger: deps.logger });
  return server;
}

/** Streamable HTTP 入口：每个请求构建一个实例，服务端不持有连接状态。 */
export function buildHandler(deps: Deps) {
  return createMcpHandler(() => buildServer(deps));
}
