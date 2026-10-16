/**
 * 终端排版小工具：卡片宽度、可见列宽、ANSI 着色。
 * 不引入第三方终端 UI 依赖；所有函数都是纯字符串处理，便于单测。
 */

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export interface AnsiStyle {
  /** 前景色 / 样式码，例如 `32`、`38;5;208` */
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

/** 是否为东亚宽字符（终端占 2 列）。 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 零宽字符：组合符号、零宽连接符、变体选择符。 */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  );
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** 清理不可信输出中的终端控制序列，保留普通文本、换行与 tab。 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (isZeroWidth(code)) return 0;
  if (isWide(code)) return 2;
  return 1;
}

/** 可见列宽：跳过 ANSI 转义，东亚宽字符按 2 列计。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) width += charWidth(char);
  return width;
}

export function paint(text: string, style: AnsiStyle, enabled: boolean): string {
  if (!enabled || (!style.color && !style.bold && !style.dim)) return text;

  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.color) codes.push(style.color);
  return `\u001b[${codes.join(';')}m${text}\u001b[0m`;
}

/** 按可见宽度截断（保留 ANSI 序列，超出部分用 … 收尾）。 */
export function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return '…';

  let result = '';
  let used = 0;

  for (const unit of ansiUnits(text)) {
    if (unit.ansi) {
      result += unit.text;
      continue;
    }
    const size = charWidth(unit.text);
    if (used + size > width - 1) break;
    result += unit.text;
    used += size;
  }

  // 截断可能把未闭合的颜色留在行尾：补一个 reset，避免颜色泄到后续输出
  return text.includes('\u001b') ? `${result}…\u001b[0m` : `${result}…`;
}

/**
 * 按可见宽度换行：超宽时硬断（保留 ANSI 序列），并按 `\n` 分行。
 * 返回至少一行（空串也返回 ['']）。
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];

  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let current = '';
    let used = 0;

    for (const unit of ansiUnits(raw)) {
      const size = unit.ansi ? 0 : charWidth(unit.text);
      if (!unit.ansi && used + size > width) {
        lines.push(current);
        current = '';
        used = 0;
      }
      current += unit.text;
      used += size;
    }

    lines.push(current);
  }

  return lines.length > 0 ? lines : [''];
}

interface AnsiUnit {
  text: string;
  ansi: boolean;
}

/** 把字符串切成「ANSI 序列」与「单个字符」两类单元，便于按可见宽度处理。 */
function ansiUnits(text: string): AnsiUnit[] {
  const units: AnsiUnit[] = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] === '\u001b') {
      const match = /^\u001b\[[0-9;]*m/.exec(text.slice(index));
      if (match) {
        units.push({ text: match[0], ansi: true });
        index += match[0].length;
        continue;
      }
    }

    const char = String.fromCodePoint(text.codePointAt(index)!);
    units.push({ text: char, ansi: false });
    index += char.length;
  }

  return units;
}
