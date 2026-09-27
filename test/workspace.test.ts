import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInsideWorkspace, resolvePath } from '../src/session.js';

describe('resolvePath（Session Workspace 解析）', () => {
  it('相对路径基于 workspace 解析', () => {
    const workspace = resolve('workspace', 'project-a');
    expect(resolvePath(workspace, join('src', 'index.ts'))).toBe(join(workspace, 'src', 'index.ts'));
  });

  it('允许通过 .. 离开 workspace', () => {
    const workspace = resolve('workspace', 'project-a');
    expect(resolvePath(workspace, join('..', 'shared', 'config.json'))).toBe(
      resolve(workspace, '..', 'shared', 'config.json'),
    );
    expect(resolvePath(workspace, join('..', '..', 'tmp', 'x'))).toBe(resolve('tmp', 'x'));
  });

  it('绝对路径直接使用，不受 workspace 限制', () => {
    const workspace = resolve('workspace', 'project-a');
    const output = resolve('tmp', 'output.log');
    const hosts = resolve('etc', 'hosts');
    expect(resolvePath(workspace, output)).toBe(output);
    expect(resolvePath(workspace, hosts)).toBe(hosts);
  });

  it('规范化结果中的 . 与 ..', () => {
    const workspace = resolve('workspace', 'project-a');
    expect(resolvePath(workspace, join('src', '..', 'lib', 'x.ts'))).toBe(join(workspace, 'lib', 'x.ts'));
  });

  it('同一相对路径在不同 workspace 下解析到不同位置', () => {
    expect(resolvePath(resolve('workspace', 'project-a'), 'x.ts')).not.toBe(
      resolvePath(resolve('workspace', 'project-b'), 'x.ts'),
    );
  });

  it('空 path 报错', () => {
    const workspace = resolve('workspace', 'project-a');
    expect(() => resolvePath(workspace, '')).toThrow(/path/);
    expect(() => resolvePath(workspace, '   ')).toThrow(/path/);
  });
});

describe('isInsideWorkspace（edit 的 workspace 边界判定）', () => {
  it('workspace 内（含子目录、相对路径解析后的结果）为 true', () => {
    const workspace = resolve('a', 'b');
    expect(isInsideWorkspace(workspace, join(workspace, 'file.ts'))).toBe(true);
    expect(isInsideWorkspace(workspace, join(workspace, 'c', 'd', 'file.ts'))).toBe(true);
    expect(isInsideWorkspace(workspace, resolvePath(workspace, join('src', 'x.ts')))).toBe(true);
  });

  it('不能用字符串前缀判断：同前缀的兄弟目录在 workspace 外', () => {
    const workspace = resolve('a', 'b');
    expect(isInsideWorkspace(workspace, join(dirname(workspace), `${basename(workspace)}c`, 'file.ts'))).toBe(false);
    expect(isInsideWorkspace(workspace, `${workspace}.txt`)).toBe(false);
  });

  it('workspace 本身与上层目录都在 workspace 外', () => {
    const workspace = resolve('a', 'b');
    expect(isInsideWorkspace(workspace, workspace)).toBe(false);
    expect(isInsideWorkspace(workspace, dirname(workspace))).toBe(false);
  });

  it('../ 穿越与其它绝对路径在 workspace 外', () => {
    const workspace = resolve('a', 'b');
    expect(isInsideWorkspace(workspace, resolvePath(workspace, join('..', 'c.ts')))).toBe(false);
    expect(isInsideWorkspace(workspace, resolve('etc', 'hosts'))).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('Windows 路径边界', () => {
  it('识别大小写不同的同一盘符路径，并拒绝同前缀目录与其它卷', () => {
    const workspace = 'C:\\work\\project';

    expect(resolvePath(workspace, 'src\\app.ts')).toBe('C:\\work\\project\\src\\app.ts');
    expect(isInsideWorkspace(workspace, 'c:\\WORK\\PROJECT\\src\\app.ts')).toBe(true);
    expect(isInsideWorkspace(workspace, 'C:\\work\\project-old\\app.ts')).toBe(false);
    expect(isInsideWorkspace(workspace, 'D:\\work\\project\\app.ts')).toBe(false);
  });

  it('正确处理 UNC workspace 及共享目录之外的目标', () => {
    const workspace = '\\\\server\\share\\project';

    expect(resolvePath(workspace, 'src\\app.ts')).toBe('\\\\server\\share\\project\\src\\app.ts');
    expect(isInsideWorkspace(workspace, '\\\\SERVER\\SHARE\\PROJECT\\src\\app.ts')).toBe(true);
    expect(isInsideWorkspace(workspace, '\\\\server\\share\\project-old\\app.ts')).toBe(false);
    expect(isInsideWorkspace(workspace, '\\\\other-server\\share\\project\\app.ts')).toBe(false);
  });
});
