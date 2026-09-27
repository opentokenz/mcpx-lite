import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSystemTrashBackend } from '../src/trash.js';

const smokeEnabled = process.env['MINI_PI_TRASH_SMOKE'] === '1';
let dir: string | undefined;

afterEach(async () => {
  if (smokeEnabled && process.platform === 'win32') {
    dir = undefined;
    return;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe.skipIf(!smokeEnabled)('system trash backend smoke', () => {
  it('把临时文件移动到当前操作系统的回收站', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mini-pi-trash-smoke-'));
    const target = join(dir, `trash-${randomUUID()}.txt`);
    await writeFile(target, 'smoke\n', 'utf8');

    await createSystemTrashBackend().trash(target);

    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
