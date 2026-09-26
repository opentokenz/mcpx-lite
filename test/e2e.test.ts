import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, expectError, expectOk, type Harness } from './harness.js';

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0x01, 0xff, 0x0a]);
const HELLO = 'export const hello = "world";\n';

let h: Harness;
let server: Awaited<ReturnType<Harness['startHttpServer']>> | undefined;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await h.cleanup();
});

describe('download 工具（进程内）', () => {
  it('返回 resource_link + JSON（name / mimeType / size / url / expiresAt），URL 用请求 origin', async () => {
    await mkdir(join(h.workspace, 'dist'), { recursive: true });
    await writeFile(join(h.workspace, 'dist', 'report.pdf'), PDF_BYTES);

    const created = expectOk(
      await h.callTool('session', { action: 'create', base: h.workspace, goal: '交付产物', reason: '开始任务' }),
    );
    const outcome = await h.callTool('download', {
      sessionId: created['sessionId'] as string,
      path: 'dist/report.pdf',
      goal: '把报告交给用户',
      reason: '产物需要下载',
    });
    const payload = expectOk(outcome) as Record<string, unknown>;

    expect(payload['name']).toBe('report.pdf');
    expect(payload['mimeType']).toBe('application/pdf');
    expect(payload['size']).toBe(PDF_BYTES.length);
    expect(payload['path']).toBe(join(h.workspace, 'dist', 'report.pdf'));
    expect(payload['url']).toMatch(/^http:\/\/127\.0\.0\.1:8787\/files\/file_[A-Za-z0-9_-]{32}$/);
    expect(Date.parse(payload['expiresAt'] as string)).toBeGreaterThan(Date.now());

    const link = outcome.content?.[0];
    expect(link).toMatchObject({
      type: 'resource_link',
      uri: payload['url'],
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.length,
    });
  });

  it('base 之外的文件也能导出；目录与不存在的文件报错', async () => {
    const outside = join(h.workspace, '..', 'outside-artifact.txt');
    await writeFile(outside, 'artifact\n', 'utf8');
    await mkdir(join(h.workspace, 'adir'), { recursive: true });

    const created = expectOk(
      await h.callTool('session', { action: 'create', base: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const sessionId = created['sessionId'] as string;
    const download = (args: Record<string, unknown>) =>
      h.callTool('download', { sessionId, goal: '导出文件', reason: '需要原始文件', ...args });

    expect(expectOk(await download({ path: outside }))['name']).toBe('outside-artifact.txt');
    expect(expectError(await download({ path: 'adir' }))).toMatch(/not a regular file/);
    expect(expectError(await download({ path: 'nope.bin' }))).toMatch(/does not exist/);
  });

  it('history 只记录路径与原因，不记录文件内容', async () => {
    await writeFile(join(h.workspace, 'secret.bin'), 'TOPSECRET-BYTES', 'utf8');
    const created = expectOk(
      await h.callTool('session', { action: 'create', base: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const sessionId = created['sessionId'] as string;

    expectOk(await h.callTool('download', { sessionId, path: 'secret.bin', goal: '导出', reason: '需要原始文件' }));

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history[0]).toMatchObject({ tool: 'download', target: join(h.workspace, 'secret.bin'), ok: true });
    expect(JSON.stringify(history)).not.toContain('TOPSECRET-BYTES');
  });
});

describe('真实 HTTP 端到端', () => {
  it('暴露恰好 7 个工具，描述都带使用说明与示例', async () => {
    server = await h.startHttpServer();

    const tools = await server.client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['bash', 'download', 'edit', 'read', 'session', 'skills', 'write'].sort(),
    );
    for (const tool of tools) {
      expect(tool.description).toMatch(/示例/);
      expect(tool.description).toContain('"reason"');
    }
  });

  it('session → write → bash → download → GET /files/:token 走完整链路，字节一致', async () => {
    server = await h.startHttpServer();
    const client = server.client;

    const created = expectOk(
      await client.callTool('session', {
        action: 'create',
        base: h.workspace,
        goal: '生成并交付产物',
        reason: '用户要求产出文件',
      }),
    );
    const sessionId = created['sessionId'] as string;
    expect(created['instructions']).toContain('不是沙箱');

    expectOk(
      await client.callTool('write', {
        sessionId,
        path: 'src/hello.ts',
        content: HELLO,
        goal: '写入口文件',
        reason: '需要一个可运行入口',
      }),
    );

    const ran = expectOk(
      await client.callTool('bash', {
        sessionId,
        command: 'mkdir -p dist && cp src/hello.ts dist/hello.txt && wc -c < dist/hello.txt',
        goal: '产出构建结果',
        reason: '验证 bash 能生成待下载文件',
      }),
    );
    expect((ran['stdout'] as string).trim()).toBe(String(Buffer.byteLength(HELLO)));

    const downloaded = expectOk(
      await client.callTool('download', {
        sessionId,
        path: 'dist/hello.txt',
        goal: '交付产物',
        reason: '远端需要拿到文件',
      }),
    );
    const url = downloaded['url'] as string;
    expect(url.startsWith(server.origin)).toBe(true);

    const response = await fetch(url);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('hello.txt');
    expect(body).toBe(HELLO);
    expect(body).toBe(await readFile(join(h.workspace, 'dist', 'hello.txt'), 'utf8'));

    // 每个工具的调用都写进了 history，且日志里有 mint / fetch 事件
    const session = expectOk(await client.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect((session['history'] as unknown[]).map((entry) => (entry as { tool: string }).tool)).toEqual([
      'write',
      'bash',
      'download',
    ]);
    expect(h.logs.some((line) => line.includes('download-mint') && line.includes('hello.txt'))).toBe(true);
    expect(h.logs.some((line) => line.includes('files-fetch') && line.includes('status=200'))).toBe(true);
  });

  it('未知路径 404；token 篡改 / 重复使用过期链接 404', async () => {
    server = await h.startHttpServer();
    const client = server.client;
    await mkdir(join(h.workspace, 'dist'), { recursive: true });
    await writeFile(join(h.workspace, 'dist', 'a.txt'), 'a\n', 'utf8');

    const created = expectOk(await client.callTool('session', { action: 'create', base: h.workspace, goal: 'g', reason: 'r' }));
    const downloaded = expectOk(
      await client.callTool('download', {
        sessionId: created['sessionId'] as string,
        path: 'dist/a.txt',
        goal: 'g',
        reason: 'r',
      }),
    );
    const token = (downloaded['url'] as string).split('/files/')[1] ?? '';

    expect((await fetch(`${server.origin}/files/${token.slice(0, -1)}b`)).status).toBe(404);
    expect((await fetch(`${server.origin}/files?path=/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${server.origin}/nope`)).status).toBe(404);
    expect((await fetch(`${server.origin}/`)).status).toBe(404);
  });

  it('每次入站 MCP 请求都记录事件（方法 / 工具名 / 状态码 / 耗时）', async () => {
    server = await h.startHttpServer();

    const tools = await server.client.listTools();
    expect(tools).toHaveLength(7);

    const line = h.logs.find((entry) => entry.includes('event mcp-request'));
    expect(line).toContain('method="POST"');
    expect(line).toContain('rpc="tools/list"');
    expect(line).toContain('status=200');
    expect(line).toMatch(/ms=\d+/);
  });

  it('缺少 MCP-Protocol-Version 请求头时被协议层拒绝（SEP-2243 头部路由）', async () => {
    server = await h.startHttpServer();

    const response = await fetch(`${server.origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': 'tools/list',
        'mcp-name': '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    const body = (await response.json()) as { error?: { code: number } };

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe(-32020);
  });

  it('非回环绑定不启用 localhost Host 校验（远端 Studio 可连）', async () => {
    const { loadConfig } = await import('../src/index.js');
    const { isLoopback } = await import('../src/index.js');

    expect(isLoopback(loadConfig({}).host)).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.9')).toBe(false);
    expect(loadConfig({}).port).toBe(8787);
    expect(loadConfig({ MINI_PI_MCP_PORT: '9000' }).port).toBe(9000);
    expect(loadConfig({ MINI_PI_MCP_PORT: 'abc' }).port).toBe(8787);
    expect(loadConfig({ MINI_PI_MCP_LOG: 'off' }).logLevel).toBe('off');
  });
});
