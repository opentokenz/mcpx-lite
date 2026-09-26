import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalRetryBody,
  createHarness,
  expectApproval,
  expectError,
  expectOk,
  toOutcome,
  type Harness,
  type ToolCallOutcome,
} from './harness.js';

let h: Harness;
let sessionId: string;

/** 只调用一轮：用于 safe 命令与门禁断言。 */
const shell = (args: Record<string, unknown>) =>
  h.callTool('shell', { sessionId, goal: '执行命令', reason: '验证现状', ...args });

/** 完整两轮：需要确认的命令自动确认后执行。 */
const shellApproved = (args: Record<string, unknown>) =>
  h.callToolApproving('shell', { sessionId, goal: '执行命令', reason: '验证现状', ...args });

beforeEach(async () => {
  h = await createHarness();
  const created = expectOk(
    await h.callTool('session', { action: 'create', workspace: h.workspace, goal: '改代码', reason: '开始任务' }),
  );
  sessionId = created['sessionId'] as string;
});

afterEach(async () => {
  await h.cleanup();
});

describe('shell 工具', () => {
  it('默认 cwd 是 session.workspace，返回 stdout / exitCode / cwd', async () => {
    const result = expectOk(await shell({ command: 'pwd' }));

    expect(result['stdout']).toBe(`${h.workspace}\n`);
    expect(result['stderr']).toBe('');
    expect(result['exitCode']).toBe(0);
    expect(result['cwd']).toBe(h.workspace);
    expect(result['timedOut']).toBe(false);
    expect(result['durationMs']).toBeTypeOf('number');
  });

  it('safe 命令一次调用直接执行（不返回确认）', async () => {
    const outcome = await shell({ command: 'git status --short && pnpm typecheck' });

    expect(outcome.resultType).not.toBe('input_required');
    expect(outcome.isError).toBe(false);
  });

  it('支持 shell 语法（管道、&&、引号）与 stderr 分流', async () => {
    const result = expectOk(
      await shellApproved({ command: 'printf "%s\\n" a b | wc -l && echo "warn: 中文" 1>&2 && exit 0' }),
    );

    expect((result['stdout'] as string).trim()).toBe('2');
    expect(result['stderr']).toContain('warn: 中文');
    expect(result['exitCode']).toBe(0);
  });

  it('非零退出码如实返回', async () => {
    const result = expectOk(await shell({ command: 'exit 3' }));

    expect(result['exitCode']).toBe(3);
  });

  it('可以离开 workspace：cd .. 与绝对路径都允许', async () => {
    const up = expectOk(await shell({ command: 'cd .. && pwd' }));
    expect(up['stdout']).toBe(`${join(h.workspace, '..')}\n`);

    const absolute = expectOk(await shell({ command: `cd ${tmpdir()} && pwd` }));
    expect(absolute['stdout']).toBe(`${tmpdir()}\n`);

    const outsideWrite = expectOk(
      await shellApproved({
        command: `sh -c 'echo outside > ${tmpdir()}/mini-pi-outside.txt' && cat ${tmpdir()}/mini-pi-outside.txt`,
      }),
    );
    expect(outsideWrite['stdout']).toBe('outside\n');
  });

  it('继承启动进程的环境变量', async () => {
    const result = expectOk(await shell({ command: 'printenv HOME' }));

    expect((result['stdout'] as string).trim()).toBe(process.env['HOME']);
  });

  it('超时后杀掉进程组并标记 timedOut', async () => {
    const result = expectOk(await shell({ command: 'echo start && sleep 10 && echo end', timeout: 300 }));

    expect(result['timedOut']).toBe(true);
    expect(result['exitCode']).toBeNull();
    expect((result['stdout'] as string).trim()).toBe('start');
    expect((result['durationMs'] as number) < 5_000).toBe(true);
  });

  it('输出超过上限时截断并标记', async () => {
    const result = expectOk(
      await shellApproved({
        command: `node -e "process.stdout.write('x'.repeat(300000)); process.stderr.write('e'.repeat(300000))"`,
      }),
    );

    expect(result['stdoutTruncated']).toBe(true);
    expect((result['stdout'] as string).length).toBe(100_000);
    expect(result['stderrTruncated']).toBe(true);
    expect((result['stderr'] as string).length).toBe(100_000);
  });

  it('命令失败（不存在）不抛异常，由 exitCode 表达', async () => {
    const result = expectOk(await shellApproved({ command: 'definitely-not-a-command' }));

    expect(result['exitCode']).toBe(127);
  });

  it('history 只记录已执行的调用（确认中的调用不落 history）', async () => {
    await writeFile(join(h.workspace, 'x.txt'), 'x', 'utf8');
    expectOk(await shell({ command: 'ls -1\n echo second-line' }));

    const pending = await shell({ command: 'touch pending.txt' });
    expectApproval(pending);

    const session = expectOk(await h.callTool('session', { action: 'get', sessionId, goal: 'g', reason: 'r' }));
    const history = session['history'] as Record<string, unknown>[];

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ tool: 'shell', target: 'ls -1', ok: true, goal: '执行命令' });
    expect(JSON.stringify(history)).not.toContain('second-line');
    expect(JSON.stringify(history)).not.toContain('touch pending.txt');
  });

  it('描述里包含风险与用户确认要求', async () => {
    const tool = (await h.listTools()).find((candidate) => candidate.name === 'shell');

    expect(tool?.description).toMatch(/用户/);
    expect(tool?.description).toMatch(/确认/);
    expect(tool?.description).toMatch(/示例/);
    expect(tool?.description).toMatch(/rm -rf|git/);
  });

  it('schema 拒绝不合理的 timeout 与空命令', async () => {
    expect((await shell({ command: 'pwd', timeout: 0 })).isError).toBe(true);
    expect((await shell({ command: 'pwd', timeout: 10_000_000 })).isError).toBe(true);
    expect((await shell({ command: '' })).isError).toBe(true);
    expect(expectError(await shell({ command: 'pwd', sessionId: 'ses_000000000000' }))).toMatch(/unknown session/);
  });
});

describe('shell 风险门禁（审核卡片 + token）', () => {
  it('危险命令首次调用返回普通 approval_required 审核卡片且不产生副作用', async () => {
    const target = join(h.workspace, 'gated.txt');
    const outcome = await shell({ command: 'touch gated.txt' });

    expect(outcome.error).toBeUndefined();
    expect(outcome.resultType).toBe('complete');
    expect(outcome.data).toMatchObject({
      resultType: 'approval_required',
      approvalRequired: true,
      approvalToken: expect.stringMatching(/^apr_/),
      approval: {
        title: '高风险操作确认',
        risk: 'dangerous',
        summary: 'touch gated.txt',
        options: [
          { id: 'approve', label: '确认执行', style: 'danger' },
          { id: 'cancel', label: '取消', style: 'secondary' },
        ],
      },
    });
    await expect(access(target)).rejects.toThrow();
  });

  it('审核卡片包含风险说明，并明确要求调用方渲染审核选项', async () => {
    const approval = expectApproval(await shell({ command: 'touch form.txt' }));

    expect(approval.approval.message).toContain('touch form.txt');
    expect(approval.approval.presentation).toMatch(/审核卡片|选项/);
  });

  it('mixed 命令（safe + dangerous）不执行任何 shell，并指出触发的子命令与原因', async () => {
    const target = join(h.workspace, 'mixed.txt');
    const outcome = await shell({ command: `git status && touch mixed.txt` });

    expectApproval(outcome);
    expect(approvalMessage(outcome)).toContain('touch mixed.txt');
    expect(approvalMessage(outcome)).toContain('fs.touch');
    expect(approvalMessage(outcome)).toContain('git status && touch mixed.txt');
    await expect(access(target)).rejects.toThrow();
  });

  it('无法静态分析的命令要求审核', async () => {
    for (const command of ["bash -c 'git commit -m x'", 'node -e "1 + 1"', 'echo $(pwd)']) {
      expectApproval(await shell({ command }));
    }
  });

  it('用户确认后，业务参数相同的危险调用执行一次', async () => {
    const target = join(h.workspace, 'approved.txt');
    const result = expectOk(await shellApproved({ command: 'touch approved.txt' }));

    expect(result['exitCode']).toBe(0);
    await expect(access(target)).resolves.toBeUndefined();
    expect(h.logs.some((line) => line.includes('APPROVAL REQUIRED'))).toBe(true);
    expect(h.logs.some((line) => line.includes('✓ SHELL'))).toBe(true);
  });

  it('用户取消后不执行，并返回非成功结果', async () => {
    const target = join(h.workspace, 'cancelled.txt');
    const args = { sessionId, command: 'touch cancelled.txt', goal: '创建文件', reason: '验证取消' };
    const first = await h.client.callTool('shell', args);
    const token = expectApproval(first).approvalToken;

    const outcome = toOutcome(
      await h.client.send(approvalRetryBody('shell', args, token, { decision: 'cancel' })),
    );

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/取消/);
    await expect(access(target)).rejects.toThrow();
    expect(h.logs.some((line) => line.includes('✗ SHELL'))).toBe(true);
  });

  it('携带 token 但没有审核决定时不执行', async () => {
    const target = join(h.workspace, 'undecided.txt');
    const args = { sessionId, command: 'touch undecided.txt', goal: 'g', reason: 'r' };
    const token = expectApproval(await h.client.callTool('shell', args)).approvalToken;

    const outcome = await h.client.callTool('shell', { ...args, approvalToken: token });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/approvalDecision/);
    await expect(access(target)).rejects.toThrow();
  });

  it('确认后修改命令，旧 approvalToken 不能授权新命令', async () => {
    const args = { sessionId, command: 'touch one.txt', goal: 'g', reason: 'r' };
    const token = expectApproval(await h.client.callTool('shell', args)).approvalToken;

    const changed = { ...args, command: 'touch one.txt && touch two.txt' };
    const retry = toOutcome(await h.client.send(approvalRetryBody('shell', changed, token)));

    expect(retry.isError).toBe(true);
    expect(retry.text).toMatch(/不匹配/);
    await expect(access(join(h.workspace, 'one.txt'))).rejects.toThrow();
    await expect(access(join(h.workspace, 'two.txt'))).rejects.toThrow();
  });

  it('二次确认允许 goal / reason 改变或省略，只校验 shell 业务参数', async () => {
    const target = join(h.workspace, 'audit-fields-ignored.txt');
    const firstArgs = {
      sessionId,
      command: 'touch audit-fields-ignored.txt',
      goal: '首轮目标',
      reason: '首轮原因',
    };
    const token = expectApproval(await h.client.callTool('shell', firstArgs)).approvalToken;

    const retryArgs = { sessionId, command: firstArgs.command };
    const retry = toOutcome(await h.client.send(approvalRetryBody('shell', retryArgs, token)));

    expect(retry.isError).toBe(false);
    expect((retry.data as Record<string, unknown>)['exitCode']).toBe(0);
    await expect(access(target)).resolves.toBeUndefined();
  });

  it('篡改 approvalToken 被拒绝，且不执行', async () => {
    const target = join(h.workspace, 'tampered.txt');
    const args = { sessionId, command: 'touch tampered.txt', goal: 'g', reason: 'r' };
    const token = expectApproval(await h.client.callTool('shell', args)).approvalToken;
    const tampered = `${token.slice(0, -2)}xx`;

    const outcome = toOutcome(await h.client.send(approvalRetryBody('shell', args, tampered)));

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/无效|过期/);
    await expect(access(target)).rejects.toThrow();
  });

  it('服务重启后未完成的 approvalToken 失效', async () => {
    const target = join(h.workspace, 'restarted.txt');
    const args = { sessionId, command: 'touch restarted.txt', goal: 'g', reason: 'r' };
    const token = expectApproval(await h.client.callTool('shell', args)).approvalToken;

    const restarted = await h.restart();
    try {
      const outcome = toOutcome(await restarted.client.send(approvalRetryBody('shell', args, token)));

      expect(outcome.isError).toBe(true);
      expect(outcome.text).toMatch(/无效|过期/);
      await expect(access(target)).rejects.toThrow();
    } finally {
      await restarted.cleanup();
    }
  });
});

function approvalMessage(outcome: ToolCallOutcome): string {
  return expectApproval(outcome).approval.message;
}
