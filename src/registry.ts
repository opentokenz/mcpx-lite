import {
  isCallToolResult,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { isApprovalRequiredResult, type ToolObserver } from './approval.js';
import { ToolError } from './errors.js';
import type { Logger } from './log.js';
import { resolvePath } from './session.js';
import type { HistoryEntry, SessionFile, SessionStore } from './session.js';

export interface ToolCallInfo {
  /** history 与日志里的「对什么操作」：解析后的路径 / 命令首行 / `action name` */
  target: string;
  /** 本次调用涉及的文件（日志用） */
  files?: string[];
  /** 卡片上展示的工具专属字段（command / path / action 等），保持插入顺序 */
  fields?: Record<string, unknown>;
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
  handler: (
    args: any,
    ctx: ServerContext,
    session: SessionFile | undefined,
    observe: ToolObserver,
  ) => Promise<unknown>;
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
  handler: (
    args: z.output<S>,
    ctx: ServerContext,
    session: SessionFile | undefined,
    observe: ToolObserver,
  ) => Promise<unknown>;
}): ToolDef {
  return def as unknown as ToolDef;
}

let callSequence = 0;

/** 路径类工具（read / write / edit / export）共用的 history 与日志目标。 */
export function describePath(session: SessionFile | undefined, path: string): ToolCallInfo {
  const fields = { path };
  try {
    const absolute = session ? resolvePath(session.workspace, path) : path;
    return absolute ? { target: absolute, files: [absolute], fields } : { target: '', fields };
  } catch {
    return { target: String(path ?? ''), fields };
  }
}

/** 每个工具都必须携带的两个审计字段（描述一致，避免七个工具各写一份）。 */
const GOAL_FIELD = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe('可选审计字段：本次要达成的整体目标（写入 session history）');
const REASON_FIELD = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe('可选审计字段：为什么现在需要这一步调用（写入 session history）');

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
 * 一次工具调用的统一包装：观测卡片 + 安全确认事件 + history 审计 + 错误收敛。
 * 工具本身不写日志，也不处理「预期失败 → isError」的转换。
 */
async function executeTool(opts: {
  tool: ToolDef;
  args: Record<string, unknown>;
  ctx: ServerContext;
  sessions: SessionStore;
  logger: Logger;
}): Promise<CallToolResult | InputRequiredResult> {
  const { tool, args, ctx, sessions, logger } = opts;
  const id = (callSequence += 1);
  const startedAt = Date.now();

  let info: ToolCallInfo = { target: '' };
  let sessionWorkspace: string | undefined;
  const fields = (): Record<string, unknown> => ({
    ...auditFields(args),
    ...(info.fields ?? {}),
  });

  const observer: ToolObserver = {
    approval(event) {
      // required 是用户做决定的那一刻：给完整卡片；approved / declined 只留一行审计
      logger.tool({
        id,
        tool: tool.name,
        phase: event.phase,
        riskLevel: event.risk,
        riskLabel: event.riskLabel,
        target: info.target,
        workspace: sessionWorkspace,
        ...(event.note ? { note: event.note } : {}),
        ...(event.phase === 'required'
          ? { fields: { ...fields(), ...(event.fields ?? {}), risk: event.riskLabel } }
          : {}),
      });
    },
  };

  try {
    const session = tool.requiresSession ? await sessions.load(String(args['sessionId'] ?? '')) : undefined;
    sessionWorkspace = session?.workspace;
    info = tool.describeCall?.(args, session) ?? { target: '' };

    logger.tool({ id, tool: tool.name, phase: 'call', target: info.target, workspace: sessionWorkspace, fields: fields() });

    const result = await tool.handler(args, ctx, session, observer);

    if (isApprovalRequiredResult(result)) {
      // 等待用户在审核卡片中做决定：还没有任何副作用，不写 history
      return toCallToolResult(result);
    }

    logger.tool({
      id,
      tool: tool.name,
      phase: 'done',
      ms: Date.now() - startedAt,
      target: info.target,
      workspace: sessionWorkspace,
      fields: { ...fields(), ...resultFields(result) },
    });
    await recordHistory({
      sessions,
      logger,
      tool,
      args,
      info,
      ok: true,
      summary: historySummary(result, info),
    });

    return toCallToolResult(result);
  } catch (error) {
    const message = errorMessage(error);
    logger.tool({
      id,
      tool: tool.name,
      phase: 'fail',
      ms: Date.now() - startedAt,
      error: message,
      target: info.target,
      workspace: sessionWorkspace,
      fields: fields(),
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
  summary?: string | undefined;
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
    ...(opts.summary ? { summary: opts.summary } : {}),
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

function historySummary(result: unknown, info: ToolCallInfo): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as Record<string, unknown>;
  const parts: string[] = [];
  const files = info.files ?? [];

  if (files.length > 0) parts.push(`${files.length} paths`);
  if (typeof value['files'] === 'number') parts.push(`${value['files']} files`);
  if (typeof value['replacements'] === 'number') parts.push(`${value['replacements']} replacements`);
  if (typeof value['succeeded'] === 'number') parts.push(`${value['succeeded']} succeeded`);
  if (typeof value['failed'] === 'number') parts.push(`${value['failed']} failed`);

  if (parts.length === 0) return undefined;
  if (files.length > 0) {
    const shown = files.slice(0, 3);
    const remaining = files.length - shown.length;
    parts.push(`${shown.join(', ')}${remaining > 0 ? `, +${remaining} more` : ''}`);
  }
  return parts.join('; ');
}

export function toCallToolResult(result: unknown): CallToolResult | InputRequiredResult {
  if (isCallToolResult(result) || isInputRequiredResult(result)) return result;
  if (isApprovalRequiredResult(result)) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

/** 卡片最前面的三个审计字段：会话、目标、原因。 */
function auditFields(args: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  const session = args['sessionId'];
  if (typeof session === 'string' && session) fields['session'] = session;
  const goal = args['goal'];
  if (typeof goal === 'string' && goal) fields['goal'] = goal;
  const reason = args['reason'];
  if (typeof reason === 'string' && reason) fields['reason'] = reason;

  return fields;
}

function resultFields(result: unknown): Record<string, unknown> {
  return summarizeResult(result);
}

function summarizeResult(result: unknown): Record<string, unknown> {
  if (isCallToolResult(result)) {
    const types = result.content.map((block) => (block as { type?: string }).type ?? 'unknown');
    const count = result.content.length;
    return { result: `${count} block${count === 1 ? '' : 's'} · ${types.join(', ')}` };
  }

  if (typeof result === 'object' && result !== null) {
    const value = result as Record<string, unknown>;
    const stdout = typeof value['stdout'] === 'string' ? value['stdout'] : undefined;
    const stderr = typeof value['stderr'] === 'string' ? value['stderr'] : undefined;

    if (stdout !== undefined || stderr !== undefined || typeof value['exitCode'] === 'number') {
      const parts: string[] = [];
      if (typeof value['exitCode'] === 'number') parts.push(`exit ${value['exitCode']}`);
      if (value['timedOut'] === true) parts.push('timed out');
      parts.push(`stderr ${stderr?.length ?? 0} chars`);
      if (value['stdoutTruncated'] === true) parts.push('stdout truncated');
      if (value['stderrTruncated'] === true) parts.push('stderr truncated');
      return {
        result: parts.join(' · '),
        ...(stdout ? { stdout } : {}),
        ...(stderr ? { stderr } : {}),
      };
    }

    if (typeof value['files'] === 'number' && typeof value['replacements'] === 'number') {
      return { result: `files ${value['files']} · replacements ${value['replacements']}` };
    }
    if (typeof value['succeeded'] === 'number' && typeof value['failed'] === 'number') {
      return { result: `${value['succeeded']} succeeded · ${value['failed']} failed` };
    }
    if (Array.isArray(value['skills'])) return { result: `${value['skills'].length} skills` };
    if (Array.isArray(value['servers'])) return { result: `${value['servers'].length} servers` };
    if (typeof value['returnedLines'] === 'number') {
      const total = typeof value['totalLines'] === 'number' ? `/${value['totalLines']}` : '';
      return { result: `${value['returnedLines']}${total} lines` };
    }
    if (typeof value['bytes'] === 'number') return { result: `${value['bytes']} bytes` };

    const json = JSON.stringify(value);
    return { result: json.length > 160 ? `${json.slice(0, 160)}…` : json };
  }

  return { result: String(result) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
