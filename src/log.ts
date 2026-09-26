export type LogLevel = 'debug' | 'info' | 'off';

export interface ToolLogEntry {
  /** 单调递增的调用序号，用于把 call / done / fail 串起来 */
  id: number;
  tool: string;
  phase: 'call' | 'done' | 'fail';
  ms?: number;
  error?: string;
  fields?: Record<string, unknown>;
}

export interface Logger {
  readonly level: LogLevel;
  tool(entry: ToolLogEntry): void;
  event(name: string, fields?: Record<string, unknown>): void;
}

const MAX_VALUE_LENGTH = 400;
const PHASE_WIDTH = 5;
const TOOL_WIDTH = 10;

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

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

/** 字符串统一 JSON 化（带引号、可转义），数字/布尔裸值，对象/数组走 JSON。 */
function formatValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(truncate(value));
  const json = JSON.stringify(value);
  return json === undefined ? undefined : truncate(json);
}

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const formatted = formatValue(value);
    if (formatted !== undefined) parts.push(`${key}=${formatted}`);
  }
  return parts.join(' ');
}

function join(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}

export function createLogger(
  opts: { level?: LogLevel; write?: (line: string) => void; now?: () => Date } = {},
): Logger {
  const level = opts.level ?? 'debug';
  const write = opts.write ?? ((line: string) => void process.stderr.write(line));
  const now = opts.now ?? (() => new Date());

  const emit = (body: string) => {
    if (level !== 'off') write(`${now().toISOString()} ${body}\n`);
  };

  return {
    level,
    tool(entry) {
      if (level === 'off') return;
      if (level === 'info' && entry.phase === 'call') return;

      const head = `${entry.phase.padEnd(PHASE_WIDTH)} #${entry.id}  ${entry.tool.padEnd(TOOL_WIDTH)}`;
      const body =
        entry.phase === 'call'
          ? join([head, formatFields(entry.fields)])
          : entry.phase === 'done'
            ? join([head, 'ok', formatFields({ ms: entry.ms, ...entry.fields })])
            : join([
                head,
                formatFields({ ms: entry.ms, error: entry.error ?? 'unknown error', ...entry.fields }),
              ]);

      emit(body);
    },
    event(name, fields) {
      if (level === 'off') return;
      emit(join([`event ${name}`, formatFields(fields)]));
    },
  };
}
