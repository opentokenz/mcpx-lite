import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
