import * as z from 'zod/v4';
import { ToolError } from '../errors.js';
import type { Logger } from '../log.js';
import { defineTool, withGoalReason, type ToolDef } from '../registry.js';
import type { SessionStore } from '../session.js';
import type { SkillIndex, SkillMeta } from '../skills.js';

const SKILLS_ACTIONS = ['list', 'get', 'reload'] as const;

export const skillsSchema = withGoalReason({
  action: z.enum(SKILLS_ACTIONS).describe('list 列出元数据 / get 读取正文 / reload 重新扫描'),
  sessionId: z.string().min(1).describe('session create 返回的会话 id；决定扫描项目 skill 的 base 目录'),
  name: z.string().min(1).optional().describe('get 必填：skill 名字（list 返回的 name）'),
});

export const SKILLS_DESCRIPTION = `本机 skill（Agent 指令集）：list / get / reload。

skill 来自两个目录：<base>/.agents/skills/<name>/SKILL.md 与 ~/.agents/skills/<name>/SKILL.md；
project 目录的同名 skill 覆盖 global。创建 Session 时只读取元数据，正文永远不自动加载。

用途：
- list：只返回 name / description / source，用于判断有哪些能力可用（不返回正文）
- get：只有确实需要某个 skill 的指引时，才按需读取它的 SKILL.md 正文
- reload：重新扫描磁盘并返回最新元数据（例如刚落盘了一个新 skill）

参数：
- sessionId：必填
- action：必填
- name：get 必填
- goal / reason：必填，写入 session history

示例：
{ "action": "list", "sessionId": "ses_ab12cd34ef56", "goal": "挑选合适的 skill", "reason": "开始新任务前先看可用能力" }
{ "action": "get", "sessionId": "ses_ab12cd34ef56", "name": "typescript", "goal": "按项目规范改代码", "reason": "需要 typescript skill 的具体指引" }`;

export function createSkillsTool(deps: {
  sessions: SessionStore;
  skills: SkillIndex;
  logger: Logger;
}): ToolDef {
  const { skills, logger } = deps;

  return defineTool({
    name: 'skills',
    title: 'Skills（本机技能索引）',
    description: SKILLS_DESCRIPTION,
    schema: skillsSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    requiresSession: true,
    describeCall: (args) => ({ target: args.name ? `${args.action} ${args.name}` : args.action }),
    handler: async (args, _ctx, session) => {
      if (!session) throw new ToolError('skills 需要有效 sessionId');

      switch (args.action) {
        case 'list':
          return { skills: metadata(await skills.scan(session.base)) };

        case 'reload': {
          const found = await skills.scan(session.base);
          logger.event('skills-reload', { session: session.id, skills: found.length });
          return { skills: metadata(found) };
        }

        case 'get': {
          if (!args.name) throw new ToolError('skills get 需要 name');

          const found = await skills.get(session.base, args.name);
          if (!found) throw new ToolError(`unknown skill: ${args.name}`);

          logger.event('skills-get', { session: session.id, skill: found.meta.name, source: found.meta.source, path: found.meta.path });

          return {
            name: found.meta.name,
            source: found.meta.source,
            path: found.meta.path,
            truncated: found.truncated,
            content: found.content,
          };
        }

        default:
          throw new ToolError(`unsupported action: ${String(args.action)}`);
      }
    },
  });
}

function metadata(skills: SkillMeta[]): { name: string; description: string; source: string }[] {
  return skills.map(({ name, description, source }) => ({ name, description, source }));
}
