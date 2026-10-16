import { open, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type SkillSource = 'global' | 'project';

export interface SkillMeta {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
}

export interface SkillContent {
  meta: SkillMeta;
  content: string;
  truncated: boolean;
}

export function skillMetadata(skills: SkillMeta[]): Pick<SkillMeta, 'name' | 'description' | 'source'>[] {
  return skills.map(({ name, description, source }) => ({ name, description, source }));
}

const SKILL_FILE = 'SKILL.md';
export const SKILLS_SUBDIR = join('.agents', 'skills');

const HEAD_BYTES = 16 * 1024;
const MAX_DESCRIPTION = 300;
const MAX_CONTENT = 200_000;

/**
 * 扫描 `~/.agents/skills` 与 `<workspace>/.agents/skills` 的 skill 元数据。
 *
 * 只在 `scan`/`get` 时读文件头 16 KiB 解析 frontmatter，正文永远不进入索引；
 * project 目录的同名 skill 覆盖 global。
 */
export class SkillIndex {
  private readonly globalSkillsDir: string;

  constructor(opts: { globalSkillsDir?: string } = {}) {
    this.globalSkillsDir = opts.globalSkillsDir ?? join(homedir(), SKILLS_SUBDIR);
  }

  async scan(workspace: string): Promise<SkillMeta[]> {
    const [globalSkills, projectSkills] = await Promise.all([
      scanDir(this.globalSkillsDir, 'global'),
      scanDir(join(workspace, SKILLS_SUBDIR), 'project'),
    ]);

    const merged = new Map<string, SkillMeta>();
    for (const skill of globalSkills) merged.set(skill.name, skill);
    for (const skill of projectSkills) merged.set(skill.name, skill);

    return [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async get(workspace: string, name: string): Promise<SkillContent | undefined> {
    const meta = (await this.scan(workspace)).find((skill) => skill.name === name);
    if (!meta) return undefined;

    const raw = await readFile(meta.path, 'utf8');
    const { body } = splitFrontmatter(raw);
    const truncated = body.length > MAX_CONTENT;

    return { meta, content: truncated ? body.slice(0, MAX_CONTENT) : body, truncated };
  }
}

async function scanDir(dir: string, source: SkillSource): Promise<SkillMeta[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills: SkillMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = join(dir, entry.name, SKILL_FILE);
    const head = await readHead(file, HEAD_BYTES);
    if (head === undefined) continue;
    skills.push(parseSkill(entry.name, file, source, head));
  }

  return skills;
}

/** 读取文件头（不存在或不是普通文件时返回 undefined）。 */
async function readHead(path: string, bytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const size = Math.min(bytes, Number(info.size));
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    return buffer.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

export function splitFrontmatter(text: string): { frontmatter?: Record<string, unknown>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { body: text };

  // 去掉 frontmatter 及其后的空行，正文从第一条实际内容开始
  const body = text.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
  try {
    const parsed: unknown = parseYaml(match[1] ?? '');
    return { frontmatter: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}, body };
  } catch {
    // frontmatter 坏掉时按「没有 frontmatter」处理，用目录名 + 正文首段兜底
    return { body };
  }
}

function parseSkill(dirName: string, path: string, source: SkillSource, head: string): SkillMeta {
  const { frontmatter, body } = splitFrontmatter(head);
  const name = nonEmptyString(frontmatter?.['name']) ?? dirName;
  const description = normalizeDescription(nonEmptyString(frontmatter?.['description']) ?? firstParagraph(body));
  return { name, description, source, path };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeDescription(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > MAX_DESCRIPTION ? single.slice(0, MAX_DESCRIPTION) : single;
}

function firstParagraph(body: string): string {
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('```')) continue;
    return line.replace(/^[>*+-]\s*/, '').replace(/^["'`]|["'`]$/g, '');
  }
  return '';
}
