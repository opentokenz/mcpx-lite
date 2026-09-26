import type { ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { TokenStore } from '../downloads.js';
import { ToolError } from '../errors.js';
import type { Logger } from '../log.js';
import { defineTool, describePath, withGoalReason } from '../registry.js';
import { resolvePath } from '../session.js';

export const downloadSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  path: z.string().min(1).describe('相对路径基于 session.base 解析；绝对路径直接使用；允许 ..'),
});

export const DOWNLOAD_DESCRIPTION = `把本机文件交给调用方下载（原始字节，不经过模型上下文）。

用途：需要拿到真实文件本身时——构建产物（zip / tar / apk）、PDF、图片、Excel / Word、音频、
二进制数据、体量太大不适合读进上下文的日志或数据文件。
要"看内容"请用 read（文本）；read 拒绝的二进制文件应该用 download。

参数：
- sessionId：必填
- path：相对路径基于 session.base 解析；绝对路径直接使用；允许 ..
- goal / reason：必填，写入 session history

返回：一个 resource_link（支持 MCP resource link 的客户端可直接识别）+ 一段 JSON
（name / mimeType / size / path / url / expiresAt）。
url 形如 \${origin}/files/<token>：只对应这一个文件、不接受任何 path 参数、**5 分钟后失效**，
需要在过期前取走；重新调用 download 会签发新链接。本工具不受 session.base 限制。

示例：
{ "sessionId": "ses_ab12cd34ef56", "path": "dist/report.pdf", "goal": "把报告交给用户", "reason": "构建产物需要下载到远端" }`;

export function createDownloadTool(deps: {
  tokens: TokenStore;
  logger: Logger;
  config: { host: string; port: number };
}) {
  const { tokens, logger, config } = deps;

  return defineTool({
    name: 'download',
    title: 'Download（导出文件）',
    description: DOWNLOAD_DESCRIPTION,
    schema: downloadSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    requiresSession: true,
    describeCall: (args, session) => describePath(session, args.path),
    handler: async (args, ctx: ServerContext, session) => {
      if (!session) throw new ToolError('download 需要有效 sessionId');

      const absolute = resolvePath(session.base, args.path);
      const record = await tokens.mint({ sessionId: session.id, path: absolute });
      const url = `${requestOrigin(ctx) ?? `http://${config.host}:${config.port}`}/files/${record.token}`;

      logger.event('download-mint', {
        session: session.id,
        token: record.token,
        file: record.path,
        size: record.size,
        mime: record.mimeType,
        url,
      });

      return {
        content: [
          {
            type: 'resource_link',
            uri: url,
            name: record.name,
            mimeType: record.mimeType,
            size: record.size,
          },
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: record.name,
                mimeType: record.mimeType,
                size: record.size,
                path: record.path,
                url,
                expiresAt: record.expiresAt,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });
}

/** download 链接的 origin 直接取本次 MCP 请求的 origin，不需要额外配置。 */
function requestOrigin(ctx: ServerContext): string | undefined {
  const url = ctx.http?.req?.url;
  if (!url) return undefined;

  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
