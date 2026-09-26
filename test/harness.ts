import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createApprovalCodec } from '../src/approval.js';
import { TokenStore } from '../src/downloads.js';
import { createHttpServer, loadConfig } from '../src/index.js';
import { createLogger, type Logger } from '../src/log.js';
import { createMcpConnection } from '../src/mcp-client.js';
import { McpManager } from '../src/mcp-manager.js';
import { McpTrustStore } from '../src/mcp-trust.js';
import { buildServer, type Deps } from '../src/server.js';
import { SessionStore } from '../src/session.js';
import { SkillIndex } from '../src/skills.js';

export const TEST_ORIGIN = 'http://127.0.0.1:8787';
export const PROTOCOL_VERSION = '2026-07-28';

const META = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  // MRTR 测试客户端明确声明 form elicitation；server 才允许返回对应 input_required。
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

export interface ToolCallOutcome {
  isError: boolean;
  /** content[0].text 解析后的 JSON（不是 JSON 就返回原始文本） */
  data: unknown;
  text: string;
  content?: { type: string; [key: string]: unknown }[];
  structuredContent?: unknown;
  /** MCP wire-level resultType；新审批协议不会使用 input_required */
  resultType?: string;
  /** JSON-RPC 层错误（未知方法 / 传输层失败等） */
  error?: { code: number; message: string };
}

export type Send = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** 用户在审核卡片中的选择。 */
export type ApprovalDecision = 'approve' | 'cancel';

export interface ApprovalOptions {
  /** 默认 approve（自动走完确认流程） */
  decision?: ApprovalDecision;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpClient {
  send: Send;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  /** 危险调用的完整两轮流程：首轮拿审核卡片/token，然后按 decision 用普通参数重试 */
  callToolApproving(
    name: string,
    args: Record<string, unknown>,
    opts?: ApprovalOptions,
  ): Promise<ToolCallOutcome>;
  listTools(): Promise<ListedTool[]>;
}

export interface Harness {
  home: string;
  workspace: string;
  globalSkillsDir: string;
  logs: string[];
  logger: Logger;
  deps: Deps;
  sessions: SessionStore;
  skills: SkillIndex;
  downloads: TokenStore;
  handler: ReturnType<typeof createMcpHandler>;
  client: McpClient;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  callToolApproving(
    name: string,
    args: Record<string, unknown>,
    opts?: ApprovalOptions,
  ): Promise<ToolCallOutcome>;
  listTools(): Promise<ListedTool[]>;
  /** 真实 HTTP 服务（路由 /mcp 与 /files），返回指向它的客户端 */
  startHttpServer(): Promise<{ origin: string; client: McpClient; close: () => Promise<void> }>;
  /** 用同一个 home 再建一个 harness，模拟「服务重启后 resume」 */
  restart(): Promise<Harness>;
  cleanup(): Promise<void>;
}

export function toolCallBody(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } };
}

export function mcpHeaders(body: Record<string, unknown>): Record<string, string> {
  const method = String(body['method'] ?? '');
  const name = (body['params'] as { name?: string } | undefined)?.name ?? '';

  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-method': method,
    'mcp-name': name,
  };
}


export function mrtrRetryBody(
  name: string,
  args: Record<string, unknown>,
  requestState: string,
  inputResponses: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      requestState,
      inputResponses,
      _meta: META,
    },
  };
}

/** 危险调用的第二轮请求体：token 原样回传，并携带用户在审核卡片中的选择。 */
export function approvalRetryBody(
  name: string,
  args: Record<string, unknown>,
  approvalToken: string,
  opts: ApprovalOptions = {},
): Record<string, unknown> {
  const approvalDecision = opts.decision ?? 'approve';

  return {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name,
      arguments: { ...args, approvalToken, approvalDecision },
      _meta: META,
    },
  };
}

export function toOutcome(body: Record<string, unknown>): ToolCallOutcome {
  if (body['error']) {
    const error = body['error'] as { code: number; message: string };
    return { isError: true, data: undefined, text: error.message, error };
  }

  const result = body['result'] as
    | {
        content?: { type: string; text?: string }[];
        isError?: boolean;
        resultType?: string;
        structuredContent?: unknown;
      }
    | undefined;
  const content = result?.content ?? [];
  const textBlock = content.find((block) => block.type === 'text' && typeof block.text === 'string');
  const text = textBlock?.text ?? JSON.stringify(content);

  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    isError: Boolean(result?.isError),
    data,
    text,
    content,
    ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result?.resultType ? { resultType: result.resultType } : {}),
  };
}

export function createClient(send: Send): McpClient {
  return {
    send,
    async callTool(name, args) {
      return toOutcome(await send(toolCallBody(name, args)));
    },
    async callToolApproving(name, args, opts = {}) {
      const first = toOutcome(await send(toolCallBody(name, args)));
      const data = first.data as { resultType?: string; approvalToken?: string } | undefined;
      if (data?.resultType !== 'approval_required' || typeof data.approvalToken !== 'string') return first;

      return toOutcome(await send(approvalRetryBody(name, args, data.approvalToken, opts)));
    },
    async listTools() {
      const body = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META } });
      const result = body['result'] as {
        tools: ListedTool[];
      };
      return result.tools;
    },
  };
}

/** 通过真实 HTTP 调用服务（POST /mcp）。 */
export function createHttpClient(origin: string): McpClient {
  return createClient(async (body) => {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(body),
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  });
}

export async function createHarness(
  opts: {
    home?: string;
    workspace?: string;
    ownedDirs?: string[];
    trashBackend?: { trash(path: string): Promise<void> };
  } = {},
): Promise<Harness> {
  const owned = opts.ownedDirs ?? [];
  const home = opts.home ?? (await createOwnedDir(owned, 'mini-pi-home-'));
  const workspace = opts.workspace ?? (await createOwnedDir(owned, 'mini-pi-workspace-'));
  const globalSkillsDir = join(home, '.agents', 'skills');

  const logs: string[] = [];
  const logger = createLogger({
    level: 'debug',
    write: (line) => void logs.push(line.replace(/\n$/, '')),
  });

  const sessions = new SessionStore({ home });
  const skills = new SkillIndex({ globalSkillsDir });
  const downloads = new TokenStore();
  const deps: Deps = {
    sessions,
    skills,
    downloads,
    logger,
    approvals: createApprovalCodec(),
    mcpManager: new McpManager({ connect: createMcpConnection }),
    mcpTrust: new McpTrustStore(),
    mcpGlobalPath: join(home, '.agents', 'mcp.json'),
    trashBackend:
      opts.trashBackend ??
      ({
        async trash() {
          throw new Error('trash backend unavailable in test harness');
        },
      } satisfies { trash(path: string): Promise<void> }),
    config: loadConfig({ MINI_PI_MCP_HOME: home }),
  };

  const handler = createMcpHandler(() => buildServer(deps));
  const client = createClient(async (body) => {
    const response = await handler.fetch(
      new Request(`${TEST_ORIGIN}/mcp`, { method: 'POST', headers: mcpHeaders(body), body: JSON.stringify(body) }),
    );
    return (await response.json()) as Record<string, unknown>;
  });

  return {
    home,
    workspace,
    globalSkillsDir,
    logs,
    logger,
    deps,
    sessions,
    skills,
    downloads,
    handler,
    client,
    callTool: (name, args) => client.callTool(name, args),
    callToolApproving: (name, args, opts) => client.callToolApproving(name, args, opts),
    listTools: () => client.listTools(),
    async startHttpServer() {
      const server = createHttpServer(deps);
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      // 让 config 反映真实监听端口：export 在无法从请求推断对外地址时会回退到它
      deps.config.port = port;

      return {
        origin,
        client: createHttpClient(origin),
        close: () => new Promise<void>((done) => server.close(() => done())),
      };
    },
    restart: () => createHarness({ home, workspace, ownedDirs: owned }),
    cleanup: async () => {
      await deps.mcpManager.closeAll();
      for (const dir of owned) await rm(dir, { recursive: true, force: true });
    },
  };
}

async function createOwnedDir(owned: string[], prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  owned.push(dir);
  await mkdir(dir, { recursive: true });
  // macOS 上 /var 是 /private/var 的符号链接：统一成 realpath，测试里可以直接比较 base
  return realpath(dir);
}

/** 断言工具结果不是错误，并返回解析后的 JSON。 */
export function expectOk(outcome: ToolCallOutcome): Record<string, unknown> {
  if (outcome.isError) throw new Error(`expected success but got error: ${outcome.text}`);
  return outcome.data as Record<string, unknown>;
}

export function expectError(outcome: ToolCallOutcome): string {
  if (!outcome.isError) throw new Error(`expected error but got: ${outcome.text}`);
  return outcome.text;
}

export function expectApproval(outcome: ToolCallOutcome): {
  resultType: 'approval_required';
  approvalRequired: true;
  approvalToken: string;
  approval: {
    title: string;
    risk: string;
    riskLabel: string;
    summary: string;
    message: string;
    presentation: string;
    options: { id: string; label: string; style: string }[];
  };
} {
  if (outcome.isError) throw new Error(`expected approval card but got error: ${outcome.text}`);
  const data = outcome.data as Record<string, unknown>;
  if (data['resultType'] !== 'approval_required' || typeof data['approvalToken'] !== 'string') {
    throw new Error(`expected approval_required but got: ${outcome.text}`);
  }
  return data as ReturnType<typeof expectApproval>;
}

export const skillFile = (body: string, fm = 'name: alpha\ndescription: 全局 alpha'): string =>
  `---\n${fm}\n---\n\n${body}`;
