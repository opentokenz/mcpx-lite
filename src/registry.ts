import type { CallToolResult, McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ToolError } from './errors.js';
import type { Logger } from './log.js';
import { resolvePath } from './session.js';
import type { HistoryEntry, SessionFile, SessionStore } from './session.js';

export interface ToolCallInfo {
  /** history 与日志里的「对什么操作」：解析后的路径 / 命令首行 / `action name` */
  target: string;
  /** 本次调用涉及的文件（日志用） */
  files?: string[];
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<any>;
  annotations?: ToolAnnotations;
  /** 是否要求有效 sessionId（除 session 工具外的 6 个工具都是 true） */
  requiresSession?: boolean;
  describeCall?: (args: any, session: SessionFile | undefined) => ToolCallInfo;
  handler: (args: any, ctx: ServerContext, session: SessionFile | undefined) => Promise<unknown>;
}

/**
 * 定义工具：对工具模块保留完整的入参类型推导，对注册表只暴露一个统一形状。
 */
export function defineTool<S extends z.ZodObject<any>>(def: {
  name: string;
  title: string;
  description: string;
  schema: S;
  annotations?: ToolAnnotations;
  requiresSession?: boolean;
  describeCall?: (args: z.output<S>, session: SessionFile | undefined) => ToolCallInfo;
  handler: (args: z.output<S>, ctx: ServerContext, session: SessionFile | undefined) => Promise<unknown>;
}): ToolDef {
  return def as unknown as ToolDef;
}

let callSequence = 0;

/** 路径类工具（read / write / edit / download）共用的 history 与日志目标。 */
export function describePath(session: SessionFile | undefined, path: string): ToolCallInfo {
  try {
    const absolute = session ? resolvePath(session.base, path) : path;
    return absolute ? { target: absolute, files: [absolute] } : { target: '' };
  } catch {
    return { target: String(path ?? '') };
  }
}

/** 每个工具都必须携带的两个审计字段（描述一致，避免七个工具各写一份）。 */
const GOAL_FIELD = z
  .string()
  .min(1)
  .max(500)
  .describe('本次要达成的整体目标（写入 session history）');
const REASON_FIELD = z
  .string()
  .min(1)
  .max(500)
  .describe('为什么现在需要这一步调用（写入 session history）');

export function withGoalReason<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, goal: GOAL_FIELD, reason: REASON_FIELD });
}

export function registerTools(
  server: McpServer,
  opts: { tools: ToolDef[]; sessions: SessionStore; logger: Logger },
): void {
  const { tools, sessions, logger } = opts;

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      (args: Record<string, unknown>, ctx: ServerContext) =>
        executeTool({ tool, args, ctx, sessions, logger }),
    );
  }
}

/**
 * 一次工具调用的统一包装：观测日志 + history 审计 + 错误收敛。
 * 工具本身不写日志，也不处理「预期失败 → isError」的转换。
 */
async function executeTool(opts: {
  tool: ToolDef;
  args: Record<string, unknown>;
  ctx: ServerContext;
  sessions: SessionStore;
  logger: Logger;
}): Promise<CallToolResult> {
  const { tool, args, ctx, sessions, logger } = opts;
  const id = (callSequence += 1);
  const startedAt = Date.now();

  logger.tool({ id, tool: tool.name, phase: 'call', fields: callFields(args) });

  let info: ToolCallInfo = { target: '' };
  try {
    const session = tool.requiresSession ? await sessions.load(String(args['sessionId'] ?? '')) : undefined;
    info = tool.describeCall?.(args, session) ?? { target: '' };

    const result = await tool.handler(args, ctx, session);
    logger.tool({
      id,
      tool: tool.name,
      phase: 'done',
      ms: Date.now() - startedAt,
      fields: { ...fileFields(info), result: resultSummary(result) },
    });
    await recordHistory({ sessions, logger, tool, args, info, ok: true });

    return toCallToolResult(result);
  } catch (error) {
    const message = errorMessage(error);
    logger.tool({
      id,
      tool: tool.name,
      phase: 'fail',
      ms: Date.now() - startedAt,
      error: message,
      fields: fileFields(info),
    });
    if (!(error instanceof ToolError)) {
      logger.event('tool-error', {
        tool: tool.name,
        stack: error instanceof Error ? (error.stack ?? message) : String(error),
      });
    }
    await recordHistory({ sessions, logger, tool, args, info, ok: false, error: message });

    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

async function recordHistory(opts: {
  sessions: SessionStore;
  logger: Logger;
  tool: ToolDef;
  args: Record<string, unknown>;
  info: ToolCallInfo;
  ok: boolean;
  error?: string;
}): Promise<void> {
  if (!opts.tool.requiresSession) return;

  const sessionId = typeof opts.args['sessionId'] === 'string' ? opts.args['sessionId'] : undefined;
  if (!sessionId) return;

  const entry: HistoryEntry = {
    at: new Date().toISOString(),
    tool: opts.tool.name,
    goal: typeof opts.args['goal'] === 'string' ? opts.args['goal'] : '',
    reason: typeof opts.args['reason'] === 'string' ? opts.args['reason'] : '',
    target: opts.info.target,
    ok: opts.ok,
    ...(typeof opts.args['action'] === 'string' ? { action: opts.args['action'] } : {}),
    ...(opts.error ? { error: opts.error } : {}),
  };

  try {
    await opts.sessions.appendHistory(sessionId, entry);
  } catch (error) {
    // history 只是审计，写失败不能影响工具结果
    opts.logger.event('history-write-failed', { session: sessionId, error: errorMessage(error) });
  }
}

export function toCallToolResult(result: unknown): CallToolResult {
  if (isCallToolResult(result)) return result;
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content);
}

/** 日志里的调用入参：不打印文件正文，只记长度。 */
function callFields(args: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'content') {
      fields['contentBytes'] = typeof value === 'string' ? value.length : undefined;
      continue;
    }
    // 日志里统一叫 session，避免 sessionId / session 两种叫法混用
    fields[key === 'sessionId' ? 'session' : key] = value;
  }
  return fields;
}

function fileFields(info: ToolCallInfo): Record<string, unknown> {
  return info.files?.length ? { files: info.files } : {};
}

/** 日志里的结果摘要：内容以 content block 返回时只记块数与类型，避免刷爆终端。 */
function resultSummary(result: unknown): unknown {
  if (isCallToolResult(result)) {
    return {
      blocks: result.content.length,
      types: result.content.map((block) => (block as { type?: string }).type ?? 'unknown'),
    };
  }
  return result;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
