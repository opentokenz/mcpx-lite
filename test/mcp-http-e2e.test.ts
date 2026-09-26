import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  approvalRetryBody,
  createHarness,
  expectApproval,
  expectOk,
  toOutcome,
  type Harness,
} from './harness.js';

let h: Harness;
let downstream: Server | undefined;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  if (downstream) {
    await new Promise<void>((done) => downstream?.close(() => done()));
    downstream = undefined;
  }
  await h.cleanup();
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

async function startDownstreamHttp(): Promise<{
  url: string;
  authorization: () => string | undefined;
  requestCount: () => number;
}> {
  let lastAuthorization: string | undefined;
  let requests = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'downstream-http-fixture', version: '1.0.0' },
      { instructions: 'http fixture instructions' },
    );

    server.registerTool(
      'echo',
      {
        description: 'Echo over HTTP',
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async ({ text }) => ({
        content: [{ type: 'text', text }],
        structuredContent: { echoed: text },
      }),
    );

    return server;
  });
  const nodeHandler = toNodeHandler(handler);

  downstream = createServer((req, res) => {
    requests += 1;
    lastAuthorization =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    void nodeHandler(req, res);
  });
  await new Promise<void>((done) => downstream?.listen(0, '127.0.0.1', done));
  const { port } = downstream.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authorization: () => lastAuthorization,
    requestCount: () => requests,
  };
}

describe('mcp_tool downstream Streamable HTTP', () => {
  it('全局 HTTP server 可 inspect / call，并带配置 headers', async () => {
    const remote = await startDownstreamHttp();
    await writeJson(join(h.home, '.agents', 'mcp.json'), {
      mcpServers: {
        remote: {
          url: remote.url,
          headers: { Authorization: 'Bearer HTTP_FIXTURE_SECRET' },
        },
      },
    });
    const created = expectOk(
      await h.callTool('session', { action: 'create', base: h.workspace }),
    );
    const sessionId = created['sessionId'] as string;

    const inspected = expectOk(
      await h.callTool('mcp_tool', {
        action: 'inspect',
        sessionId,
        server: 'remote',
      }),
    );

    expect(inspected).toMatchObject({
      server: { name: 'remote', source: 'global', transport: 'http' },
      serverInfo: { name: 'downstream-http-fixture', version: '1.0.0' },
      instructions: 'http fixture instructions',
    });
    expect(remote.authorization()).toBe('Bearer HTTP_FIXTURE_SECRET');
    expect(JSON.stringify(inspected)).not.toContain('HTTP_FIXTURE_SECRET');

    const called = await h.callTool('mcp_tool', {
      action: 'call',
      sessionId,
      server: 'remote',
      name: 'echo',
      arguments: { text: 'hello-http' },
    });

    expect(called.isError).toBe(false);
    expect(called.content).toContainEqual({ type: 'text', text: 'hello-http' });
    expect(called.structuredContent).toEqual({ echoed: 'hello-http' });
  });

  it('项目级 HTTP server 审批前不发网络请求，批准时 goal/reason 可变化', async () => {
    const remote = await startDownstreamHttp();
    await writeJson(join(h.workspace, '.mcp.json'), {
      mcpServers: {
        remote: { url: remote.url },
      },
    });
    const created = expectOk(
      await h.callTool('session', { action: 'create', base: h.workspace }),
    );
    const sessionId = created['sessionId'] as string;
    const firstArgs = {
      action: 'inspect',
      sessionId,
      server: 'remote',
      goal: '首轮 HTTP 连接目标',
      reason: '首轮 HTTP 连接原因',
    };

    const first = await h.callTool('mcp_tool', firstArgs);
    const token = expectApproval(first).approvalToken;
    expect(remote.requestCount()).toBe(0);

    const retryArgs = {
      action: 'inspect',
      sessionId,
      server: 'remote',
      goal: '二次目标变化',
      reason: '二次原因变化',
    };
    const retried = toOutcome(
      await h.client.send(approvalRetryBody('mcp_tool', retryArgs, token)),
    );

    expect(retried.isError).toBe(false);
    expect(remote.requestCount()).toBeGreaterThan(0);
  });
});
