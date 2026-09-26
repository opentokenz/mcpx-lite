import { randomBytes } from 'node:crypto';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * 原子写文件：先写同目录临时文件再 rename，避免读到半个文件或中断留下损坏内容。
 * session 存储、write 工具、edit 工具共用这一处实现。
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

/**
 * 目标文件的真实路径（目标可以尚不存在）：从目标向上找到最深的存在祖先并 realpath，
 * 再拼回剩余路径段。返回 null 表示真实路径无法解析（symlink 环、权限等），
 * 调用方按 fail closed 处理（要求用户确认，而不是假定安全）。
 */
export async function realpathDeep(absolute: string): Promise<string | null> {
  let current = absolute;
  const suffix: string[] = [];

  for (;;) {
    try {
      return join(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if (!isNotFound(error)) return null;

      const parent = dirname(current);
      if (parent === current) return null;

      suffix.push(basename(current));
      current = parent;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
