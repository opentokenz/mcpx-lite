import { spawn, type ChildProcess } from 'node:child_process';
import * as z from 'zod/v4';
import {
  APPROVAL_INPUT_FIELDS,
  enforceApproval,
  hashArgs,
  type ApprovalCodec,
} from '../approval.js';
import { ToolError } from '../errors.js';
import { defineTool, withGoalReason, type ToolDef } from '../registry.js';
import { analyzeShellCommand, summarizeRisk } from '../risk.js';

const MAX_OUTPUT_CHARS = 100_000;
const KILL_GRACE_MS = 5_000;

export const shellSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  command: z.string().min(1).describe('shell 命令，由 session 的 Shell Runtime 执行，默认工作目录是 session.base'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .default(120_000)
    .describe('超时毫秒数，默认 120000；超时后杀掉整个进程组'),
  ...APPROVAL_INPUT_FIELDS,
});

export const SHELL_DESCRIPTION = `在真实机器上执行 Shell 命令，返回 stdout / stderr / exitCode（cwd 默认为 session.base）。

用途：运行真实机器上的命令，例如测试、编译、Git 与只读查询。默认 cwd 是 session.base，
但命令可以访问 base 之外的路径、网络和进程，因此可能产生真实且持久的副作用。
需要删除文件或目录时优先使用 trash 工具；shell 的 rm / rmdir 仍按危险命令要求审核。

参数：
- sessionId：必填
- command：必填，Shell command（管道、&&、重定向都可用）
- timeout：默认 120000ms，上限 600000ms；超时杀整个进程组并返回 timedOut=true
- goal / reason：可选审计字段；提供时写入 session history

行为：stdout / stderr 各自最多保留 100_000 字符（超出置 stdoutTruncated / stderrTruncated）。
没有沙箱、没有回滚：命令产生的副作用会真实保留。

风险门禁（服务端强制执行）：
- 明确安全的只读命令直接执行。
- 危险或无法静态证明安全的命令先返回 approval_required，确认前不会启动 shell。
- 用户确认后用原 command / timeout 携带 approvalToken + approvalDecision=approve 重试；取消、token 失效或参数变化都不会执行。

示例：
{ "sessionId": "ses_ab12cd34ef56", "command": "pnpm test", "timeout": 300000 }
{ "sessionId": "ses_ab12cd34ef56", "command": "git status --short" }`;

export function createShellTool(approvals: ApprovalCodec): ToolDef {
  return defineTool({
    name: 'shell',
    title: 'Shell（真实 shell）',
    description: SHELL_DESCRIPTION,
    schema: shellSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    requiresSession: true,
    describeCall: (args) => ({ target: firstLine(args.command), fields: { command: args.command } }),
    handler: async (args, _ctx, session, observe) => {
      if (!session) throw new ToolError('shell 需要有效 sessionId');

      const analysis = analyzeShellCommand(args.command);
      if (analysis.risk !== 'safe') {
        const { kind, reason } = summarizeRisk(analysis);
        const triggered = analysis.findings.filter((finding) => finding.risk !== 'safe');
        const approval = await enforceApproval({
          codec: approvals,
          sessionId: session.id,
          tool: 'shell',
          argsHash: hashArgs([args.command, args.timeout]),
          ...(args.approvalToken ? { approvalToken: args.approvalToken } : {}),
          ...(args.approvalDecision ? { approvalDecision: args.approvalDecision } : {}),
          prompt: {
            risk: analysis.risk,
            riskLabel: `${kind} · ${reason}`,
            summary: firstLine(args.command),
            message: approvalMessage(args.command, triggered),
            fields: { command: args.command },
          },
          observer: observe,
        });
        if (approval) return approval;
      }

      const startedAt = Date.now();
      const child = spawn('/bin/bash', ['-c', args.command], {
        cwd: session.base,
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      const stdout = collector(MAX_OUTPUT_CHARS);
      const stderr = collector(MAX_OUTPUT_CHARS);
      child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

      let timedOut = false;
      const { code } = await waitForExit(child, args.timeout, () => {
        timedOut = true;
        killProcessGroup(child);
      });

      return {
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        cwd: session.base,
      };
    },
  });
}

/** 确认文案：把触发风险的子命令与原因逐条列出，附上完整命令。 */
function approvalMessage(command: string, triggered: ReturnType<typeof analyzeShellCommand>['findings']): string {
  const details = triggered.map((finding) => `- ${finding.command}（${finding.kind}：${finding.reason}）`);
  return [
    '这条命令包含需要确认的操作，确认后会在真实机器上执行（没有沙箱、没有回滚）：',
    '',
    ...details,
    '',
    '完整命令：',
    command,
  ].join('\n');
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    let graceTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      onTimeout();
      // 极端情况下 SIGKILL 后仍未收到 close：不把工具调用挂死
      graceTimer = setTimeout(() => resolve({ code: null }), KILL_GRACE_MS);
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(new ToolError(`could not start shell: ${error.message}`));
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ code });
    });
  });
}

function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程已经退出
    }
  }
}

function collector(limit: number) {
  let text = '';
  let wasTruncated = false;

  return {
    push(chunk: string) {
      if (wasTruncated) return;

      if (text.length + chunk.length > limit) {
        text += chunk.slice(0, limit - text.length);
        wasTruncated = true;
        return;
      }

      text += chunk;
    },
    text: () => text,
    truncated: () => wasTruncated,
  };
}

function firstLine(command: string): string {
  const line = command.split('\n')[0]?.trim() ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
