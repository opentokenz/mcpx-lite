import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenStore, createFilesRoute } from '../src/downloads.js';

let root: string;
let base: string;
let outside: string;
let clock: number;
let tokens: TokenStore;

const PDF_BYTES = Buffer.from('%PDF-1.7 fake pdf body\x00\x01\x02', 'utf8');

async function startFilesServer(store: TokenStore) {
  const route = createFilesRoute({ tokens: store });
  const server = createServer((req, res) => {
    void route(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mini-pi-downloads-'));
  base = join(root, 'project');
  outside = join(root, 'outside');
  await mkdir(join(base, 'dist'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(base, 'dist', 'report.pdf'), PDF_BYTES);
  await writeFile(join(base, 'notes.txt'), 'hello\n', 'utf8');
  await writeFile(join(outside, 'other.txt'), 'outside base\n', 'utf8');
  clock = Date.parse('2026-09-26T00:00:00.000Z');
  tokens = new TokenStore({ now: () => clock });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TokenStore', () => {
  it('mint 返回 token / name / mimeType / size / expiresAt，token 不透明且不可预测', async () => {
    const record = await tokens.mint({ sessionId: 'ses_abc123def456', path: join(base, 'dist', 'report.pdf') });

    expect(record.token).toMatch(/^file_[A-Za-z0-9_-]{32}$/);
    expect(record.name).toBe('report.pdf');
    expect(record.mimeType).toBe('application/pdf');
    expect(record.size).toBe(PDF_BYTES.length);
    expect(record.expiresAt).toBe('2026-09-26T00:05:00.000Z');
    expect(record.sessionId).toBe('ses_abc123def456');

    const second = await tokens.mint({ sessionId: 'ses_abc123def456', path: join(base, 'notes.txt') });
    expect(second.token).not.toBe(record.token);
  });

  it('mimeType 未知扩展名时兜底 octet-stream', async () => {
    await writeFile(join(base, 'blob.unknownext'), 'x', 'utf8');

    const record = await tokens.mint({ sessionId: 'ses_abc123def456', path: join(base, 'blob.unknownext') });

    expect(record.mimeType).toBe('application/octet-stream');
  });

  it('mint 对目录、不存在的文件报错', async () => {
    await expect(tokens.mint({ sessionId: 'ses_abc123def456', path: base })).rejects.toThrow(/not a regular file/);
    await expect(tokens.mint({ sessionId: 'ses_abc123def456', path: join(base, 'missing') })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('base 之外的文件也能 mint（base 不是下载边界）', async () => {
    const record = await tokens.mint({ sessionId: 'ses_abc123def456', path: join(outside, 'other.txt') });

    expect(record.path).toBe(join(outside, 'other.txt'));
  });

  it('verify 未过期返回记录，过期或未知返回 undefined，并清理过期项', async () => {
    const record = await tokens.mint({ sessionId: 'ses_abc123def456', path: join(base, 'notes.txt') });

    expect(tokens.verify(record.token)).toEqual(record);
    expect(tokens.verify('file_' + 'x'.repeat(32))).toBeUndefined();
    expect(tokens.verify('not-a-token')).toBeUndefined();

    clock += 5 * 60 * 1000 + 1;
    expect(tokens.verify(record.token)).toBeUndefined();
    expect(tokens.size).toBe(0);
  });
});

describe('GET /files/:token', () => {
  it('返回与源文件字节一致的内容与响应头', async () => {
    const server = await startFilesServer(tokens);
    const record = await tokens.mint({ sessionId: 'ses_abc123def456', path: join(base, 'dist', 'report.pdf') });

    const response = await fetch(`${server.origin}/files/${record.token}`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-length')).toBe(String(PDF_BYTES.length));
    expect(response.headers.get('content-disposition')).toBe('attachment; filename*=UTF-8\'\'report.pdf');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body.equals(PDF_BYTES)).toBe(true);

    await server.close();
  });

  it('中文文件名走 filename* 编码', async () => {
    await writeFile(join(base, '报告.txt'), 'ok\n', 'utf8');
    const server = await startFilesServer(tokens);
    const record = await tokens.mint({ sessionId: 'ses_abc123def456', path: join(base, '报告.txt') });

    const response = await fetch(`${server.origin}/files/${record.token}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('报告.txt')}`,
    );

    await server.close();
  });

  it('未知 / 篡改 / 过期 token 都是 404', async () => {
    const server = await startFilesServer(tokens);
    const record = await tokens.mint({ sessionId: 'ses_abc123def456', path: join(base, 'notes.txt') });
    // 篡改要保证一定改了字符，否则随机 token 末位恰好是 b 时会误判
    const tampered = `${record.token.slice(0, -1)}${record.token.endsWith('b') ? 'c' : 'b'}`;

    expect((await fetch(`${server.origin}/files/file_${'a'.repeat(32)}`)).status).toBe(404);
    expect((await fetch(`${server.origin}/files/${tampered}`)).status).toBe(404);
    expect((await fetch(`${server.origin}/files/short`)).status).toBe(404);

    clock += 5 * 60 * 1000 + 1;
    expect((await fetch(`${server.origin}/files/${record.token}`)).status).toBe(404);

    await server.close();
  });

  it('mint 之后文件被删除 → 404', async () => {
    const server = await startFilesServer(tokens);
    const target = join(base, 'temp.txt');
    await writeFile(target, 'gone soon', 'utf8');
    const record = await tokens.mint({ sessionId: 'ses_abc123def456', path: target });
    await rm(target, { force: true });

    expect((await fetch(`${server.origin}/files/${record.token}`)).status).toBe(404);

    await server.close();
  });

  it('非 GET 方法 405；/files 路径不接受 path 查询参数', async () => {
    const server = await startFilesServer(tokens);

    const post = await fetch(`${server.origin}/files/file_${'a'.repeat(32)}`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');

    expect((await fetch(`${server.origin}/files?path=/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${server.origin}/files/../etc/passwd`)).status).toBe(404);

    await server.close();
  });

  it('非 /files 路径不处理（返回 false 交给上层 404）', async () => {
    const server = await startFilesServer(tokens);

    expect((await fetch(`${server.origin}/mcp`)).status).toBe(404);

    await server.close();
  });
});
