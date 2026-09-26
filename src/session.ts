import { randomBytes } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import * as z from 'zod/v4';
import { ToolError } from './errors.js';
import { writeFileAtomic } from './paths.js';
import type { SkillMeta } from './skills.js';

const SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}$/;
export const SESSIONS_SUBDIR = 'sessions';
const DEFAULT_HISTORY_LIMIT = 200;

/**
 * 创建 Session 时返回给调用方的全局提示词：mini-pi-mcp 是「模型 ↔ 真实机器」之间的网关，
 * 不是沙箱。同一段文案也会作为 MCP server 的 instructions 暴露给 2025-era 客户端。
 */
export const GATEWAY_INSTRUCTIONS = [
  '你是通过 mini-pi-mcp 连接到一台真实机器的模型，不是沙箱、不是容器、不是临时环境。',
  '',
  '- 真实副作用：write / edit 直接修改真实文件，export 会把文件内容交给调用方；trash 会把文件或目录移动到系统回收站；shell 命令与 git 操作都会真实生效并持续。edit 在提交失败时会尽力回滚，trash 不 fallback 永久删除，但都没有文件系统级 ACID 或隔离副本。',
  '- 写文件优先用 edit 的 edits[]：每个 replacement 的 oldText 在当时内容中必须恰好匹配一次，同一个真实文件不能重复出现。需要删除文件/目录时优先使用 trash，不要用 rm / rmdir 绕过确认。',
  '- base 是写类/外带工具（write / edit / export）的信任边界：base 内可直接执行；base 外（../ 穿越、绝对路径、symlink 逃逸）服务端会返回普通 approval_required 审核卡片和一次性 approvalToken。trash 无论目标是否在 base 内都必须确认；read 只读且无副作用，不受 base 限制；shell 可以 cd 到任意目录，它的风险由命令白名单判定。',
  '- 服务端已强制门禁，不能绕过：shell 只有明确安全的命令才直接执行；危险命令、无法静态判断的命令以及越界文件操作会先返回“确认执行 / 取消”审核卡片。调用方必须让用户选择；只有业务参数不变并携带 approvalToken + approvalDecision=approve 的重试才执行。goal / reason 仅用于审计，可变化或省略。',
  '- 所以先约束自己：删除或大段覆盖代码、rm -rf、git reset / commit / push、发布与配置变更、读取或修改 base 之外的敏感文件，都要先向用户说明要做什么与风险；命中门禁后使用工具返回的审核卡片让用户做选择，不要代替用户确认，也不要反复重试被取消或拒绝的调用。',
  '- 不要假设有网络隔离、备份或自动测试兜底；不确定就先用只读手段（read / shell 查询）核实，并以真实机器上的实际输出与路径为准。',
].join('\n');

const skillMetaSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(['global', 'project']),
  path: z.string(),
});

const historyEntrySchema = z.object({
  at: z.string(),
  tool: z.string(),
  action: z.string().optional(),
  goal: z.string(),
  reason: z.string(),
  target: z.string(),
  ok: z.boolean(),
  summary: z.string().optional(),
  error: z.string().optional(),
});

const sessionFileSchema = z.object({
  id: z.string(),
  base: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  skills: z.array(skillMetaSchema),
  history: z.array(historyEntrySchema),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type SessionFile = z.infer<typeof sessionFileSchema>;

/**
 * 把工具收到的 path 解析成绝对路径：相对路径基于 `session.base`，绝对路径直接使用。
 * 不做任何「必须位于 base 内」的限制——base 是定位锚点，不是安全边界。
 */
export function resolvePath(base: string, path: string): string {
  if (typeof path !== 'string' || !path.trim()) throw new ToolError('path is required');
  return isAbsolute(path) ? normalize(path) : resolve(base, path);
}

/** 校验并规范化 session 的 base：必须存在、必须是目录，返回 realpath。 */
export async function resolveBase(base: string): Promise<string> {
  if (typeof base !== 'string' || !base.trim()) throw new ToolError('base is required');

  const absolute = resolve(base);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new ToolError(`base does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) throw new ToolError(`base is not a directory: ${absolute}`);

  return realpath(absolute);
}

/**
 * 目标真实路径是否位于 base 内：两侧都必须是 realpath，用 relative 判断而不是字符串前缀。
 * base 本身不算“内部”（edit 只处理普通文件，不会命中目录）。
 */
export function isInsideBase(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Session 持久化：一个 session 一个 JSON 文件，写入用「临时文件 + rename」原子替换，
 * 并且同一 sessionId 的读改写串行化，避免并发工具调用互相覆盖 history。
 */
export class SessionStore {
  readonly home: string;
  readonly sessionsDir: string;
  private readonly historyLimit: number;
  private readonly now: () => Date;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(opts: { home: string; now?: () => Date; historyLimit?: number }) {
    this.home = opts.home;
    this.sessionsDir = join(opts.home, SESSIONS_SUBDIR);
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.now = opts.now ?? (() => new Date());
  }

  filePath(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }

  async create(opts: { base: string; skills?: SkillMeta[] }): Promise<SessionFile> {
    const base = await resolveBase(opts.base);
    const timestamp = this.now().toISOString();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = `ses_${randomBytes(6).toString('hex')}`;
      if (await pathExists(this.filePath(id))) continue;

      const session: SessionFile = {
        id,
        base,
        createdAt: timestamp,
        updatedAt: timestamp,
        closedAt: null,
        skills: opts.skills ?? [],
        history: [],
      };
      await this.save(session);
      return session;
    }

    throw new ToolError('could not allocate a session id');
  }

  /** 原始读取：不关心 closedAt（`session get` / `close` / `resume` 用这个）。 */
  async read(id: string): Promise<SessionFile> {
    if (!SESSION_ID_PATTERN.test(id)) throw new ToolError(`invalid session id: ${id}`);

    let raw: string;
    try {
      raw = await readFile(this.filePath(id), 'utf8');
    } catch {
      throw new ToolError(`unknown session ${id}`);
    }

    try {
      return sessionFileSchema.parse(JSON.parse(raw));
    } catch {
      throw new ToolError(`session ${id} file is corrupt: ${this.filePath(id)}`);
    }
  }

  /** 正常工具调用前的载入：已关闭的 session 必须显式 resume 才能继续用。 */
  async load(id: string): Promise<SessionFile> {
    const session = await this.read(id);
    if (session.closedAt) throw new ToolError(`session ${id} is closed; call session resume first`);
    return session;
  }

  async resume(id: string, skills: SkillMeta[]): Promise<SessionFile> {
    return this.queue(id, async () => {
      const session = await this.read(id);
      return this.save({ ...session, skills, closedAt: null, updatedAt: this.timestamp() });
    });
  }

  async close(id: string): Promise<SessionFile> {
    return this.queue(id, async () => {
      const session = await this.read(id);
      return this.save({ ...session, closedAt: session.closedAt ?? this.timestamp(), updatedAt: this.timestamp() });
    });
  }

  async list(): Promise<SessionFile[]> {
    const files = await readdir(this.sessionsDir).catch(() => [] as string[]);
    const sessions: SessionFile[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        sessions.push(await this.read(file.slice(0, -'.json'.length)));
      } catch {
        // 损坏或不合规的文件不参与列表；调用方仍可通过 session get 拿到具体错误
      }
    }

    return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async appendHistory(id: string, entry: HistoryEntry): Promise<SessionFile> {
    return this.queue(id, async () => {
      const session = await this.read(id);
      const history = [...session.history, entry].slice(-this.historyLimit);
      return this.save({ ...session, history, updatedAt: this.timestamp() });
    });
  }

  async save(session: SessionFile): Promise<SessionFile> {
    await writeFileAtomic(this.filePath(session.id), `${JSON.stringify(session, null, 2)}\n`);
    return session;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private queue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
