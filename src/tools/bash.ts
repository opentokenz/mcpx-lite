import { spawn, type ChildProcess } from 'node:child_process';
import * as z from 'zod/v4';
import { ToolError } from '../errors.js';
import { defineTool, withGoalReason } from '../registry.js';

const MAX_OUTPUT_CHARS = 100_000;
const KILL_GRACE_MS = 5_000;

export const bashSchema = withGoalReason({
  sessionId: z.string().min(1).describe('session create 返回的会话 id'),
  command: z.string().min(1).describe('shell 命令，用 /bin/bash -c 执行，默认工作目录是 session.base'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .default(120_000)
    .describe('超时毫秒数，默认 120000；超时后杀掉整个进程组'),
});

export const BASH_DESCRIPTION = `执行 shell 命令，返回 stdout / stderr / exitCode（cwd 默认为 session.base）。

用途：跑测试、装依赖、用 git、grep/find/ls、编译、起一次性脚本——所有"在真实机器上执行"的事情都走这里。
本工具就是真实 shell：可以 cd 到任意目录、读写 base 之外的文件、访问网络、启动进程。

参数：
- sessionId：必填
- command：必填，用 /bin/bash -c 执行（管道、&&、重定向都可用）
- timeout：默认 120000ms，上限 600000ms；超时杀整个进程组并返回 timedOut=true
- goal / reason：必填，写入 session history

行为：stdout / stderr 各自最多保留 100_000 字符（超出置 stdoutTruncated / stderrTruncated）。
没有沙箱、没有回滚：命令产生的副作用会真实保留。

风险与确认（必须遵守）：
- 破坏性命令（rm -rf、git reset --hard、git clean -fd、drop、批量覆盖、kill 进程、改系统或全局配置、
  安装/升级依赖、推送或重写仓库历史如 git commit / git push / rebase --force）在调用前，必须先用
  自然语言向用户说明要执行什么、影响哪些文件与数据、如何回退，并得到用户明确确认。
- 不要用"先试一下"的方式执行不可逆命令；不确定就先跑只读命令（pwd、ls、git status、cat、grep）核实。
- 长时间运行或交互式命令（前台 server、watch、需要输入的 CLI）不要用本工具起，会一直占用到超时。

示例：
{ "sessionId": "ses_ab12cd34ef56", "command": "pnpm test", "timeout": 300000, "goal": "跑回归测试", "reason": "改完 edit 后需要确认没有破坏行为" }
{ "sessionId": "ses_ab12cd34ef56", "command": "git status --short", "goal": "确认工作区状态", "reason": "提交前核对改动范围" }`;

export const bashTool = defineTool({
  name: 'bash',
  title: 'Bash（真实 shell）',
  description: BASH_DESCRIPTION,
  schema: bashSchema,
  annotations: { destructiveHint: true, openWorldHint: true },
  requiresSession: true,
  describeCall: (args) => ({ target: firstLine(args.command) }),
  handler: async (args, _ctx, session) => {
    if (!session) throw new ToolError('bash 需要有效 sessionId');

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
