# Mini Pi MCP V1（无模型 Coding Runtime）

## Goal

按 PRD 0.3 + 后续补充实现 `mini-pi-mcp`：一个 TypeScript 编写的 MCP Server，只暴露 7 个工具
（`session` / `skills` / `read` / `write` / `edit` / `bash` / `download`）：

- 协议目标 **MCP 2026-07-28**（无状态核心），Transport 为 **Streamable HTTP**，入口 `POST /mcp`；
- 应用层 `sessionId` handle 提供可接续 Session，每个 Session 绑定一个项目锚点 `base`；
- Skill 只在创建/刷新 Session 时读取 metadata，正文由 `skills.get` 按需加载；
- `download` + `GET /files/:token` 让远端 Studio 拿到本机原始文件（token 不透明、短有效期）；
- 每个工具的描述里带**使用说明 + 示例**；`edit` / `bash` 明确要求模型先向用户说明风险并取得确认。

不含 LLM / Provider / Agent Loop / Prompt Engine / RAG / Planner。

## Context（已在本机验证的事实，实现时直接依赖）

- 本机 node `v24.14.0`，pnpm 可用；`/Users/star/Workspace/code/ai/mini-pi-mcp` 是空仓库（无 commit）。
- Tier-1 TS SDK 的 **v2 线**才是 2026-07-28 实现：`@modelcontextprotocol/server@2.1.0`、
  `@modelcontextprotocol/node@2.1.0`（v1 线 `@modelcontextprotocol/sdk@1.30.1` 是 2025-era）。
- `createMcpHandler(factory)` 默认 `legacy: 'stateless'`：现代（2026-07-28）请求按请求构建实例，
  同时以无状态方式兼容 2025-era 客户端。HTTP 入口即 Streamable HTTP，无需自建 transport。
- 实测（`/tmp/mpiv2` 探针，真实 HTTP）：`toNodeHandler(handler)` 可直接挂在 `node:http`
  `createServer` 上；`POST /mcp` + 请求头 `MCP-Protocol-Version: 2026-07-28`、`Mcp-Method`、`Mcp-Name`
  返回 200 JSON；缺 `MCP-Protocol-Version` 时返回 `-32020`（SEP-2243 头部路由为协议强制）。
- 2026-07-28 已移除 `initialize` / `Mcp-Session-Id` / HTTP GET / `ping` / `logging/setLevel`；
  跨调用状态必须由应用层 handle 显式传递（SEP-2567）——与 PRD §2 一致，也是「每次必须带 sessionId」的根据。
- Tool Result 的 `resource_link` 在 2026-07-28 仍然有效，SDK 对
  `{type:'resource_link', uri, name, mimeType, size}` 原样透传（实测通过）。
- 工厂回调收到 `requestInfo`（inbound `Request`），工具 handler 通过 `ctx.http.req`
  拿到本次请求 URL → **download 的 origin 从请求推导，不需要 base URL 配置**（实测通过）。
- `ctx` 无 `sessionId`（无状态）；依赖注入必须走模块级闭包，不能挂在连接上。

## Decisions

1. **只做 Streamable HTTP**：`POST /mcp` 交给 `createMcpHandler` + `toNodeHandler`；V1 不做 stdio。
2. **监听/配置**：默认 `127.0.0.1:8787`；env `MINI_PI_MCP_HOST` / `MINI_PI_MCP_PORT` /
   `MINI_PI_MCP_HOME`（默认 `~/.mini-pi-mcp`，只存 session 记录）。**不做鉴权**。
3. **download URL**：由本次请求 origin（`ctx.http.req.url`）拼 `${origin}/files/${token}`，
   无 `MINI_PI_PUBLIC_URL`。
4. **每个工具都带两个必填入参**：`goal`（本次要达成的整体目标）与 `reason`（为什么需要这一步调用），
   各 `1..500` 字符，两者都写入 session history。`goal` 不另存为 session 字段（可从 history 末条推导，
   避免重复状态）。
5. **history = 审计日志**：每次工具调用追加
   `{ at, tool, action?, goal, reason, target, ok, error? }`，上限 200 条（超出丢最旧）。
   只存「为什么 + 对什么 + 成功与否」的目标摘要（解析后的路径 / 命令首行），
   **不存文件正文、命令输出、prompt、模型消息、context、token**（PRD §4）。
6. **`base` 是项目锚点，不是安全边界**（用户明确补充，覆盖 PRD §17 的作用域限制）：
   - 相对路径 → `resolve(session.base, path)`；绝对路径 → 直接使用；
   - 允许 `..` 离开 `base`，`read` / `write` / `edit` / `download` **不限制路径必须位于 base 内**；
   - `bash` 默认 `cwd = session.base`，但允许 `cd ..` / `cd /tmp` / 访问任意路径；
   - 真正的边界是 Mini Pi MCP 进程的 OS 权限，不是 `base`。
7. **Session 持久化**：一个 session 一个 JSON 文件 `<home>/sessions/<id>.json`；
   写入用「临时文件 + rename」原子替换，并对同一 sessionId 串行化 read-modify-write。
   `close` 只标记 `closedAt`（不删文件，保留可 resume）；`resume` 清除 `closedAt` 重新激活。
8. **resume 重新扫描 skill index**：不信任落盘的旧索引（本地 skills 可能在 session 之间变化），
   resume 后索引与 `create` 同源；落盘的 `skills` 字段只是快照。
9. **Skill 解析**：用 `yaml` 解析 frontmatter；缺 frontmatter 时 `name` = 目录名、
   `description` = 第一段非标题文本（≤300 字符）；frontmatter 的 `hidden` 等其它字段忽略。
10. **Download token**：进程内 `Map` 保存 `{ token, sessionId, path, name, mimeType, size, expiresAt }`，
    TTL 5 分钟；`GET /files/:token` 只认 token，**不接受任何 path 参数**；取文件时复核
    「token 存在 + 未过期 + 仍是普通文件」——因为没有路径边界可复核，token 本身就是授权凭据。
11. **错误处理统一在 registry 层**：每个 handler 外包一层 try/catch，预期失败（未知 session、
    git/命令非零退出后的语义错误、edit 0/多匹配、超时…）与意外异常都转成 `isError: true` 的文本结果，
    不把栈泄漏给模型。
12. **工具结果用文本 JSON**（不声明 `outputSchema` / `structuredContent`，减少重复 schema）；
    `download` 额外返回 `resource_link` 块。
13. **依赖**：运行时 `@modelcontextprotocol/server`、`@modelcontextprotocol/node`、`zod`、`yaml`、
    `mime-types`；开发 `typescript`、`tsx`、`vitest`、`@types/node`、`@types/mime-types`。
14. **工程约定**：pnpm；`type: module`；测试用 vitest（放 `test/`），类型检查 `tsc --noEmit`，
    运行用 `tsx`，**暂不产出 build/dist**（用户当轮明确）。
15. **回环绑定时启用 SDK 的 `localhostHostValidation` / `localhostOriginValidation`**（防 DNS rebinding）；
    绑定非回环地址时跳过 Host 校验（否则远端 Studio 连不上），并向 stderr 打印「无鉴权 + 可写任意路径」警告。
16. **保留 SDK 默认的 2025-era 无状态兼容**（不写 `legacy: 'reject'`）：零额外成本，目标协议仍是
    2026-07-28，测试断言以 2026-07-28 为准。
17. **会话隔离靠显式 `sessionId`**：除 `session` 工具外，其余 6 个工具的 `sessionId` 全部必填；
    `session` 工具按 action 校验（`create` 不接受 `sessionId`，`resume` / `get` / `close` 必填，
    `list` 不需要）。没有有效 sessionId 的请求一律 `isError` 拒绝，服务端不保存任何隐式「当前会话」。
    `sessionId` 决定的是**默认解析位置（base）、skill index 与 history 归属**，不是访问权限。
18. **每个工具描述必须带使用说明 + 示例**：描述结构固定为
    `用途` → `参数` → `路径规则` → `示例`（1–2 个完整 JSON 调用样例）；
    字段级说明同时写进 zod `.describe()`（会进 `inputSchema`）。
19. **风险与确认引导**：`edit` 与 `bash` 的描述中明确要求——涉及删除代码、覆盖大段实现、
    破坏性命令（`rm -rf`、`git reset --hard`）、`git commit` / `git push`、发布或改配置等操作前，
    必须先用自然语言向用户说明将做什么与风险，并在用户确认后才调用；
    `write` 描述中带一条同源短提示（覆盖已有文件前先说明）。这是**指令层**约束，不做强制字段/拦截。
20. **`base` 必须存在**：`session create` 时校验 `base` 是已存在目录并 `realpath` 规范化
    （bash 的 cwd 与相对路径解析都依赖它）；不存在时返回可读错误并提示先创建或改用已存在的上级目录。
21. **`session create`（以及 `resume`）返回全局提示词 `instructions`**：一段固定文案，告诉调用方
    「这是模型与真实机器之间的网关，不是沙箱」，并列出真实副作用、`base` 不是边界、
    破坏性操作需先向用户确认。同一常量也作为 `McpServer` 的 `instructions`（只对 2025-era 客户端可见，
    因为 2026-07-28 已无 `initialize`，`server/discover` 不携带 instructions）。
22. **`instructions` 是唯一来源的常量**：`GATEWAY_INSTRUCTIONS` 定义在 `src/session.ts`，
    工具不各自拼接文案；测试断言关键句存在，避免文案被改得失去警示作用。
23. **终端观测日志（stderr）**：`src/log.ts` 提供 `createLogger()`，默认 `debug` 全量输出，
    env `MINI_PI_MCP_LOG=debug|info|off` 可调。每次工具调用都打「调用入参 + 涉及文件 +
    结果摘要 + 耗时 + 错误」，另外打 server 启动/退出、`session create`（base + skill 数量）、
    download token mint、`/files/:token` 请求与状态、404 路由未命中。日志写 stderr（stdout 保持干净）；
    长值（goal/reason/命令/结果）截断到 400 字符；**download 不记文件正文（只记 size）**，
    bash 不记完整 stdout（只记头部与大小）。

## Rationale

- Decision 1/16：2026-07-28 的 MCP 是 request/response 无状态协议，`createMcpHandler` 已按请求
  构建实例并处理头部路由、`_meta` 信封、`resultType`、cache 字段；自建 transport 只会重造这些。
- Decision 4/5：PRD §4/§21 禁止把 prompt / context 落盘，但 §23 又要求 session 带 `history`。
  由模型显式提供 `goal` + `reason` 后，history 是「调用意图审计」而不是「上下文缓存」；
  `goal` 跨调用稳定（这次任务要什么），`reason` 每次不同（为什么这一步）。
- Decision 6：`base` 只负责「默认解析位置 + bash 默认 cwd + 标识关联项目」，不是沙箱；
  这样模型可以跨项目访问（`../project-b`、`/tmp`），代价是**文件访问安全完全依赖进程 OS 权限与
  客户端可信**——所以默认只绑回环地址（Decision 2/15），并在 `edit` / `bash` 描述里要求风险确认
  （Decision 19）。
- Decision 7：`resume` 是 PRD 的验收项，所以 `close` 不能是破坏性删除；原子写 + 串行化避免并发
  工具调用互相覆盖 history。
- Decision 10：既然没有路径边界可校验，token 就是唯一的授权凭据 → 随机不透明、5 分钟过期、
  无 path 参数、只对应 mint 时的那一个文件。
- Decision 17：`sessionId` 必填解决「多项目/多任务时的默认上下文串台」，而 2026-07-28 的协议级
  session 已被移除，所以只能靠工具参数显式传递。

## Alternatives Considered

- **用 v1 SDK（`@modelcontextprotocol/sdk@1.30.1`）+ `StreamableHTTPServerTransport`**：
  放弃。v1 是 2025-era（`initialize` 握手 + `Mcp-Session-Id`）线，PRD 目标是 2026-07-28；
  用 v1 等于一边声称 2026-07-28 一边发 2025 字节。
- **自建 JSON-RPC/HTTP 层（手写路由、schema、header 校验）**：放弃。属于重造 Tier-1 SDK 已有能力，
  且 2026-07-28 的 `_meta` / `resultType` / 错误码（-32020/-32021/-32022）细节容易做错。
- **用 `Mcp-Session-Id` 做 Session 状态**：不可行。2026-07-28 已删除协议级 session。
- **把 `base` 当作 confinement 根（早期计划方案）**：放弃。用户明确 `base ≠ root ≠ sandbox`
  ≠ permission boundary；早期计划的 `paths.ts` 越界校验与 PRD §17「禁止路径逃逸」一并作废。
- **download token 落盘（重启后仍可用）**：放弃。TTL 只有 5 分钟，落盘会引入过期文件清理。
- **history 存成独立 JSONL 追加文件**：放弃。PRD §4/§23 把 `history` 定义为 session 文档内字段；
  V1 用「同 session 串行写」已足够。
- **手写扩展名→MIME 映射表**：放弃。`mime-types` 是既有标准库，PRD 场景覆盖 pdf/图片/zip/office/音频。

## Scope

### In

- 7 个工具（`session` / `skills` / `read` / `write` / `edit` / `bash` / `download`）及其 zod 入参 schema、
  含使用说明与示例的工具描述。
- Session：`create` / `resume` / `get` / `list` / `close`，`base` 锚点解析、持久化 + 原子写 + history 审计、
  `create`/`resume` 返回全局提示词 `instructions`（真实机器网关，不是沙箱）。
- 终端观测日志：工具调用入参、涉及文件、结果摘要、耗时、错误，以及 server 生命周期与 `/files` 请求。
- Skill：扫描 `~/.agents/skills` 与 `<base>/.agents/skills`（project 覆盖 global，同名去重），
  `list` / `get` / `reload`；创建时只返回 metadata。
- read / write / edit（相对 base 解析、绝对路径直用、可越出 base）、bash（默认 cwd = base，含超时与输出上限）、
  download（token + `GET /files/:token`）。
- HTTP 服务：路由 `/mcp` 与 `/files/:token`，回环 host/origin 校验，优雅退出。
- vitest 测试（含进程内 handler 测试与真实 HTTP 端到端测试）、`tsc --noEmit` 类型检查、
  简短 README（安装/启动/客户端配置示例）。

### Out

- PRD §21 全部：LLM / Provider / Agent Loop / Prompt Engine / RAG / Vector DB / Browser /
  Git Tool / grep / find / ls / PTY / Background Process / Skill 全量预加载。
- **PRD §17 的「download 只能下载 cwd 内文件」与安全范围「禁止路径逃逸」**：按用户补充的
  Session Base 规范作废——`base` 不是边界。
- stdio transport、鉴权/多租户隔离、`subscriptions/listen` 主动推送、session 删除与 GC、
  session 列表分页、`hidden` frontmatter 语义、download 断点续传 / HEAD、build 产物。

## Design

### 目录结构（相对 PRD §20 的增补）

```text
mini-pi-mcp/
├── src/
│   ├── index.ts        # 入口：读 env、建 http server、路由、优雅退出
│   ├── server.ts       # buildHandler()：createMcpHandler + factory（依赖注入）
│   ├── registry.ts     # 工具注册表：ToolDef[] → McpServer.registerTool，统一错误包装
│   ├── session.ts      # SessionStore + resolvePath(base, path)（相对/绝对解析）
│   ├── skills.ts       # SkillIndex：扫描 / frontmatter 解析 / 去重 / 读正文
│   ├── downloads.ts    # TokenStore（mint/verify）+ GET /files/:token 处理器
│   └── tools/{session,skills,read,write,edit,bash,download}.ts
├── test/               # vitest：harness.ts + 各模块/端到端测试（增补，PRD 未列测试位置）
├── docs/plans/          # 本计划
├── README.md            # 增补：如何跑 + 客户端接法
├── package.json  tsconfig.json  vitest.config.ts  .gitignore
```

不需要独立 `paths.ts`：`base` 只是解析锚点，`resolvePath` 是一行函数，和 `base` 语义一起放在
`session.ts`。

### 运行时装配

```ts
// index.ts
const config = { host, port, home };                  // env → 常量
const sessions = new SessionStore(config.home);
const skills   = new SkillIndex();                     // 无状态，按 base 扫描
const downloads = new TokenStore({ ttlMs: 300_000 });
const handler = createMcpHandler(() => buildServer({ sessions, skills, downloads }));
const nodeHandler = toNodeHandler(handler);
```

工具 handler 内只需要 `sessionId` 与 `ctx`（download 用 `ctx.http.req` 推导 origin）；
工厂只负责「注册一次工具」。

### 路径解析（`session.ts`）

```ts
export function resolvePath(base: string, p: string): string {
  return isAbsolute(p) ? normalize(p) : resolve(base, p);
}
```

- 不检查结果是否在 `base` 内，不拒绝 `..`，不做权限判定；`read` / `write` / `edit` / `download` 一致。
- 工具出参里的 `path` 是**解析后的绝对路径**；history 的 `target` 也用解析后的路径（bash 用命令首行）。
- `base` 在 `session create` 时 `realpath` 规范化并校验存在。

### 数据模型

**Session 文件 `<home>/sessions/ses_<12hex>.json`**

```jsonc
{
  "id": "ses_abc123def456",
  "base": "/workspace/project-a",        // realpath 后的绝对路径（项目锚点）
  "createdAt": "2026-09-26T00:00:00.000Z",
  "updatedAt": "2026-09-26T00:10:00.000Z",
  "closedAt": null,                      // close 时写时间戳，resume 时置回 null
  "skills": [{ "name": "...", "description": "...", "source": "global|project", "path": "/abs/SKILL.md" }],
  "history": [{ "at": "...", "tool": "bash", "goal": "修复分页接口", "reason": "跑回归测试",
                "target": "pnpm test", "ok": true }]
}
```

用 zod 定义 `SessionFileSchema` 做落盘校验（zod 已是直接依赖）；解析失败 → session 视为损坏并报错。
id 生成 `'ses_' + randomBytes(6).toString('hex')`；`history` 保留最后 200 条。

**Download token（进程内）**

```ts
{ token: 'file_<32 base64url>', sessionId, path /*绝对*/, name, mimeType, size, expiresAt }
```

`mint` 时清理过期项；`verify(token)` 返回记录或 `undefined`。

### 全局提示词（`session create` / `resume` 返回）

`src/session.ts` 导出常量 `GATEWAY_INSTRUCTIONS`（唯一来源），`session create` 与 `resume` 的返回体都带
`instructions` 字段（同一段文案；`resume` 也返回，因为恢复会话就是重新拿到同一个真实机器句柄）：

```text
你是通过 mini-pi-mcp 连接到一台真实机器的模型，不是沙箱、不是容器、不是临时环境。

- 真实副作用：write / edit 直接修改真实文件；bash 执行的命令、删除、文件操作、git 操作都会真实生效并持续，
  没有快照、没有回滚、没有隔离副本。
- base 只是默认路径锚点（相对路径解析基准 + bash 默认 cwd），不是权限边界：你可以访问 base 之外的任意路径，
  实际可达范围取决于运行 mini-pi-mcp 的进程权限。
- 所以先确认影响范围：删除或大段覆盖代码、rm -rf、git reset / commit / push、发布与配置变更、
  修改 base 之外的敏感文件，都必须先用自然语言向用户说明要做什么与风险，得到用户明确确认后再调用工具。
- 不要假设有网络隔离、备份或自动测试兜底；不确定就先用只读手段（read / bash 查询）核实，并以真实机器上的
  实际输出与路径为准。
```

同一常量也传给 `new McpServer({...}, { instructions })`，让 2025-era 客户端在 `initialize` 阶段就能看到；
2026-07-28 客户端靠 `session create` 的返回值获取。

### 终端观测日志

`createLogger({ level, write? })`（`write` 默认 `process.stderr.write`，测试可注入收集器）输出单行、
时间戳 + 阶段 + 工具名 + 字段：

```text
2026-09-26T08:12:33.123Z event listening       host=127.0.0.1 port=8787 home=/Users/x/.mini-pi-mcp
2026-09-26T08:12:40.001Z event session-create  session=ses_ab12cd34ef56 base=/workspace/project-a skills=12
2026-09-26T08:12:41.010Z call  #1 read         session=ses_ab12cd34ef56 path=src/index.ts offset=0 limit=200 goal="了解入口实现" reason="确认索引文件结构"
2026-09-26T08:12:41.052Z done  #1 read         ok ms=42 files=/workspace/project-a/src/index.ts result={"path":"/workspace/project-a/src/index.ts","returnedLines":120,"totalLines":120,"truncated":false}
2026-09-26T08:12:50.200Z fail  #2 edit         ms=3 error="oldText matches 3 times in /workspace/project-a/src/a.ts" files=/workspace/project-a/src/a.ts
2026-09-26T08:13:02.400Z done  #3 bash         ok ms=8123 files= cmd="pnpm test" exitCode=0 stdout=12.3KB stderr=0B
2026-09-26T08:13:05.900Z event download-mint   session=ses_ab12cd34ef56 token=file_9x… file=/workspace/project-a/dist/report.pdf size=183402 mime=application/pdf url=http://127.0.0.1:8787/files/file_9x…
2026-09-26T08:13:06.100Z event files-fetch   token=file_9x… status=200 bytes=183402
2026-09-26T08:13:09.500Z event files-fetch   token=file_unknown status=404
```

- `call` / `done` / `fail` 由 `registry.ts` 的包装层统一输出（工具本身不写日志），
  工具通过 `describeCall(args, session)` 提供 `target` / `files`，两者同时用于 history 与日志。
- `event` 用于生命周期与外设动作（listening、session-create/resume/close、download-mint、files-fetch、http-404）。
- 级别：`debug` = 全部；`info` = 只输出 `done` / `fail` / `event`（不输出 `call` 的入参，适合长期挂后台）；`off` = 静默。
- 字段值规则：字符串带空格或引号时用 `JSON.stringify`，对象/数组 JSON 化，长值（>400 字符）截断并加 `…`。

### 隔离边界（sessionId 决定什么）

```text
call(sessionId=ses_A) ─┐
                       ├─ 各自的 base（默认解析位置 + bash cwd）、各自的 skill index、各自的 history
call(sessionId=ses_B) ─┘
                       但文件系统访问不受 base 限制，任何 session 都能读写任意路径
```

- 6 个非 session 工具的 `sessionId` 是 zod 必填字段，缺失直接被 schema 拒绝（`-32602`）。
- sessionId 未知 / 文件损坏 / 已关闭（`close` 后未 `resume`）→ `isError`，不静默新建会话。
- 并发调用不同 session 互不影响（各自文件 + 各自串行写队列）。

### 工具描述规范（Decision 18/19）

每个工具的描述按固定结构书写，示例（`read` 的简化形态）：

```text
读取文本文件（不支持二进制，二进制请用 download）。

参数：
- sessionId：必填，决定相对路径的解析基准
- path：相对路径基于 session.base 解析，绝对路径直接使用，允许 ..
- offset/limit：按行分页，默认 0/200
- goal/reason：必填，写入 session history

示例：
{ "sessionId": "ses_abc123", "path": "src/index.ts", "limit": 100,
  "goal": "了解入口实现", "reason": "需要确认索引文件结构" }
```

- 7 个工具都写「用途 / 参数 / 路径规则 / 示例」；`download` 额外说明 URL 短期有效；
  `edit` / `bash` 额外写「风险与确认」段落（删除代码、覆盖大段实现、`rm -rf`、`git reset --hard`、
  `git commit`/`git push`、发布与配置变更前，必须先用自然语言向用户说明并等用户确认）；
  `write` 带一条「覆盖已有文件前先说明」的短提示。
- 字段级说明写进 zod `.describe()`，会体现在 `inputSchema` 里。

### 工具契约（入参 / 出参 / 失败）

所有工具入参都含必填 `goal` + `reason`（下表不再逐行重复）；出参为
`content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]`；失败统一返回
`{ isError: true, content: [{type:'text', text:'<人类可读原因>'}] }`。

| 工具 | 入参（zod） | 成功出参 | 主要失败 |
| --- | --- | --- | --- |
| `session` | `action: create\|resume\|get\|list\|close`，`base`（create 必填，须为已存在目录），`sessionId?`（resume/get/close），`goal`，`reason` | create/resume → `{ sessionId, base, skills: metadata[], instructions }`；get → session 文档；list → `{ sessions: [{sessionId,base,createdAt,updatedAt,closedAt,skillCount,historyCount}] }`；close → `{ sessionId, closedAt }` | base 不存在/非目录；sessionId 未知、损坏或已关闭；action 与参数不匹配 |
| `skills` | `action: list\|get\|reload`，`sessionId`，`name?`（get），`goal`，`reason` | list/reload → `{ skills: [{name,description,source}] }`（**不含正文**）；get → `{ name, source, path, content }` | sessionId 未知；get 缺 `name` / 名字不存在 |
| `read` | `sessionId`，`path`，`offset=0`，`limit=200`，`goal`，`reason` | `{ path /*绝对*/, offset, limit, returnedLines, totalLines, truncated, content }` | 不存在/非普通文件；二进制（前 8KiB 有 NUL）→ 提示改用 `download` |
| `write` | `sessionId`，`path`，`content`，`goal`，`reason` | `{ path, bytes, created }` | 目标是目录；父路径创建失败；磁盘写入失败 |
| `edit` | `sessionId`，`path`，`oldText`（非空），`newText`，`goal`，`reason` | `{ path, replaced: 1, bytes }` | `oldText` 0 次匹配 / 多次匹配（错误信息带次数）；文件不存在 |
| `bash` | `sessionId`，`command`，`timeout=120000`（1..600000），`goal`，`reason` | `{ stdout, stderr, exitCode, timedOut, durationMs, stdoutTruncated, stderrTruncated, cwd }` | sessionId 未知；无法 spawn shell |
| `download` | `sessionId`，`path`，`goal`，`reason` | `content: [resource_link{uri,name,mimeType,size}, text{name,mimeType,size,url,expiresAt,path}]` | 不存在/非普通文件；sessionId 未知 |

实现要点：

- `read`：`readline` 流式遍历，跳过 `offset` 行、收集最多 `limit` 行，同时统计 `totalLines`；
  累计字符超过 100_000 时截断并置 `truncated: true`；检测到二进制时给可读错误。
- `write`：`mkdir -p` 父目录 → 写 `<file>.tmp-<rand>` → `rename`（原子覆盖）。
- `edit`：字面量计数（不用正则），恰好 1 次才替换，复用 `write` 的原子写。
- `bash`：`spawn('/bin/bash', ['-c', command], { cwd: session.base, detached: true, env: process.env })`
  （用 `-c` 不用 `-lc`：保持 cwd 与输出确定，PATH 直接继承启动服务的进程环境）；
  超时 `process.kill(-pid, 'SIGKILL')` 连子进程一起杀，`timedOut: true`；每个流最多保留 100_000 字符；
  不限制命令访问 base 之外（`cd ..`、`cd /tmp`、`cat /etc/hosts` 均允许）。
- `download`：解析路径 → 校验存在且是普通文件 → mint token → 结果带资源链接；
  URL 用 `new URL(ctx.http.req.url).origin`，缺失时回退 `http://${config.host}:${config.port}`。

### HTTP 路由

```text
POST /mcp              → toNodeHandler(createMcpHandler(...))   # 2026-07-28 + 2025 无状态兼容
GET  /files/<token>    → TokenStore.verify → 复核(未过期 + 仍是普通文件) → 流式返回文件
其他                    → 404 {"error":"not found"}；/files 非 GET → 405
```

`/files` 响应头：`Content-Type`（`mime-types` 推断，兜底 `application/octet-stream`）、
`Content-Length`、`Content-Disposition: attachment; filename*=UTF-8''<encodeURIComponent>`、
`X-Content-Type-Options: nosniff`。token 未命中 / 过期 / 文件已消失统一 404，不区分原因。
token 必须匹配 `/^file_[A-Za-z0-9_-]{32}$/`，路由中不读取任何 query/path 参数。

回环绑定（默认）时在 handler 前串 `localhostHostValidation` + `localhostOriginValidation`；
非回环绑定跳过 Host 校验并向 stderr 打印警告。`SIGINT`/`SIGTERM` → `handler.close()` + `server.close()`。

### 工具注册表与错误包装

```ts
type ToolDef = { name: string; title?: string; description: string; schema: z.ZodObject;
                 annotations?: ToolAnnotations; requiresSession?: boolean;
                 describeCall?: (args, session) => { target: string; files?: string[] };
                 handler: (args, ctx, session) => Promise<unknown> };
// registry: server.registerTool(name, { title, description, inputSchema: schema, annotations }, wrap(handler))
// wrap:
//   const id = nextCallId();
//   const session = def.requiresSession ? await sessions.load(args.sessionId) : undefined;
//   const info = def.describeCall?.(args, session);
//   logger.tool({ id, tool: def.name, phase: 'call', fields: { session, ...info, ...args } });
//   try { const r = await def.handler(args, ctx, session); logger.tool({..., phase:'done', ms, fields:{ files, result }});
//         await sessions.appendHistory(...ok: true); return toResult(r); }
//   catch (e) { logger.tool({..., phase:'fail', ms, fields:{ error, files }});
//               await sessions.appendHistory(...ok: false, error); return errorResult(message(e)); }
//   没有可用 sessionId 的调用（session.create / session.list）不记 history
```

`ToolError`（`registry.ts` 导出）表示预期失败，工具用 `throw new ToolError('可读原因')`；
其他异常也转成 `isError` 文本（栈只进终端日志，不进工具结果）。

`annotations`：`read` / `download` / `skills.list` / `session.get|list` 标 `readOnlyHint: true`；
`write` / `edit` / `bash` 标 `destructiveHint: true`（`bash` 同时 `openWorldHint: true`）。

### Skill 索引

```ts
scanSkills(base): [{ name, description, source, path }]   // project 覆盖 global，按 name 升序
readSkillContent(name): string | undefined
```

扫描 `~/.agents/skills/*/SKILL.md` 与 `<base>/.agents/skills/*/SKILL.md`；忽略隐藏目录与无
`SKILL.md` 的目录；只读文件头部 16 KiB 解析 frontmatter（找不到闭合 `---` 视为无 frontmatter）；
YAML 解析失败按「无 frontmatter」降级处理。`skills.get` 读取时上限 200_000 字符，超出置 `truncated`。

## Acceptance Criteria

1. `POST /mcp` 用 2026-07-28 头部 + `_meta` 信封可完成 `tools/list` / `tools/call`，返回 7 个工具，
   每个工具描述都含使用说明与示例。
2. `session` 的 5 个 action 均可用；`create` 必须带 `base`、只返回 skill metadata（不含正文），
   并返回全局提示词 `instructions`（说明「与真实机器之间的网关，不是沙箱」、base 不是边界、破坏性操作须确认）；
   session 落盘到 `<home>/sessions/`；服务重启后 `resume` 能恢复 `base` 与 skill index 并继续操作。
3. `skills.list` 不返回正文；`skills.get` 按需返回正文；`skills.reload` 能发现新增 skill；
   同名 skill 时 project 版本生效（`source: "project"`）。
4. `read` / `write` / `edit` 行为符合上表；`edit` 在 0 或多处匹配时报错且不改文件。
5. `bash` 默认在 `session.base` 执行并返回 stdout/stderr/exitCode；超时能杀掉进程并标注 `timedOut`；
   `cd ..` / `cd /tmp` 不被阻止。
6. `download` 返回 `resource_link` 与可访问 URL；`curl` 该 URL 能拿到与原文件字节一致的内容；
   token 5 分钟后失效；`/files?path=/etc/passwd` 这类请求不存在（路由不接受 path 参数）。
7. Session Base 语义：相对路径基于 `base` 解析；`../shared/x` 与 `/tmp/x` 均可用；
   `read` / `write` / `edit` / `download` 不因路径离开 `base` 而拒绝（PRD §17 的边界要求已作废）。
8. 每次工具调用在 session history 留下 `{ at, tool, goal, reason, target, ok }`；history 不含文件正文、
   命令输出、prompt、context。
9. 会话隔离：除 `session create` 外，任何工具调用缺少 / 携带无效 `sessionId` 都被拒绝；
   不同 session 的 base / skill index / history 互不串台。
10. `edit` / `bash` 的描述包含风险与用户确认要求。
11. 终端日志：一次完整的 create → read → edit(失败) → bash → download 流程后，stderr 里能看到
    每个工具的 `call` / `done` / `fail` 行（含 sessionId、涉及文件、耗时、结果摘要/错误）
    以及 `session-create`、`download-mint`、`files-fetch` 事件；`MINI_PI_MCP_LOG=off` 时无输出。
12. `pnpm test` 全绿，`pnpm typecheck` 无错误。

## Test Strategy

测试文件（`test/`，vitest，临时目录 `fs.mkdtemp` 作为 home 与 workspace，`afterEach` 清理）：

- `harness.ts`：建 handler（注入临时 home + 临时 global skills 目录 + 收集日志的 logger）并暴露
  `callTool(name, args)`（进程内 `handler.fetch`，按 2026-07-28 头部与 `_meta` 信封构造请求）、
  `startHttpServer()`、`logs`（日志行数组）、临时目录 fixture 助手。
- `log.test.ts`：格式（时间戳/阶段/字段顺序）、字符串加引号、长值截断、`info` 不输出 `call`、`off` 静默。
- `session.test.ts`：create 必须带 `base` 且返回 metadata 不含正文；`base` 不存在/非目录报错；
  落盘文件字段完整（`id`/`base`/`skills`/`history`）；resume 恢复 base 并重扫索引；get/list/close；
  close→resume 后 `closedAt` 归零；close 后未 resume 的其他工具调用被拒；未知/损坏 session；
  history 追加（含 `goal`/`reason`/`target`/`ok`）与 200 条上限；create/resume 返回的 `instructions`
  含「不是沙箱」「base 不是权限边界」「先向用户确认」三类关键句。
- `base.test.ts`：相对路径 → `resolve(base, p)`；`../shared/x` 可解析到 base 外；绝对路径原样使用；
  同一路径在不同 base 的 session 下解析结果不同；read/write/download 到 base 外的文件都成功（无边界）。
- `skills.test.ts`：happy（global + project 各一）；project 覆盖同名 global；frontmatter 三种写法
  （无引号 / 双引号 / 块标量 `|`、`>-`）；无 frontmatter 用目录名 + 首段；无 `SKILL.md` 目录跳过；
  顺序稳定；`reload` 发现新增；`get` 未知名字报错。
- `read.test.ts`：offset/limit 分页与 `totalLines`；超长截断；二进制拒绝并提示 download；目录拒绝；
  读 `base` 外文件成功。
- `write.test.ts`：新建含多级父目录（`created: true`）；覆盖（`created: false`）；bytes 正确；
  写 `base` 外路径成功。
- `edit.test.ts`：1 次匹配替换成功；0 次 / 多次匹配报错且文件未变；`oldText` 为空报错。
- `bash.test.ts`：stdout + exitCode 0；非零退出；stderr；默认 cwd = base（`pwd` 断言）；
  `cd ..` 与绝对目录可达；超时被杀（`timedOut: true`）；大输出截断标记。
- `downloads.test.ts`：mint 返回 name/mimeType/size/url/expiresAt；结果含 `resource_link`；
  真实 HTTP `GET /files/<token>` 取到字节一致内容与响应头；base 外文件也能下载；未知 / 过期 token 404；
  token 被篡改 404；mint 后文件被删 → 404；非 GET → 405。
- `transport.test.ts`：真实 HTTP 服务：缺 `MCP-Protocol-Version` → `-32020`；`tools/list` 恰好 7 个工具
  且每个 description 含示例（断言出现 `"goal"` 与 JSON 样例片段）；`read` 缺 `sessionId` / `goal` / `reason`
  被 schema 拒绝；`session` 未知 sessionId 报错；`session create` 返回里带 `instructions`；
  `logs` 中出现 `call`/`done` 行且含工具名、文件路径与结果摘要；完整链路 create → write → bash → download → curl。

先写失败测试（RED）→ 最小实现（GREEN）→ 必要时重构（REFACTOR）。

## Implementation Plan

每个 task 自带测试周期（RED→GREEN），完成一个再进下一个。

1. **骨架**：`package.json`（`type: module`、scripts `start`/`test`/`typecheck`）、`tsconfig.json`
   （strict、`module: nodenext`、include `src` + `test`）、`vitest.config.ts`、`.gitignore`、
   `src/log.ts`（终端观测日志）+ `test/log.test.ts`。
2. **session store**：`src/session.ts`（`SessionFileSchema`、`GATEWAY_INSTRUCTIONS`、`resolvePath`、
   原子写 + 串行写、history 上限与追加、create/resume/get/list/close、base 校验）+
   `test/session.test.ts`、`test/base.test.ts`。
3. **skills**：`src/skills.ts`（扫描 / frontmatter / 去重 / 读正文）+ `test/skills.test.ts`。
4. **downloads token + files 路由**：`src/downloads.ts`（mint/verify + node 原生 `GET /files/:token`
   处理器 + `files-fetch` 日志）+ 接进 `src/index.ts` + `test/downloads.test.ts`。
5. **registry + server + session/skills 工具**：`src/registry.ts`（ToolDef、ToolError、统一错误包装、
   call/done/fail 日志、history 落盘）+ `src/server.ts`（`createMcpHandler` 工厂注入 + instructions）+
   `src/tools/session.ts`、`src/tools/skills.ts`、`src/index.ts`（env 配置、路由、优雅退出、启动日志）+
   `test/transport.test.ts`（7 工具清单 + 描述要求 + 日志断言）。
6. **read / write / edit 工具**：`src/tools/{read,write,edit}.ts`（含使用说明、示例、风险提示）+ 对应测试。
7. **bash 工具**：`src/tools/bash.ts`（含超时、输出上限、风险与确认说明）+ `test/bash.test.ts`。
8. **download 工具 + README**：`src/tools/download.ts`（resource_link + URL + mint 日志）+ 端到端测试补齐 + README。

## Verification

收口时按顺序执行并贴真实输出：

1. `pnpm typecheck` → `tsc --noEmit` 0 error。
2. `pnpm test` → 全部通过（vitest 汇总）。
3. 手工端到端 smoke：

```bash
pnpm start &                       # 默认 127.0.0.1:8787
H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
   -H 'mcp-protocol-version: 2026-07-28')
curl -s "${H[@]}" -H 'mcp-method: tools/list' -H 'mcp-name: ' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' \
  http://127.0.0.1:8787/mcp            # → 7 个工具，描述含使用说明与示例
# session.create(base=/tmp/demo) → 拿 sessionId；write 写文件；bash pwd；download 拿 url
curl -s "<url>" -o /tmp/out.bin && cmp <源文件> /tmp/out.bin   # 字节一致
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/files/unknown   # → 404
```

4. 复查完整 diff（`git status` + untracked），确认无生成物（`node_modules`/`coverage`）入库、
   无重复实现、无临时命名残留。

## 实施记录（与计划的偏差）

实现完成后的实际状态：`pnpm test` 100 个用例全绿（11 个测试文件），`pnpm typecheck` 0 error，
真实 HTTP smoke（`pnpm start` + curl 全链路：tools/list → session create → write → bash → download →
GET /files/:token → 404 分支）通过。以下是实现期发现并直接处理的小偏差：

1. 新增 `src/errors.ts`（`ToolError`）与 `src/paths.ts`（`writeFileAtomic`）：
   计划里说"不需要 paths.ts"，但原子写被 session 存储 / write / edit 三处共用，放在共享模块比复制三份更好；
   `ToolError` 单独成文件是为了避免 tools → registry 的运行时循环依赖。
2. `bash` 用 `/bin/bash -c`（计划写的是 `-c` 之前的 `-lc`）：登录 shell 会引入 profile 噪音并可能改变 cwd，
   而 PATH 本来就从启动进程继承，去掉 `-l` 后 cwd 与输出更确定。
3. `read` 增加 `hasMore` 字段；字符预算被突破时返回最后一行被截断的部分（而不是整行丢弃），
   避免"文件很大时什么都读不到"。
4. `session` 工具完全不写 history（计划写的是只有 create/list 不写）：只有 6 个必须带 `sessionId`
   的工具落审计，规则更简单。
5. `skills reload` 不落盘刷新后的快照（保持 `readOnlyHint: true` 诚实；索引本来就是每次从磁盘扫描）。
6. schema 校验失败由 SDK 以「in-band `isError` 结果」返回（文本 `Input validation error: ...`），
   不是 JSON-RPC `-32602`；测试按实际契约断言（仍断言必须含缺失字段名）。
7. `governance`: 裁剪了只在本文件使用的 `export`（`DEFAULT_*`、`SERVER_INFO`、`TOKEN_PATTERN` 等），
   `tsconfig` 打开 `noUnusedLocals` / `noUnusedParameters`。
8. 新增 `pnpm-workspace.yaml`（pnpm 生成的 `allowBuilds` / 供应链策略排除项），保证 `pnpm install` 可复现。
