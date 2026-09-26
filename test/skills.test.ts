import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillIndex } from '../src/skills.js';

let root: string;
let globalDir: string;
let workspace: string;

async function writeSkill(dir: string, name: string, content: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), content, 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mini-pi-skills-'));
  globalDir = join(root, 'global-skills');
  workspace = join(root, 'project');
  await mkdir(globalDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SkillIndex.scan', () => {
  it('扫描 global 与 project 目录，返回 metadata（不含正文），按 name 升序', async () => {
    await writeSkill(globalDir, 'zeta', '---\nname: zeta\ndescription: 全局 zeta\n---\n\n# Zeta\n');
    await writeSkill(globalDir, 'alpha', '---\nname: alpha\ndescription: "全局 alpha"\n---\n\n# Alpha\n');
    await writeSkill(join(workspace, '.agents', 'skills'), 'beta', '---\nname: beta\ndescription: 项目 beta\n---\n\n# Beta\n');

    const skills = await new SkillIndex({ globalSkillsDir: globalDir }).scan(workspace);

    expect(skills.map((skill) => skill.name)).toEqual(['alpha', 'beta', 'zeta']);
    expect(skills).toEqual([
      { name: 'alpha', description: '全局 alpha', source: 'global', path: join(globalDir, 'alpha', 'SKILL.md') },
      { name: 'beta', description: '项目 beta', source: 'project', path: join(workspace, '.agents', 'skills', 'beta', 'SKILL.md') },
      { name: 'zeta', description: '全局 zeta', source: 'global', path: join(globalDir, 'zeta', 'SKILL.md') },
    ]);
    expect(JSON.stringify(skills)).not.toContain('# Alpha');
  });

  it('同名 skill 由 project 覆盖 global，且只保留一份', async () => {
    await writeSkill(globalDir, 'shared', '---\nname: shared\ndescription: 全局版本\n---\n\n# Global\n');
    await writeSkill(join(workspace, '.agents', 'skills'), 'shared', '---\nname: shared\ndescription: 项目版本\n---\n\n# Project\n');

    const skills = await new SkillIndex({ globalSkillsDir: globalDir }).scan(workspace);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'shared', description: '项目版本', source: 'project' });
  });

  it('支持四种 frontmatter 写法：双引号 / 无引号 / 块标量 | / 折叠 >-，多行描述折成单行', async () => {
    await writeSkill(globalDir, 'quoted', '---\nname: quoted\ndescription: "带 空格 的引号值"\n---\n\n# Quoted\n');
    await writeSkill(globalDir, 'plain', '---\nname: plain\ndescription: 裸值描述\n---\n\n# Plain\n');
    await writeSkill(globalDir, 'literal', '---\nname: literal\ndescription: |\n  第一行\n  第二行\n---\n\n# Literal\n');
    await writeSkill(globalDir, 'folded', '---\nname: folded\ndescription: >-\n  折叠后的\n  单行描述\n---\n\n# Folded\n');

    const skills = await new SkillIndex({ globalSkillsDir: globalDir }).scan(workspace);
    const byName = new Map(skills.map((skill) => [skill.name, skill.description]));

    expect(byName.get('quoted')).toBe('带 空格 的引号值');
    expect(byName.get('plain')).toBe('裸值描述');
    expect(byName.get('literal')).toBe('第一行 第二行');
    expect(byName.get('folded')).toBe('折叠后的 单行描述');
  });

  it('忽略 frontmatter 里的其它字段（hidden / metadata / allowed-tools）', async () => {
    await writeSkill(
      globalDir,
      'extra',
      '---\nname: extra\ndescription: 有额外字段\nhidden: true\nallowed-tools: Bash(x:*)\nmetadata:\n  version: "1.0.0"\n---\n\n# Extra\n',
    );

    const skills = await new SkillIndex({ globalSkillsDir: globalDir }).scan(workspace);

    expect(skills).toEqual([
      { name: 'extra', description: '有额外字段', source: 'global', path: join(globalDir, 'extra', 'SKILL.md') },
    ]);
  });

  it('无 frontmatter 时用目录名 + 首个非标题段落', async () => {
    await writeSkill(globalDir, 'no-frontmatter', '# 标题\n\n  这是第一段说明。  \n\n第二段\n');
    await writeSkill(globalDir, 'yaml-broken', '---\nname: [unclosed\ndescription: 坏了\n---\n\n正文第一段\n');

    const skills = await new SkillIndex({ globalSkillsDir: globalDir }).scan(workspace);

    expect(skills[0]).toMatchObject({ name: 'no-frontmatter', description: '这是第一段说明。' });
    expect(skills[1]).toMatchObject({ name: 'yaml-broken', description: '正文第一段' });
  });

  it('跳过没有 SKILL.md 的目录、隐藏目录与文件；目录不存在时返回空数组', async () => {
    await mkdir(join(globalDir, 'empty-skill'), { recursive: true });
    await mkdir(join(globalDir, '.hidden-skill'), { recursive: true });
    await writeFile(join(globalDir, 'loose-file.md'), '# not a skill\n', 'utf8');

    expect(await new SkillIndex({ globalSkillsDir: globalDir }).scan(workspace)).toEqual([]);
    expect(await new SkillIndex({ globalSkillsDir: join(root, 'missing') }).scan(join(root, 'missing-workspace'))).toEqual([]);
  });

  it('描述超长时截断到 300 字符', async () => {
    await writeSkill(globalDir, 'long', `---\nname: long\ndescription: ${'d'.repeat(400)}\n---\n\n# Long\n`);

    const skills = await new SkillIndex({ globalSkillsDir: globalDir }).scan(workspace);

    expect(skills[0]?.description).toHaveLength(300);
  });
});

describe('SkillIndex.get', () => {
  it('按名字返回正文（去掉 frontmatter）与来源信息', async () => {
    await writeSkill(globalDir, 'alpha', '---\nname: alpha\ndescription: 全局 alpha\n---\n\n# Alpha 正文\n\ninstructions\n');

    const skill = await new SkillIndex({ globalSkillsDir: globalDir }).get(workspace, 'alpha');

    expect(skill?.meta).toMatchObject({ name: 'alpha', source: 'global' });
    expect(skill?.content).toBe('# Alpha 正文\n\ninstructions\n');
    expect(skill?.content).not.toContain('description: 全局 alpha');
    expect(skill?.truncated).toBe(false);
  });

  it('未知名字返回 undefined', async () => {
    expect(await new SkillIndex({ globalSkillsDir: globalDir }).get(workspace, 'nope')).toBeUndefined();
  });

  it('正文超过 200_000 字符时截断并标记', async () => {
    await writeSkill(globalDir, 'huge', `---\nname: huge\ndescription: 巨大\n---\n\n${'x'.repeat(200_005)}`);

    const skill = await new SkillIndex({ globalSkillsDir: globalDir }).get(workspace, 'huge');

    expect(skill?.truncated).toBe(true);
    expect(skill?.content).toHaveLength(200_000);
  });
});
