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

/** 只调用一轮：workspace 内编辑与门禁断言。 */
const edit = (args: Record<string, unknown>) =>
  h.callTool('edit', { sessionId, goal: '改代码', reason: '精确替换', ...args });

/** 完整两轮：workspace 外编辑自动确认后执行。 */
const editApproved = (args: Record<string, unknown>) =>
  h.callToolApproving('edit', { sessionId, goal: '改代码', reason: '精确替换', ...args });

const single = (path: string, oldText: string, newText: string) => ({
  edits: [{ path, replacements: [{ oldText, newText }] }],
});

beforeEach(async () => {
  h = await createHarness();
  const created = expectOk(
    await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '改代码', reason: '开始任务' }),
  );
  sessionId = created['sessionId'] as string;
});

afterEach(async () => {
  await h.cleanup();
});

describe('edit 工具', () => {
  it('单文件单 replacement 成功并返回 files / replacements', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');

    const result = expectOk(await edit(single('app.ts', 'const b = 2;', 'const b = 42;')));

    expect(result).toMatchObject({ files: 1, replacements: 1 });
    expect(await readFile(join(h.workspace, 'app.ts'), 'utf8')).toBe('const a = 1;\nconst b = 42;\n');
  });

  it('同一文件多个 replacement 严格按数组顺序应用', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\nuse(a);\n', 'utf8');

    expectOk(
      await edit({
        edits: [
          {
            path: 'app.ts',
            replacements: [
              { oldText: 'const a = 1;', newText: 'const b = 2;' },
              { oldText: 'use(a);', newText: 'use(b);' },
            ],
          },
        ],
      }),
    );

    expect(await readFile(join(h.workspace, 'app.ts'), 'utf8')).toBe('const b = 2;\nuse(b);\n');
  });

  it('后一个 replacement 可以匹配前一个 replacement 生成的内容', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'use(a);\n', 'utf8');

    expectOk(
      await edit({
        edits: [
          {
            path: 'app.ts',
            replacements: [
              { oldText: 'use(a);', newText: 'use(b);' },
              { oldText: 'use(b);', newText: 'use(c);' },
            ],
          },
        ],
      }),
    );

    expect(await readFile(join(h.workspace, 'app.ts'), 'utf8')).toBe('use(c);\n');
  });

  it('多文件 happy path', async () => {
    await writeFile(join(h.workspace, 'a.ts'), 'old-a\n', 'utf8');
    await writeFile(join(h.workspace, 'b.ts'), 'old-b\n', 'utf8');

    const result = expectOk(
      await edit({
        edits: [
          { path: 'a.ts', replacements: [{ oldText: 'old-a', newText: 'new-a' }] },
          { path: 'b.ts', replacements: [{ oldText: 'old-b', newText: 'new-b' }] },
        ],
      }),
    );

    expect(result).toMatchObject({ files: 2, replacements: 2 });
    expect(await readFile(join(h.workspace, 'a.ts'), 'utf8')).toBe('new-a\n');
    expect(await readFile(join(h.workspace, 'b.ts'), 'utf8')).toBe('new-b\n');
  });

  it('支持多行 oldText 与删除（newText 为空串）', async () => {
    await writeFile(join(h.workspace, 'multi.ts'), 'keep\nremove me\nkeep2\n', 'utf8');

    expectOk(await edit(single('multi.ts', 'remove me\n', '')));

    expect(await readFile(join(h.workspace, 'multi.ts'), 'utf8')).toBe('keep\nkeep2\n');
  });

  it('oldText 不存在时报错且文件不变', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\n', 'utf8');

    const message = expectError(await edit(single('app.ts', 'nope', 'x')));

    expect(message).toMatch(/not found/);
    expect(await readFile(join(h.workspace, 'app.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('多处匹配时报错（带次数）且文件不变', async () => {
    await writeFile(join(h.workspace, 'dup.ts'), 'x();\nx();\nx();\n', 'utf8');

    const message = expectError(await edit(single('dup.ts', 'x();', 'y();')));

    expect(message).toMatch(/matches 3 times/);
    expect(await readFile(join(h.workspace, 'dup.ts'), 'utf8')).toBe('x();\nx();\nx();\n');
  });

  it('oldText 为空、文件不存在、目标是目录时报错', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\n', 'utf8');

    expect(expectError(await edit(single('app.ts', '', 'x')))).toMatch(/oldText|too small/i);
    expect(expectError(await edit(single('missing.ts', 'a', 'b')))).toMatch(/does not exist/);
    expect(expectError(await edit(single('.', 'a', 'b')))).toMatch(/not a regular file/);
  });

  it('旧 path / oldText / newText schema 被明确拒绝', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'old\n', 'utf8');

    const message = expectError(
      await edit({ path: 'app.ts', oldText: 'old', newText: 'new' }),
    );

    expect(message).toMatch(/edits/);
    expect(await readFile(join(h.workspace, 'app.ts'), 'utf8')).toBe('old\n');
  });

  it('失败调用留 history，多文件成功只写一条批次记录', async () => {
    await writeFile(join(h.workspace, 'a.ts'), 'old-a\n', 'utf8');
    await writeFile(join(h.workspace, 'b.ts'), 'old-b\n', 'utf8');
    expectError(await edit(single('a.ts', 'nope', 'x')));
    expectOk(
      await edit({
        edits: [
          { path: 'a.ts', replacements: [{ oldText: 'old-a', newText: 'new-a' }] },
          { path: 'b.ts', replacements: [{ oldText: 'old-b', newText: 'new-b' }] },
        ],
      }),
    );

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ tool: 'edit', ok: false, target: '1 files' });
    expect(history[0]?.['error']).toMatch(/not found/);
    expect(history[1]).toMatchObject({ tool: 'edit', ok: true, target: '2 files' });
    expect(history[1]?.['summary']).toMatch(/2 files.*2 replacements/);
    expect(history[1]?.['summary']).toMatch(/a\.ts.*b\.ts/);
  });
});

describe('edit workspace 边界门禁（MRTR）', () => {
  it('workspace 内普通文件不需要确认', async () => {
    await writeFile(join(h.workspace, 'inside.ts'), 'old\n', 'utf8');

    const outcome = await edit(single('inside.ts', 'old', 'new'));

    expect(outcome.resultType).not.toBe('input_required');
    expect(outcome.isError).toBe(false);
    expect(await readFile(join(h.workspace, 'inside.ts'), 'utf8')).toBe('new\n');
  });

  it('workspace 内 symlink 指向 workspace 内文件时也不需要确认', async () => {
    await writeFile(join(h.workspace, 'real.ts'), 'old\n', 'utf8');
    await symlink(join(h.workspace, 'real.ts'), join(h.workspace, 'alias.ts'));

    const outcome = await edit(single('alias.ts', 'old', 'new'));

    expect(outcome.resultType).not.toBe('input_required');
    expect(await readFile(join(h.workspace, 'real.ts'), 'utf8')).toBe('new\n');
  });

  it('../ 相对路径越界时不修改文件并返回审核卡片', async () => {
    const outside = join(h.workspace, '..', 'outside-traverse.txt');
    await writeFile(outside, 'old\n', 'utf8');

    const outcome = await edit(single('../outside-traverse.txt', 'old', 'new'));

    expectApproval(outcome);
    expect(await readFile(outside, 'utf8')).toBe('old\n');

    expectOk(await editApproved(single('../outside-traverse.txt', 'old', 'new')));
    expect(await readFile(outside, 'utf8')).toBe('new\n');
  });

  it('绝对路径指向 workspace 外时不修改文件并返回审核卡片', async () => {
    const outside = join(h.workspace, '..', 'outside-absolute.txt');
    await writeFile(outside, 'old value\n', 'utf8');

    const outcome = await edit(single(outside, 'old value', 'new value'));

    expect(expectApproval(outcome).approvalToken).toMatch(/^apr_/);
    expect(await readFile(outside, 'utf8')).toBe('old value\n');

    expectOk(await editApproved(single(outside, 'old value', 'new value')));
    expect(await readFile(outside, 'utf8')).toBe('new value\n');
  });

  it('workspace 内 symlink 指向 workspace 外时按真实路径判定，确认后写入真实目标而不替换 symlink', async () => {
    const outside = join(h.workspace, '..', 'outside-symlink-target.txt');
    await writeFile(outside, 'old\n', 'utf8');
    await symlink(outside, join(h.workspace, 'escape.ts'));

    const outcome = await edit(single('escape.ts', 'old', 'new'));

    expectApproval(outcome);
    expect(await readFile(outside, 'utf8')).toBe('old\n');

    expectOk(await editApproved(single('escape.ts', 'old', 'new')));
    expect(await readFile(outside, 'utf8')).toBe('new\n');
    expect(await readFile(join(h.workspace, 'escape.ts'), 'utf8')).toBe('new\n');
  });

  it('确认后修改 path / oldText / newText 都不会被旧 approvalToken 授权', async () => {
    const outside = join(h.workspace, '..', 'outside-tamper.txt');
    const other = join(h.workspace, '..', 'outside-tamper-other.txt');
    await writeFile(outside, 'alpha\nbeta\n', 'utf8');
    await writeFile(other, 'alpha\n', 'utf8');

    const args = single(outside, 'alpha', 'ALPHA');
    const token = expectApproval(await edit(args)).approvalToken;

    for (const changed of [
      single(other, 'alpha', 'ALPHA'),
      single(outside, 'beta', 'BETA'),
      single(outside, 'alpha', 'OMEGA'),
    ]) {
      const fullArgs = { sessionId, goal: 'g', reason: 'r', ...changed };
      const outcome = toOutcome(await h.client.send(approvalRetryBody('edit', fullArgs, token)));

      expect(outcome.isError, JSON.stringify(changed)).toBe(true);
      expect(outcome.text, JSON.stringify(changed)).toMatch(/不匹配/);
    }

    expect(await readFile(outside, 'utf8')).toBe('alpha\nbeta\n');
    expect(await readFile(other, 'utf8')).toBe('alpha\n');
  });

  it('二次确认允许省略 goal / reason，只校验 edit 业务参数', async () => {
    const outside = join(h.workspace, '..', 'outside-audit-fields.txt');
    await writeFile(outside, 'old\n', 'utf8');

    const firstArgs = {
      sessionId,
      ...single(outside, 'old', 'new'),
      goal: '首轮目标',
      reason: '首轮原因',
    };
    const token = expectApproval(await h.client.callTool('edit', firstArgs)).approvalToken;

    const retryArgs = { sessionId, ...single(outside, 'old', 'new') };
    const retry = toOutcome(await h.client.send(approvalRetryBody('edit', retryArgs, token)));

    expect(retry.isError).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe('new\n');
  });

  it('确认中的 workspace 外编辑不写 history，确认执行后才记录', async () => {
    const outside = join(h.workspace, '..', 'outside-history.txt');
    await writeFile(outside, 'old\n', 'utf8');

    await edit(single(outside, 'old', 'new'));

    const pending = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(pending['history']).toHaveLength(0);

    expectOk(await editApproved(single(outside, 'old', 'new')));

    const done = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(done['history']).toHaveLength(1);
    expect((done['history'] as Record<string, unknown>[])[0]).toMatchObject({ tool: 'edit', ok: true });
  });
});
