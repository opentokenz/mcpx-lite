import { stat } from 'node:fs/promises';
import * as z from 'zod/v4';
import {
  APPROVAL_INPUT_FIELDS,
  enforceBaseBoundary,
  hashArgs,
  type ApprovalCodec,
} from '../approval.js';
import { ToolError } from '../errors.js';
import { realpathDeep, writeFileAtomic } from '../paths.js';
import { defineTool, describePath, withGoalReason, type ToolDef } from '../registry.js';
import { isInsideBase, resolvePath } from '../session.js';

export const writeSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  path: z.string().min(1).describe('相对路径基于 session.base 解析；绝对路径直接使用；允许 ..'),
  content: z.string().describe('要写入的完整文件内容（覆盖写，不是追加）'),
  ...APPROVAL_INPUT_FIELDS,
});

export const WRITE_DESCRIPTION = `创建或覆盖文件（整文件写入，不是追加）。

用途：新增文件，或整体重写一个文件。小范围改动请优先用 edit（只改唯一匹配的片段）。
风险：覆盖已有文件会丢弃原内容且不可撤销；不要用它来"试探性"写文件。

参数：
- sessionId：必填
- path：相对路径基于 session.base 解析；绝对路径直接使用；允许 ..
- content：完整文件内容（UTF-8）
- goal / reason：必填，写入 session history

行为：自动创建缺失的父目录；写入使用「临时文件 + rename」原子替换；返回 path / bytes / created。

base 边界门禁（服务端强制执行）：
- base 是文件类工具的信任边界：目标真实路径（解析 symlink 之后，允许尚不存在）在 base 内时直接写入。
- 落在 base 外（../ 穿越、绝对路径、父目录或目标本身是 symlink 逃逸）时，服务端不写文件，
  而是返回普通 approval_required 审核卡片和一次性 approvalToken。
- 调用方必须让用户选择“确认执行 / 取消”；确认后只有携带相同 path / content、
  approvalToken + approvalDecision=approve 的重试才会写入。

示例：
{ "sessionId": "ses_ab12cd34ef56", "path": "src/utils/format.ts", "content": "export const format = (v: string) => v.trim();\\n", "goal": "补齐格式化工具", "reason": "新模块缺少 format 工具函数" }`;

export function createWriteTool(approvals: ApprovalCodec): ToolDef {
  return defineTool({
    name: 'write',
    title: 'Write（写文件）',
    description: WRITE_DESCRIPTION,
    schema: writeSchema,
    annotations: { destructiveHint: true, openWorldHint: false },
    requiresSession: true,
    describeCall: (args, session) => describePath(session, args.path),
    handler: async (args, _ctx, session, observe) => {
      if (!session) throw new ToolError('write 需要有效 sessionId');

      const absolute = resolvePath(session.base, args.path);
      const existed = await exists(absolute);
      const bytes = Buffer.byteLength(args.content, 'utf8');

      // 目标可能尚不存在，用 realpathDeep 求「真实目标」；解析不出来就按 fail closed 处理
      const target = await realpathDeep(absolute);
      if (target === null || !isInsideBase(session.base, target)) {
        const approval = await enforceBaseBoundary({
          codec: approvals,
          sessionId: session.id,
          tool: 'write',
          argsHash: hashArgs([args.path, args.content]),
          ...(args.approvalToken ? { approvalToken: args.approvalToken } : {}),
          ...(args.approvalDecision ? { approvalDecision: args.approvalDecision } : {}),
          action: '写入',
          path: absolute,
          target,
          base: session.base,
          fields: { bytes },
          observer: observe,
        });
        if (approval) return approval;
      }

      try {
        await writeFileAtomic(target ?? absolute, args.content);
      } catch (error) {
        throw new ToolError(`could not write ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
      }

      return { path: absolute, bytes, created: !existed };
    },
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) throw new ToolError(`not a regular file (directory): ${path}`);
    return true;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return false;
  }
}
