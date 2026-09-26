import { readFile, stat } from 'node:fs/promises';
import * as z from 'zod/v4';
import { ToolError } from '../errors.js';
import { writeFileAtomic } from '../paths.js';
import { defineTool, describePath, withGoalReason } from '../registry.js';
import { resolvePath } from '../session.js';

export const editSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  path: z.string().min(1).describe('相对路径基于 session.base 解析；绝对路径直接使用；允许 ..'),
  oldText: z.string().min(1).describe('要被替换的原文（必须是文件中唯一出现的字面量片段）'),
  newText: z.string().describe('替换后的内容；传空串表示删除这段内容'),
});

export const EDIT_DESCRIPTION = `精确替换文件中的一段文本（字面量匹配，不是正则）。

用途：改代码的主力工具。oldText 必须在文件中恰好出现一次：0 次或多次都直接报错且不改文件。
风险：edit 会真实修改磁盘文件且不可撤销。删除代码、大段覆盖实现、修改关键配置或公共接口前，
必须先用自然语言向用户说明要改什么、影响范围，得到用户明确确认后再调用；
涉及 git 提交 / 撤销等操作请走 bash 并向用户确认。

参数：
- sessionId：必填
- path：相对路径基于 session.base 解析；绝对路径直接使用；允许 ..
- oldText：唯一匹配的原文片段（要包含足够上下文来保证唯一）
- newText：替换内容；空串 = 删除
- goal / reason：必填，写入 session history

行为：读取 → 校验唯一匹配 → 原子写回；返回 path / replaced（固定 1）/ bytes。
本工具不受 session.base 限制。

示例：
{ "sessionId": "ses_ab12cd34ef56", "path": "src/config.ts", "oldText": "timeout: 30,", "newText": "timeout: 60,", "goal": "把超时调大一倍", "reason": "接口在高延迟网络下会超时" }`;

export const editTool = defineTool({
  name: 'edit',
  title: 'Edit（精确替换）',
  description: EDIT_DESCRIPTION,
  schema: editSchema,
  annotations: { destructiveHint: true, openWorldHint: false },
  requiresSession: true,
  describeCall: (args, session) => describePath(session, args.path),
  handler: async (args, _ctx, session) => {
    if (!session) throw new ToolError('edit 需要有效 sessionId');

    const absolute = resolvePath(session.base, args.path);

    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new ToolError(`file does not exist: ${absolute}`);
    }
    if (!info.isFile()) throw new ToolError(`not a regular file: ${absolute}`);

    const current = await readFile(absolute, 'utf8');
    const occurrences = current.split(args.oldText).length - 1;

    if (occurrences === 0) throw new ToolError(`oldText not found in ${absolute}`);
    if (occurrences > 1) {
      throw new ToolError(`oldText matches ${occurrences} times in ${absolute}; include more context to make it unique`);
    }

    const next = current.replace(args.oldText, args.newText);
    await writeFileAtomic(absolute, next);

    return { path: absolute, replaced: 1, bytes: Buffer.byteLength(next, 'utf8') };
  },
});
