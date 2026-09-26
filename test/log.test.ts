import { describe, expect, it } from 'vitest';
import { displayWidth } from '../src/ansi.js';
import {
  createLogger,
  formatDuration,
  resolveColorMode,
  resolveLogLevel,
  type LoggerOptions,
  type LogLevel,
  type ToolLogEntry,
} from '../src/log.js';

const WIDTH = 72;

function collector(level: LogLevel = 'debug', opts: Partial<LoggerOptions> = {}) {
  const writes: string[] = [];
  const logger = createLogger({
    level,
    write: (line) => void writes.push(line),
    now: () => new Date('2026-09-26T08:12:41.010Z'),
    columns: WIDTH,
    ...opts,
  });

  return {
    logger,
    writes,
    get lines(): string[] {
      return writes.map((line) => line.replace(/\n$/, ''));
    },
  };
}

function shellCard(entry: Partial<ToolLogEntry> = {}): ToolLogEntry {
  return {
    id: 12,
    tool: 'shell',
    phase: 'done',
    ms: 42,
    fields: { session: 'ses_ab12cd34ef56', goal: '验证当前代码', reason: '改完 edit 后确认没破坏行为' },
    ...entry,
  };
}

/** 卡片所有行（含边框）的可见宽度必须一致，否则边框会错位。 */
function expectUniformWidth(lines: string[], width = WIDTH): void {
  expect(lines.length).toBeGreaterThan(2);
  for (const line of lines) {
    expect(displayWidth(line), line).toBe(width);
  }
}

describe('resolveLogLevel', () => {
  it('默认 debug，支持 off/quiet/info', () => {
    expect(resolveLogLevel(undefined)).toBe('debug');
    expect(resolveLogLevel('')).toBe('debug');
    expect(resolveLogLevel('debug')).toBe('debug');
    expect(resolveLogLevel('info')).toBe('info');
    expect(resolveLogLevel('off')).toBe('off');
    expect(resolveLogLevel('quiet')).toBe('off');
    expect(resolveLogLevel('nonsense')).toBe('debug');
  });
});

describe('resolveColorMode', () => {
  it('NO_COLOR 与 TERM=dumb 优先于 TTY', () => {
    expect(resolveColorMode({}, true)).toBe(true);
    expect(resolveColorMode({}, false)).toBe(false);
    expect(resolveColorMode({ NO_COLOR: '' }, true)).toBe(false);
    expect(resolveColorMode({ TERM: 'dumb' }, true)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('人类可读格式', () => {
    expect(formatDuration(42)).toBe('42ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_800)).toBe('1.8s');
    expect(formatDuration(59_400)).toBe('59.4s');
    expect(formatDuration(125_000)).toBe('2m05s');
  });
});

describe('工具卡片', () => {
  it('结果卡片：边框、工具名、编号、状态、耗时、session/goal/reason 默认可见', () => {
    const sink = collector('debug');
    sink.logger.tool(shellCard());

    const [header, ...body] = sink.lines;
    const footer = body.pop() ?? '';

    expect(header).toContain('┌─');
    expect(header).toContain('SHELL');
    expect(header).toContain('#12');
    expect(header).toContain('SUCCESS');
    expect(header).toContain('42ms');
    expect(header).toContain('08:12:41.010');
    expect(footer.startsWith('└')).toBe(true);
    expect(footer.endsWith('┘')).toBe(true);

    expect(body.map((line) => line.slice(2, 9))).toEqual(['session', 'goal   ', 'reason ']);
    expect(body[0]).toContain('ses_ab12cd34ef56');
    expect(body[1]).toContain('验证当前代码');
    expect(body[2]).toContain('改完 edit 后确认没破坏行为');

    expectUniformWidth(sink.lines);
  });

  it('调用起点只占一行：字段不重复、不是卡片', () => {
    const sink = collector('debug');
    sink.logger.tool(shellCard({ phase: 'call', ms: undefined, target: 'pnpm test && pnpm typecheck' }));

    expect(sink.lines).toHaveLength(1);
    const line = sink.lines[0] ?? '';

    expect(line).toContain('→ SHELL #12');
    expect(line).toContain('pnpm test && pnpm typecheck');
    // 结果卡片里已有的字段不在起点行重复
    expect(line).not.toContain('session');
    expect(line).not.toContain('goal');
    expect(line).not.toContain('reason');
    expect(line).not.toContain('┌');
  });

  it('单行事件按终端宽度截断（含时间戳）', () => {
    const sink = collector('debug', { columns: 72 });
    sink.logger.tool(shellCard({ phase: 'call', ms: undefined, target: 'x'.repeat(200) }));

    expect(sink.lines).toHaveLength(1);
    expect(displayWidth(sink.lines[0] ?? '')).toBe(72);
    expect(sink.lines[0]).toContain('…');
  });

  it('状态用明确文字表达：卡片状态 + 单行确认结果', () => {
    const cards: Array<[Partial<ToolLogEntry>, string]> = [
      [{ phase: 'done' }, 'SUCCESS'],
      [{ phase: 'fail', error: 'boom' }, 'FAILED'],
      [{ phase: 'required', riskLevel: 'dangerous' }, 'APPROVAL REQUIRED'],
      [{ phase: 'required', riskLevel: 'unknown' }, 'RISK UNKNOWN'],
    ];

    for (const [patch, label] of cards) {
      const sink = collector('debug');
      sink.logger.tool(shellCard(patch));

      expect(sink.lines[0], label).toContain('┌─');
      expect(sink.lines[0], label).toContain(label);
    }

    // 确认结果只留一行，不再重复一张卡片
    const approved = collector('debug');
    approved.logger.tool(
      shellCard({
        phase: 'approved',
        riskLevel: 'dangerous',
        ms: undefined,
        riskLabel: 'git.commit · 会创建本地 Git 提交',
      }),
    );
    expect(approved.lines).toHaveLength(1);
    expect(approved.lines[0]).toContain('✓ SHELL #12');
    expect(approved.lines[0]).toContain('git.commit · 会创建本地 Git 提交');

    const declined = collector('debug');
    declined.logger.tool(
      shellCard({
        phase: 'declined',
        riskLevel: 'unknown',
        ms: undefined,
        note: '用户拒绝执行',
        riskLabel: 'shell.variable · 变量展开',
      }),
    );
    expect(declined.lines).toHaveLength(1);
    expect(declined.lines[0]).toContain('✗ SHELL #12');
    expect(declined.lines[0]).toContain('用户拒绝执行');
  });

  it('失败卡片展示 error，慢调用强调耗时', () => {
    const sink = collector('debug');
    sink.logger.tool(shellCard({ phase: 'fail', ms: 6_781, error: 'oldText matches 3 times' }));

    expect(sink.lines[0]).toContain('FAILED');
    expect(sink.lines[0]).toContain('6.8s');
    expect(sink.lines.join('\n')).toContain('oldText matches 3 times');
  });

  it('工具专属字段按插入顺序渲染（command / path / risk）', () => {
    const sink = collector('debug');
    sink.logger.tool(
      shellCard({
        phase: 'required',
        riskLevel: 'dangerous',
        ms: undefined,
        fields: {
          session: 'ses_ab12cd34ef56',
          goal: '提交当前代码',
          reason: '创建本地 Git 提交',
          command: 'git commit -m x',
          risk: 'git.commit · 会创建本地 Git 提交',
        },
      }),
    );

    const labels = sink.lines
      .filter((line) => line.startsWith('│ '))
      .map((line) => line.slice(2, 11).trim());

    expect(labels).toEqual(['session', 'goal', 'reason', 'command', 'risk']);
    expectUniformWidth(sink.lines);
  });

  it('长字段截断到 400 字符并换行，仍保持边框对齐', () => {
    const sink = collector('debug');
    sink.logger.tool(shellCard({ fields: { session: 's', goal: 'g', reason: 'r', command: 'Z'.repeat(1000) } }));

    const text = sink.lines.join('\n');

    expect(text).toContain('…');
    expect(text.split('Z').length - 1).toBe(400);
    expectUniformWidth(sink.lines);
  });

  it('多行字段（命令里带 \\n）拆成多行展示', () => {
    const sink = collector('debug');
    sink.logger.tool(shellCard({ fields: { session: 's', goal: 'g', reason: 'r', command: 'ls -1\necho x' } }));

    const body = sink.lines.filter((line) => line.startsWith('│ '));

    expect(body.some((line) => line.includes('ls -1'))).toBe(true);
    expect(body.some((line) => line.includes('echo x'))).toBe(true);
    expectUniformWidth(sink.lines);
  });

  it('终端宽度自适应并夹在合理范围', () => {
    for (const [width, expected] of [
      [40, 64],
      [72, 72],
      [200, 100],
    ] as const) {
      const sink = collector('debug', { columns: width });
      sink.logger.tool(shellCard());

      expectUniformWidth(sink.lines, expected);
    }
  });

  it('info 级别不输出调用起点，仍输出结果与安全事件', () => {
    const sink = collector('info');
    sink.logger.tool(shellCard({ phase: 'call', ms: undefined, target: 'pwd' }));
    expect(sink.lines).toEqual([]);

    sink.logger.tool(shellCard());
    sink.logger.tool(shellCard({ phase: 'required', riskLevel: 'unknown', ms: undefined }));
    sink.logger.tool(
      shellCard({ phase: 'approved', riskLevel: 'dangerous', ms: undefined, riskLabel: 'git.commit · 会创建提交' }),
    );

    const text = sink.lines.join('\n');
    expect(text).toContain('SUCCESS');
    expect(text).toContain('RISK UNKNOWN');
    expect(text).toContain('✓ SHELL');
    expect(text).not.toContain('→');
  });

  it('debug 级别额外输出调用起点（单行）', () => {
    const sink = collector('debug');
    sink.logger.tool(shellCard({ phase: 'call', ms: undefined, target: 'pnpm test' }));

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('→ SHELL #12  pnpm test');
  });

  it('off 级别完全静默', () => {
    const sink = collector('off');
    sink.logger.tool(shellCard());
    sink.logger.tool(shellCard({ phase: 'fail', error: 'boom' }));
    sink.logger.event('listening', { port: 1 });

    expect(sink.lines).toEqual([]);
  });
});

describe('工具配色与 ANSI', () => {
  it('TTY 下开启颜色，同一工具跨调用配色一致，不用颜色表达语义', () => {
    const sink = collector('debug', { colors: true });
    sink.logger.tool(shellCard({ id: 1 }));
    sink.logger.tool(shellCard({ id: 2 }));
    sink.logger.tool(shellCard({ id: 3, tool: 'read' }));

    const headers = sink.lines.filter((line) => line.startsWith('┌─'));
    const [first, second, read] = headers;

    expect(headers).toHaveLength(3);
    expect(first).toContain('\u001b[');
    expect(first?.includes('38;5;208mSHELL')).toBe(true);
    expect(second?.includes('38;5;208mSHELL')).toBe(true);
    expect(read?.includes(';34mREAD')).toBe(true);
    expect(read?.includes('38;5;208')).toBe(false);

    // 颜色不改变可见宽度
    expectUniformWidth(sink.lines);
  });

  it('工具卡片使用新名称 SHELL / EXPORT，并保持各自稳定配色', () => {
    const sink = collector('debug', { colors: true });
    sink.logger.tool(shellCard({ id: 1 }));
    sink.logger.tool(shellCard({ id: 2, tool: 'export', fields: { path: 'dist/report.zip' } }));

    const [shell, exported] = sink.lines.filter((line) => line.startsWith('┌─'));

    expect(shell).toContain('SHELL');
    expect(exported).toContain('EXPORT');
    expect(shell?.includes('38;5;208')).toBe(true);
    expect(exported?.includes('38;5;141')).toBe(true);
    expect(exported?.includes('38;5;208')).toBe(false);
    expectUniformWidth(sink.lines);
  });

  it('非 TTY / 自定义 sink / NO_COLOR 下不输出 ANSI，但保留纯文本卡片结构', () => {
    for (const opts of [{}, { colors: false }] as const) {
      const sink = collector('debug', opts);
      sink.logger.tool(shellCard());

      expect(sink.writes.every((line) => !line.includes('\u001b['))).toBe(true);
      expect(sink.lines[0]).toContain('┌─');
      expectUniformWidth(sink.lines);
    }
  });

  it('每个 write 都是一行（含换行），便于重定向', () => {
    const sink = collector('debug');
    sink.logger.tool(shellCard());

    expect(sink.writes.every((line) => line.endsWith('\n'))).toBe(true);
    expect(sink.writes).toHaveLength(sink.lines.length);
  });
});

describe('事件行', () => {
  it('info 事件输出名称与字段', () => {
    const sink = collector('info');
    sink.logger.event('listening', { host: '127.0.0.1', port: 8787 });

    expect(sink.lines).toEqual(['2026-09-26T08:12:41.010Z event listening host="127.0.0.1" port=8787']);
  });

  it('debug 级事件只在 debug 输出，且视觉层级弱于工具卡片', () => {
    const debug = collector('debug');
    debug.logger.event('mcp-request', { method: 'POST', rpc: 'tools/call', status: 200, ms: 12 }, 'debug');

    expect(debug.lines[0]).toContain('· mcp-request');
    expect(debug.lines[0]).not.toContain('event mcp-request');
    expect(debug.lines[0]).toContain('status=200');

    const info = collector('info');
    info.logger.event('mcp-request', { method: 'POST' }, 'debug');
    expect(info.lines).toEqual([]);
  });

  it('event 字段里的长值截断，敏感正文由调用方先转成摘要', () => {
    const sink = collector('info');
    sink.logger.event('download-mint', { file: 'x'.repeat(500) });

    expect(sink.lines[0]).toContain(`"${'x'.repeat(400)}…"`);
  });
});
