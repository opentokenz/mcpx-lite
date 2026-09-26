import { isAbsolute, relative, sep } from 'node:path';
import { displayWidth, paint, sanitizeTerminalText, truncateToWidth, wrapToWidth } from './ansi.js';

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
  /** session.workspace；用于把 workspace 内文件路径显示成相对路径 */
  workspace?: string;
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
const STDOUT_PREVIEW_LENGTH = 800;
const MIN_WIDTH = 40;
const MAX_WIDTH = 160;
const DEFAULT_WIDTH = 100;
const SLOW_MS = 3_000;

/** 工具调用 → agent transcript 动词。 */
const TOOL_VERBS: Record<string, string> = {
  session: 'Session',
  skills: 'Skills',
  mcp_tool: 'MCP',
  read: 'Read',
  write: 'Wrote',
  edit: 'Edited',
  trash: 'Trashed',
  shell: 'Ran',
  export: 'Exported',
};

const AUDIT_KEYS = new Set(['session', 'goal', 'reason']);
const TARGET_KEYS = new Set(['command', 'path', 'paths']);
const OUTPUT_KEYS = new Set(['stdout', 'stderr']);
const RESULT_KEYS = new Set(['result', 'risk']);

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

/** 需要渲染结果块的阶段；`call` / `approved` / `declined` 只占一行。 */
type CardPhase = 'done' | 'fail' | 'required';

const APPROVAL_REQUIRED_LABEL = 'APPROVAL REQUIRED';

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

/** 事件行字段：字符串 JSON 化（带引号），其它走 JSON，保持可读格式。 */
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

function toolVerb(tool: string): string {
  return TOOL_VERBS[tool] ?? tool;
}

function fieldText(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(String).join(', ');
  return fieldValue(value);
}

function targetText(entry: ToolLogEntry): string | undefined {
  if (entry.target?.trim()) return displayTarget(entry, entry.target.trim());
  const fields = entry.fields ?? {};
  for (const key of TARGET_KEYS) {
    const value = fieldText(fields[key]);
    if (value) return displayTarget(entry, value);
  }
  return undefined;
}

function displayTarget(entry: ToolLogEntry, target: string): string {
  if (!entry.workspace || !isAbsolute(target)) return target;
  const rel = relative(entry.workspace, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return target;
  return rel;
}

function titleLine(entry: ToolLogEntry, columns: number, colors: boolean): string {
  const target = targetText(entry);
  const bullet = paint('•', { dim: true }, colors);
  const verb = paint(toolVerb(entry.tool), { color: TOOL_COLORS[entry.tool] ?? '37', bold: true }, colors);
  const command = target ? `  ${paint(target, { color: '36' }, colors)}` : '';
  return truncateToWidth(`${bullet} ${verb}${command}`, columns);
}

function segmentLines(segments: string[], columns: number, colors: boolean): string[] {
  if (segments.length === 0) return [];
  const separator = paint(' · ', { dim: true }, colors);
  const width = Math.max(8, columns - 2);
  const lines: string[] = [];
  let current = '';

  for (const segment of segments) {
    const candidate = current ? `${current}${separator}${segment}` : segment;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(`  ${current}`);
      current = '';
    }

    const wrapped = wrapToWidth(segment, width);
    for (const line of wrapped.slice(0, -1)) lines.push(`  ${line}`);
    current = wrapped.at(-1) ?? '';
  }

  if (current) lines.push(`  ${current}`);
  return lines;
}

function auditLines(entry: ToolLogEntry, columns: number, colors: boolean): string[] {
  const fields = entry.fields ?? {};
  const segments: string[] = [];
  for (const key of ['goal', 'reason', 'session']) {
    const value = fieldText(fields[key]);
    if (value) segments.push(`${paint(key, { dim: true }, colors)} ${value}`);
  }
  return segmentLines(segments, columns, colors);
}

function detailLines(entry: ToolLogEntry, columns: number, colors: boolean): string[] {
  const fields = entry.fields ?? {};
  const segments: string[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (AUDIT_KEYS.has(key) || TARGET_KEYS.has(key) || OUTPUT_KEYS.has(key) || RESULT_KEYS.has(key)) continue;
    const value = fieldText(raw);
    if (value) segments.push(`${paint(key, { dim: true }, colors)} ${value}`);
  }
  return segmentLines(segments, columns, colors);
}

function outputLines(entry: ToolLogEntry, columns: number, colors: boolean): string[] {
  const fields = entry.fields ?? {};
  const lines: string[] = [];

  for (const [key, style] of [
    ['stdout', { dim: true }],
    ['stderr', { color: '31' }],
  ] as const) {
    const raw = fieldText(fields[key]);
    if (!raw) continue;

    const clean = sanitizeTerminalText(raw).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!clean) continue;

    const truncated = clean.length > STDOUT_PREVIEW_LENGTH;
    const preview = truncated ? clean.slice(0, STDOUT_PREVIEW_LENGTH) : clean;
    const wrapped = wrapToWidth(preview, Math.max(8, columns - 4));
    const connector = paint(key === 'stderr' ? '!' : '└', { dim: true }, colors);

    lines.push(`  ${connector} ${paint(wrapped[0] ?? '', style, colors)}`);
    for (const line of wrapped.slice(1)) lines.push(`    ${paint(line, style, colors)}`);
    if (truncated) {
      lines.push(`    ${paint(`… (+${clean.length - STDOUT_PREVIEW_LENGTH} chars)`, { dim: true }, colors)}`);
    }
  }

  return lines;
}

function statusLines(entry: ToolLogEntry, phase: CardPhase, columns: number, colors: boolean): string[] {
  const duration = entry.ms === undefined ? undefined : formatDuration(entry.ms);
  const slow = entry.ms !== undefined && entry.ms >= SLOW_MS;
  const durationText = duration === undefined ? '' : paint(duration, slow ? { color: '33', bold: true } : { dim: true }, colors);

  if (phase === 'required') {
    const unknown = entry.riskLevel === 'unknown';
    const label = unknown ? 'RISK UNKNOWN' : APPROVAL_REQUIRED_LABEL;
    const risk = fieldText(entry.fields?.['risk']) ?? entry.riskLabel;
    const line = [
      `  ${paint('!', { color: '33', bold: true }, colors)}`,
      paint(label, { color: '33', bold: true }, colors),
      ...(risk ? [`· ${risk}`] : []),
    ].join(' ');
    return wrapToWidth(truncate(line), columns);
  }

  if (phase === 'fail') {
    const error = paint(entry.error ?? 'unknown error', { color: '31' }, colors);
    const prefix = durationText ? `${durationText} · ` : '';
    return wrapToWidth(`  ${paint('✗', { color: '31', bold: true }, colors)} ${prefix}${error}`, columns);
  }

  const result = fieldText(entry.fields?.['result']);
  const parts = [durationText, result].filter((part): part is string => Boolean(part));
  const suffix = parts.length > 0 ? ` ${parts.join(' · ')}` : '';
  return wrapToWidth(`  ${paint('✓', { color: '32', bold: true }, colors)}${suffix}`, columns);
}

function renderBlock(
  entry: ToolLogEntry,
  phase: CardPhase,
  columns: number,
  colors: boolean,
  includeHeader: boolean,
): string[] {
  const lines: string[] = [];
  if (includeHeader) {
    lines.push(
      ...auditLines(entry, columns, colors),
      titleLine(entry, columns, colors),
      ...detailLines(entry, columns, colors),
    );
  }
  lines.push(...outputLines(entry, columns, colors));
  lines.push(...statusLines(entry, phase, columns, colors));
  return lines;
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

  const pendingCalls = new Map<number, ToolLogEntry>();
  let needsSeparator = false;

  const beginBlock = (): void => {
    if (needsSeparator) {
      sink('\n');
      needsSeparator = false;
    }
  };

  return {
    level,
    tool(entry) {
      if (level === 'off') return;

      const phase = entry.phase;

      if (phase === 'call') {
        pendingCalls.set(entry.id, entry);
        if (level === 'debug') {
          beginBlock();
          for (const line of [
            ...auditLines(entry, columns, colors),
            titleLine(entry, columns, colors),
            ...detailLines(entry, columns, colors),
          ]) {
            sink(`${line}\n`);
          }
        }
        return;
      }

      if (phase === 'approved' || phase === 'declined') {
        sink(`${progressLine(entry, colors, columns)}\n`);
        needsSeparator = true;
        return;
      }

      const hadPendingCall = pendingCalls.delete(entry.id);
      const includeHeader = level !== 'debug' || !hadPendingCall;
      beginBlock();
      for (const line of renderBlock(entry, phase, columns, colors, includeHeader)) sink(`${line}\n`);
      needsSeparator = true;
    },
    event(name, fields, eventLevel = 'info') {
      if (level === 'off') return;
      if (eventLevel === 'debug' && level !== 'debug') return;

      const separated = needsSeparator;
      if (separated) beginBlock();
      const body = formatEventFields(fields);
      if (eventLevel === 'debug') {
        // 底层诊断信息：视觉层级弱于工具卡片
        emit(`${now().toISOString()} ${paint(`· ${name}`, { dim: true }, colors)}${body ? ` ${body}` : ''}`);
        needsSeparator = separated;
        return;
      }
      emit(`${now().toISOString()} event ${paint(name, { color: '36' }, colors)}${body ? ` ${body}` : ''}`);
      needsSeparator = separated;
    },
  };
}

/** 确认结果：单行状态，不重复结果块里的字段。 */
function progressLine(entry: ToolLogEntry, colors: boolean, width: number): string {
  const tool = paint(entry.tool.toUpperCase(), { color: TOOL_COLORS[entry.tool] ?? '37', bold: true }, colors);
  const id = paint(`#${entry.id}`, { dim: true }, colors);

  const approved = entry.phase === 'approved';
  const symbol = paint(approved ? '✓' : '✗', { color: approved ? '32' : '31', bold: true }, colors);
  // 拒绝时只留原因（风险标签已经在 required 卡片上给过了）；确认通过则留风险标签
  const detail = entry.note ?? entry.riskLabel ?? '';
  return truncateToWidth(`${symbol} ${tool} ${id}${detail ? `  ${detail}` : ''}`, width);
}
