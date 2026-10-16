import { describe, expect, it } from 'vitest';
import { displayWidth, stripAnsi, truncateToWidth, wrapToWidth } from '../src/ansi.js';

const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

describe('displayWidth', () => {
  it('ASCII 按 1 列、东亚宽字符按 2 列', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中b')).toBe(4);
    expect(displayWidth('')).toBe(0);
  });

  it('ANSI 转义不计入可见宽度', () => {
    expect(displayWidth(`${BOLD}shell${RESET}`)).toBe(5);
    expect(displayWidth(`${BOLD}提交${RESET}`)).toBe(4);
  });
});

describe('truncateToWidth', () => {
  it('未超宽时原样返回', () => {
    expect(truncateToWidth('abc', 10)).toBe('abc');
    expect(truncateToWidth('中文', 4)).toBe('中文');
  });

  it('超宽时按可见宽度截断并补省略号', () => {
    const truncated = truncateToWidth('abcdefghij', 5);

    expect(truncated).toBe('abcd…');
    expect(displayWidth(truncated)).toBe(5);
  });

  it('截断后补回 ANSI reset，避免颜色泄到后续输出', () => {
    const truncated = truncateToWidth(`${BOLD}abcdef${RESET}`, 4);

    expect(truncated.endsWith(RESET)).toBe(true);
    expect(displayWidth(truncated)).toBe(4);
    expect(stripAnsi(truncated)).toBe('abc…');
  });

  it('宽字符不会被截成半格', () => {
    const truncated = truncateToWidth('中中中中', 5);

    expect(truncated).toBe('中中…');
    expect(displayWidth(truncated)).toBe(5);
  });
});

describe('wrapToWidth', () => {
  it('按可见宽度硬换行，宽字符算 2 列', () => {
    expect(wrapToWidth('abcdef', 3)).toEqual(['abc', 'def']);
    expect(wrapToWidth('中中中', 4)).toEqual(['中中', '中']);
  });

  it('按 \\n 分行并保留空行', () => {
    expect(wrapToWidth('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });

  it('保留 ANSI 序列且不计入宽度', () => {
    const lines = wrapToWidth(`${BOLD}abcdef${RESET}`, 3);

    expect(lines).toEqual([`${BOLD}abc`, `def${RESET}`]);
    expect(lines.map(displayWidth)).toEqual([3, 3]);
  });
});

describe('stripAnsi', () => {
  it('去掉转义序列', () => {
    expect(stripAnsi(`${BOLD}hi${RESET}`)).toBe('hi');
  });
});
