import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, expectError, expectOk, skillFile, type Harness } from './harness.js';
import type { SessionFile } from '../src/session.js';

let h: Harness;

async function writeSkill(dir: string, name: string, content: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), content, 'utf8');
}

async function createSession(harness: Harness = h): Promise<Record<string, unknown>> {
  return expectOk(
    await harness.callTool('session', {
      action: 'create',
      base: harness.workspace,
      goal: '开始处理项目',
      reason: '需要绑定项目锚点',
    }),
  );
}

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

describe('tools/list', () => {
  it('9 个工具都提供最小参数示例，goal / reason 只作为可选审计字段说明', async () => {
    const tools = await h.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('session');
    expect(names).toContain('skills');
    expect(names).toContain('mcp_tool');
    expect(names).toContain('trash');
    expect(names).toHaveLength(9);

    for (const tool of tools) {
      expect(tool.description).toMatch(/示例/);
      expect(tool.description).toMatch(/goal \/ reason：可选/);
      expect(tool.description).not.toContain('"goal"');
      expect(tool.description).not.toContain('"reason"');
      expect(tool.inputSchema['type']).toBe('object');
    }
  });

  it('goal / reason 仍暴露为可选审计字段，但不进入 required', async () => {
    const session = (await h.listTools()).find((tool) => tool.name === 'session');
    const required = (session?.inputSchema['required'] ?? []) as string[];
    const properties = (session?.inputSchema['properties'] ?? {}) as Record<string, unknown>;

    expect(required).toContain('action');
    expect(required).not.toContain('goal');
    expect(required).not.toContain('reason');
    expect(properties).toHaveProperty('goal');
    expect(properties).toHaveProperty('reason');
  });

  it('9 个工具显式暴露完整且准确的安全 annotations', async () => {
    const tools = Object.fromEntries((await h.listTools()).map((tool) => [tool.name, tool]));

    expect(tools['session']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools['skills']?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools['read']?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools['write']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(tools['trash']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(tools['edit']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(tools['shell']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(tools['export']?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools['mcp_tool']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('session close 的工具描述明确它只停用逻辑句柄且可以 resume，不删除数据或结束进程', async () => {
    const session = (await h.listTools()).find((tool) => tool.name === 'session');

    expect(session?.description).toMatch(/close.*逻辑.*句柄/s);
    expect(session?.description).toMatch(/不会删除.*文件/s);
    expect(session?.description).toMatch(/不会删除.*history/s);
    expect(session?.description).toMatch(/不会.*进程/s);
    expect(session?.description).toMatch(/resume.*恢复/s);
  });
});

describe('session 工具', () => {
  it('create 返回 sessionId / base / skills metadata / instructions，且不含 skill 正文', async () => {
    await writeSkill(h.globalSkillsDir, 'alpha', skillFile('# Alpha 正文\n', 'name: alpha\ndescription: 全局 alpha'));

    const created = await createSession();
    const skills = created['skills'] as { name: string; description: string; source: string }[];

    expect(created['sessionId']).toMatch(/^ses_[0-9a-f]{12}$/);
    expect(created['base']).toBe(h.workspace);
    expect(skills).toEqual([{ name: 'alpha', description: '全局 alpha', source: 'global' }]);
    expect(JSON.stringify(created)).not.toContain('# Alpha 正文');

    const instructions = created['instructions'] as string;
    expect(instructions).toContain('不是沙箱');
    expect(instructions).toContain('base');
    expect(instructions).toMatch(/用户/);

    const stored = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        join(h.home, 'sessions', `${created['sessionId'] as string}.json`),
        'utf8',
      ),
    ) as SessionFile;
    expect(stored.base).toBe(h.workspace);
    expect(stored.skills[0]?.path).toBe(join(h.globalSkillsDir, 'alpha', 'SKILL.md'));
    expect(stored.history).toEqual([]);
  });

  it('create 缺少 base 或不存在的 base 都是可读错误', async () => {
    expect(expectError(await h.callTool('session', { action: 'create', goal: 'g', reason: 'r' }))).toContain('base');

    expect(
      expectError(
        await h.callTool('session', {
          action: 'create',
          base: join(h.workspace, 'missing'),
          goal: 'g',
          reason: 'r',
        }),
      ),
    ).toContain('base does not exist');
  });

  it('get / list / close 行为正确，close 后其他工具拒绝执行', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;

    const got = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(got['id']).toBe(sessionId);
    expect(got['closedAt']).toBeNull();

    const listed = expectOk(await h.callTool('session', { action: 'list', goal: 'g', reason: 'r' }));
    expect((listed['sessions'] as Record<string, unknown>[])[0]).toMatchObject({
      sessionId,
      base: h.workspace,
      skillCount: 0,
      historyCount: 0,
      closedAt: null,
    });

    const closed = expectOk(await h.callTool('session', { action: 'close', sessionId, goal: 'g', reason: 'r' }));
    expect(closed['closedAt']).toBeTypeOf('string');
    expect(expectError(await h.callTool('skills', { action: 'list', sessionId, goal: 'g', reason: 'r' }))).toMatch(
      /closed/,
    );
  });

  it('重启后 resume 恢复 base 与 skill index', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;
    await writeSkill(join(h.workspace, '.agents', 'skills'), 'beta', skillFile('# Beta\n', 'name: beta\ndescription: 项目 beta'));

    const restarted = await h.restart();
    const resumed = expectOk(
      await restarted.callTool('session', {
        action: 'resume',
        sessionId,
        goal: '继续上次工作',
        reason: '服务重启',
      }),
    );

    expect(resumed['base']).toBe(h.workspace);
    expect(resumed['skills']).toEqual([{ name: 'beta', description: '项目 beta', source: 'project' }]);
    expect(resumed['instructions']).toContain('不是沙箱');
  });

  it('未知 sessionId 被拒绝，不静默新建会话', async () => {
    expect(expectError(await h.callTool('session', { action: 'get', sessionId: 'ses_000000000000', goal: 'g', reason: 'r' })))
      .toMatch(/unknown session/);
    expect(expectError(await h.callTool('skills', { action: 'list', sessionId: 'ses_000000000000', goal: 'g', reason: 'r' })))
      .toMatch(/unknown session/);
  });

  it('action 与参数不匹配时报错', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;

    expect(expectError(await h.callTool('session', { action: 'resume', goal: 'g', reason: 'r' }))).toContain('sessionId');
    expect(expectError(await h.callTool('session', { action: 'create', base: h.workspace, sessionId, goal: 'g', reason: 'r' })))
      .toContain('sessionId');
    expect(expectError(await h.callTool('session', { action: 'unknown', goal: 'g', reason: 'r' }))).toBeTruthy();
  });
});

describe('skills 工具', () => {
  it('list 只返回 metadata，get 按需返回正文，reload 发现新增 skill', async () => {
    await writeSkill(h.globalSkillsDir, 'alpha', skillFile('# Alpha 正文\n', 'name: alpha\ndescription: 全局 alpha'));
    const created = await createSession();
    const sessionId = created['sessionId'] as string;

    const listed = expectOk(await h.callTool('skills', { action: 'list', sessionId, goal: 'g', reason: '看看有什么 skill' }));
    expect(listed['skills']).toEqual([{ name: 'alpha', description: '全局 alpha', source: 'global' }]);

    const got = expectOk(
      await h.callTool('skills', { action: 'get', sessionId, name: 'alpha', goal: 'g', reason: '需要 alpha 指引' }),
    );
    expect(got['content']).toBe('# Alpha 正文\n');
    expect(got['source']).toBe('global');
    expect(got['path']).toBe(join(h.globalSkillsDir, 'alpha', 'SKILL.md'));

    await writeSkill(h.globalSkillsDir, 'gamma', skillFile('# Gamma\n', 'name: gamma\ndescription: 新增 gamma'));
    const reloaded = expectOk(await h.callTool('skills', { action: 'reload', sessionId, goal: 'g', reason: '刷新索引' }));
    expect((reloaded['skills'] as { name: string }[]).map((skill) => skill.name)).toEqual(['alpha', 'gamma']);
  });

  it('get 缺 name 或名字不存在时报错', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;

    expect(expectError(await h.callTool('skills', { action: 'get', sessionId, goal: 'g', reason: 'r' }))).toContain('name');
    expect(
      expectError(await h.callTool('skills', { action: 'get', sessionId, name: 'nope', goal: 'g', reason: 'r' })),
    ).toMatch(/unknown skill/);
  });
});

describe('schema 与隔离', () => {
  it('sessionId 仍必填；省略 goal / reason 仍可执行并以空值写入审计 history', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;

    const missingSession = await h.callTool('skills', { action: 'list', goal: 'g', reason: 'r' });
    expect(missingSession.isError).toBe(true);
    expect(missingSession.text).toContain('sessionId');

    expectOk(await h.callTool('skills', { action: 'list', sessionId }));

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(session['history']).toHaveLength(1);
    expect((session['history'] as Record<string, unknown>[])[0]).toMatchObject({
      tool: 'skills',
      action: 'list',
      goal: '',
      reason: '',
      ok: true,
    });
  });

  it('不同 session 的 base 与 history 互不串台', async () => {
    const otherWorkspace = join(h.workspace, '..', 'other-project');
    await mkdir(otherWorkspace, { recursive: true });

    const first = await createSession();
    const second = expectOk(
      await h.callTool('session', { action: 'create', base: otherWorkspace, goal: 'g2', reason: 'r2' }),
    );

    expect(first['base']).toBe(h.workspace);
    expect(second['base']).toBe(otherWorkspace);

    expectOk(await h.callTool('skills', { action: 'list', sessionId: first['sessionId'] as string, goal: 'g', reason: 'r' }));
    expectOk(await h.callTool('skills', { action: 'list', sessionId: second['sessionId'] as string, goal: 'g', reason: 'r' }));

    const firstHistory = (expectOk(
      await h.callTool('session', { action: 'get', sessionId: first['sessionId'] as string, goal: 'g', reason: 'r' }),
    )['history'] as unknown[]).length;
    const secondHistory = (expectOk(
      await h.callTool('session', { action: 'get', sessionId: second['sessionId'] as string, goal: 'g', reason: 'r' }),
    )['history'] as unknown[]).length;

    expect(firstHistory).toBe(1);
    expect(secondHistory).toBe(1);
  });
});

describe('history 与终端日志', () => {
  it('工具调用写入 history（goal / reason / target / ok）', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;

    expectError(
      await h.callTool('skills', { action: 'get', sessionId, name: 'missing', goal: '读 skill', reason: '需要指引' }),
    );

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ tool: 'skills', action: 'get', goal: '读 skill', reason: '需要指引', ok: false });
    expect(history[0]?.['target']).toBe('get missing');
    expect(history[0]?.['error']).toMatch(/unknown skill/);
  });

  it('失败调用也留 history，且不包含文件正文 / 命令输出', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;
    const secret = 'TOPSECRET-CONTENT';

    expectError(
      await h.callTool('skills', { action: 'get', sessionId, name: secret, goal: 'g', reason: 'r' }),
    );

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    expect(JSON.stringify(session['history'])).not.toContain('content');
  });

  it('观测卡片不打印文件正文 / 命令输出 / 超长提示词', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;
    const secret = 'TOPSECRET-CARD-CONTENT';
    await writeFile(join(h.workspace, 'card-secret.txt'), secret, 'utf8');

    const read = expectOk(
      await h.callTool('read', { sessionId, path: 'card-secret.txt', goal: '读配置', reason: '确认内容' }),
    );

    // 返回值里有正文，日志卡片里没有（去掉卡片装饰与换行后再比对，避免换行掩盖问题）
    const flat = h.logs.join('\n').replace(/[│\s]+/g, '');
    expect(read['content']).toBe(secret);
    expect(flat).toContain(`<${secret.length}chars>`);
    expect(flat).not.toContain(secret);
  });

  it('终端日志以卡片展示工具调用（含 sessionId / 目标 / 原因 / 结果 / 耗时）', async () => {
    const created = await createSession();
    const sessionId = created['sessionId'] as string;

    expectOk(await h.callTool('skills', { action: 'list', sessionId, goal: '了解 skill', reason: '先看看' }));

    expect(h.logs.some((line) => line.includes('event session-create') && line.includes(sessionId))).toBe(true);

    // 调用起点（debug 级）：单行，含工具名 + 编号 + 目标
    expect(h.logs.some((line) => line.includes('→ SKILLS #') && line.includes('list'))).toBe(true);

    // sessionId / goal / reason 是卡片里默认可见的一等信息
    expect(h.logs.some((line) => line.includes(`session  ${sessionId}`))).toBe(true);
    expect(h.logs.some((line) => line.includes('goal     了解 skill'))).toBe(true);
    expect(h.logs.some((line) => line.includes('reason   先看看'))).toBe(true);

    const doneLine = h.logs.find((line) => line.includes('SKILLS') && line.includes('SUCCESS'));
    expect(doneLine).toMatch(/\d+ms|\d+\.\d+s/);
    expect(h.logs.some((line) => line.includes('result   '))).toBe(true);
    expect(h.logs.some((line) => line.includes('"skills"'))).toBe(true);
  });
});
