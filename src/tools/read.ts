import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import * as z from 'zod/v4';
import { ToolError } from '../errors.js';
import { defineTool, describePath, withGoalReason } from '../registry.js';
import { resolvePath } from '../session.js';

const MAX_CHARS = 100_000;
const SNIFF_BYTES = 8192;

export const readSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  path: z.string().min(1).describe('相对路径基于 session.workspace 解析；绝对路径直接使用；允许 ..'),
  offset: z.number().int().min(0).default(0).describe('起始行号（0 基），默认 0'),
  limit: z.number().int().min(1).max(2000).default(200).describe('最多返回行数，默认 200'),
});

export const READ_DESCRIPTION = `读取文本文件内容（按行分页）。

用途：在改代码前了解现状——确认实现、配置、日志、测试文件的内容。
二进制文件（PDF / 图片 / ZIP 等）不能用本工具读取，请用 fetch。

参数：
- sessionId：必填
- path：相对路径基于 session.workspace 解析；绝对路径直接使用；允许 .. 离开 workspace
- offset：起始行号（0 基），默认 0
- limit：最多返回行数，默认 200（配合 offset 翻页；返回里带 hasMore / totalLines）
- goal / reason：可选审计字段；提供时写入 session history

行为：只读工具，不受 workspace 边界限制：workspace 外也能直接读，不需要用户确认。
最多返回 100_000 字符，超出时截断并置 truncated=true。

示例：
{ "sessionId": "ses_ab12cd34ef56", "path": "src/index.ts", "limit": 100 }
{ "sessionId": "ses_ab12cd34ef56", "path": "/tmp/build.log", "offset": 400, "limit": 200 }`;

export const readTool = defineTool({
  name: 'read',
  title: 'Read（读文本文件）',
  description: READ_DESCRIPTION,
  schema: readSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  requiresSession: true,
  describeCall: (args, session) => describePath(session, args.path),
  handler: async (args, _ctx, session) => {
    if (!session) throw new ToolError('read 需要有效 sessionId');

    const absolute = resolvePath(session.workspace, args.path);

    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new ToolError(`file does not exist: ${absolute}`);
    }
    if (!info.isFile()) throw new ToolError(`not a regular file: ${absolute}`);

    const workspace = {
      path: absolute,
      offset: args.offset,
      limit: args.limit,
      returnedLines: 0,
      totalLines: 0,
      hasMore: false,
      truncated: false,
      content: '',
    };

    if (info.size === 0) return workspace;

    await assertTextFile(absolute, info.size);

    const lines: string[] = [];
    let totalLines = 0;
    let chars = 0;
    let truncated = false;

    const input = createReadStream(absolute, { encoding: 'utf8' });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        totalLines += 1;
        if (totalLines - 1 < args.offset) continue;
        if (truncated || lines.length >= args.limit) continue;

        const separator = lines.length > 0 ? 1 : 0;
        const remaining = MAX_CHARS - chars - separator;
        if (line.length > remaining) {
          if (remaining > 0) {
            lines.push(line.slice(0, remaining));
            chars += separator + remaining;
          }
          truncated = true;
          continue;
        }

        lines.push(line);
        chars += separator + line.length;
      }
    } finally {
      reader.close();
      input.destroy();
    }

    return {
      ...workspace,
      returnedLines: lines.length,
      totalLines,
      hasMore: args.offset + lines.length < totalLines,
      truncated,
      content: lines.join('\n'),
    };
  },
});

async function assertTextFile(path: string, size: number): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.includes(0)) throw new ToolError(`binary file (use fetch instead): ${path}`);
  } finally {
    await handle.close();
  }
}
