import { displayWidth, padToWidth, paint, truncateToWidth, wrapToWidth, type AnsiStyle } from './ansi.js';

export type LogLevel = 'debug' | 'info' | 'off';

export type ToolPhase = 'call' | 'done' | 'fail' | 'required' | 'approved' | 'declined';

export interface ToolLogEntry {
  /** 单调递增的调用序号，用于把同一次调用的各个阶段串起来 */
  id: number;
  tool: string;
  phase: ToolPhase;
  ms?: number;
  error?: string;
  /** 安全确认事件的风险等级，用于区分 APPROVAL REQUIRED / RISK UNKNOWN */
  riskLevel?: 'dangerous' | 'unknown';
  /** call 阶段：对什么操作（命令首行 / 解析后的路径 / `action name`） */
  target?: string;
  /** approved / declined 阶段：展示用的风险标签 `kind · reason` */
  riskLabel?: string;
  /** approved / declined 阶段：补充说明（拒绝原因等） */
  note?: string;
  /** 卡片字段（required / done / fail 阶段），按插入顺序渲染 */
  fields?: Record<string, unknown>;
}

export interface Logger {
  readonly level: LogLevel;
  tool(entry: ToolLogEntry): void;
  /** `level` 默认 info；debug 级事件在 info 级别下不输出（例如原始 HTTP 请求） */
  event(name: string, fields?: Record<string, unknown>, level?: LogLevel): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
  /** 强制开关 ANSI 颜色；默认按 TTY + NO_COLOR 判断 */
  colors?: boolean;
  /** 卡片宽度；默认取终端 columns 并夹在 [MIN_WIDTH, MAX_WIDTH] */
  columns?: number;
}

const MAX_VALUE_LENGTH = 400;
const LABEL_WIDTH = 9;
const MIN_WIDTH = 64;
const MAX_WIDTH = 100;
const DEFAULT_WIDTH = 88;
const SLOW_MS = 3_000;

/** 工具名 → 稳定颜色（同一工具跨调用颜色一致）。 */
const TOOL_COLORS: Record<string, string> = {
  session: '36',
  skills: '35',
  mcp_tool: '38;5;45',
  read: '34',
  write: '33',
  edit: '32',
  trash: '38;5;160',
  shell: '38;5;208',
  export: '38;5;141',
};

/** 有完整卡片的阶段；`call` / `approved` / `declined` 只占一行（见 progressLine）。 */
type CardPhase = 'done' | 'fail' | 'required';

const STATUS: Record<CardPhase, { label: string; style: AnsiStyle }> = {
  done: { label: 'SUCCESS', style: { color: '32' } },
  fail: { label: 'FAILED', style: { color: '31' } },
  required: { label: 'APPROVAL REQUIRED', style: { color: '33', bold: true } },
};

export function resolveLogLevel(raw: string | undefined | null): LogLevel {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'off':
    case 'quiet':
      return 'off';
    case 'info':
      return 'info';
    default:
      return 'debug';
  }
}

/** 人类可读耗时：`42ms` / `1.8s` / `2m01s`。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** 颜色策略：`NO_COLOR` / `TERM=dumb` 优先于 TTY；非 TTY 不加 ANSI。 */
export function resolveColorMode(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (env['NO_COLOR'] !== undefined) return false;
  if (env['TERM'] === 'dumb') return false;
  return isTty;
}

function defaultColumns(): number {
  const columns = process.stderr.columns ?? process.stdout.columns;
  return typeof columns === 'number' && Number.isFinite(columns) ? clamp(columns) : DEFAULT_WIDTH;
}

function clamp(value: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(value)));
}

/** 卡片字段值：字符串原样展示（不打印文件正文，正文由调用方替换成摘要）。 */
function fieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = JSON.stringify(value);
  return json === undefined ? undefined : json;
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

/** 事件行字段：字符串 JSON 化（带引号），其它走 JSON —— 保持与旧日志兼容的可读格式。 */
function formatEventFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  const parts: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const text =
      typeof value === 'string'
        ? JSON.stringify(truncate(value))
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : truncate(JSON.stringify(value) ?? '');
    parts.push(`${key}=${text}`);
  }

  return parts.join(' ');
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'debug';
  const sink = opts.write ?? ((line: string) => void process.stderr.write(line));
  const now = opts.now ?? (() => new Date());
  // 自定义 sink（测试 / 重定向）默认不加 ANSI，便于 snapshot 与 diff
  const colors =
    opts.colors ?? (opts.write ? false : resolveColorMode(process.env, process.stderr.isTTY === true));
  const columns = opts.columns !== undefined ? clamp(opts.columns) : defaultColumns();

  const emit = (body: string) => {
    if (level !== 'off') sink(`${body}\n`);
  };

  const renderCard = (entry: ToolLogEntry, phase: CardPhase): string[] => {
    const lines: string[] = [];

    // 卡片头：工具名 + 编号 + 状态（+ 耗时），时间戳右对齐在填充区末端
    const toolColor = TOOL_COLORS[entry.tool] ?? '37';
    const name = paint(entry.tool.toUpperCase(), { color: toolColor, bold: true }, colors);
    const status = STATUS[phase];
    const unknown = phase === 'required' && entry.riskLevel === 'unknown';
    const label = unknown ? 'RISK UNKNOWN' : status.label;
    const statusStyle: AnsiStyle = unknown ? { color: '33', bold: true } : status.style;

    const duration = entry.ms === undefined ? undefined : formatDuration(entry.ms);
    const slow = duration !== undefined && (entry.ms ?? 0) >= SLOW_MS;
    const clockText = paint(now().toISOString().slice(11, 23), { dim: true }, colors);
    const rightText =
      duration === undefined
        ? clockText
        : `${paint(duration, slow ? { color: '33', bold: true } : { dim: true }, colors)}  ${clockText}`;

    const head = `${name}  #${entry.id}  ${paint(label, statusStyle, colors)}`;
    const used = 3 + displayWidth(head) + 2 + displayWidth(rightText) + 2;
    const fill = Math.max(1, columns - used);
    const headLine = `┌─ ${head} ${paint('─'.repeat(fill), { dim: true }, colors)} ${rightText} ┐`;
    lines.push(headLine);

    const inner = columns - 4;
    const valueWidth = Math.max(8, inner - LABEL_WIDTH);

    for (const [key, raw] of Object.entries(entry.fields ?? {})) {
      const value = fieldValue(raw);
      if (value === undefined) continue;
      renderField(lines, key, truncate(value), valueWidth, colors);
    }

    if (entry.phase === 'fail') {
      renderField(lines, 'error', truncate(entry.error ?? 'unknown error'), valueWidth, colors, { color: '31' });
    }

    lines.push(`└${'─'.repeat(Math.max(1, columns - 2))}┘`);
    return lines;
  };

  return {
    level,
    tool(entry) {
      if (level === 'off') return;

      const phase = entry.phase;
      const line = (): string => {
        const timestamp = now().toISOString();
        // 时间戳也占宽度，剩下的才是单行内容的可用列数
        return `${timestamp} ${progressLine(entry, colors, Math.max(1, columns - timestamp.length - 1))}`;
      };

      if (phase === 'call') {
        // 调用起点只占一行，且只在 debug 输出（完整信息都在结果/确认卡片里）
        if (level === 'debug') sink(`${line()}\n`);
        return;
      }

      if (phase === 'approved' || phase === 'declined') {
        // 确认结果也只占一行：完整上下文在 required 卡片与结果卡片上
        sink(`${line()}\n`);
        return;
      }

      for (const cardLine of renderCard(entry, phase)) sink(`${cardLine}\n`);
    },
    event(name, fields, eventLevel = 'info') {
      if (level === 'off') return;
      if (eventLevel === 'debug' && level !== 'debug') return;

      const body = formatEventFields(fields);
      if (eventLevel === 'debug') {
        // 底层诊断信息：视觉层级弱于工具卡片
        emit(`${now().toISOString()} ${paint(`· ${name}`, { dim: true }, colors)}${body ? ` ${body}` : ''}`);
        return;
      }
      emit(`${now().toISOString()} event ${paint(name, { color: '36' }, colors)}${body ? ` ${body}` : ''}`);
    },
  };
}

/** 调用起点 / 确认结果：单行状态，不重复结果卡片里的字段。 */
function progressLine(entry: ToolLogEntry, colors: boolean, width: number): string {
  const tool = paint(entry.tool.toUpperCase(), { color: TOOL_COLORS[entry.tool] ?? '37', bold: true }, colors);
  const id = paint(`#${entry.id}`, { dim: true }, colors);

  if (entry.phase === 'call') {
    const arrow = paint('→', { dim: true }, colors);
    return truncateToWidth(`${arrow} ${tool} ${id}${entry.target ? `  ${entry.target}` : ''}`, width);
  }

  const approved = entry.phase === 'approved';
  const symbol = paint(approved ? '✓' : '✗', { color: approved ? '32' : '31', bold: true }, colors);
  // 拒绝时只留原因（风险标签已经在 required 卡片上给过了）；确认通过则留风险标签
  const detail = entry.note ?? entry.riskLabel ?? '';
  return truncateToWidth(`${symbol} ${tool} ${id}${detail ? `  ${detail}` : ''}`, width);
}

function renderField(
  lines: string[],
  label: string,
  value: string,
  width: number,
  colors: boolean,
  style: AnsiStyle = {},
): void {
  const labelText = paint(label.padEnd(LABEL_WIDTH), { dim: true }, colors);

  for (const line of wrapToWidth(value, width)) {
    const painted = paint(line, style, colors);
    // 补白按可见宽度计算，ANSI 不计入
    lines.push(`│ ${labelText}${padToWidth(painted, width)} │`);
  }
}
