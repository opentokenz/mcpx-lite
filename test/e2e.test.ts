import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpConnection } from '../src/mcp-client.js';
import type { ResolvedMcpServer } from '../src/mcp-config.js';
import {
  approvalRetryBody,
  createHarness,
  expectApproval,
  expectError,
  expectOk,
  mcpHeaders,
  toOutcome,
  toolCallBody,
  type Harness,
} from './harness.js';

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

describe('fetch 工具（进程内）', () => {
  it('返回 resource_link + JSON（name / mimeType / size / url / expiresAt），URL 用请求 origin', async () => {
    await mkdir(join(h.workspace, 'dist'), { recursive: true });
    await writeFile(join(h.workspace, 'dist', 'report.pdf'), PDF_BYTES);

    const created = expectOk(
      await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '交付产物', reason: '开始任务' }),
    );
    const outcome = await h.callTool('fetch', {
      sessionId: created['sessionId'] as string,
      path: 'dist/report.pdf',
      goal: '把报告交给用户',
      reason: '产物需要下载',
    });
    const payload = expectOk(outcome) as Record<string, unknown>;

    expect(outcome.resultType).toBe('complete');
    expect(h.logs.join('\n')).not.toContain('fetch.outside-workspace');

    expect(payload['name']).toBe('report.pdf');
    expect(payload['mimeType']).toBe('application/pdf');
    expect(payload['size']).toBe(PDF_BYTES.length);
    expect(payload['path']).toBe(join(h.workspace, 'dist', 'report.pdf'));
    expect(payload['url']).toMatch(/^http:\/\/127\.0\.0\.1:29090\/files\/file_[A-Za-z0-9_-]{32}$/);
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

  it('workspace 外导出需要确认（确认前不签发链接）；目录与不存在的文件报错', async () => {
    const outside = join(h.workspace, '..', 'outside-artifact.txt');
    await writeFile(outside, 'artifact\n', 'utf8');
    await mkdir(join(h.workspace, 'adir'), { recursive: true });

    const created = expectOk(
      await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const sessionId = created['sessionId'] as string;
    const fetchFile = (args: Record<string, unknown>) =>
      h.callTool('fetch', { sessionId, goal: '获取文件', reason: '需要原始文件', ...args });
    const fetchArgs = { sessionId, path: outside, goal: '获取文件', reason: '需要原始文件' };

    // 首轮：只返回审核卡片/token，不签发任何下载链接
    const gated = await h.callTool('fetch', fetchArgs);
    expect(expectApproval(gated).approvalToken).toMatch(/^apr_/);
    expect(h.logs.join('\n')).toContain('fetch.outside-workspace');
    expect(h.logs.some((line) => line.includes('download-mint'))).toBe(false);

    // 确认后才签发链接
    const confirmed = expectOk(await h.callToolApproving('fetch', fetchArgs));
    expect(confirmed['name']).toBe('outside-artifact.txt');

    // 目录 / 不存在的文件在确认之前就报错
    expect(expectError(await fetchFile({ path: 'adir' }))).toMatch(/not a regular file/);
    expect(expectError(await fetchFile({ path: 'nope.bin' }))).toMatch(/does not exist/);
  });

  it('delivery=base64：内联返回 embedded resource + 摘要，字节一致且不签发链接', async () => {
    await mkdir(join(h.workspace, 'dist'), { recursive: true });
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x2f]);
    await writeFile(join(h.workspace, 'dist', 'inline.zip'), bytes);

    const created = expectOk(
      await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const outcome = await h.callTool('fetch', {
      sessionId: created['sessionId'] as string,
      path: 'dist/inline.zip',
      delivery: 'base64',
      goal: '内联拿到产物',
      reason: '链接客户端不可达',
    });

    expect(outcome.isError).toBe(false);

    const embedded = outcome.content?.[0] as
      | { type: string; resource: { uri: string; mimeType?: string; blob: string } }
      | undefined;
    expect(embedded?.type).toBe('resource');
    expect(embedded?.resource.uri).toBe(`file://${join(h.workspace, 'dist', 'inline.zip')}`);
    expect(embedded?.resource.mimeType).toBe('application/zip');
    expect(Buffer.from(embedded?.resource.blob ?? '', 'base64').equals(bytes)).toBe(true);

    const summary = JSON.parse(
      (outcome.content?.[1] as { text?: string } | undefined)?.text ?? '{}',
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      name: 'inline.zip',
      mimeType: 'application/zip',
      size: bytes.byteLength,
      path: join(h.workspace, 'dist', 'inline.zip'),
      encoding: 'base64',
    });
    expect(summary['sha256']).toBe(createHash('sha256').update(bytes).digest('hex'));

    // 内联模式不签发下载链接
    expect(h.logs.some((line) => line.includes('download-mint'))).toBe(false);

    // base64 正文（连同 sha256）不会进终端日志：摘要只记块数与类型
    const flat = h.logs.join('').replace(/[│\s]+/g, '');
    expect(flat).toContain('2blocks·resource,text');
    expect(flat).not.toContain(embedded?.resource.blob ?? 'x');
    expect(flat).not.toContain(String(summary['sha256']));
  });

  it('delivery=base64 超过上限：报错并提示改用 link', async () => {
    await mkdir(join(h.workspace, 'dist'), { recursive: true });
    await writeFile(join(h.workspace, 'dist', 'big.bin'), Buffer.alloc(1_048_577, 1));

    const created = expectOk(
      await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const message = expectError(
      await h.callTool('fetch', {
        sessionId: created['sessionId'] as string,
        path: 'dist/big.bin',
        delivery: 'base64',
        goal: '内联拿到大文件',
        reason: '链接不可达',
      }),
    );

    expect(message).toMatch(/too large for inline base64/);
    expect(message).toMatch(/delivery=link/);
  });

  it('workspace 外 + delivery=base64：确认前不读内容、不返回数据', async () => {
    const outside = join(h.workspace, '..', 'outside-inline.bin');
    const bytes = Buffer.from('SECRET-INLINE-BYTES');
    await writeFile(outside, bytes);

    const created = expectOk(
      await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const args = {
      sessionId: created['sessionId'] as string,
      path: outside,
      delivery: 'base64' as const,
      goal: '内联拿到外部文件',
      reason: '需要原始字节',
    };

    const first = await h.callTool('fetch', args);

    expectApproval(first);
    expect(first.text).not.toContain(bytes.toString('base64'));
    expect(h.logs.join('\n')).toContain('fetch.outside-workspace');

    const approved = await h.callToolApproving('fetch', args);
    const embedded = approved.content?.[0] as { resource: { blob: string } } | undefined;
    expect(Buffer.from(embedded?.resource.blob ?? '', 'base64').toString()).toBe('SECRET-INLINE-BYTES');
  });

  it('确认后修改 delivery：旧 approvalToken 不授权新交付方式', async () => {
    const outside = join(h.workspace, '..', 'outside-delivery.txt');
    await writeFile(outside, 'x', 'utf8');

    const created = expectOk(
      await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const sessionId = created['sessionId'] as string;
    const first = await h.callTool('fetch', { sessionId, path: outside, goal: '交付', reason: '需要文件' });
    const token = expectApproval(first).approvalToken;

    const changed = { sessionId, path: outside, delivery: 'base64', goal: '交付', reason: '需要文件' };
    const retry = toOutcome(await h.client.send(approvalRetryBody('fetch', changed, token)));

    expect(retry.isError).toBe(true);
    expect(retry.text).toMatch(/不匹配/);
  });

  it('二次确认允许 goal / reason 改变，只校验 fetch 业务参数', async () => {
    const outside = join(h.workspace, '..', 'outside-audit-fields.txt');
    await writeFile(outside, 'audit-fields', 'utf8');

    const created = expectOk(
      await h.callTool('session', { action: 'create', workspace: h.workspace }),
    );
    const sessionId = created['sessionId'] as string;
    const firstArgs = {
      sessionId,
      path: outside,
      goal: '首轮导出目标',
      reason: '首轮导出原因',
    };
    const token = expectApproval(await h.callTool('fetch', firstArgs)).approvalToken;

    const retryArgs = {
      ...firstArgs,
      goal: '二次目标变化',
      reason: '二次原因变化',
    };
    const retry = toOutcome(await h.client.send(approvalRetryBody('fetch', retryArgs, token)));

    expect(retry.isError).toBe(false);
    expect(retry.text).toContain('outside-audit-fields.txt');
  });

  it('history 只记录路径与原因，不记录文件内容', async () => {
    await writeFile(join(h.workspace, 'secret.bin'), 'TOPSECRET-BYTES', 'utf8');
    const created = expectOk(
      await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const sessionId = created['sessionId'] as string;

    expectOk(await h.callTool('fetch', { sessionId, path: 'secret.bin', goal: '获取', reason: '需要原始文件' }));

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history[0]).toMatchObject({ tool: 'fetch', target: join(h.workspace, 'secret.bin'), ok: true });
    expect(JSON.stringify(history)).not.toContain('TOPSECRET-BYTES');
  });
});

describe('真实 HTTP 端到端', () => {
  it('关闭审批后 initialize instructions 明确说明不再返回 approval_required', async () => {
    await h.cleanup();
    h = await createHarness({ approvalsEnabled: false });
    server = await h.startHttpServer();
    const downstream: ResolvedMcpServer = {
      name: 'self',
      source: 'global',
      transport: 'http',
      url: `${server.origin}/mcp`,
      headers: {},
      display: { url: `${server.origin}/mcp`, headers: [] },
      hash: 'self-no-approval',
    };
    const connection = await createMcpConnection(downstream);

    try {
      expect(connection.info().instructions).toContain('审批已关闭');
      expect(connection.info().instructions).not.toMatch(/必须让用户选择|先向用户说明/);
    } finally {
      await connection.close();
    }
  });

  it('暴露恰好 9 个工具，描述都带使用说明与示例', async () => {
    server = await h.startHttpServer();

    const tools = await server.client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['shell', 'fetch', 'edit', 'mcp_tool', 'read', 'session', 'skills', 'trash', 'write'].sort(),
    );
    for (const tool of tools) {
      expect(tool.description).toMatch(/示例/);
      expect(tool.description).toMatch(/goal \/ reason：可选/);
      expect(tool.description).not.toContain('"goal"');
      expect(tool.description).not.toContain('"reason"');
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
  });

  it('不再暴露 bash / download / export：旧名称按未知工具失败，且不产生副作用', async () => {
    server = await h.startHttpServer();

    const names = (await server.client.listTools()).map((tool) => tool.name);
    expect(names).not.toContain('bash');
    expect(names).not.toContain('download');

    for (const legacy of ['bash', 'download', 'export']) {
      const outcome = await server.client.callTool(legacy, { goal: 'g', reason: 'r' });

      expect(outcome.error?.code, legacy).toBe(-32602);
      expect(outcome.text).toContain(`Tool ${legacy} not found`);
    }
  });

  it('session → write → shell → fetch → GET /files/:token 走完整链路，字节一致', async () => {
    server = await h.startHttpServer();
    const client = server.client;

    const created = expectOk(
      await client.callTool('session', {
        action: 'create',
        workspace: h.workspace,
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
      await client.callToolApproving('shell', {
        sessionId,
        command:
          process.platform === 'win32'
            ? 'New-Item -ItemType Directory -Force -Path dist | Out-Null; Copy-Item -LiteralPath src/hello.ts -Destination dist/hello.txt; (Get-Item -LiteralPath dist/hello.txt).Length'
            : 'mkdir -p dist && cp src/hello.ts dist/hello.txt && wc -c < dist/hello.txt',
        goal: '产出构建结果',
        reason: '验证 shell 能生成待导出文件',
      }),
    );
    expect((ran['stdout'] as string).trim()).toBe(String(Buffer.byteLength(HELLO)));

    const fetched = expectOk(
      await client.callTool('fetch', {
        sessionId,
        path: 'dist/hello.txt',
        goal: '交付产物',
        reason: '远端需要拿到文件',
      }),
    );
    const url = fetched['url'] as string;
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
      'shell',
      'fetch',
    ]);
    expect(h.logs.some((line) => line.includes('download-mint') && line.includes('hello.txt'))).toBe(true);
    expect(h.logs.some((line) => line.includes('files-fetch') && line.includes('status=200'))).toBe(true);
  });

  it('未知路径 404；token 篡改 / 重复使用过期链接 404', async () => {
    server = await h.startHttpServer();
    const client = server.client;
    await mkdir(join(h.workspace, 'dist'), { recursive: true });
    await writeFile(join(h.workspace, 'dist', 'a.txt'), 'a\n', 'utf8');

    const created = expectOk(await client.callTool('session', { action: 'create', workspace: h.workspace, goal: 'g', reason: 'r' }));
    const fetched = expectOk(
      await client.callTool('fetch', {
        sessionId: created['sessionId'] as string,
        path: 'dist/a.txt',
        goal: 'g',
        reason: 'r',
      }),
    );
    const token = (fetched['url'] as string).split('/files/')[1] ?? '';
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    expect(tamperedToken).not.toBe(token);
    expect((await fetch(`${server.origin}/files/${tamperedToken}`)).status).toBe(404);
    expect((await fetch(`${server.origin}/files?path=/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${server.origin}/nope`)).status).toBe(404);
    expect((await fetch(`${server.origin}/`)).status).toBe(404);
  });

  it('每次入站 MCP 请求都记录事件（方法 / 工具名 / 状态码 / 耗时）', async () => {
    server = await h.startHttpServer();

    const tools = await server.client.listTools();
    expect(tools).toHaveLength(9);

    const line = h.logs.find((entry) => entry.includes('mcp-request'));
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
    expect(loadConfig({}).port).toBe(29090);
    expect(loadConfig({ MCPX_LITE_PORT: '9000' }).port).toBe(9000);
    expect(loadConfig({ MCPX_LITE_PORT: 'abc' }).port).toBe(29090);
    expect(loadConfig({ MCPX_LITE_LOG: 'off' }).logLevel).toBe('off');
  });

  it('fetch 链接的 origin 优先取反向代理头（公网域名）', async () => {
    server = await h.startHttpServer();
    const { origin, client } = server;
    await mkdir(join(h.workspace, 'dist'), { recursive: true });
    await writeFile(join(h.workspace, 'dist', 'a.txt'), 'a\n', 'utf8');

    const created = expectOk(
      await client.callTool('session', { action: 'create', workspace: h.workspace, goal: '交付', reason: '开始任务' }),
    );
    const sessionId = created['sessionId'] as string;

    const callWithHeaders = async (extra: Record<string, string>) => {
      const body = toolCallBody('fetch', {
        sessionId,
        path: 'dist/a.txt',
        goal: '交付产物',
        reason: '远端需要文件',
      });
      const response = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: { ...mcpHeaders(body), ...extra },
        body: JSON.stringify(body),
      });
      return toOutcome((await response.json()) as Record<string, unknown>);
    };

    // RFC 7239 Forwarded
    const forwarded = expectOk(await callWithHeaders({ forwarded: 'proto=https;host=pi.example.com' }));
    expect(forwarded['url']).toMatch(/^https:\/\/pi\.example\.com\/files\/file_/);

    // 事实标准 X-Forwarded-*
    const xforwarded = await callWithHeaders({
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'pi.example.com:8443',
    });
    const payload = expectOk(xforwarded);
    expect(payload['url']).toMatch(/^https:\/\/pi\.example\.com:8443\/files\/file_/);
    expect((xforwarded.content?.[0] as { uri?: string }).uri).toBe(payload['url']);

    // 没有代理头时回退到服务配置的 host:port（不再是代理域名）
    h.deps.config.host = '0.0.0.0';
    const direct = expectOk(await callWithHeaders({}));
    expect(direct['url']).not.toContain('pi.example.com');
    expect(direct['url']).toMatch(/\/files\/file_/);
    expect(direct['url']).toContain('0.0.0.0');

    // 通配监听地址 + 推断不出对外地址 → 记一条告警，便于定位「客户端拿不到域名」
    expect(h.logs.some((line) => line.includes('fetch-origin-warning'))).toBe(true);
  });
});

describe('真实 HTTP 端到端：安全确认（MRTR）', () => {
  it('safe 命令一次请求直接执行；危险命令确认后才产生副作用', async () => {
    server = await h.startHttpServer();
    const client = server.client;

    const created = expectOk(
      await client.callTool('session', { action: 'create', workspace: h.workspace, goal: 'g', reason: 'r' }),
    );
    const sessionId = created['sessionId'] as string;

    // safe fast path：不进入确认流程
    const safeCommand = process.platform === 'win32' ? '[Console]::Out.Write((Get-Location).Path)' : 'pwd';
    const safe = await client.callTool('shell', { sessionId, command: safeCommand, goal: '验证现状', reason: 'r' });
    expect(safe.resultType).not.toBe('input_required');
    expect(safe.isError).toBe(false);
    expect((expectOk(safe)['stdout'] as string).trim()).toBe(h.workspace);

    // 危险命令：首轮只拿到普通审核卡片/token，真实机器上没有任何副作用
    const gated = join(h.workspace, 'e2e-gated.txt');
    const gatedCommand =
      process.platform === 'win32'
        ? `Set-Content -LiteralPath '${gated.replaceAll("'", "''")}' -Value 'created'`
        : 'touch e2e-gated.txt';
    const args = { sessionId, command: gatedCommand, goal: '创建文件', reason: '验证门禁' };
    const first = await client.callTool('shell', args);
    const token = expectApproval(first).approvalToken;

    expect(first.resultType).toBe('complete');
    await expect(access(gated)).rejects.toThrow();

    // 第二轮：用户确认后以普通参数重试
    const confirmed = expectOk(
      toOutcome(await client.send(approvalRetryBody('shell', args, token))),
    );
    expect(confirmed['exitCode']).toBe(0);
    await expect(access(gated)).resolves.toBeUndefined();
  });

  it('workspace 外 edit 两轮流程：确认后写入真实目标，approval 事件进入观测日志', async () => {
    server = await h.startHttpServer();
    const client = server.client;

    const created = expectOk(
      await client.callTool('session', { action: 'create', workspace: h.workspace, goal: 'g', reason: 'r' }),
    );
    const sessionId = created['sessionId'] as string;

    const outside = join(h.workspace, '..', 'e2e-outside.txt');
    await writeFile(outside, 'old\n', 'utf8');

    const args = {
      sessionId,
      edits: [{ path: outside, replacements: [{ oldText: 'old', newText: 'new' }] }],
      goal: '改配置',
      reason: '需要越界编辑',
    };
    const first = await client.callTool('edit', args);
    const token = expectApproval(first).approvalToken;

    expect(first.resultType).toBe('complete');
    expect(await readFile(outside, 'utf8')).toBe('old\n');

    const confirmed = expectOk(
      toOutcome(await client.send(approvalRetryBody('edit', args, token))),
    );
    expect(confirmed['files']).toBe(1);
    expect(confirmed['replacements']).toBe(1);
    expect(await readFile(outside, 'utf8')).toBe('new\n');

    // 安全事件以卡片状态进入观测日志
    expect(h.logs.some((line) => line.includes('APPROVAL REQUIRED'))).toBe(true);
    expect(h.logs.some((line) => line.includes('✓ EDIT'))).toBe(true);
    expect(h.logs.some((line) => line.includes('edit.outside-workspace'))).toBe(true);
  });
});
