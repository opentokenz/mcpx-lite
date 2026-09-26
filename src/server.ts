import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { TokenStore } from './downloads.js';
import type { Logger } from './log.js';
import { registerTools, type ToolDef } from './registry.js';
import { GATEWAY_INSTRUCTIONS, type SessionStore } from './session.js';
import type { SkillIndex } from './skills.js';
import { createSessionTool } from './tools/session.js';
import { createSkillsTool } from './tools/skills.js';
import { bashTool } from './tools/bash.js';
import { createDownloadTool } from './tools/download.js';
import { editTool } from './tools/edit.js';
import { readTool } from './tools/read.js';
import { writeTool } from './tools/write.js';

const SERVER_INFO = { name: 'mini-pi-mcp', version: '0.1.0' };

export interface Deps {
  sessions: SessionStore;
  skills: SkillIndex;
  downloads: TokenStore;
  logger: Logger;
  config: { host: string; port: number };
}

/** 7 个工具的装配点（工具模块只依赖自己需要的协作者）。 */
export function createTools(deps: Deps): ToolDef[] {
  return [
    createSessionTool(deps),
    createSkillsTool(deps),
    readTool,
    writeTool,
    editTool,
    bashTool,
    createDownloadTool({ tokens: deps.downloads, logger: deps.logger, config: deps.config }),
  ];
}

export function buildServer(deps: Deps): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: GATEWAY_INSTRUCTIONS });
  registerTools(server, { tools: createTools(deps), sessions: deps.sessions, logger: deps.logger });
  return server;
}

/** Streamable HTTP 入口：每个请求构建一个实例，服务端不持有连接状态。 */
export function buildHandler(deps: Deps) {
  return createMcpHandler(() => buildServer(deps));
}
