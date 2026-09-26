import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  APPROVAL_INPUT_FIELDS,
  enforceBaseBoundary,
  hashArgs,
  type ApprovalCodec,
} from '../approval.js';
import { inspectExportable, mimeTypeFor, type TokenStore } from '../downloads.js';
import { ToolError } from '../errors.js';
import type { Logger } from '../log.js';
import { defineTool, describePath, withGoalReason } from '../registry.js';
import { isInsideBase, resolvePath } from '../session.js';

/** base64 内联传输的上限：超过就请用 link 模式，避免把大文件塞进 MCP 响应。 */
const MAX_INLINE_BYTES = 1_048_576;

export const exportSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  path: z.string().min(1).describe('相对路径基于 session.base 解析；绝对路径直接使用；允许 ..'),
  delivery: z
    .enum(['link', 'base64'])
    .default('link')
    .describe('link：签发临时下载链接（默认）；base64：直接把内容内联返回（客户端拿不到链接时用）'),
  ...APPROVAL_INPUT_FIELDS,
});

export const EXPORT_DESCRIPTION = `把真实机器上的指定文件交给 MCP 调用方（原始字节，不经过模型上下文）。

有两种交付方式（delivery）：
- link（默认）：服务端只签发一个临时链接，实际下载由调用方通过该链接完成；
  适合文件较大或调用方能访问该 origin 的场景。
- base64：把文件内容直接内联在返回结果里（embedded resource 的 blob + 一段 JSON 摘要），
  适合调用方拿不到链接（反向代理 / 内网 / 域名不可达）或文件很小的情况；上限 1 MiB（1_048_576 字节），
  超出会报错并提示改用 link。

用途：需要拿到真实文件本身时——构建产物（zip / tar / apk）、PDF、图片、Excel / Word、音频、
二进制数据、体量太大不适合读进上下文的日志或数据文件。
要"看内容"请用 read（文本）；read 拒绝的二进制文件应该用 export。

参数：
- sessionId：必填
- path：相对路径基于 session.base 解析；绝对路径直接使用；允许 ..
- delivery：link（默认）/ base64
- goal / reason：必填，写入 session history

返回（link）：一个 resource_link（支持 MCP resource link 的客户端可直接识别）+ 一段 JSON
（name / mimeType / size / path / url / expiresAt）。
url 形如 \${origin}/files/<token>：只对应这一个文件、不接受任何 path 参数、**5 分钟后失效**，
需要在过期前取走；重新调用 export 会签发新链接。
origin 的取值顺序：Forwarded（RFC 7239）→ X-Forwarded-Proto + X-Forwarded-Host → 请求自身的
绝对 URL（非回环地址）→ 服务配置的 host:port；反向代理部署时转发这些头就能拿到对外域名。

返回（base64）：一个 embedded resource（uri / mimeType / blob=base64）+ 一段 JSON
（name / mimeType / size / path / encoding / sha256），可用 sha256 校验组装结果。

base 边界门禁（服务端强制执行）：base 是写类/外带工具的信任边界；目标真实路径（解析 symlink 之后）
落在 base 外时返回普通 approval_required 审核卡片和一次性 approvalToken，确认前不会读取内容、也不会签发任何链接。
调用方必须让用户选择“确认执行 / 取消”；确认后只有携带相同 path / delivery、
approvalToken + approvalDecision=approve 的重试才会继续导出。

示例：
{ "sessionId": "ses_ab12cd34ef56", "path": "dist/report.pdf", "goal": "把报告交给用户", "reason": "构建产物需要导出给远端" }
{ "sessionId": "ses_ab12cd34ef56", "path": "dist/plan.xlsx", "delivery": "base64", "goal": "内联拿到表格", "reason": "回源链接客户端不可达" }`;

export function createExportTool(deps: {
  tokens: TokenStore;
  logger: Logger;
  config: { host: string; port: number };
  approvals: ApprovalCodec;
}) {
  const { tokens, logger, config, approvals } = deps;

  return defineTool({
    name: 'export',
    title: 'Export（导出文件）',
    description: EXPORT_DESCRIPTION,
    schema: exportSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    requiresSession: true,
    describeCall: (args, session) => {
      const info = describePath(session, args.path);
      return args.delivery === 'base64'
        ? { ...info, fields: { ...(info.fields ?? {}), delivery: 'base64' } }
        : info;
    },
    handler: async (args, ctx: ServerContext, session, observe) => {
      if (!session) throw new ToolError('export 需要有效 sessionId');

      const absolute = resolvePath(session.base, args.path);
      const inline = args.delivery === 'base64';

      // 确认之前先做无副作用的前置检查，不让用户为一个不存在的文件（或超限的内联传输）确认
      const info = await inspectExportable(absolute);
      if (inline && info.size > MAX_INLINE_BYTES) {
        throw new ToolError(
          `file too large for inline base64: ${info.size} bytes (limit ${MAX_INLINE_BYTES}); use delivery=link`,
        );
      }

      const target = await realpath(absolute);
      if (!isInsideBase(session.base, target)) {
        const approval = await enforceBaseBoundary({
          codec: approvals,
          sessionId: session.id,
          tool: 'export',
          argsHash: hashArgs([args.path, args.delivery]),
          ...(args.approvalToken ? { approvalToken: args.approvalToken } : {}),
          ...(args.approvalDecision ? { approvalDecision: args.approvalDecision } : {}),
          action: '导出',
          path: absolute,
          target,
          base: session.base,
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
      const requestOrigin = resolveRequestOrigin(ctx.http?.req);
      if (!requestOrigin && isWildcardHost(config.host)) {
        logger.event('export-origin-warning', {
          host: config.host,
          message:
            '无法从请求推断对外地址，且监听地址是通配地址：请转发 Forwarded / X-Forwarded-Host，或把 MINI_PI_MCP_HOST 设为客户端可达地址',
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
export function resolveRequestOrigin(req: { url?: string; headers?: Headers } | undefined): string | undefined {
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
