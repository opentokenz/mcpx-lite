import { beforeEach, describe, expect, it, vi } from 'vitest';

const packageMover = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('trash', () => ({ default: packageMover }));

beforeEach(() => {
  packageMover.mockClear();
});

describe('system trash backend', () => {
  it('单项调用第三方 trash 时显式关闭 glob', async () => {
    const module = await import('../src/trash.js');
    const factory = (module as Record<string, unknown>)['createSystemTrashBackend'];
    expect(factory).toBeTypeOf('function');

    const calls: unknown[] = [];
    const backend = (factory as (
      move: (paths: string[], options: { glob: boolean }) => Promise<void>,
    ) => { trash(path: string): Promise<void> })(async (paths, options) => {
      calls.push({ paths, options });
    });

    await backend.trash('/tmp/a*');

    expect(calls).toEqual([{ paths: ['/tmp/a*'], options: { glob: false } }]);
  });

  it('默认 backend 单项调用 trash npm 包并关闭 glob', async () => {
    const module = await import('../src/trash.js');
    const backend = module.createSystemTrashBackend();

    await backend.trash('/tmp/a*');

    expect(packageMover).toHaveBeenCalledWith(['/tmp/a*'], { glob: false });
  });
});
