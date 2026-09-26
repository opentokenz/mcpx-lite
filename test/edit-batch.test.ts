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

beforeEach(async () => {
  h = await createHarness();
  const created = expectOk(
    await h.callTool('session', { action: 'create', workspace: h.workspace }),
  );
  sessionId = created['sessionId'] as string;
});

afterEach(async () => {
  await h.cleanup();
});

describe('batch edit', () => {
  it('统一 edits[] schema，并在同一文件中按顺序应用多个 replacement', async () => {
    await writeFile(join(h.workspace, 'app.ts'), 'const a = 1;\nuse(a);\n', 'utf8');

    const result = expectOk(
      await h.callTool('edit', {
        sessionId,
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
    expect(result).toMatchObject({ files: 1, replacements: 2 });
  });

  it('后续文件预检失败时整个 batch 0 写入', async () => {
    await writeFile(join(h.workspace, 'a.ts'), 'old-a\n', 'utf8');
    await writeFile(join(h.workspace, 'b.ts'), 'old-b\n', 'utf8');

    const message = expectError(
      await h.callTool('edit', {
        sessionId,
        edits: [
          { path: 'a.ts', replacements: [{ oldText: 'old-a', newText: 'new-a' }] },
          { path: 'b.ts', replacements: [{ oldText: 'missing', newText: 'new-b' }] },
        ],
      }),
    );

    expect(message).toMatch(/not found/i);
    expect(message).toMatch(/editIndex=1/);
    expect(message).toMatch(/replacementIndex=0/);
    expect(message).toMatch(/b\.ts/);
    expect(await readFile(join(h.workspace, 'a.ts'), 'utf8')).toBe('old-a\n');
    expect(await readFile(join(h.workspace, 'b.ts'), 'utf8')).toBe('old-b\n');
  });

  it('同一真实文件通过 real path 与 symlink 重复出现时整批拒绝', async () => {
    const real = join(h.workspace, 'real.ts');
    await writeFile(real, 'old\n', 'utf8');
    await symlink(real, join(h.workspace, 'alias.ts'));

    const message = expectError(
      await h.callTool('edit', {
        sessionId,
        edits: [
          { path: 'real.ts', replacements: [{ oldText: 'old', newText: 'first' }] },
          { path: 'alias.ts', replacements: [{ oldText: 'old', newText: 'second' }] },
        ],
      }),
    );

    expect(message).toMatch(/duplicate target/i);
    expect(await readFile(real, 'utf8')).toBe('old\n');
  });

  it('任一真实目标位于 workspace 外时整批一次审批，确认前 0 写入', async () => {
    const inside = join(h.workspace, 'inside.ts');
    const outside = join(h.home, 'outside.ts');
    await writeFile(inside, 'old-in\n', 'utf8');
    await writeFile(outside, 'old-out\n', 'utf8');
    const args = {
      sessionId,
      edits: [
        { path: 'inside.ts', replacements: [{ oldText: 'old-in', newText: 'new-in' }] },
        { path: outside, replacements: [{ oldText: 'old-out', newText: 'new-out' }] },
      ],
    };

    expectApproval(await h.callTool('edit', args));
    expect(await readFile(inside, 'utf8')).toBe('old-in\n');
    expect(await readFile(outside, 'utf8')).toBe('old-out\n');

    expectOk(await h.callToolApproving('edit', args));
    expect(await readFile(inside, 'utf8')).toBe('new-in\n');
    expect(await readFile(outside, 'utf8')).toBe('new-out\n');
  });

  it('审批等待期间文件发生变化时触发 concurrent_modification 且 0 写入', async () => {
    const outside = join(h.home, 'outside-concurrent.ts');
    await writeFile(outside, 'old\n', 'utf8');
    const args = {
      sessionId,
      edits: [{ path: outside, replacements: [{ oldText: 'old', newText: 'new' }] }],
    };

    const token = expectApproval(await h.callTool('edit', args)).approvalToken;
    await writeFile(outside, 'prefix\nold\n', 'utf8');

    const outcome = toOutcome(await h.client.send(approvalRetryBody('edit', args, token)));

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/concurrent[_ ]modification/i);
    expect(await readFile(outside, 'utf8')).toBe('prefix\nold\n');
  });
});
