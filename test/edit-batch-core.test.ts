import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitPreparedEdits, prepareBatchEdits } from '../src/edit-batch.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mini-pi-edit-batch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('edit batch commit', () => {
  it('prepare 后目标内容被外部修改时拒绝提交且不覆盖新内容', async () => {
    const path = join(dir, 'a.ts');
    await writeFile(path, 'old\n', 'utf8');
    const prepared = await prepareBatchEdits(dir, [
      { path: 'a.ts', replacements: [{ oldText: 'old', newText: 'new' }] },
    ]);

    await writeFile(path, 'external-change\n', 'utf8');

    await expect(commitPreparedEdits(prepared)).rejects.toThrow(/concurrent modification/i);
    expect(await readFile(path, 'utf8')).toBe('external-change\n');
  });

  it('第 N 个写入失败时逆序恢复已经提交的文件', async () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    await writeFile(a, 'old-a\n', 'utf8');
    await writeFile(b, 'old-b\n', 'utf8');
    const prepared = await prepareBatchEdits(dir, [
      { path: 'a.ts', replacements: [{ oldText: 'old-a', newText: 'new-a' }] },
      { path: 'b.ts', replacements: [{ oldText: 'old-b', newText: 'new-b' }] },
    ]);

    const commit = commitPreparedEdits as unknown as (
      batch: typeof prepared,
      io: {
        read(path: string): Promise<string>;
        write(path: string, content: string): Promise<void>;
      },
    ) => Promise<void>;

    await expect(
      commit(prepared, {
        read: (path) => readFile(path, 'utf8'),
        async write(path, content) {
          if (path === prepared[1]!.target && content === 'new-b\n') throw new Error('disk full');
          await writeFile(path, content, 'utf8');
        },
      }),
    ).rejects.toThrow(/rollbackSucceeded=true/);

    expect(await readFile(a, 'utf8')).toBe('old-a\n');
    expect(await readFile(b, 'utf8')).toBe('old-b\n');
  });

  it('回滚失败时返回 rollbackSucceeded=false 与 uncertainPaths', async () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    await writeFile(a, 'old-a\n', 'utf8');
    await writeFile(b, 'old-b\n', 'utf8');
    const prepared = await prepareBatchEdits(dir, [
      { path: 'a.ts', replacements: [{ oldText: 'old-a', newText: 'new-a' }] },
      { path: 'b.ts', replacements: [{ oldText: 'old-b', newText: 'new-b' }] },
    ]);

    const commit = commitPreparedEdits as unknown as (
      batch: typeof prepared,
      io: {
        read(path: string): Promise<string>;
        write(path: string, content: string): Promise<void>;
      },
    ) => Promise<void>;

    await expect(
      commit(prepared, {
        read: (path) => readFile(path, 'utf8'),
        async write(path, content) {
          if (path === prepared[0]!.target && content === 'old-a\n') throw new Error('rollback denied');
          if (path === prepared[1]!.target && content === 'new-b\n') throw new Error('disk full');
          await writeFile(path, content, 'utf8');
        },
      }),
    ).rejects.toThrow(/rollbackSucceeded=false.*uncertainPaths/);

    expect(await readFile(a, 'utf8')).toBe('new-a\n');
    expect(await readFile(b, 'utf8')).toBe('old-b\n');
  });
});
