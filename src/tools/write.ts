import { stat } from 'node:fs/promises';
import * as z from 'zod/v4';
import { ToolError } from '../errors.js';
import { writeFileAtomic } from '../paths.js';
import { defineTool, describePath, withGoalReason } from '../registry.js';
import { resolvePath } from '../session.js';

export const writeSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  path: z.string().min(1).describe('相对路径基于 session.base 解析；绝对路径直接使用；允许 ..'),
  content: z.string().describe('要写入的完整文件内容（覆盖写，不是追加）'),
});

export const WRITE_DESCRIPTION = `创建或覆盖文件（整文件写入，不是追加）。

用途：新增文件，或整体重写一个文件。小范围改动请优先用 edit（只改唯一匹配的片段）。
风险：覆盖已有文件会丢弃原内容且不可撤销。覆盖前先用自然语言向用户说明将改哪个文件、影响范围，
用户确认后再调用；不要用它来"试探性"写文件。

参数：
- sessionId：必填
- path：相对路径基于 session.base 解析；绝对路径直接使用；允许 ..
- content：完整文件内容（UTF-8）
- goal / reason：必填，写入 session history

行为：自动创建缺失的父目录；写入使用「临时文件 + rename」原子替换；返回 path / bytes / created。
本工具不受 session.base 限制，可以写 base 之外的路径。

示例：
{ "sessionId": "ses_ab12cd34ef56", "path": "src/utils/format.ts", "content": "export const format = (v: string) => v.trim();\\n", "goal": "补齐格式化工具", "reason": "新模块缺少 format 工具函数" }`;

export const writeTool = defineTool({
  name: 'write',
  title: 'Write（写文件）',
  description: WRITE_DESCRIPTION,
  schema: writeSchema,
  annotations: { destructiveHint: true, openWorldHint: false },
  requiresSession: true,
  describeCall: (args, session) => describePath(session, args.path),
  handler: async (args, _ctx, session) => {
    if (!session) throw new ToolError('write 需要有效 sessionId');

    const absolute = resolvePath(session.base, args.path);
    const existed = await exists(absolute);

    try {
      await writeFileAtomic(absolute, args.content);
    } catch (error) {
      throw new ToolError(`could not write ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { path: absolute, bytes: Buffer.byteLength(args.content, 'utf8'), created: !existed };
  },
});

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
