import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, expectError, expectOk, type Harness } from './harness.js';

let h: Harness;
let sessionId: string;

const bash = (args: Record<string, unknown>) =>
  h.callTool('bash', { sessionId, goal: '执行命令', reason: '验证现状', ...args });

beforeEach(async () => {
  h = await createHarness();
  const created = expectOk(
    await h.callTool('session', { action: 'create', base: h.workspace, goal: '改代码', reason: '开始任务' }),
  );
  sessionId = created['sessionId'] as string;
});

afterEach(async () => {
  await h.cleanup();
});

describe('bash 工具', () => {
  it('默认 cwd 是 session.base，返回 stdout / exitCode / cwd', async () => {
    const result = expectOk(await bash({ command: 'pwd' }));

    expect(result['stdout']).toBe(`${h.workspace}\n`);
    expect(result['stderr']).toBe('');
    expect(result['exitCode']).toBe(0);
    expect(result['cwd']).toBe(h.workspace);
    expect(result['timedOut']).toBe(false);
    expect(result['durationMs']).toBeTypeOf('number');
  });

  it('支持 shell 语法（管道、&&、引号）与 stderr 分流', async () => {
    const result = expectOk(
      await bash({ command: 'printf "%s\\n" a b | wc -l && echo "warn: 中文" 1>&2 && exit 0' }),
    );

    expect((result['stdout'] as string).trim()).toBe('2');
    expect(result['stderr']).toContain('warn: 中文');
    expect(result['exitCode']).toBe(0);
  });

  it('非零退出码如实返回', async () => {
    const result = expectOk(await bash({ command: 'exit 3' }));

    expect(result['exitCode']).toBe(3);
  });

  it('可以离开 base：cd .. 与绝对路径都允许', async () => {
    const up = expectOk(await bash({ command: 'cd .. && pwd' }));
    expect(up['stdout']).toBe(`${join(h.workspace, '..')}\n`);

    const absolute = expectOk(await bash({ command: `cd ${tmpdir()} && pwd` }));
    expect(absolute['stdout']).toBe(`${tmpdir()}\n`);

    const outsideWrite = expectOk(await bash({ command: `sh -c 'echo outside > ${tmpdir()}/mini-pi-outside.txt' && cat ${tmpdir()}/mini-pi-outside.txt` }));
    expect(outsideWrite['stdout']).toBe('outside\n');
  });

  it('继承启动进程的环境变量', async () => {
    const result = expectOk(await bash({ command: 'echo $HOME' }));

    expect((result['stdout'] as string).trim()).toBe(process.env['HOME']);
  });

  it('超时后杀掉进程组并标记 timedOut', async () => {
    const result = expectOk(await bash({ command: 'echo start && sleep 10 && echo end', timeout: 300 }));

    expect(result['timedOut']).toBe(true);
    expect(result['exitCode']).toBeNull();
    expect((result['stdout'] as string).trim()).toBe('start');
    expect((result['durationMs'] as number) < 5_000).toBe(true);
  });

  it('输出超过上限时截断并标记', async () => {
    const result = expectOk(
      await bash({ command: `node -e "process.stdout.write('x'.repeat(300000)); process.stderr.write('e'.repeat(300000))"` }),
    );

    expect(result['stdoutTruncated']).toBe(true);
    expect((result['stdout'] as string).length).toBe(100_000);
    expect(result['stderrTruncated']).toBe(true);
    expect((result['stderr'] as string).length).toBe(100_000);
  });

  it('命令失败（不存在）不抛异常，由 exitCode 表达', async () => {
    const result = expectOk(await bash({ command: 'definitely-not-a-command 2>/dev/null' }));

    expect(result['exitCode']).toBe(127);
  });

  it('history 记录命令首行（不记录完整输出）', async () => {
    await writeFile(join(h.workspace, 'x.txt'), 'x', 'utf8');
    expectOk(await bash({ command: 'ls -1\n echo second-line' }));

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history[0]).toMatchObject({ tool: 'bash', target: 'ls -1', ok: true, goal: '执行命令' });
    expect(JSON.stringify(history)).not.toContain('second-line');
  });

  it('描述里包含风险与用户确认要求', async () => {
    const tool = (await h.listTools()).find((candidate) => candidate.name === 'bash');

    expect(tool?.description).toMatch(/用户/);
    expect(tool?.description).toMatch(/确认/);
    expect(tool?.description).toMatch(/示例/);
    expect(tool?.description).toMatch(/rm -rf|git/);
  });

  it('schema 拒绝不合理的 timeout 与空命令', async () => {
    expect((await bash({ command: 'pwd', timeout: 0 })).isError).toBe(true);
    expect((await bash({ command: 'pwd', timeout: 10_000_000 })).isError).toBe(true);
    expect((await bash({ command: '' })).isError).toBe(true);
    expect(expectError(await bash({ command: 'pwd', sessionId: 'ses_000000000000' }))).toMatch(/unknown session/);
  });
});
