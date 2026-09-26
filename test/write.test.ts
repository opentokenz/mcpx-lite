import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, expectError, expectOk, type Harness } from './harness.js';

let h: Harness;
let sessionId: string;

const write = (args: Record<string, unknown>) =>
  h.callTool('write', { sessionId, goal: '写文件', reason: '落盘改动', ...args });

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

  it('可以写 base 之外与绝对路径（base 不是写入边界）', async () => {
    const outside = join(h.workspace, '..', 'outside', 'logs', 'a.txt');

    const result = expectOk(await write({ path: outside, content: 'x' }));

    expect(result['path']).toBe(outside);
    expect(await readFile(outside, 'utf8')).toBe('x');
    expect(await readdir(join(h.workspace, '..', 'outside', 'logs'))).toEqual(['a.txt']);
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
