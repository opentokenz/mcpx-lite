import { lstat } from 'node:fs/promises';
import * as z from 'zod/v4';
import { APPROVAL_INPUT_FIELDS, enforceApproval, hashArgs, type ApprovalCodec } from '../approval.js';
import { errorMessage, ToolError } from '../errors.js';
import { defineTool, withGoalReason, type ToolDef } from '../registry.js';
import { isPathWithin, resolvePath } from '../session.js';
import type { TrashBackend } from '../trash.js';

export const trashSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  paths: z.array(z.string().min(1)).min(1).max(100).describe('要移动到系统回收站的文件/目录路径'),
  ...APPROVAL_INPUT_FIELDS,
});

export const TRASH_DESCRIPTION = `将文件或目录移动到系统回收站。

用途：可恢复地移除文件/目录，替代常见 rm 场景。所有调用都必须经过用户确认。
参数：
- sessionId：必填
- paths：1-100 个路径；相对路径基于 session.workspace 解析
- goal / reason：可选审计字段；提供时写入 session history

示例：
{ "sessionId": "ses_ab12cd34ef56", "paths": ["tmp", "old.txt"] }`;

export function createTrashTool(approvals: ApprovalCodec, backend: TrashBackend): ToolDef {
  return defineTool({
    name: 'trash',
    title: 'Trash（移入回收站）',
    description: TRASH_DESCRIPTION,
    schema: trashSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    requiresSession: true,
    describeCall: (args, session) => ({
      target: `${args.paths.length} paths`,
      files: session ? args.paths.map((path) => resolvePath(session.workspace, path)) : args.paths,
      fields: { paths: args.paths },
    }),
    handler: async (args, _ctx, session, observe) => {
      if (!session) throw new ToolError('trash 需要有效 sessionId');

      const paths = args.paths.map((path) => resolvePath(session.workspace, path));
      if (new Set(paths).size !== paths.length) {
        throw new ToolError('trash preflight failed: duplicate path');
      }
      for (let i = 0; i < paths.length; i += 1) {
        for (let j = i + 1; j < paths.length; j += 1) {
          const a = paths[i]!;
          const b = paths[j]!;
          if (isPathWithin(a, b) || isPathWithin(b, a)) {
            throw new ToolError(`trash preflight failed: overlapping paths: ${a} <> ${b}`);
          }
        }
      }
      for (const path of paths) {
        try {
          await lstat(path);
        } catch {
          throw new ToolError(`path does not exist: ${path}`);
        }
      }

      const approval = await enforceApproval({
        codec: approvals,
        sessionId: session.id,
        tool: 'trash',
        argsHash: hashArgs(paths),
        ...(args.approvalToken ? { approvalToken: args.approvalToken } : {}),
        ...(args.approvalDecision ? { approvalDecision: args.approvalDecision } : {}),
        observer: observe,
        prompt: {
          risk: 'dangerous',
          riskLabel: 'trash.move · 将文件或目录移动到系统回收站',
          summary: `移动 ${paths.length} 个项目到系统回收站`,
          message: ['这些路径将被移动到系统回收站：', '', ...paths.map((path) => `- ${path}`)].join('\n'),
          fields: { paths },
        },
      });
      if (approval) return approval;

      const results: { path: string; ok: boolean; error?: string }[] = [];
      for (const path of paths) {
        try {
          await backend.trash(path);
          results.push({ path, ok: true });
        } catch (error) {
          results.push({ path, ok: false, error: errorMessage(error) });
        }
      }
      const succeeded = results.filter((result) => result.ok).length;
      return { results, succeeded, failed: results.length - succeeded };
    },
  });
}
