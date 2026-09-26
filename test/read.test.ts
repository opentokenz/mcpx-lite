import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, expectError, expectOk, type Harness } from './harness.js';

let h: Harness;
let sessionId: string;

/** base 外的测试目标：带上工作区名，避免多个测试共享同一个系统 tmp 目录时互相干扰。 */
const outsideDir = () => `${basename(h.workspace)}-shared`;
const outsideFile = (name: string) => join(h.workspace, '..', outsideDir(), name);

async function start(): Promise<void> {
  h = await createHarness();
  const created = expectOk(
    await h.callTool('session', { action: 'create', base: h.workspace, goal: '改代码', reason: '开始任务' }),
  );
  sessionId = created['sessionId'] as string;
}

const read = (args: Record<string, unknown>) =>
  h.callTool('read', { sessionId, goal: '读文件', reason: '需要看内容', ...args });

beforeEach(start);
afterEach(async () => {
  await h.cleanup();
});

describe('read 工具', () => {
  it('按行分页：offset / limit / totalLines / hasMore，content 不含行尾换行', async () => {
    const lines = Array.from({ length: 300 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(h.workspace, 'big.txt'), `${lines.join('\n')}\n`, 'utf8');

    const first = expectOk(await read({ path: 'big.txt' }));
    expect(first).toMatchObject({
      path: join(h.workspace, 'big.txt'),
      offset: 0,
      limit: 200,
      returnedLines: 200,
      totalLines: 300,
      hasMore: true,
      truncated: false,
    });
    expect((first['content'] as string).split('\n')).toHaveLength(200);
    expect(first['content']).toMatch(/^line-1\n/);
    expect(first['content']).toMatch(/line-200$/);

    const second = expectOk(await read({ path: 'big.txt', offset: 200, limit: 200 }));
    expect(second).toMatchObject({ returnedLines: 100, totalLines: 300, hasMore: false });
    expect(second['content']).toMatch(/^line-201\n/);
    expect(second['content']).toMatch(/line-300$/);

    const tail = expectOk(await read({ path: 'big.txt', offset: 299, limit: 5 }));
    expect(tail['content']).toBe('line-300');
  });

  it('空文件返回 0 行', async () => {
    await writeFile(join(h.workspace, 'empty.txt'), '', 'utf8');

    const result = expectOk(await read({ path: 'empty.txt' }));

    expect(result).toMatchObject({ returnedLines: 0, totalLines: 0, hasMore: false, truncated: false, content: '' });
  });

  it('相对路径基于 session.base 解析；base 外也能直接读，不需要确认', async () => {
    await mkdir(join(h.workspace, 'src'), { recursive: true });
    await writeFile(join(h.workspace, 'src', 'index.ts'), 'export const a = 1;\n', 'utf8');
    await mkdir(join(h.workspace, '..', outsideDir()), { recursive: true });
    await writeFile(outsideFile('config.json'), '{}\n', 'utf8');

    const relative = expectOk(await read({ path: 'src/index.ts' }));
    expect(relative['path']).toBe(join(h.workspace, 'src', 'index.ts'));
    expect(relative['content']).toBe('export const a = 1;');

    // base 外：相对路径（..）与绝对路径都直接读
    const traversal = await read({ path: `../${outsideDir()}/config.json` });
    expect(traversal.resultType).not.toBe('input_required');
    expect(expectOk(traversal)['content']).toBe('{}');

    const absolute = await read({ path: outsideFile('config.json') });
    expect(absolute.resultType).not.toBe('input_required');
    expect(expectOk(absolute)['path']).toBe(outsideFile('config.json'));
  });

  it('超过字符预算时截断并标记 truncated', async () => {
    await writeFile(join(h.workspace, 'huge.txt'), `${'x'.repeat(150_000)}\n`, 'utf8');

    const result = expectOk(await read({ path: 'huge.txt', limit: 10 }));

    expect(result['truncated']).toBe(true);
    expect(result['returnedLines']).toBe(1);
    expect((result['content'] as string).length).toBe(100_000);
  });

  it('多行文件超出预算时停在预算内', async () => {
    const lines = Array.from({ length: 300 }, (_, index) => `${index}-${'y'.repeat(400)}`);
    await writeFile(join(h.workspace, 'wide.txt'), lines.join('\n'), 'utf8');

    const result = expectOk(await read({ path: 'wide.txt', limit: 300 }));

    expect(result['truncated']).toBe(true);
    expect((result['returnedLines'] as number) < 300).toBe(true);
    expect((result['content'] as string).length <= 100_000).toBe(true);
  });

  it('二进制文件被拒绝并提示改用 export', async () => {
    await writeFile(join(h.workspace, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));

    const message = expectError(await read({ path: 'blob.bin' }));

    expect(message).toMatch(/binary/);
    expect(message).toMatch(/export/);
  });

  it('文件不存在、目录、空 path 都是可读错误', async () => {
    expect(expectError(await read({ path: 'missing.txt' }))).toMatch(/does not exist/);
    expect(expectError(await read({ path: '.' }))).toMatch(/not a regular file/);
    expect(expectError(await read({ path: '' }))).toMatch(/path/);
  });

  it('history 记录解析后的绝对路径', async () => {
    await writeFile(join(h.workspace, 'note.md'), '# hi\n', 'utf8');
    expectOk(await read({ path: 'note.md' }));

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history[0]).toMatchObject({
      tool: 'read',
      target: join(h.workspace, 'note.md'),
      goal: '读文件',
      reason: '需要看内容',
      ok: true,
    });
    expect(JSON.stringify(history)).not.toContain('# hi');
  });

  it('base 外读取不进入确认流程，也不产生安全事件', async () => {
    await mkdir(join(h.workspace, '..', outsideDir()), { recursive: true });
    const outside = outsideFile('secret.txt');
    await writeFile(outside, 'TOPSECRET-READ-BODY\n', 'utf8');

    const outcome = await read({ path: outside });

    expect(outcome.resultType).not.toBe('input_required');
    expect(expectOk(outcome)['content']).toBe('TOPSECRET-READ-BODY');

    const logs = h.logs.join('\n');
    expect(logs).not.toContain('APPROVAL');
    expect(logs).not.toContain('read.outside-base');
  });
});
