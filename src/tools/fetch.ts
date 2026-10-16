import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  APPROVAL_INPUT_FIELDS,
  enforceWorkspaceBoundary,
  hashArgs,
  type ApprovalCodec,
} from '../approval.js';
import { inspectFetchable, mimeTypeFor, type TokenStore } from '../downloads.js';
import { ToolError } from '../errors.js';
import type { Logger } from '../log.js';
import { defineTool, describePath, withGoalReason } from '../registry.js';
import { isPathWithin, resolvePath } from '../session.js';

/** base64 内联传输的上限：超过就请用 link 模式，避免把大文件塞进 MCP 响应。 */
const MAX_INLINE_BYTES = 1_048_576;

export const fetchSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  path: z.string().min(1).describe('相对路径基于 session.workspace 解析；绝对路径直接使用；允许 ..'),
  delivery: z
    .enum(['link', 'base64'])
    .default('link')
    .describe('link：签发临时下载链接（默认）；base64：直接把内容内联返回（客户端拿不到链接时用）'),
  ...APPROVAL_INPUT_FIELDS,
});

export const FETCH_DESCRIPTION = `把真实机器上的指定文件交给 MCP 调用方（原始字节，不经过模型上下文）。

有两种交付方式（delivery）：
- link（默认）：服务端只签发一个临时链接，实际下载由调用方通过该链接完成；
  适合文件较大或调用方能访问该 origin 的场景。
- base64：把文件内容直接内联在返回结果里（embedded resource 的 blob + 一段 JSON 摘要），
  适合调用方拿不到链接（反向代理 / 内网 / 域名不可达）或文件很小的情况；上限 1 MiB（1_048_576 字节），
  超出会报错并提示改用 link。

用途：需要拿到真实文件本身时——构建产物（zip / tar / apk）、PDF、图片、Excel / Word、音频、
二进制数据、体量太大不适合读进上下文的日志或数据文件。
要"看内容"请用 read（文本）；read 拒绝的二进制文件应该用 fetch。

参数：
- sessionId：必填
- path：相对路径基于 session.workspace 解析；绝对路径直接使用；允许 ..
- delivery：link（默认）/ base64
- goal / reason：可选审计字段；提供时写入 session history

返回：
- link：resource_link + 文件摘要，临时链接 5 分钟后失效。
- base64：embedded resource + 文件摘要，内联上限 1 MiB。

workspace 边界门禁（服务端强制执行）：
- workspace 内真实目标直接获取。
- workspace 外真实目标先返回 approval_required；确认前不读取内容、不签发链接。
- 用户确认后用原 path / delivery 携带 approvalToken + approvalDecision=approve 重试。

示例：
{ "sessionId": "ses_ab12cd34ef56", "path": "dist/report.pdf" }
{ "sessionId": "ses_ab12cd34ef56", "path": "dist/plan.xlsx", "delivery": "base64" }`;

export function createFetchTool(deps: {
  tokens: TokenStore;
  logger: Logger;
  config: { host: string; port: number };
  approvals: ApprovalCodec;
}) {
  const { tokens, logger, config, approvals } = deps;

  return defineTool({
    name: 'fetch',
    title: 'Fetch（获取文件）',
    description: FETCH_DESCRIPTION,
    schema: fetchSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    requiresSession: true,
    describeCall: (args, session) => {
      const info = describePath(session, args.path);
      return args.delivery === 'base64'
        ? { ...info, fields: { ...(info.fields ?? {}), delivery: 'base64' } }
        : info;
    },
    handler: async (args, ctx: ServerContext, session, observe) => {
      if (!session) throw new ToolError('fetch 需要有效 sessionId');

      const absolute = resolvePath(session.workspace, args.path);
      const inline = args.delivery === 'base64';

      // 确认之前先做无副作用的前置检查，不让用户为一个不存在的文件（或超限的内联传输）确认
      const info = await inspectFetchable(absolute);
      if (inline && info.size > MAX_INLINE_BYTES) {
        throw new ToolError(
          `file too large for inline base64: ${info.size} bytes (limit ${MAX_INLINE_BYTES}); use delivery=link`,
        );
      }

      const target = await realpath(absolute);
      if (!isPathWithin(session.workspace, target)) {
        const approval = await enforceWorkspaceBoundary({
          codec: approvals,
          sessionId: session.id,
          tool: 'fetch',
          argsHash: hashArgs([args.path, args.delivery]),
          ...(args.approvalToken ? { approvalToken: args.approvalToken } : {}),
          ...(args.approvalDecision ? { approvalDecision: args.approvalDecision } : {}),
          action: '获取',
          path: absolute,
          target,
          workspace: session.workspace,
          observer: observe,
        });
        if (approval) return approval;
      }

      if (inline) {
        const bytes = await readFile(target);

        return {
          content: [
            {
              type: 'resource',
              resource: { uri: `file://${target}`, mimeType: mimeTypeFor(target), blob: bytes.toString('base64') },
            },
            {
              type: 'text',
              text: JSON.stringify(
                {
                  name: basename(target),
                  mimeType: mimeTypeFor(target),
                  size: bytes.byteLength,
                  path: target,
                  encoding: 'base64',
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // 用已确认的真实目标签发 token：确认后即使 symlink 被改写也不会换掉被授权的文件
      const record = await tokens.mint({ sessionId: session.id, path: target });
      const requestOrigin = resolveFetchOrigin(ctx.http?.req);
      if (!requestOrigin && isWildcardHost(config.host)) {
        logger.event('fetch-origin-warning', {
          host: config.host,
          message:
            '无法从请求推断对外地址，且监听地址是通配地址：请转发 Forwarded / X-Forwarded-Host，或把 MCPX_LITE_HOST 设为客户端可达地址',
        });
      }
      const url = `${requestOrigin ?? `http://${config.host}:${config.port}`}/files/${record.token}`;

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

/**
 * 下载链接的 origin：优先反向代理传递的对外地址，其次请求自身的绝对 URL，最后调用方回退到配置的
 * host:port。
 *
 * 顺序（都取第一个值，多级代理时靠最外层）：
 * 1. RFC 7239 `Forwarded: proto=https;host=pi.example.com`
 * 2. 事实标准 `X-Forwarded-Proto` + `X-Forwarded-Host`
 * 3. 请求的绝对 URL（仅在 hostname 不是回环地址时可用）
 *
 * 注意：这些值来自请求头，即调用方自己提供的；单用户本地 runtime 下可以接受（客户端只会误导自己），
 * 但不应当把生成的 URL 当作可信来源转给第三方。
 */
export function resolveFetchOrigin(req: { url?: string; headers?: Headers } | undefined): string | undefined {
  if (!req) return undefined;

  const forwarded = req.headers?.get('forwarded');
  if (forwarded) {
    const first = forwarded.split(',')[0] ?? '';
    const params = new Map<string, string>();
    for (const segment of first.split(';')) {
      const [key, ...rest] = segment.trim().split('=');
      if (!key) continue;
      params.set(key.toLowerCase(), rest.join('=').trim().replace(/^"|"$/g, ''));
    }

    const proto = params.get('proto');
    const host = params.get('host');
    if (proto && host) {
      const origin = normalizeOrigin(proto, host);
      if (origin) return origin;
    }
  }

  const proto = req.headers?.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = req.headers?.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (proto && host) {
    const origin = normalizeOrigin(proto, host);
    if (origin) return origin;
  }

  if (req.url) {
    try {
      const url = new URL(req.url);
      return isLoopbackHostname(url.hostname) ? undefined : url.origin;
    } catch {
      // 相对 URL：无法从中推断对外地址
      return undefined;
    }
  }

  return undefined;
}

/**
 * 把代理头里的 proto / host 归一成 origin：只接受 http / https，并且丢掉路径与非法值
 * （proxied host 是外部输入，不能直接拼进返回给调用方的 URL）。
 */
function normalizeOrigin(proto: string, host: string): string | undefined {
  try {
    const url = new URL(`${proto}://${host}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!url.hostname) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** 回环 / 不可作为对外地址的 hostname（0.0.0.0 也不是可访问地址）。 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.startsWith('127.');
}

/** 监听在通配地址上：回退出来的 http://0.0.0.0:port 客户端不可达，需要记录一条告警。 */
function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}
