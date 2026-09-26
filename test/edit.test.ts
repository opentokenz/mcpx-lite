import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, expectError, expectOk, type Harness } from './harness.js';

let h: Harness;
let sessionId: string;

const edit = (args: Record<string, unknown>) =>
  h.callTool('edit', { sessionId, goal: '改代码', reason: '精确替换', ...args });

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

  it('可以编辑 base 之外的绝对路径', async () => {
    const outside = join(h.workspace, '..', 'outside-edit.txt');
    await writeFile(outside, 'old value\n', 'utf8');

    expectOk(await edit({ path: outside, oldText: 'old value', newText: 'new value' }));

    expect(await readFile(outside, 'utf8')).toBe('new value\n');
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
