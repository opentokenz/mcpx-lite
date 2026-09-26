import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_INSTRUCTIONS, SessionStore, resolveBase } from '../src/session.js';
import type { SessionFile } from '../src/session.js';
import type { SkillMeta } from '../src/skills.js';

let root: string;
let home: string;
let base: string;
let store: SessionStore;
let clock: number;

const skill = (name: string): SkillMeta => ({
  name,
  description: `描述 ${name}`,
  source: 'global',
  path: `/skills/${name}/SKILL.md`,
});

const entry = (reason: string, overrides: Partial<Parameters<SessionStore['appendHistory']>[1]> = {}) => ({
  at: '2026-09-26T00:00:00.000Z',
  tool: 'read',
  goal: '了解项目',
  reason,
  target: 'src/index.ts',
  ok: true,
  ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mini-pi-session-'));
  home = join(root, 'home');
  base = join(root, 'project');
  await mkdir(base, { recursive: true });
  clock = Date.parse('2026-09-26T00:00:00.000Z');
  store = new SessionStore({ home, now: () => new Date((clock += 1000)) });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GATEWAY_INSTRUCTIONS', () => {
  it('说明这是真实机器网关、base 不是边界、破坏性操作需确认', () => {
    expect(GATEWAY_INSTRUCTIONS).toContain('不是沙箱');
    expect(GATEWAY_INSTRUCTIONS).toContain('真实');
    expect(GATEWAY_INSTRUCTIONS).toContain('base');
    expect(GATEWAY_INSTRUCTIONS).toMatch(/向用户|用户确认/);
    expect(GATEWAY_INSTRUCTIONS).toMatch(/删除|rm -rf|git/);
  });
});

describe('SessionStore.create', () => {
  it('生成 ses_<12hex> id、落盘 JSON、base 为 realpath 后的绝对路径', async () => {
    const session = await store.create({ base, skills: [skill('alpha')] });

    expect(session.id).toMatch(/^ses_[0-9a-f]{12}$/);
    expect(session.base).toBe(await realpath(base));
    expect(session.closedAt).toBeNull();
    expect(session.history).toEqual([]);
    expect(session.skills).toEqual([skill('alpha')]);

    const raw = JSON.parse(await readFile(join(home, 'sessions', `${session.id}.json`), 'utf8')) as SessionFile;
    expect(raw).toEqual(session);
    expect(raw.createdAt).toBe('2026-09-26T00:00:01.000Z');
  });

  it('接受相对 base（相对进程 cwd）', async () => {
    const session = await store.create({ base: relative(process.cwd(), base) });

    expect(session.base).toBe(await realpath(base));
  });

  it('base 不存在或不是目录时报错', async () => {
    await expect(store.create({ base: join(root, 'missing') })).rejects.toThrow(/base does not exist/);

    const file = join(root, 'a-file');
    await writeFile(file, 'x', 'utf8');
    await expect(store.create({ base: file })).rejects.toThrow(/not a directory/);
    await expect(resolveBase('')).rejects.toThrow(/base/);
  });
});

describe('SessionStore 读取与生命周期', () => {
  it('未知 id / 非法 id / 损坏文件都有可读错误', async () => {
    await expect(store.load('ses_000000000000')).rejects.toThrow(/unknown session/);
    await expect(store.load('../../etc/passwd')).rejects.toThrow(/invalid session id/);
    await expect(store.load('ses_not-hex')).rejects.toThrow(/invalid session id/);

    await mkdir(join(home, 'sessions'), { recursive: true });
    await writeFile(join(home, 'sessions', 'ses_ffffffffffff.json'), '{oops', 'utf8');
    await expect(store.load('ses_ffffffffffff')).rejects.toThrow(/corrupt/);
    expect(await store.list()).toEqual([]);
  });

  it('close 标记 closedAt 并让其他工具拒绝；read 仍能拿到记录；resume 重新激活并刷新 skills', async () => {
    const created = await store.create({ base, skills: [skill('alpha')] });

    const closed = await store.close(created.id);
    expect(closed.closedAt).toBe('2026-09-26T00:00:02.000Z');
    await expect(store.load(created.id)).rejects.toThrow(/closed/);
    expect((await store.read(created.id)).closedAt).toBe(closed.closedAt);

    const resumed = await store.resume(created.id, [skill('alpha'), skill('beta')]);
    expect(resumed.closedAt).toBeNull();
    expect(resumed.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect((await store.load(created.id)).skills).toHaveLength(2);
  });

  it('list 按 updatedAt 倒序，跳过损坏文件', async () => {
    const first = await store.create({ base });
    const second = await store.create({ base });
    await store.close(first.id);

    await writeFile(join(home, 'sessions', 'ses_0123456789ab.json'), 'not json', 'utf8');

    const sessions = await store.list();

    expect(sessions.map((s) => s.id)).toEqual([first.id, second.id]);
  });
});

describe('SessionStore.appendHistory', () => {
  it('追加审计条目（含 goal / reason / target / ok）并更新 updatedAt', async () => {
    const created = await store.create({ base });

    const updated = await store.appendHistory(created.id, entry('确认结构'));

    expect(updated?.history).toEqual([entry('确认结构')]);
    expect(updated?.updatedAt).toBe('2026-09-26T00:00:02.000Z');
    expect((await store.load(created.id)).history).toHaveLength(1);
  });

  it('超过 historyLimit 时丢最旧的一条', async () => {
    const limited = new SessionStore({ home, historyLimit: 3, now: () => new Date((clock += 1000)) });
    const created = await limited.create({ base });

    for (const reason of ['r1', 'r2', 'r3', 'r4']) await limited.appendHistory(created.id, entry(reason));

    expect((await limited.load(created.id)).history.map((h) => h.reason)).toEqual(['r2', 'r3', 'r4']);
  });

  it('并发追加不丢失（同一 session 串行写）', async () => {
    const created = await store.create({ base });

    await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.appendHistory(created.id, entry(`并发 ${index}`))),
    );

    const history = (await store.load(created.id)).history;
    expect(history).toHaveLength(10);
    expect(new Set(history.map((h) => h.reason)).size).toBe(10);
  });

  it('未知 session 追加失败但不破坏已有文件', async () => {
    await expect(store.appendHistory('ses_000000000000', entry('x'))).rejects.toThrow(/unknown session/);
  });
});
