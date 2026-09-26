import { describe, expect, it } from 'vitest';
import { resolvePath } from '../src/session.js';

describe('resolvePath（Session Base 解析）', () => {
  it('相对路径基于 base 解析', () => {
    expect(resolvePath('/workspace/project-a', 'src/index.ts')).toBe('/workspace/project-a/src/index.ts');
  });

  it('允许通过 .. 离开 base', () => {
    expect(resolvePath('/workspace/project-a', '../shared/config.json')).toBe('/workspace/shared/config.json');
    expect(resolvePath('/workspace/project-a', '../../tmp/x')).toBe('/tmp/x');
  });

  it('绝对路径直接使用，不受 base 限制', () => {
    expect(resolvePath('/workspace/project-a', '/tmp/output.log')).toBe('/tmp/output.log');
    expect(resolvePath('/workspace/project-a', '/etc/hosts')).toBe('/etc/hosts');
  });

  it('规范化结果中的 . 与 ..', () => {
    expect(resolvePath('/workspace/project-a', 'src/../lib/x.ts')).toBe('/workspace/project-a/lib/x.ts');
  });

  it('同一相对路径在不同 base 下解析到不同位置', () => {
    expect(resolvePath('/workspace/project-a', 'x.ts')).not.toBe(resolvePath('/workspace/project-b', 'x.ts'));
  });

  it('空 path 报错', () => {
    expect(() => resolvePath('/workspace/project-a', '')).toThrow(/path/);
    expect(() => resolvePath('/workspace/project-a', '   ')).toThrow(/path/);
  });
});
