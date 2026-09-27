import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayWidth, stripAnsi } from '../src/ansi.js';
import {
  createLogger,
  formatDuration,
  resolveColorMode,
  resolveLogLevel,
  type LoggerOptions,
  type LogLevel,
  type ToolLogEntry,
} from '../src/log.js';

const WIDTH = 120;

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
    get plain(): string[] {
      return this.lines.map((line) => stripAnsi(line));
    },
  };
}

function shellCard(entry: Partial<ToolLogEntry> = {}): ToolLogEntry {
  return {
    id: 12,
    tool: 'shell',
    phase: 'done',
    ms: 42,
    target: 'pnpm test',
    fields: {
      session: 'ses_ab12cd34ef56',
      goal: '验证当前代码',
      reason: '改完 edit 后确认没破坏行为',
      result: 'exit 0 · stderr 0 chars',
      stdout: '> vitest run\nTest Files 26 passed | 1 skipped',
    },
    ...entry,
  };
}

function expectWithinWidth(lines: string[], width: number): void {
  for (const line of lines) expect(displayWidth(line), line).toBeLessThanOrEqual(width);
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

describe('工具 transcript', () => {
  it('结果使用紧凑 agent transcript：关键字/命令着色，stdout 灰色，状态最后', () => {
    const sink = collector('debug', { colors: true });
    sink.logger.tool(shellCard());

    expect(sink.plain).toEqual([
      '  goal 验证当前代码 · reason 改完 edit 后确认没破坏行为 · session ses_ab12cd34ef56',
      '• Ran  pnpm test',
      '  └ > vitest run',
      '    Test Files 26 passed | 1 skipped',
      '  ✓ 42ms · exit 0 · stderr 0 chars',
    ]);
    expect(sink.lines[1]).toContain('38;5;208mRan');
    expect(sink.lines[1]).toContain('36mpnpm test');
    expect(sink.lines[2]).toContain('\u001b[2m');
    expectWithinWidth(sink.lines, WIDTH);
  });

  it('debug 调用起点使用同一标题；结果阶段不重复标题', () => {
    const sink = collector('debug');
    sink.logger.tool({
      id: 12,
      tool: 'shell',
      phase: 'call',
      target: 'pnpm test',
      fields: { session: 'ses_ab12cd34ef56', goal: '验证当前代码', reason: '改完 edit 后确认没破坏行为' },
    });
    sink.logger.tool(shellCard({ fields: { result: 'exit 0 · stderr 0 chars' } }));

    expect(sink.plain[0]).toContain('session ses_ab12cd34ef56');
    expect(sink.plain[1]).toBe('• Ran  pnpm test');
    expect(sink.plain.filter((line) => line.includes('• Ran'))).toHaveLength(1);
    expect(sink.plain.at(-1)).toBe('  ✓ 42ms · exit 0 · stderr 0 chars');
  });

  it('info 级别不输出起点，但结果块会补齐标题', () => {
    const sink = collector('info');
    sink.logger.tool({
      id: 12,
      tool: 'shell',
      phase: 'call',
      target: 'pnpm test',
      fields: { session: 'ses_ab12cd34ef56', goal: '验证当前代码', reason: '改完 edit 后确认没破坏行为' },
    });
    expect(sink.lines).toEqual([]);

    sink.logger.tool(shellCard());
    expect(sink.plain[0]).toContain('session ses_ab12cd34ef56');
    expect(sink.plain[1]).toBe('• Ran  pnpm test');
    expect(sink.plain.at(-1)).toContain('✓ 42ms');
  });

  it('stdout 灰色显示，截断到 800 字符后继续换行并标注剩余长度', () => {
    const sink = collector('debug', { colors: true });
    sink.logger.tool(shellCard({ fields: { result: 'exit 0 · stderr 0 chars', stdout: 'z'.repeat(900) } }));

    const text = sink.plain.join('\n');
    expect(text).toContain('… (+100 chars)');
    expect(text.split('z').length - 1).toBe(800);
    expect(sink.lines.some((line) => line.includes('\u001b[2m'))).toBe(true);
    expectWithinWidth(sink.lines, WIDTH);
  });

  it('stdout / stderr 不把终端控制序列透传到日志', () => {
    const sink = collector('debug');
    sink.logger.tool(
      shellCard({
        fields: {
          result: 'exit 0 · stderr 0 chars',
          stdout: '\u001b[31mred\u001b[0m \u001b]0;evil-title\u0007 text',
        },
      }),
    );

    const text = sink.plain.join('\n');
    expect(text).toContain('red');
    expect(text).toContain('text');
    expect(text).not.toContain('\u001b]');
    expect(sink.lines.join('\n')).not.toContain('\u001b]');
  });

  it('goal / reason 缺失时不显示；stdout 灰色、stderr 红色标识', () => {
    const sink = collector('debug', { colors: true });
    sink.logger.tool(
      shellCard({
        fields: {
          session: 'ses_ab12cd34ef56',
          result: 'exit 0 · stderr 2 chars',
          stdout: 'out',
          stderr: 'err',
        },
      }),
    );

    const plain = sink.plain;
    expect(plain.some((line) => line.includes('goal'))).toBe(false);
    expect(plain.some((line) => line.includes('reason'))).toBe(false);

    const stdoutIndex = sink.lines.findIndex((line) => stripAnsi(line).endsWith('out'));
    const stderrIndex = sink.lines.findIndex((line) => stripAnsi(line).endsWith('err'));
    expect(stdoutIndex).toBeGreaterThanOrEqual(0);
    expect(stderrIndex).toBeGreaterThanOrEqual(0);
    expect(sink.lines[stdoutIndex]).toContain('\u001b[2m');
    expect(sink.lines[stderrIndex]).toContain('\u001b[31m');
  });

  it('不同工具调用块之间保留一个空行作为分割', () => {
    const sink = collector('debug');
    sink.logger.tool(shellCard({ id: 1 }));
    sink.logger.tool({ id: 2, tool: 'shell', phase: 'call', target: 'pwd' });

    const secondTitle = sink.plain.findIndex((line) => line === '• Ran  pwd');
    expect(secondTitle).toBeGreaterThan(0);
    expect(sink.plain[secondTitle - 1]).toBe('');
  });

  it('MCP 工具参数放在工具标题下方', () => {
    const sink = collector('debug');
    sink.logger.tool({
      id: 7,
      tool: 'mcp_tool',
      phase: 'done',
      target: 'mcp:dbx call dbx_list_tables',
      fields: {
        session: 'ses_ab12cd34ef56',
        goal: '查看数据库表',
        reason: '需要确认 schema',
        action: 'call',
        server: 'dbx',
        name: 'dbx_list_tables',
        result: '1 call',
      },
    });

    expect(sink.plain.slice(0, 4)).toEqual([
      '  goal 查看数据库表 · reason 需要确认 schema · session ses_ab12cd34ef56',
      '• MCP  mcp:dbx call dbx_list_tables',
      '  action call · server dbx · name dbx_list_tables',
      '  ✓ 1 call',
    ]);
  });

  it('workspace 内文件路径显示相对路径，workspace 外保持绝对路径', () => {
    const workspace = resolve('repo');
    const outsidePath = resolve('tmp', 'log.ts');
    const inside = collector('debug');
    inside.logger.tool({
      id: 1,
      tool: 'read',
      phase: 'done',
      target: join(workspace, 'src', 'log.ts'),
      workspace,
      fields: { session: 'ses_1', result: '1/1 lines' },
    });
    expect(inside.plain[1]).toBe(`• Read  ${join('src', 'log.ts')}`);

    const outside = collector('debug');
    outside.logger.tool({
      id: 2,
      tool: 'read',
      phase: 'done',
      target: outsidePath,
      workspace,
      fields: { session: 'ses_1', result: '1/1 lines' },
    });
    expect(outside.plain[1]).toBe(`• Read  ${outsidePath}`);
  });

  it('session / goal / reason 始终展示，超宽时按字段行换行', () => {
    const sink = collector('debug', { columns: 72 });
    sink.logger.tool(
      shellCard({
        fields: {
          session: 'ses_ab12cd34ef56',
          goal: '验证当前代码',
          reason: '改完 edit 后确认没破坏行为，并检查所有回归用例',
          result: 'exit 0 · stderr 0 chars',
        },
      }),
    );

    const text = sink.plain.join('\n');
    expect(text).toContain('session ses_ab12cd34ef56');
    expect(text).toContain('goal 验证当前代码');
    expect(text).toContain('reason 改完 edit 后确认没破坏行为');
    expectWithinWidth(sink.lines, 72);
  });

  it('失败状态与错误放在最后一行', () => {
    const sink = collector('debug', { colors: true });
    sink.logger.tool(shellCard({ phase: 'fail', ms: 6_781, error: 'oldText matches 3 times' }));

    const last = sink.plain.at(-1) ?? '';
    expect(last).toContain('✗ 6.8s · oldText matches 3 times');
    expect(sink.lines.at(-1)).toContain('\u001b[31m');
    expect(sink.plain.join('\n')).not.toContain('┌');
  });

  it('approval required / risk unknown 使用黄色状态行收尾', () => {
    for (const [riskLevel, label] of [
      ['dangerous', 'APPROVAL REQUIRED'],
      ['unknown', 'RISK UNKNOWN'],
    ] as const) {
      const sink = collector('debug', { colors: true });
      sink.logger.tool(
        shellCard({
          phase: 'required',
          ms: undefined,
          riskLevel,
          fields: {
            session: 'ses_ab12cd34ef56',
            goal: '提交当前代码',
            reason: '创建本地 Git 提交',
            risk: 'git.commit · 会创建本地 Git 提交',
          },
        }),
      );

      expect(sink.plain.at(-1)).toBe(`  ! ${label} · git.commit · 会创建本地 Git 提交`);
      expect(sink.lines.at(-1)).toContain('\u001b[1;33m');
    }
  });

  it('approved / declined 仍保持单行审计事件', () => {
    const approved = collector('debug');
    approved.logger.tool(
      shellCard({
        phase: 'approved',
        ms: undefined,
        riskLevel: 'dangerous',
        riskLabel: 'git.commit · 会创建本地 Git 提交',
      }),
    );
    expect(approved.plain).toEqual(['✓ SHELL #12  git.commit · 会创建本地 Git 提交']);

    const declined = collector('debug');
    declined.logger.tool(
      shellCard({
        phase: 'declined',
        ms: undefined,
        riskLevel: 'unknown',
        note: '用户拒绝执行',
      }),
    );
    expect(declined.plain).toEqual(['✗ SHELL #12  用户拒绝执行']);
  });

  it('终端宽度使用更多横向空间，并夹在 40-160', () => {
    const narrow = collector('debug', { columns: 20 });
    narrow.logger.tool(shellCard({ fields: { result: 'exit 0', stdout: 'x'.repeat(200) } }));
    expectWithinWidth(narrow.lines, 40);

    const wide = collector('debug', { columns: 300 });
    wide.logger.tool(
      shellCard({
        fields: {
          session: 's'.repeat(80),
          goal: 'g'.repeat(80),
          reason: 'r'.repeat(80),
          result: 'exit 0',
        },
      }),
    );
    expectWithinWidth(wide.lines, 160);
  });

  it('off 级别完全静默', () => {
    const sink = collector('off');
    sink.logger.tool(shellCard());
    sink.logger.tool(shellCard({ phase: 'fail', error: 'boom' }));
    sink.logger.event('listening', { port: 1 });

    expect(sink.lines).toEqual([]);
  });
});

describe('工具配色与输出通道', () => {
  it('不同工具使用稳定配色，命令统一使用青色', () => {
    const sink = collector('debug', { colors: true });
    sink.logger.tool(shellCard({ id: 1 }));
    sink.logger.tool(shellCard({ id: 2, tool: 'read', target: 'src/log.ts' }));

    const [shell, read] = sink.lines.filter((line) => line.startsWith('\u001b[2m•'));
    expect(shell).toContain('38;5;208mRan');
    expect(shell).toContain('36mpnpm test');
    expect(read).toContain('34mRead');
    expect(read).toContain('36msrc/log.ts');
  });

  it('非 TTY / 自定义 sink / NO_COLOR 下不输出 ANSI，但保留 transcript', () => {
    for (const opts of [{}, { colors: false }] as const) {
      const sink = collector('debug', opts);
      sink.logger.tool(shellCard());

      expect(sink.writes.every((line) => !line.includes('\u001b['))).toBe(true);
      expect(sink.plain[0]).toContain('session ses_ab12cd34ef56');
      expect(sink.plain[1]).toBe('• Ran  pnpm test');
      expect(sink.plain.at(-1)).toContain('✓ 42ms');
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

  it('debug 级事件只在 debug 输出，且视觉层级弱于工具 transcript', () => {
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
