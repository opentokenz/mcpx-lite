import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, expectApproval, expectOk, type Harness } from './harness.js';

describe.skipIf(process.platform !== 'win32')('shell 工具（Windows PowerShell）', () => {
  let harness: Harness;
  let sessionId: string;

  const shell = (command: string, timeout?: number) =>
    harness.callTool('shell', {
      sessionId,
      command,
      ...(timeout === undefined ? {} : { timeout }),
      goal: '验证 PowerShell',
      reason: '测试 Windows shell',
    });

  const shellApproved = (command: string, timeout?: number) =>
    harness.callToolApproving('shell', {
      sessionId,
      command,
      ...(timeout === undefined ? {} : { timeout }),
      goal: '验证 PowerShell',
      reason: '测试 Windows shell',
    });

  beforeEach(async () => {
    harness = await createHarness();
    const session = expectOk(
      await harness.callTool('session', {
        action: 'create',
        workspace: harness.workspace,
        goal: '测试 Windows shell',
        reason: '创建临时 session',
      }),
    );
    sessionId = session['sessionId'] as string;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('以 session.workspace 为 cwd，并保留 UTF-8 Unicode 输出', async () => {
    const result = expectOk(await shell('[Console]::Out.Write("你好")'));

    expect(result['stdout']).toBe('你好');
    // PowerShell can emit first-run module initialization progress through stderr.
    expect(result['exitCode']).toBe(0);
    expect(result['cwd']).toBe(harness.workspace);
  });

  it('返回 Windows 原生命令的非零退出码', async () => {
    const result = expectOk(await shell('cmd.exe /d /s /c "exit /b 7"'));

    expect(result['exitCode']).toBe(7);
  });

  it('PowerShell 语句抛错时返回非零退出码与 stderr', async () => {
    const result = expectOk(await shell("throw 'expected failure'"));

    expect(result['exitCode']).toBe(1);
    expect(result['stderr']).toContain('expected failure');
  });

  it('解析阶段不执行脚本，并在语法错误时 fail closed', async () => {
    const marker = join(harness.workspace, 'must-not-exist.txt');
    const command = `Set-Content -LiteralPath ${psQuote(marker)} -Value 'executed'; if (`;
    const outcome = await shell(command);

    expect(outcome.isError).toBe(true);
    await expect(access(marker)).rejects.toThrow();
  });

  it('PowerShell 危险 cmdlet 返回审批卡片，确认前不产生副作用', async () => {
    const marker = join(harness.workspace, 'approval-marker.txt');
    const outcome = await shell(`Set-Content -LiteralPath ${psQuote(marker)} -Value 'written'`);

    expectApproval(outcome);
    await expect(access(marker)).rejects.toThrow();
  });

  it('超时后终止 PowerShell 及其子进程树', async () => {
    const pidFile = join(harness.workspace, 'child.pid');
    const quotedPidFile = psQuote(pidFile);
    const command = [
      "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 20') -PassThru",
      `Set-Content -LiteralPath ${quotedPidFile} -Value $child.Id`,
      'Start-Sleep -Seconds 20',
    ].join('; ');
    const result = expectOk(await shellApproved(command, 1_500));

    expect(result['timedOut']).toBe(true); // taskkill's exit code is platform-dependent

    const childPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
    const deadline = Date.now() + 3_000;
    let childAlive = true;
    while (childAlive && Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        childAlive = false;
      }
    }
    expect(childAlive).toBe(false);
  });
});

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
