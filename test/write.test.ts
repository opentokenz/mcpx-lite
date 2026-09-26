import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalRetryBody,
  createHarness,
  expectApproval,
  expectError,
  expectOk,
  toOutcome,
  type Harness,
} from './harness.js';

let h: Harness;
let sessionId: string;

/**
 * base 外的测试目标统一放在工作区父目录，并带上工作区名：
 * 父目录（系统 tmp）在测试之间是共享的，加前缀才能保证互不干扰、可重复运行。
 */
const outsideName = (name: string) => `${basename(h.workspace)}-${name}`;
const outsideFile = (name: string) => join(h.workspace, '..', outsideName(name));
const outsideRelative = (name: string) => `../${outsideName(name)}`;

/** 只调用一轮：base 内写入与门禁断言。 */
const write = (args: Record<string, unknown>) =>
  h.callTool('write', { sessionId, goal: '写文件', reason: '落盘改动', ...args });

/** 完整两轮：base 外写入自动确认后执行。 */
const writeApproved = (args: Record<string, unknown>) =>
  h.callToolApproving('write', { sessionId, goal: '写文件', reason: '落盘改动', ...args });

beforeEach(async () => {
  h = await createHarness();
  const created = expectOk(
    await h.callTool('session', { action: 'create', base: h.workspace, goal: '改代码', reason: '开始任务' }),
  );
  sessionId = created['sessionId'] as string;
});

afterEach(async () => {
  await h.cleanup();
});

describe('write 工具', () => {
  it('新建文件时自动创建多级父目录，created 为 true', async () => {
    const result = expectOk(await write({ path: 'a/b/c/new.ts', content: 'export const x = 1;\n' }));

    expect(result).toMatchObject({ path: join(h.workspace, 'a', 'b', 'c', 'new.ts'), created: true });
    expect(result['bytes']).toBe(20);
    expect(await readFile(join(h.workspace, 'a', 'b', 'c', 'new.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('覆盖已有文件时 created 为 false，内容按字节写入', async () => {
    await writeFile(join(h.workspace, 'existing.txt'), 'old', 'utf8');

    const result = expectOk(await write({ path: 'existing.txt', content: '新内容\n第二行\n' }));

    expect(result['created']).toBe(false);
    expect(result['bytes']).toBe(Buffer.byteLength('新内容\n第二行\n', 'utf8'));
    expect(await readFile(join(h.workspace, 'existing.txt'), 'utf8')).toBe('新内容\n第二行\n');
  });

  it('base 外写入确认后自动创建父目录', async () => {
    const outside = outsideFile('outside/logs/a.txt');

    const result = expectOk(await writeApproved({ path: outside, content: 'x' }));

    expect(result['path']).toBe(outside);
    expect(await readFile(outside, 'utf8')).toBe('x');
    expect(await readdir(join(outside, '..'))).toEqual(['a.txt']);
  });

  it('留原子写的临时文件不残留', async () => {
    await write({ path: 'atomic.txt', content: 'v1' });
    await write({ path: 'atomic.txt', content: 'v2' });

    expect((await readdir(h.workspace)).filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(await readFile(join(h.workspace, 'atomic.txt'), 'utf8')).toBe('v2');
  });

  it('目标是目录或 path 为空时报错', async () => {
    await mkdir(join(h.workspace, 'adir'), { recursive: true });

    expect(expectError(await write({ path: 'adir', content: 'x' }))).toMatch(/directory/);
    expect(expectError(await write({ path: '', content: 'x' }))).toMatch(/path/);
  });

  it('history 只记录目标路径与原因，不记录正文', async () => {
    expectOk(await write({ path: 'secret.txt', content: 'TOPSECRET-CONTENT' }));

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history[0]).toMatchObject({ tool: 'write', target: join(h.workspace, 'secret.txt'), ok: true });
    expect(JSON.stringify(history)).not.toContain('TOPSECRET-CONTENT');
  });
});

describe('write base 边界门禁（MRTR）', () => {
  it('base 内新建与覆盖都直接执行，不需要确认', async () => {
    const created = await write({ path: 'a/b/new.ts', content: 'x\n' });
    expect(created.resultType).not.toBe('input_required');
    expect(created.isError).toBe(false);

    await writeFile(join(h.workspace, 'existing.txt'), 'old', 'utf8');
    const overwritten = await write({ path: 'existing.txt', content: 'new' });

    expect(overwritten.resultType).not.toBe('input_required');
    expect(await readFile(join(h.workspace, 'existing.txt'), 'utf8')).toBe('new');
  });

  it('../ 相对路径越界返回审核卡片且不创建文件，确认后才写入', async () => {
    const relative = outsideRelative('traverse.txt');
    const outside = outsideFile('traverse.txt');

    const outcome = await write({ path: relative, content: 'x' });

    expect(expectApproval(outcome).approvalToken).toMatch(/^apr_/);
    await expect(access(outside)).rejects.toThrow();

    expectOk(await writeApproved({ path: relative, content: 'x' }));
    expect(await readFile(outside, 'utf8')).toBe('x');
  });

  it('绝对路径越界返回审核卡片且不创建文件', async () => {
    const outside = outsideFile('absolute.txt');

    const outcome = await write({ path: outside, content: 'x' });

    expectApproval(outcome);
    await expect(access(outside)).rejects.toThrow();
  });

  it('创建场景：父目录 symlink 指向 base 外时按真实路径判定', async () => {
    const outsideDir = join(h.workspace, '..', outsideName('outside-dir'));
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, join(h.workspace, 'escape-dir'));

    const outcome = await write({ path: 'escape-dir/new.txt', content: 'x' });

    expectApproval(outcome);
    await expect(access(join(outsideDir, 'new.txt'))).rejects.toThrow();

    expectOk(await writeApproved({ path: 'escape-dir/new.txt', content: 'x' }));
    expect(await readFile(join(outsideDir, 'new.txt'), 'utf8')).toBe('x');
  });

  it('覆盖 base 内指向 base 外文件的 symlink：按真实路径判定，且不把 symlink 换成普通文件', async () => {
    const outside = outsideFile('link-target.txt');
    await writeFile(outside, 'old', 'utf8');
    await symlink(outside, join(h.workspace, 'linked.txt'));

    const outcome = await write({ path: 'linked.txt', content: 'new' });

    expectApproval(outcome);
    expect(await readFile(outside, 'utf8')).toBe('old');

    expectOk(await writeApproved({ path: 'linked.txt', content: 'new' }));
    expect(await readFile(outside, 'utf8')).toBe('new');
    expect(await readFile(join(h.workspace, 'linked.txt'), 'utf8')).toBe('new');
  });

  it('确认后修改 content：旧 approvalToken 不授权新内容', async () => {
    const outside = outsideFile('tamper.txt');
    const first = await write({ path: outside, content: 'first' });
    const token = expectApproval(first).approvalToken;

    const changed = { sessionId, goal: '写文件', reason: '落盘改动', path: outside, content: 'second' };
    const retry = toOutcome(await h.client.send(approvalRetryBody('write', changed, token)));

    expect(retry.isError).toBe(true);
    expect(retry.text).toMatch(/不匹配/);
    await expect(access(outside)).rejects.toThrow();
  });

  it('用户取消后不写入', async () => {
    const outside = outsideFile('cancelled.txt');
    const args = { sessionId, goal: '写文件', reason: '落盘改动', path: outside, content: 'x' };
    const token = expectApproval(await h.client.callTool('write', args)).approvalToken;

    const outcome = toOutcome(
      await h.client.send(approvalRetryBody('write', args, token, { decision: 'cancel' })),
    );

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/取消/);
    await expect(access(outside)).rejects.toThrow();
    expect(h.logs.some((line) => line.includes('✗ WRITE'))).toBe(true);
  });

  it('确认中的写入不写 history，执行后才记录', async () => {
    const outside = outsideFile('history.txt');

    await write({ path: outside, content: 'x' });

    const pending = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(pending['history']).toHaveLength(0);

    expectOk(await writeApproved({ path: outside, content: 'x' }));

    const done = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(done['history']).toHaveLength(1);
    expect((done['history'] as Record<string, unknown>[])[0]).toMatchObject({ tool: 'write', ok: true });
  });

  it('确认卡片只展示 path / target / bytes，不打印正文', async () => {
    const outside = outsideFile('card.txt');
    const secret = 'TOPSECRET-WRITE-BODY';

    const outcome = await write({ path: outside, content: secret });

    expectApproval(outcome);

    // 去掉卡片装饰与换行后再比对，避免换行掩盖正文泄漏
    const flat = h.logs.join('\n').replace(/[│\s]+/g, '');
    expect(flat).toContain('write.outside-base');
    expect(flat).toContain(`bytes${secret.length}`);
    expect(flat).not.toContain(secret);
  });

  it('无法解析真实目标时 fail closed（symlink 自环）', async () => {
    await mkdir(join(h.workspace, 'loopdir'), { recursive: true });
    await symlink('loop', join(h.workspace, 'loopdir', 'loop'));

    const outcome = await write({ path: 'loopdir/loop', content: 'x' });

    expectApproval(outcome);
    expect(h.logs.join('\n')).toContain('write.unresolved');
  });
});
