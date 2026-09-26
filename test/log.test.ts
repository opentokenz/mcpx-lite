import { describe, expect, it } from 'vitest';
import { createLogger, resolveLogLevel } from '../src/log.js';

function collector() {
  const writes: string[] = [];
  return {
    writes,
    get lines(): string[] {
      return writes.map((write) => write.replace(/\n$/, ''));
    },
    write: (line: string) => void writes.push(line),
  };
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

describe('createLogger', () => {
  it('debug 输出 call 与 done 行，含时间戳、工具名、文件与结果摘要', () => {
    const sink = collector();
    const logger = createLogger({
      level: 'debug',
      write: sink.write,
      now: () => new Date('2026-09-26T08:12:41.010Z'),
    });

    logger.tool({
      id: 1,
      tool: 'read',
      phase: 'call',
      fields: { session: 'ses_ab', path: 'src/index.ts', goal: '了解入口', reason: '确认结构' },
    });
    logger.tool({
      id: 1,
      tool: 'read',
      phase: 'done',
      ms: 42,
      fields: { files: ['/abs/src/index.ts'], result: { returnedLines: 120 } },
    });

    expect(sink.lines).toHaveLength(2);
    expect(sink.writes.every((line) => line.endsWith('\n'))).toBe(true);
    expect(sink.lines[0]).toBe(
      '2026-09-26T08:12:41.010Z call  #1  read       session="ses_ab" path="src/index.ts" goal="了解入口" reason="确认结构"',
    );
    expect(sink.lines[1]).toBe(
      '2026-09-26T08:12:41.010Z done  #1  read       ok ms=42 files=["/abs/src/index.ts"] result={"returnedLines":120}',
    );
  });

  it('fail 行带 error 与 files', () => {
    const sink = collector();
    const logger = createLogger({ level: 'debug', write: sink.write, now: () => new Date(0) });

    logger.tool({
      id: 7,
      tool: 'edit',
      phase: 'fail',
      ms: 3,
      error: 'oldText matches 3 times',
      fields: { files: ['/abs/a.ts'] },
    });

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('fail  #7');
    expect(sink.lines[0]).toContain('edit');
    expect(sink.lines[0]).toContain('error="oldText matches 3 times"');
    expect(sink.lines[0]).toContain('ms=3');
    expect(sink.lines[0]).toContain('files=["/abs/a.ts"]');
  });

  it('event 行输出名称与字段', () => {
    const sink = collector();
    const logger = createLogger({ level: 'info', write: sink.write, now: () => new Date('2026-09-26T00:00:00.000Z') });

    logger.event('listening', { host: '127.0.0.1', port: 8787 });

    expect(sink.lines).toEqual(['2026-09-26T00:00:00.000Z event listening host="127.0.0.1" port=8787']);
  });

  it('info 级别不输出 call 行（只留 done/fail/event）', () => {
    const sink = collector();
    const logger = createLogger({ level: 'info', write: sink.write });

    logger.tool({ id: 1, tool: 'read', phase: 'call', fields: { path: 'a.ts' } });
    logger.tool({ id: 1, tool: 'read', phase: 'done', ms: 1, fields: {} });

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('done  #1');
  });

  it('off 级别完全静默', () => {
    const sink = collector();
    const logger = createLogger({ level: 'off', write: sink.write });

    logger.event('listening', { port: 1 });
    logger.tool({ id: 1, tool: 'bash', phase: 'call', fields: { command: 'ls' } });
    logger.tool({ id: 1, tool: 'bash', phase: 'fail', error: 'boom' });

    expect(sink.lines).toEqual([]);
  });

  it('长值截断到 400 字符并加省略号，undefined/null 字段被跳过', () => {
    const sink = collector();
    const logger = createLogger({ level: 'debug', write: sink.write, now: () => new Date(0) });

    logger.tool({
      id: 2,
      tool: 'write',
      phase: 'call',
      fields: { content: 'x'.repeat(1000), missing: undefined, empty: null },
    });

    expect(sink.lines[0]).toContain(`content="${'x'.repeat(400)}…"`);
    expect(sink.lines[0]).not.toContain('missing');
    expect(sink.lines[0]).not.toContain('empty');
  });
});
