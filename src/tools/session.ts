import * as z from 'zod/v4';
import { ToolError } from '../errors.js';
import type { Logger } from '../log.js';
import { defineTool, withGoalReason, type ToolDef } from '../registry.js';
import { createGatewayInstructions, resolveWorkspace, type SessionStore } from '../session.js';
import { skillMetadata, type SkillIndex } from '../skills.js';

const SESSION_ACTIONS = ['create', 'resume', 'get', 'list', 'close'] as const;

export const sessionSchema = withGoalReason({
  action: z.enum(SESSION_ACTIONS).describe('create 新建 / resume 恢复 / get 查看 / list 列出 / close 释放'),
  workspace: z.string().min(1).optional().describe('create 必填：项目锚点目录（必须已存在）'),
  sessionId: z.string().min(1).optional().describe('resume / get / close 必填：形如 ses_xxxxxxxxxxxx'),
});

export const SESSION_DESCRIPTION = `会话管理：create / resume / get / list / close。

Session 是「模型 ↔ 真实机器」之间的工作句柄，只记住三件事：workspace（项目锚点）、skill 索引、调用 history。
除本工具外，其他 8 个工具都必须携带 sessionId；服务端不保存任何隐式「当前会话」。

用途：
- create：绑定一个已存在的项目目录作为 workspace，返回 sessionId、skill metadata 与全局提示词 instructions
- resume：用 sessionId 重新激活会话（服务重启后、或 close 之后），并重新扫描 skill 索引
- get：查看会话记录（workspace、时间、skills 快照、history 审计）
- list：列出本机所有会话（按最近更新倒序）
- close：只停用这个逻辑 Session 句柄；不会删除文件、不会删除 history、不会删除持久化 Session 数据，也不会结束任何进程。之后可用 resume 恢复

参数：
- action：必填
- workspace：create 必填，必须是已存在的目录；相对路径基于服务进程 cwd 解析
- sessionId：resume / get / close 必填
- goal / reason：可选审计字段；提供时写入 session history

路径规则：workspace 是相对路径解析基准与 shell 默认 cwd；对 write / edit / fetch 同时是信任边界，workspace 外先走 approval_required。trash 无论是否位于 workspace 内都先走 approval_required。read 可只读访问 workspace 外路径；shell 是否确认由命令风险判定。

示例：
{ "action": "create", "workspace": "/workspace/project-a" }
{ "action": "resume", "sessionId": "ses_ab12cd34ef56" }
{ "action": "list" }`;

export function createSessionTool(deps: {
  sessions: SessionStore;
  skills: SkillIndex;
  logger: Logger;
  config: { approvalsEnabled: boolean };
  mcpManager: { closeScope(scopeId: string): Promise<void> };
  mcpTrust: { clearSession(sessionId: string): void };
}): ToolDef {
  const { sessions, skills, logger, config, mcpManager, mcpTrust } = deps;

  return defineTool({
    name: 'session',
    title: 'Session（项目会话）',
    description: SESSION_DESCRIPTION,
    schema: sessionSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    describeCall: (args) => ({
      target:
        args.action === 'create'
          ? `create ${args.workspace ?? ''}`
          : args.action === 'list'
            ? 'list'
            : `${args.action} ${args.sessionId ?? ''}`,
      fields: { action: args.action },
    }),
    handler: async (args) => {
      switch (args.action) {
        case 'create': {
          if (args.sessionId) throw new ToolError('session create 不接受 sessionId');
          if (!args.workspace) throw new ToolError('session create 需要 workspace（项目锚点目录）');

          const workspace = await resolveWorkspace(args.workspace);
          const found = await skills.scan(workspace);
          const session = await sessions.create({ workspace, skills: found });

          logger.event('session-create', { session: session.id, workspace: session.workspace, skills: found.length });

          return {
            sessionId: session.id,
            workspace: session.workspace,
            skills: skillMetadata(found),
            instructions: createGatewayInstructions(config.approvalsEnabled),
          };
        }

        case 'resume': {
          const sessionId = requireSessionId(args.sessionId, 'resume');
          const existing = await sessions.read(sessionId);
          const found = await skills.scan(existing.workspace);
          const session = await sessions.resume(sessionId, found);

          logger.event('session-resume', { session: session.id, workspace: session.workspace, skills: found.length });

          return {
            sessionId: session.id,
            workspace: session.workspace,
            skills: skillMetadata(found),
            instructions: createGatewayInstructions(config.approvalsEnabled),
          };
        }

        case 'get': {
          const session = await sessions.read(requireSessionId(args.sessionId, 'get'));
          return session;
        }

        case 'list': {
          const all = await sessions.list();
          return {
            sessions: all.map((session) => ({
              sessionId: session.id,
              workspace: session.workspace,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              closedAt: session.closedAt,
              skillCount: session.skills.length,
              historyCount: session.history.length,
            })),
          };
        }

        case 'close': {
          const session = await sessions.close(requireSessionId(args.sessionId, 'close'));
          try {
            await mcpManager.closeScope(session.id);
          } finally {
            mcpTrust.clearSession(session.id);
          }
          logger.event('session-close', { session: session.id, workspace: session.workspace });
          return { sessionId: session.id, closedAt: session.closedAt };
        }

        default:
          throw new ToolError(`unsupported action: ${String(args.action)}`);
      }
    },
  });
}

function requireSessionId(sessionId: string | undefined, action: string): string {
  if (!sessionId) throw new ToolError(`session ${action} 需要 sessionId`);
  return sessionId;
}
