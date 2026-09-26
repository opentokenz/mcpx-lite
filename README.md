# Mini Pi MCP

支持可接续 Session、按需 Skills 和本地文件传输的**极简无模型 Coding Runtime**。

- 协议：**MCP 2026-07-28**（无状态核心，无 `initialize` 握手）
- Transport：**Streamable HTTP**，入口 `POST /mcp`
- 工具：`session` / `skills` / `read` / `write` / `edit` / `shell` / `export`
- 不含：LLM、Provider、Agent Loop、Prompt Engine、RAG、Planner

```text
Studio / Agent / LLM
        │  MCP (Streamable HTTP)
        ▼
   Mini Pi MCP  ──►  Local PC（真实文件系统 / 真实 shell）
```

## 要求

- Node.js >= 22
- pnpm

## 快速开始

```bash
pnpm install
pnpm start            # 默认监听 127.0.0.1:8787
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MINI_PI_MCP_HOST` | `127.0.0.1` | 监听地址。绑非回环地址时启动会打印「无鉴权」警告 |
| `MINI_PI_MCP_PORT` | `8787` | 监听端口 |
| `MINI_PI_MCP_HOME` | `~/.mini-pi-mcp` | Session 存储目录（`<home>/sessions/<id>.json`） |
| `MINI_PI_MCP_GLOBAL_SKILLS` | `~/.agents/skills` | 全局 skill 目录 |
| `MINI_PI_MCP_LOG` | `debug` | 终端观测日志级别：`debug`（含调用起点与底层请求）/ `info`（只输出工具结果卡片与安全事件）/ `off` |

## 客户端接法

MCP 服务地址就是 `http://127.0.0.1:8787/mcp`（Streamable HTTP，POST）。
2026-07-28 要求每个请求自带协议版本头部与 `_meta` 信封：

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' \
  -H 'mcp-method: tools/list' \
  -H 'mcp-name: ' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

> `clientCapabilities` 按 2026-07-28 envelope 要求保留即可，可以是空对象。安全确认不依赖
> `elicitation` / `input_required`：服务端用普通 tool result 返回审核卡片与一次性 `approvalToken`。

创建 Session（除 `session` 工具外，其余工具都必须带这个 `sessionId`）：

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: session' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"session","arguments":{"action":"create","base":"/path/to/project","goal":"接手该项目","reason":"用户要求持续工作"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

返回里包含 `sessionId`、`base`、skill metadata，以及一段全局提示词 `instructions`（说明这是
「模型 ↔ 真实机器」之间的网关，不是沙箱）。

## Session Base 语义

`base` 是**项目锚点**，同时是**写类 / 外带工具的信任边界**（`write` / `edit` / `export`）：

- 相对路径 → `resolve(base, path)`；绝对路径 → 直接使用；`..` 允许使用
- `base` 内：`write` 直接写、`edit` 直接改、`export` 直接签发链接
- `base` 外：三者都返回普通 `approval_required` 审核卡片与一次性 `approvalToken`，用户选择“确认执行”后
  用相同参数携带 `approvalToken + approvalDecision=approve` 重试才执行；判定以**解析后的真实路径**为准
  （`realpath`，会跟随 symlink）
- `read` **不受 base 限制**：只读且无副作用，base 内 / base 外都直接读，不需要确认
- `shell` 的默认 `cwd = base`，但可以 `cd ..`、`cd /tmp`、访问任意目录：它的风险由**命令白名单**判定，不是路径判定（见下）
- 真正的边界仍然是运行 Mini Pi MCP 的进程所拥有的操作系统权限

## 安全门禁（shell / 文件类工具）

高风险调用不再只靠提示词约束，而是由 MCP Server 强制执行：

```text
shell / write / edit / export 调用
      │
      ├─ 明确安全 ────────────────► 直接执行
      │
      └─ 危险 / 无法静态判断 ─────► complete tool result
                                        │
                                        ├─ resultType: approval_required
                                        ├─ approvalToken: apr_...
                                        └─ 审核卡片：确认执行 / 取消
                                                │
                              用户确认 + 原参数一致 + token
                                                ▼
                                             真正执行
```

**写类 / 外带工具（write / edit / export）**：按 `base` 划一条线：

- `base` 内 → 直接执行（safe）：`write` 直接写、`edit` 直接改、`export` 直接签发链接
- `base` 外 → 返回 `approval_required` 审核卡片（dangerous）：`../` 穿越、绝对路径指向外部、父目录或目标本身是 symlink 逃逸，
  以及真实路径无法解析（symlink 环等，fail closed）
- 审核卡片包含一次性随机 `approvalToken`；调用方必须提供“确认执行 / 取消”选项，不能替用户做决定
- 确认前不产生任何副作用：不写文件、不签发下载链接；取消、token 失效/篡改、参数变化都不会执行
- `read` **不划线**：只读且无副作用，base 外也直接读、不产生确认卡片

**shell**：白名单 + fail closed。每个顶层子命令（按 `&&` / `||` / `;` / 管道 / 换行拆分，尊重引号与转义）
都必须判定为 safe，整条命令才直接执行：

- safe：`pwd` `ls` `cat` `head` `tail` `rg` `grep` `wc` 等只读命令、受限 `find`（无 `-exec` / `-delete` / `-fprint*`）、
  `git status|diff|log|show`、`pnpm test|typecheck|lint`、`vitest run`、`tsc --noEmit`
- 危险：`rm` `mv` `cp` `touch` `mkdir` `chmod` `git add|commit|push|reset|clean|rebase|checkout|restore…`、
  安装/删除依赖、`curl` / `wget`、`sudo` / `kill`、压缩解包、云与容器 CLI 等
- unknown（fail closed）：命令替换、反引号、重定向、子 shell / 分组、变量展开、解释器包装（`bash -c` / `node -e` 等）、
  以 `/` 开头的路径调用、未列入白名单的命令

确认流程使用普通 tool result，不依赖 MCP elicitation / MRTR。首次危险调用返回：

```json
{
  "resultType": "approval_required",
  "approvalRequired": true,
  "approvalToken": "apr_...",
  "approval": {
    "title": "高风险操作确认",
    "message": "...",
    "options": [
      { "id": "approve", "label": "确认执行", "style": "danger" },
      { "id": "cancel", "label": "取消", "style": "secondary" }
    ]
  }
}
```

- `approvalToken` 是服务端生成的 192-bit 随机一次性 token，默认 10 分钟过期，只保存在进程内
- token 绑定 sessionId / 工具名 / 参数摘要；参数变了（`git commit` → `git commit && git push`、换 path / oldText / newText / content / delivery）旧 token 不授权
- 用户确认：用原参数携带 `approvalToken` + `approvalDecision=approve` 重试；服务端消费 token 后才执行
- 用户取消：携带 `approvalToken` + `approvalDecision=cancel`；服务端消费 token 且不执行
- token 篡改、过期、跨服务重启或重复使用都会失败
- 确认中的调用不会写入 session history，只有真正执行或失败的调用才记录
- 客户端只需按 2026-07-28 要求提供 `clientCapabilities` 字段；可以是空对象，无需声明 `elicitation`

## Skills

- 扫描 `~/.agents/skills/<name>/SKILL.md` 与 `<base>/.agents/skills/<name>/SKILL.md`
- 同名时 project 覆盖 global
- `session create` / `resume` 只读取 frontmatter 元数据（`name` / `description`），**正文不自动加载**
- 需要时用 `skills get` 按需读取正文；`skills reload` 重新扫描磁盘

## Download（export 工具）

`export` 把真实机器上的指定文件交给调用方，两种交付方式：

**`delivery: "link"`（默认）**：服务端只签发临时链接，实际下载由调用方完成：

```json
{
  "name": "report.pdf",
  "mimeType": "application/pdf",
  "size": 183402,
  "url": "http://127.0.0.1:8787/files/file_xxx",
  "expiresAt": "2026-09-26T00:05:00.000Z"
}
```

**`delivery: "base64"`**：把内容直接内联在返回里（embedded resource 的 `blob` + 一段 JSON 摘要）：

```json
{
  "name": "plan.xlsx",
  "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "size": 4096,
  "path": "/workspace/project-a/dist/plan.xlsx",
  "encoding": "base64",
  "sha256": "9f2c…"
}
```

- 拿不到链接的场景（反向代理域名不可达、内网隔离、客户端只能读响应体）用 `base64`；
  上限 **1 MiB**（超出报错并提示改用 link），返回的 `sha256` 可用于校验组装结果
- `link` 模式结果同时带一个 `resource_link`，支持它的客户端可以直接识别该文件
- `GET /files/<token>` 只认随机 token：不接受任何 `path` 参数、只对应一个具体文件、**5 分钟过期**
- 取文件时会重新确认文件仍存在且仍是普通文件
- 目标在 `base` 外时先要求确认，**确认前不会读取内容、也不会签发任何 token**
- 返回 URL 的 `origin` 按顺序取：`Forwarded`（RFC 7239）→ `X-Forwarded-Proto` + `X-Forwarded-Host` →
  请求自身的绝对 URL（仅当 hostname 不是回环地址）→ 服务配置的 `host:port`；
  部署在反向代理后面时转发这些头，客户端就能拿到对外域名
- 这些值来自请求头（调用方自述），单用户 runtime 下可接受；只接受 `http` / `https`，
  并会丢掉路径与非法值
- 监听在通配地址（`0.0.0.0` / `::`）时，若又推断不出对外地址，会输出一条 `export-origin-warning`
  事件提醒：回退出来的链接客户端不可达，需要转发代理头或把 `MINI_PI_MCP_HOST` 设为客户端可达地址
- 返回 URL 的 `origin` 按顺序取：`Forwarded`（RFC 7239）→ `X-Forwarded-Proto` + `X-Forwarded-Host` →
  请求自身的绝对 URL（仅当 hostname 不是回环地址）→ 服务配置的 `host:port`；
  部署在反向代理后面时转发这些头，客户端就能拿到对外域名
- 这些值来自请求头（调用方自述），单用户 runtime 下可接受；只接受 `http` / `https`，
  并会丢掉路径与非法值
- 监听在通配地址（`0.0.0.0` / `::`）时，若又推断不出对外地址，会输出一条 `export-origin-warning`
  事件提醒：回退出来的链接客户端不可达，需要转发代理头或把 `MINI_PI_MCP_HOST` 设为客户端可达地址

## 终端观测日志

日志的重点是「看懂 agent 正在做什么」：每次工具调用渲染成一张独立卡片，而不是散成普通文本行。
日志写 stderr，不写文件；字段值截断到 400 字符，文件正文 / 命令输出只记长度。

```text
2026-09-26T02:20:40.087Z → SHELL #3  pnpm test
┌─ SHELL  #3  SUCCESS ──────────────────────────────────────────── 483ms  02:20:40.570 ┐
│ session  ses_a8ee4bf8c11c                                                            │
│ goal     跑测试                                                                      │
│ reason   改完确认没破坏                                                              │
│ command  pnpm test                                                                   │
│ result   {"stdout":"<1407 chars>","stderr":"<0 chars>","exitCode":1,"timedOut":false │
│ result   ,"durationMs":482,"stdoutTruncated":false,"stderrTruncated":false,"cwd":"/p │
│ result   rivate/tmp/log2-demo"}                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
2026-09-26T02:20:40.573Z → SHELL #4  touch new.txt
┌─ SHELL  #4  APPROVAL REQUIRED ───────────────────────────────────────── 02:20:40.574 ┐
│ session  ses_a8ee4bf8c11c                                                            │
│ goal     创建文件                                                                    │
│ reason   需要落盘                                                                    │
│ command  touch new.txt                                                               │
│ risk     fs.touch · 会创建文件或更新时间戳                                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
2026-09-26T02:20:40.578Z → SHELL #5  touch new.txt
2026-09-26T02:20:40.578Z ✓ SHELL #5  fs.touch · 会创建文件或更新时间戳
┌─ SHELL  #5  SUCCESS ────────────────────────────────────────────── 6ms  02:20:40.583 ┐
│ session  ses_a8ee4bf8c11c                                                            │
│ goal     创建文件                                                                    │
│ reason   需要落盘                                                                    │
│ command  touch new.txt                                                               │
│ result   {"stdout":"<0 chars>","stderr":"<0 chars>","exitCode":0,"timedOut":false,"d │
│ result   urationMs":5,"stdoutTruncated":false,"stderrTruncated":false,"cwd":"/privat │
│ result   e/tmp/log2-demo"}                                                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
2026-09-26T02:20:40.589Z → EXPORT #7  /private/tmp/log2-demo/dist/report.pdf
┌─ EXPORT  #7  SUCCESS ───────────────────────────────────────────── 0ms  02:20:40.589 ┐
│ session  ses_a8ee4bf8c11c                                                            │
│ goal     内联交付                                                                    │
│ reason   链接不可达                                                                  │
│ path     dist/report.pdf                                                             │
│ delivery base64                                                                      │
│ result   {"blocks":2,"types":["resource","text"]}                                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

规则：

- 一次调用只有**一张结果卡片**（工具名 + 编号 + 状态 + 耗时）；调用起点与确认结果只占一行
  （`→ TOOL #id target` / `✓ TOOL #id risk` / `✗ TOOL #id reason`），不把字段重复一遍。
- 卡片状态用明确文字：`SUCCESS` / `FAILED` / `APPROVAL REQUIRED` / `RISK UNKNOWN`；
  状态不依赖颜色，单行事件用 `→` / `✓` / `✗` 标记。
- `session` / `goal` / `reason` 默认可见；工具相关字段固定 label 列（`command` / `path` / `action` / `delivery` / `result` / `risk`）。
- 工具名使用稳定配色（同一工具跨调用颜色一致）；边框宽度按终端列数自适应（夹在 64–100），
  东亚宽字符按 2 列计算，ANSI 不计入宽度，所以中文内容不会把边框挤歪。
- 慢调用（≥ 3s）的耗时会被强调；长字段按宽度换行，单行事件按宽度截断。
- TTY 且未设 `NO_COLOR` 时启用 ANSI；非 TTY / `NO_COLOR` / 自定义 sink 下不输出转义序列，但保留同样的纯文本布局。
- 日志级别（环境变量 `MINI_PI_MCP_LOG`，启动前设置）：
  - `debug`（默认）：单行调用起点 + 结果卡片 + 安全事件 + 弱化的 `· mcp-request` 诊断行；
  - `info`：只保留结果卡片与安全事件（`APPROVAL REQUIRED` / `RISK UNKNOWN` 卡片、`✓` / `✗` 行）；
  - `off` / `quiet`：完全静默；
  - 例：`MINI_PI_MCP_LOG=info pnpm start`。
- 日志永不输出负载本身：文件正文、命令 stdout / stderr、`export` 内联的 base64 blob 都只记长度或块类型
  （形如 `result {"blocks":2,"types":["resource","text"]}`）。
- 客户端（Studio / Agent）如果把工具响应自己打印到终端，那是客户端行为，与本服务的日志无关；
  大文件交付建议用 `link` 而不是 `base64`。

## 开发

```bash
pnpm test          # vitest（198 个用例：单元 + 进程内 MCP + 真实 HTTP 端到端）
pnpm typecheck     # tsc --noEmit
pnpm test:watch
```

目录：

```text
src/
├── index.ts        # 入口：env、HTTP 路由（/mcp、/files/:token）、优雅退出
├── server.ts       # createMcpHandler 工厂 + 7 工具装配
├── registry.ts     # ToolDef、统一错误包装、审核 pending 识别、终端卡片、history 落盘
├── session.ts      # Session 持久化 + base 解析 + base 边界判定 + GATEWAY_INSTRUCTIONS
├── skills.ts       # skill 扫描 / frontmatter / 去重 / 读正文
├── downloads.ts    # 下载 token + GET /files/:token（transport 层，保留 download 命名）
├── paths.ts        # 原子写文件 + realpathDeep（目标可尚不存在的真实路径解析）
├── risk.ts         # shell 命令拆分 / tokenise / 安全白名单（fail closed）
├── approval.ts     # 随机一次性 approvalToken + 审核卡片 + base 边界门禁 + 参数摘要
├── ansi.ts         # 可见宽度 / 宽度换行 / ANSI 着色 helper
├── log.ts          # 终端观测卡片（状态 / 配色 / 宽度自适应）
└── tools/          # 7 个工具
```

## V1 不做

LLM / Provider / Agent Loop / Prompt Engine / RAG / Vector DB / Browser / Git 工具 /
grep / find / ls / PTY / 后台进程 / skill 全量预加载 / stdio transport / 鉴权。
需要 `grep`、`find`、`ls`、`git`、`npm`、`python` 时统一走 `shell`。

安全门禁本身也划定了 V1 不做的范围：OS sandbox / 容器 / seccomp / macOS sandbox、
完整 Shell AST 解释器、shell 命令里的路径归属分析、持久化 approval 与跨重启继续确认、
自定义 policy 配置与 RBAC、自动读取并分析脚本内容。
