import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod/v4';
import { ToolError } from './errors.js';

/** 危险工具重试时携带的审批参数。 */
export const APPROVAL_INPUT_FIELDS = {
  approvalToken: z
    .string()
    .min(1)
    .optional()
    .describe('危险操作审核卡片返回的一次性 token；仅在用户做出审核决定后原样回传'),
  approvalDecision: z
    .enum(['approve', 'cancel'])
    .optional()
    .describe('用户在审核卡片中的选择：approve=确认执行，cancel=取消'),
};

export type ApprovalRisk = 'dangerous' | 'unknown';
export type ApprovalDecision = 'approve' | 'cancel';

/** 绑进 approval token 的最小事实：换 session / 换工具 / 换业务参数都必须重新审核；goal / reason 仅用于审计，不参与授权比对。 */
export interface ApprovalState {
  v: 1;
  sessionId: string;
  tool: string;
  argsHash: string;
  /** 可选的业务前置状态摘要；用于审批等待期间检测文件等内容是否变化。 */
  contextHash?: string;
  risk: ApprovalRisk;
}

export interface ApprovalOption {
  id: ApprovalDecision;
  label: string;
  style: 'danger' | 'secondary';
}

export interface ApprovalRequiredResult {
  resultType: 'approval_required';
  approvalRequired: true;
  approvalToken: string;
  approval: {
    title: string;
    risk: ApprovalRisk;
    riskLabel: string;
    summary: string;
    message: string;
    presentation: string;
    options: ApprovalOption[];
  };
}

/** 观察钩子：工具把安全确认事件交给 registry 统一渲染到终端卡片。 */
export interface ToolApprovalEvent {
  phase: 'required' | 'approved' | 'declined';
  risk: ApprovalRisk;
  /** 展示用风险标签，例如 `git.commit · 会创建本地 Git 提交` */
  riskLabel: string;
  /** 卡片上的补充说明（拒绝/取消原因等） */
  note?: string;
  /** 卡片上额外展示的字段（command / path 等） */
  fields?: Record<string, unknown>;
}

export interface ToolObserver {
  approval(event: ToolApprovalEvent): void;
}

interface StoredApproval {
  state: ApprovalState;
  expiresAt: number;
}

/**
 * 进程级一次性 approval token 存储。
 *
 * token 使用 192-bit 随机数，不携带任何可由客户端修改的状态；状态只保存在服务端内存中。
 * 服务重启后 token 自然失效，TTL 默认 10 分钟。
 */
export interface ApprovalCodec {
  mint(state: ApprovalState): Promise<string>;
  verify(token: string): Promise<ApprovalState>;
  consume(token: string): Promise<ApprovalState>;
}

export function createApprovalCodec(opts: { ttlSeconds?: number } = {}): ApprovalCodec {
  const ttlMs = (opts.ttlSeconds ?? 600) * 1000;
  const tokens = new Map<string, StoredApproval>();

  function lookup(token: string): StoredApproval {
    const record = tokens.get(token);
    if (!record || record.expiresAt <= Date.now()) {
      tokens.delete(token);
      throw new ToolError('approvalToken 无效或已过期，请重新发起审核');
    }
    return record;
  }

  return {
    async mint(state) {
      let token: string;
      do {
        token = `apr_${randomBytes(24).toString('base64url')}`;
      } while (tokens.has(token));

      tokens.set(token, { state, expiresAt: Date.now() + ttlMs });
      return token;
    },
    async verify(token) {
      return lookup(token).state;
    },
    async consume(token) {
      const record = lookup(token);
      tokens.delete(token);
      return record.state;
    },
  };
}

/** 参数摘要：用于把 approval token 绑定到具体调用参数（goal / reason 与审批字段不参与）。 */
export function hashArgs(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

export interface ApprovalPrompt {
  risk: ApprovalRisk;
  /** 展示用风险标签：`kind · reason` */
  riskLabel: string;
  /** 一句话描述这次调用（用于审核卡片与拒绝信息） */
  summary: string;
  /** 审核卡片正文 */
  message: string;
  fields?: Record<string, unknown>;
}

/**
 * 普通 tool-result 审批门禁：
 * - 首轮 → 签发一次性随机 approvalToken，返回 approval_required 审核卡片，不执行副作用。
 * - 用户取消 → 校验 token 后消费并拒绝执行。
 * - 用户确认 → token 必须与 session / tool / 业务参数匹配；goal / reason 可变化或省略，消费后才允许继续执行。
 *
 * 这个流程不依赖 MCP elicitation / input_required，因此可穿过不支持 MRTR 的客户端桥接层。
 */
export async function enforceApproval(opts: {
  codec: ApprovalCodec;
  sessionId: string;
  tool: string;
  argsHash: string;
  contextHash?: string;
  contextMismatchMessage?: string;
  approvalToken?: string;
  approvalDecision?: ApprovalDecision;
  prompt: ApprovalPrompt;
  observer?: ToolObserver;
}): Promise<ApprovalRequiredResult | null> {
  const {
    codec,
    sessionId,
    tool,
    argsHash,
    contextHash,
    contextMismatchMessage,
    approvalToken,
    approvalDecision,
    prompt,
    observer,
  } = opts;

  if (!approvalToken) {
    const token = await codec.mint({
      v: 1,
      sessionId,
      tool,
      argsHash,
      ...(contextHash ? { contextHash } : {}),
      risk: prompt.risk,
    });
    observer?.approval({
      phase: 'required',
      risk: prompt.risk,
      riskLabel: prompt.riskLabel,
      ...(prompt.fields ? { fields: prompt.fields } : {}),
    });

    return {
      resultType: 'approval_required',
      approvalRequired: true,
      approvalToken: token,
      approval: {
        title: '高风险操作确认',
        risk: prompt.risk,
        riskLabel: prompt.riskLabel,
        summary: prompt.summary,
        message: prompt.message,
        presentation:
          '请将此请求渲染为审核卡片，并向用户提供“确认执行”和“取消”选项；必须由用户选择，不得代替用户做决定。',
        options: [
          { id: 'approve', label: '确认执行', style: 'danger' },
          { id: 'cancel', label: '取消', style: 'secondary' },
        ],
      },
    };
  }

  const state = await codec.verify(approvalToken);
  const matches =
    state.v === 1 &&
    state.sessionId === sessionId &&
    state.tool === tool &&
    state.argsHash === argsHash;

  if (!matches) {
    throw new ToolError('approvalToken 与当前调用不匹配，请重新发起审核');
  }

  if (approvalDecision === 'cancel') {
    await codec.consume(approvalToken);
    observer?.approval({
      phase: 'declined',
      risk: prompt.risk,
      riskLabel: prompt.riskLabel,
      note: '用户取消执行',
      ...(prompt.fields ? { fields: prompt.fields } : {}),
    });
    throw new ToolError(`用户取消执行：${prompt.summary}`);
  }

  if (state.contextHash !== contextHash) {
    throw new ToolError(contextMismatchMessage ?? 'approvalToken 与当前调用不匹配，请重新发起审核');
  }

  if (approvalDecision !== 'approve') {
    throw new ToolError('携带 approvalToken 重试时必须同时提供 approvalDecision=approve 或 cancel');
  }

  await codec.consume(approvalToken);
  observer?.approval({
    phase: 'approved',
    risk: prompt.risk,
    riskLabel: prompt.riskLabel,
    ...(prompt.fields ? { fields: prompt.fields } : {}),
  });
  return null;
}

export function isApprovalRequiredResult(value: unknown): value is ApprovalRequiredResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record['resultType'] === 'approval_required' && record['approvalRequired'] === true;
}

/**
 * workspace 是文件类工具（write / edit / fetch）的信任边界：目标真实路径落在 workspace 之外
 * 一律 dangerous，必须用户通过审核卡片确认后才能操作。
 *
 * `target === null` 表示真实路径无法解析（symlink 环 / 权限等），同样 fail closed。
 */
export async function enforceWorkspaceBoundary(opts: {
  codec: ApprovalCodec;
  sessionId: string;
  tool: string;
  argsHash: string;
  approvalToken?: string;
  approvalDecision?: ApprovalDecision;
  /** 动作用词，用于确认文案：写入 / 编辑 / 获取 */
  action: string;
  /** resolve 之后的请求路径 */
  path: string;
  /** 解析出的真实目标；null = 无法解析 */
  target: string | null;
  workspace: string;
  fields?: Record<string, unknown>;
  observer?: ToolObserver;
}): Promise<ApprovalRequiredResult | null> {
  const unresolved = opts.target === null;
  const shown = opts.target ?? opts.path;

  return enforceApproval({
    codec: opts.codec,
    sessionId: opts.sessionId,
    tool: opts.tool,
    argsHash: opts.argsHash,
    ...(opts.approvalToken ? { approvalToken: opts.approvalToken } : {}),
    ...(opts.approvalDecision ? { approvalDecision: opts.approvalDecision } : {}),
    ...(opts.observer ? { observer: opts.observer } : {}),
    prompt: {
      risk: 'dangerous',
      riskLabel: unresolved
        ? `${opts.tool}.unresolved · 无法解析目标真实路径，按 fail closed 要求确认`
        : `${opts.tool}.outside-workspace · 目标文件的真实路径位于 session.workspace 之外`,
      summary: shown,
      message: [
        `这个${opts.action}目标的真实路径在 session.workspace 之外（workspace 是文件类工具的信任边界）：`,
        '',
        `请求路径：${opts.path}`,
        `真实目标：${shown}`,
        `workspace：${opts.workspace}`,
        ...(unresolved ? ['', '目标真实路径无法解析（可能是 symlink 环或权限问题），按 fail closed 处理。'] : []),
      ].join('\n'),
      fields: { path: opts.path, ...(opts.target ? { target: opts.target } : {}), ...(opts.fields ?? {}) },
    },
  });
}
