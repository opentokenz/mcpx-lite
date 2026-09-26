import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/** 只调用一轮：base 内编辑与门禁断言。 */
const edit = (args: Record<string, unknown>) =>
  h.callTool('edit', { sessionId, goal: '改代码', reason: '精确替换', ...args });

/** 完整两轮：base 外编辑自动确认后执行。 */
const editApproved = (args: Record<string, unknown>) =>
  h.callToolApproving('edit', { sessionId, goal: '改代码', reason: '精确替换', ...args });

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

describe('edit 工具', () => {
  it('唯一匹配时替换成功并返回 replaced / bytes', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');

    const result = expectOk(await edit({ path: 'app.ts', oldText: 'const b = 2;', newText: 'const b = 42;' }));

    expect(result).toMatchObject({ path: join(h.workspace, 'app.ts'), replaced: 1 });
    expect(result['bytes']).toBe(Buffer.byteLength('const a = 1;\nconst b = 42;\n', 'utf8'));
    expect(await readFile(join(h.workspace, 'app.ts'), 'utf8')).toBe('const a = 1;\nconst b = 42;\n');
  });

  it('支持多行 oldText 与删除（newText 为空串）', async () => {
    await writeFile(join(h.workspace, 'multi.ts'), 'keep\nremove me\nkeep2\n', 'utf8');

    expectOk(await edit({ path: 'multi.ts', oldText: 'remove me\n', newText: '' }));

    expect(await readFile(join(h.workspace, 'multi.ts'), 'utf8')).toBe('keep\nkeep2\n');
  });

  it('oldText 不存在时报错且文件不变', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\n', 'utf8');

    const message = expectError(await edit({ path: 'app.ts', oldText: 'nope', newText: 'x' }));

    expect(message).toMatch(/not found/);
    expect(await readFile(join(h.workspace, 'app.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('多处匹配时报错（带次数）且文件不变', async () => {
    await writeFile(join(h.workspace, 'dup.ts'), 'x();\nx();\nx();\n', 'utf8');

    const message = expectError(await edit({ path: 'dup.ts', oldText: 'x();', newText: 'y();' }));

    expect(message).toMatch(/matches 3 times/);
    expect(await readFile(join(h.workspace, 'dup.ts'), 'utf8')).toBe('x();\nx();\nx();\n');
  });

  it('oldText 为空、文件不存在、目标是目录时报错', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\n', 'utf8');

    expect(expectError(await edit({ path: 'app.ts', oldText: '', newText: 'x' }))).toMatch(/oldText/);
    expect(expectError(await edit({ path: 'missing.ts', oldText: 'a', newText: 'b' }))).toMatch(/does not exist/);
    expect(expectError(await edit({ path: '.', oldText: 'a', newText: 'b' }))).toMatch(/not a regular file/);
  });

  it('失败调用留 history（含 error），成功调用 target 是绝对路径', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\n', 'utf8');
    expectError(await edit({ path: 'app.ts', oldText: 'nope', newText: 'x' }));
    expectOk(await edit({ path: 'app.ts', oldText: 'const a = 1;', newText: 'const a = 2;' }));

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history[0]).toMatchObject({ tool: 'edit', ok: false, target: join(h.workspace, 'app.ts') });
    expect(history[0]?.['error']).toMatch(/not found/);
    expect(history[1]).toMatchObject({ tool: 'edit', ok: true });
  });
});

describe('edit base 边界门禁（MRTR）', () => {
  it('base 内普通文件不需要确认', async () => {
    await writeFile(join(h.workspace, 'inside.ts'), 'old\n', 'utf8');

    const outcome = await edit({ path: 'inside.ts', oldText: 'old', newText: 'new' });

    expect(outcome.resultType).not.toBe('input_required');
    expect(outcome.isError).toBe(false);
    expect(await readFile(join(h.workspace, 'inside.ts'), 'utf8')).toBe('new\n');
  });

  it('base 内 symlink 指向 base 内文件时也不需要确认', async () => {
    await writeFile(join(h.workspace, 'real.ts'), 'old\n', 'utf8');
    await symlink(join(h.workspace, 'real.ts'), join(h.workspace, 'alias.ts'));

    const outcome = await edit({ path: 'alias.ts', oldText: 'old', newText: 'new' });

    expect(outcome.resultType).not.toBe('input_required');
    expect(await readFile(join(h.workspace, 'real.ts'), 'utf8')).toBe('new\n');
  });

  it('../ 相对路径越界时不修改文件并返回审核卡片', async () => {
    const outside = join(h.workspace, '..', 'outside-traverse.txt');
    await writeFile(outside, 'old\n', 'utf8');

    const outcome = await edit({ path: '../outside-traverse.txt', oldText: 'old', newText: 'new' });

    expectApproval(outcome);
    expect(await readFile(outside, 'utf8')).toBe('old\n');

    expectOk(await editApproved({ path: '../outside-traverse.txt', oldText: 'old', newText: 'new' }));
    expect(await readFile(outside, 'utf8')).toBe('new\n');
  });

  it('绝对路径指向 base 外时不修改文件并返回审核卡片', async () => {
    const outside = join(h.workspace, '..', 'outside-absolute.txt');
    await writeFile(outside, 'old value\n', 'utf8');

    const outcome = await edit({ path: outside, oldText: 'old value', newText: 'new value' });

    expect(expectApproval(outcome).approvalToken).toMatch(/^apr_/);
    expect(await readFile(outside, 'utf8')).toBe('old value\n');

    expectOk(await editApproved({ path: outside, oldText: 'old value', newText: 'new value' }));
    expect(await readFile(outside, 'utf8')).toBe('new value\n');
  });

  it('base 内 symlink 指向 base 外时按真实路径判定，确认后写入真实目标而不替换 symlink', async () => {
    const outside = join(h.workspace, '..', 'outside-symlink-target.txt');
    await writeFile(outside, 'old\n', 'utf8');
    await symlink(outside, join(h.workspace, 'escape.ts'));

    const outcome = await edit({ path: 'escape.ts', oldText: 'old', newText: 'new' });

    expectApproval(outcome);
    expect(await readFile(outside, 'utf8')).toBe('old\n');

    expectOk(await editApproved({ path: 'escape.ts', oldText: 'old', newText: 'new' }));
    expect(await readFile(outside, 'utf8')).toBe('new\n');

    // symlink 仍然存在，且仍指向基外目标
    const link = await readFile(join(h.workspace, 'escape.ts'), 'utf8');
    expect(link).toBe('new\n');
  });

  it('确认后修改 path / oldText / newText 都不会被旧 approvalToken 授权', async () => {
    const outside = join(h.workspace, '..', 'outside-tamper.txt');
    const other = join(h.workspace, '..', 'outside-tamper-other.txt');
    await writeFile(outside, 'old\n', 'utf8');
    await writeFile(other, 'other\n', 'utf8');

    const args = { path: outside, oldText: 'old', newText: 'new' };
    const token = expectApproval(await edit(args)).approvalToken;

    for (const changed of [
      { ...args, path: other },
      { ...args, oldText: 'other' },
      { ...args, newText: 'changed' },
    ]) {
      const fullArgs = { sessionId, goal: 'g', reason: 'r', ...changed };
      const outcome = toOutcome(await h.client.send(approvalRetryBody('edit', fullArgs, token)));

      expect(outcome.isError, JSON.stringify(changed)).toBe(true);
      expect(outcome.text, JSON.stringify(changed)).toMatch(/不匹配/);
    }

    expect(await readFile(outside, 'utf8')).toBe('old\n');
    expect(await readFile(other, 'utf8')).toBe('other\n');
  });

  it('确认中的 base 外编辑不写 history，确认执行后才记录', async () => {
    const outside = join(h.workspace, '..', 'outside-history.txt');
    await writeFile(outside, 'old\n', 'utf8');

    await edit({ path: outside, oldText: 'old', newText: 'new' });

    const pending = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(pending['history']).toHaveLength(0);

    expectOk(await editApproved({ path: outside, oldText: 'old', newText: 'new' }));

    const done = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(done['history']).toHaveLength(1);
    expect((done['history'] as Record<string, unknown>[])[0]).toMatchObject({ tool: 'edit', ok: true });
  });
});
