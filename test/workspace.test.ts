import { describe, expect, it } from 'vitest';
import { isInsideWorkspace, resolvePath } from '../src/session.js';

describe('resolvePath（Session Workspace 解析）', () => {
  it('相对路径基于 workspace 解析', () => {
    expect(resolvePath('/workspace/project-a', 'src/index.ts')).toBe('/workspace/project-a/src/index.ts');
  });

  it('允许通过 .. 离开 workspace', () => {
    expect(resolvePath('/workspace/project-a', '../shared/config.json')).toBe('/workspace/shared/config.json');
    expect(resolvePath('/workspace/project-a', '../../tmp/x')).toBe('/tmp/x');
  });

  it('绝对路径直接使用，不受 workspace 限制', () => {
    expect(resolvePath('/workspace/project-a', '/tmp/output.log')).toBe('/tmp/output.log');
    expect(resolvePath('/workspace/project-a', '/etc/hosts')).toBe('/etc/hosts');
  });

  it('规范化结果中的 . 与 ..', () => {
    expect(resolvePath('/workspace/project-a', 'src/../lib/x.ts')).toBe('/workspace/project-a/lib/x.ts');
  });

  it('同一相对路径在不同 workspace 下解析到不同位置', () => {
    expect(resolvePath('/workspace/project-a', 'x.ts')).not.toBe(resolvePath('/workspace/project-b', 'x.ts'));
  });

  it('空 path 报错', () => {
    expect(() => resolvePath('/workspace/project-a', '')).toThrow(/path/);
    expect(() => resolvePath('/workspace/project-a', '   ')).toThrow(/path/);
  });
});

describe('isInsideWorkspace（edit 的 workspace 边界判定）', () => {
  it('workspace 内（含子目录、相对路径解析后的结果）为 true', () => {
    expect(isInsideWorkspace('/a/b', '/a/b/file.ts')).toBe(true);
    expect(isInsideWorkspace('/a/b', '/a/b/c/d/file.ts')).toBe(true);
    expect(isInsideWorkspace('/a/b', resolvePath('/a/b', 'src/x.ts'))).toBe(true);
  });

  it('不能用字符串前缀判断：同前缀的兄弟目录在 workspace 外', () => {
    expect(isInsideWorkspace('/a/b', '/a/bc/file.ts')).toBe(false);
    expect(isInsideWorkspace('/a/b', '/a/b.txt')).toBe(false);
  });

  it('workspace 本身与上层目录都在 workspace 外', () => {
    expect(isInsideWorkspace('/a/b', '/a/b')).toBe(false);
    expect(isInsideWorkspace('/a/b', '/a')).toBe(false);
  });

  it('../ 穿越与其它绝对路径在 workspace 外', () => {
    expect(isInsideWorkspace('/a/b', resolvePath('/a/b', '../c.ts'))).toBe(false);
    expect(isInsideWorkspace('/a/b', '/etc/hosts')).toBe(false);
  });
});
