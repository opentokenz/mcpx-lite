import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { lookup } from 'mime-types';
import { ToolError } from './errors.js';
import type { Logger } from './log.js';

const TOKEN_PATTERN = /^file_[A-Za-z0-9_-]{32}$/;
export const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const FILES_PREFIX = '/files/';

export interface DownloadRecord {
  token: string;
  sessionId: string;
  /** 绝对路径（已在 mint 时解析并确认存在） */
  path: string;
  name: string;
  mimeType: string;
  size: number;
  expiresAt: string;
}

/**
 * download 工具的下载凭据：随机不透明 token → 恰好一个具体文件，带 TTL。
 * 因为没有路径边界可校验（base 不是边界），token 本身就是唯一授权凭据。
 */
export class TokenStore {
  private readonly records = new Map<string, DownloadRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.records.size;
  }

  async mint(opts: { sessionId: string; path: string }): Promise<DownloadRecord> {
    let info;
    try {
      info = await stat(opts.path);
    } catch {
      throw new ToolError(`file does not exist: ${opts.path}`);
    }
    if (!info.isFile()) throw new ToolError(`not a regular file: ${opts.path}`);

    this.sweep();

    const record: DownloadRecord = {
      token: `file_${randomBytes(24).toString('base64url')}`,
      sessionId: opts.sessionId,
      path: opts.path,
      name: basename(opts.path),
      mimeType: lookup(opts.path) || 'application/octet-stream',
      size: info.size,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    };

    this.records.set(record.token, record);
    return record;
  }

  verify(token: string): DownloadRecord | undefined {
    if (!TOKEN_PATTERN.test(token)) return undefined;

    const record = this.records.get(token);
    if (!record) return undefined;

    if (Date.parse(record.expiresAt) <= this.now()) {
      this.records.delete(token);
      return undefined;
    }

    return record;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, record] of this.records) {
      if (Date.parse(record.expiresAt) <= now) this.records.delete(token);
    }
  }
}

/**
 * `GET /files/:token` 的处理器。
 *
 * 只接受 token，不接受任何 path 参数；取文件时重新确认「文件仍然存在且是普通文件」。
 * 返回 `false` 表示路径不属于 /files（交给上层 404）。
 */
export function createFilesRoute(opts: { tokens: TokenStore; logger?: Logger }) {
  const { tokens, logger } = opts;

  return async function handleFilesRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!pathname.startsWith(FILES_PREFIX)) return false;

    const token = pathname.slice(FILES_PREFIX.length);
    const respond = (status: number, headers: Record<string, string>, body: string): void => {
      logger?.event('files-fetch', { token, status });
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    };

    if (req.method !== 'GET') {
      respond(405, { allow: 'GET' }, '{"error":"method not allowed"}');
      return true;
    }

    const record = tokens.verify(token);
    if (!record) {
      respond(404, {}, '{"error":"not found"}');
      return true;
    }

    let info;
    try {
      info = await stat(record.path);
    } catch {
      info = undefined;
    }
    if (!info?.isFile()) {
      respond(404, {}, '{"error":"not found"}');
      return true;
    }

    res.writeHead(200, {
      'content-type': record.mimeType,
      'content-length': String(info.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
      'x-content-type-options': 'nosniff',
    });
    logger?.event('files-fetch', { token, status: 200, bytes: info.size, file: record.path });

    await pipeline(createReadStream(record.path), res);
    return true;
  };
}
