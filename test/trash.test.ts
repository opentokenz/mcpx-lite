import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
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
let calls: string[];
let trashImpl: (path: string) => Promise<void>;

beforeEach(async () => {
  calls = [];
  trashImpl = async () => {};
  h = await createHarness({
    trashBackend: {
      async trash(path: string) {
        calls.push(path);
        await trashImpl(path);
      },
    },
  });
  const created = expectOk(
    await h.callTool('session', { action: 'create', workspace: h.workspace }),
  );
  sessionId = created['sessionId'] as string;
});

afterEach(async () => {
  await h.cleanup();
});

describe('trash 工具', () => {
  it('workspace 内目标首次调用仍要求确认，确认前 backend 调用为 0', async () => {
    await writeFile(join(h.workspace, 'old.txt'), 'old\n', 'utf8');

    const outcome = await h.callTool('trash', {
      sessionId,
      paths: ['old.txt'],
    });

    expectApproval(outcome);
    expect(calls).toEqual([]);
  });

  it('用户确认后才按解析后的绝对路径调用 backend', async () => {
    await writeFile(join(h.workspace, 'old.txt'), 'old\n', 'utf8');

    const result = expectOk(
      await h.callToolApproving('trash', {
        sessionId,
        paths: ['old.txt'],
      }),
    );

    expect(calls).toEqual([join(h.workspace, 'old.txt')]);
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it('支持目录和多个目标，并按输入顺序逐项调用 backend', async () => {
    await mkdir(join(h.workspace, 'tmp'));
    await writeFile(join(h.workspace, 'a.txt'), 'a\n', 'utf8');

    const result = expectOk(
      await h.callToolApproving('trash', {
        sessionId,
        paths: ['tmp', 'a.txt'],
      }),
    );

    expect(calls).toEqual([join(h.workspace, 'tmp'), join(h.workspace, 'a.txt')]);
    expect(result).toMatchObject({ succeeded: 2, failed: 0 });
  });

  it('workspace 外目标也无条件审批，确认前 backend 调用为 0', async () => {
    const outside = join(h.home, 'outside.txt');
    await writeFile(outside, 'outside\n', 'utf8');
    const args = { sessionId, paths: [outside] };

    expectApproval(await h.callTool('trash', args));
    expect(calls).toEqual([]);

    expectOk(await h.callToolApproving('trash', args));
    expect(calls).toEqual([outside]);
  });

  it('重复路径导致整批 preflight 失败且 backend 不执行', async () => {
    await writeFile(join(h.workspace, 'old.txt'), 'old\n', 'utf8');

    const message = expectError(
      await h.callTool('trash', {
        sessionId,
        paths: ['old.txt', './old.txt'],
      }),
    );

    expect(message).toMatch(/duplicate/i);
    expect(calls).toEqual([]);
  });

  it('祖先与后代同时出现时整批 preflight 失败', async () => {
    await mkdir(join(h.workspace, 'tmp'));
    await writeFile(join(h.workspace, 'tmp', 'cache.db'), 'cache\n', 'utf8');

    const message = expectError(
      await h.callTool('trash', {
        sessionId,
        paths: ['tmp', 'tmp/cache.db'],
      }),
    );

    expect(message).toMatch(/overlap/i);
    expect(calls).toEqual([]);
  });

  it('任一路径不存在时整批 preflight 失败且 backend 不执行', async () => {
    const message = expectError(
      await h.callTool('trash', {
        sessionId,
        paths: ['missing.txt'],
      }),
    );

    expect(message).toMatch(/does not exist/i);
    expect(calls).toEqual([]);
  });

  it('symlink 只处理链接对象自身，不跟随真实目标', async () => {
    const real = join(h.home, 'real.txt');
    const link = join(h.workspace, 'link.txt');
    await writeFile(real, 'real\n', 'utf8');
    await symlink(real, link);

    expectOk(await h.callToolApproving('trash', { sessionId, paths: ['link.txt'] }));

    expect(calls).toEqual([link]);
    expect(await readFile(real, 'utf8')).toBe('real\n');
  });

  it('glob 字符按普通路径处理，不展开匹配', async () => {
    await writeFile(join(h.workspace, 'a*.txt'), 'literal\n', 'utf8');

    expectOk(await h.callToolApproving('trash', { sessionId, paths: ['a*.txt'] }));

    expect(calls).toEqual([join(h.workspace, 'a*.txt')]);
  });

  it('approvalToken 对 paths 的顺序和数量敏感', async () => {
    await writeFile(join(h.workspace, 'a.txt'), 'a\n', 'utf8');
    await writeFile(join(h.workspace, 'b.txt'), 'b\n', 'utf8');
    await writeFile(join(h.workspace, 'c.txt'), 'c\n', 'utf8');

    const token = expectApproval(
      await h.callTool('trash', { sessionId, paths: ['a.txt', 'b.txt'] }),
    ).approvalToken;

    for (const paths of [
      ['b.txt', 'a.txt'],
      ['a.txt'],
      ['a.txt', 'b.txt', 'c.txt'],
    ]) {
      const args = { sessionId, paths, goal: 'g', reason: 'r' };
      const outcome = toOutcome(await h.client.send(approvalRetryBody('trash', args, token)));
      expect(outcome.isError, JSON.stringify(paths)).toBe(true);
      expect(outcome.text, JSON.stringify(paths)).toMatch(/不匹配/);
    }
    expect(calls).toEqual([]);
  });

  it('二次确认允许修改或省略 goal / reason', async () => {
    await writeFile(join(h.workspace, 'old.txt'), 'old\n', 'utf8');
    const firstArgs = { sessionId, paths: ['old.txt'], goal: '首轮目标', reason: '首轮原因' };
    const token = expectApproval(await h.client.callTool('trash', firstArgs)).approvalToken;

    const retry = toOutcome(
      await h.client.send(approvalRetryBody('trash', { sessionId, paths: ['old.txt'] }, token)),
    );

    expect(retry.isError).toBe(false);
    expect(calls).toEqual([join(h.workspace, 'old.txt')]);
  });

  it('单项 backend 失败后继续处理剩余目标并返回逐项结果', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(join(h.workspace, name), `${name}\n`, 'utf8');
    }
    trashImpl = async (path) => {
      if (path.endsWith('b.txt')) throw new Error('recycle bin unavailable');
    };

    const result = expectOk(
      await h.callToolApproving('trash', {
        sessionId,
        paths: ['a.txt', 'b.txt', 'c.txt'],
      }),
    );

    expect(calls.map((path) => basename(path))).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(result).toMatchObject({ succeeded: 2, failed: 1 });
    expect(result['results']).toEqual([
      { path: join(h.workspace, 'a.txt'), ok: true },
      { path: join(h.workspace, 'b.txt'), ok: false, error: 'recycle bin unavailable' },
      { path: join(h.workspace, 'c.txt'), ok: true },
    ]);
  });

  it('确认中的 trash 不写 history，实际执行后只写一条批次记录', async () => {
    await writeFile(join(h.workspace, 'a.txt'), 'a\n', 'utf8');
    await writeFile(join(h.workspace, 'b.txt'), 'b\n', 'utf8');
    const args = { sessionId, paths: ['a.txt', 'b.txt'] };

    expectApproval(await h.callTool('trash', args));
    const pending = expectOk(await h.callTool('session', { action: 'get', sessionId }));
    expect(pending['history']).toHaveLength(0);

    expectOk(await h.callToolApproving('trash', args));
    const done = expectOk(await h.callTool('session', { action: 'get', sessionId }));
    expect(done['history']).toHaveLength(1);
    expect((done['history'] as Record<string, unknown>[])[0]).toMatchObject({
      tool: 'trash',
      ok: true,
      target: '2 paths',
    });
    const summary = (done['history'] as Record<string, unknown>[])[0]?.['summary'];
    expect(summary).toMatch(/2 paths.*2 succeeded.*0 failed/);
    expect(summary).toMatch(/a\.txt.*b\.txt/);
  });
});
