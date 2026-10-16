# mcpx-lite

支持可接续 Session、按需 Skills 和本地文件传输的**极简无模型 Coding Runtime**。

- 协议：**MCP 2026-07-28**（无状态核心，无 `initialize` 握手）
- Transport：**Streamable HTTP**，入口 `POST /mcp`
- 工具：`session` / `skills` / `mcp_tool` / `read` / `write` / `edit` / `trash` / `shell` / `fetch`
- 不含：LLM、Provider、Agent Loop、Prompt Engine、RAG、Planner

```text
Studio / Agent / LLM
        │  MCP (Streamable HTTP)
        ▼
   mcpx-lite  ──►  Local PC（真实文件系统 / 真实 shell）
```

## 要求

- Node.js >= 24
- pnpm
- Windows 10/11：系统提供的 Windows PowerShell 5.1；shell 工具在 Windows 中使用 PowerShell，macOS/Linux 使用 Bash

支持 Windows x64 与 ARM64。ARM64 的 PowerShell AST 解析器与 exe 需要在原生 ARM64 设备上验收。

## 快速开始

```bash
pnpm install
pnpm start                         # 前台运行，默认监听 127.0.0.1:29090
pnpm start -- --daemon             # 后台运行
pnpm start -- --daemon --port 3000 # 指定端口后台运行
pnpm start -- --no-approval        # 关闭全部 mcpx-lite 审批门禁
pnpm start -- --stop               # 停止后台实例
```

Windows PowerShell 中也使用 `pnpm install` 与 `pnpm start`。参数支持 `--daemon` / `-d`、`--stop`、`--port` / `-p` 和 `--no-approval`；CLI 端口参数优先于环境变量。创建 session 时，`workspace` 可使用盘符路径或 UNC 路径，例如 `C:\work\project` 或 `\\server\share\project`。

前台和后台启动都会先停止由当前版本登记的旧实例。后台日志写入 `~/.mcpx-lite/daemon.log`；设置 `MCPX_LITE_HOME` 后，日志和实例记录保存在该目录。新版本不读取或迁移旧会话数据；若旧服务仍运行且占用相同端口，请先在原终端按 `Ctrl+C` 停止。

## 平台可执行文件

安装 [Bun](https://bun.sh) 和项目依赖（`pnpm install`），即可在支持 Bun 的构建主机上交叉构建以下平台目标。
可分别运行平台脚本，也可加 `:x64` 或 `:arm64` 只构建一种架构。

### macOS

```bash
pnpm build:macos
```

产物：`dist/mcpx-lite-macos-x64`（Intel）和 `dist/mcpx-lite-macos-arm64`（Apple Silicon）。

### Linux

```bash
pnpm build:linux
```

产物：`dist/mcpx-lite-linux-x64` 和 `dist/mcpx-lite-linux-arm64`。

### Windows

```powershell
pnpm build:windows
```

产物：`dist/mcpx-lite-win-x64.exe` 与 `dist/mcpx-lite-win-arm64.exe`。
exe 不内置用户配置、skills 或 session；这些数据仍从当前用户 home 目录和项目目录读取。
Windows ARM64 exe 需在原生 Windows ARM64 设备上运行验收。

### 安装到本机

在仓库根目录运行：

```bash
pnpm install:local
```

脚本按当前主机平台和架构构建当前 checkout 的代码，并将二进制安装到
`~/.local/bin/mcpx-lite`。需要预先安装 pnpm、Bun 和项目依赖；脚本不会拉取 Git 更新，
也不会修改 shell 配置或 PATH；若 `~/.local/bin` 不在 PATH 中，需自行添加。仅支持 macOS/Linux x64 与 ARM64。

安装后可直接用 CLI 参数启停：

```bash
mcpx-lite --daemon
mcpx-lite --daemon --port 3000
mcpx-lite --daemon --no-approval
mcpx-lite --stop
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MCPX_LITE_HOST` | `127.0.0.1` | 监听地址。绑非回环地址时启动会打印「无鉴权」警告 |
| `MCPX_LITE_PORT` | `29090` | 监听端口 |
| `MCPX_LITE_HOME` | `~/.mcpx-lite` | Session 存储目录（`<home>/sessions/<id>.json`） |
| `MCPX_LITE_GLOBAL_SKILLS` | `~/.agents/skills` | 全局 skill 目录 |
| `MCPX_LITE_LOG` | `debug` | 终端观测日志级别：`debug`（含调用起点与底层请求）/ `info`（只输出工具结果卡片与安全事件）/ `off` |
| `MCPX_LITE_APPROVALS` | `on` | 设为 `off` 时关闭全部 mcpx-lite 审批门禁；等价于启动时传 `--no-approval` |

## 客户端接法

MCP 服务地址就是 `http://127.0.0.1:29090/mcp`（Streamable HTTP，POST）。
2026-07-28 要求每个请求自带协议版本头部与 `_meta` 信封：

```bash
curl -s http://127.0.0.1:29090/mcp \
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
curl -s http://127.0.0.1:29090/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: session' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"session","arguments":{"action":"create","workspace":"/path/to/project"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

返回里包含 `sessionId`、`workspace`、skill metadata，以及一段全局提示词 `instructions`（说明这是
「模型 ↔ 真实机器」之间的网关，不是沙箱）。

所有工具仍接受 `goal` / `reason` 作为**可选审计字段**；提供时会写入 session history。
它们不是执行工具所需的业务参数，客户端可以省略，避免为每次调用额外生成自由文本。

## 关闭全部审批

默认仍启用审批。显式传 `--no-approval`，或设置 `MCPX_LITE_APPROVALS=off`，会关闭当前 mcpx-lite 进程的**全部审批门禁**：危险 `shell`、workspace 外 `write` / `edit` / `fetch`、所有 `trash`、项目级 MCP 首次连接，以及下游 MCP 首次工具调用都不会再返回 `approval_required`，而是直接继续执行。前台与 daemon 模式都支持；关闭时启动日志会打印显式警告。

这个开关只关闭审批，不跳过其余校验与保护：路径解析、参数 schema、`edit` 唯一匹配和并发修改检测、PowerShell AST/语法检查、操作系统权限等仍然生效。`session` 返回的 `instructions` 与 MCP initialize instructions 也会明确标记“审批已关闭”，避免调用方继续按旧门禁语义等待确认。

> 这是高风险模式。mcpx-lite 操作的是真实机器，并且没有沙箱或自动回滚。需要恢复默认行为时，去掉 `--no-approval` 并不要把 `MCPX_LITE_APPROVALS` 设为 `off`，然后重启服务。

## Session Workspace 语义

`workspace` 是**项目锚点**；审批开启时，同时是**写类 / 外带工具的信任边界**（`write` / `edit` / `fetch`）：

- 相对路径 → `resolve(workspace, path)`；绝对路径 → 直接使用；`..` 允许使用
- `workspace` 内：`write` 直接写、`edit` 直接改、`fetch` 直接签发链接；`trash` 仍然必须确认
- `workspace` 外：三者都返回普通 `approval_required` 审核卡片与一次性 `approvalToken`，用户选择“确认执行”后
  用相同**业务参数**携带 `approvalToken + approvalDecision=approve` 重试才执行；`goal` / `reason` 可变化或省略。路径判定以**解析后的真实路径**为准
  （`realpath`，会跟随 symlink）
- `read` **不受 workspace 限制**：只读且无副作用，workspace 内 / workspace 外都直接读，不需要确认
- `shell` 的默认 `cwd = workspace`，但可以 `cd ..`、`cd /tmp`、访问任意目录：它的审批由**危险命令规则**判定，不是路径判定（见下）
- 审批关闭时，上述 `approval_required` 分支全部跳过，`workspace` 只保留路径解析锚点和 shell 默认 cwd 的作用
- 真正的边界仍然是运行 mcpx-lite 的进程所拥有的操作系统权限

## 安全门禁（shell / 文件类工具）

审批开启时，写类工具边界与命中的危险 shell 命令不再只靠提示词约束，而是由 MCP Server 强制执行：

```text
shell / write / edit / trash / fetch 调用
      │
      ├─ 无需审批 ─────────────────► 直接执行
      │
      └─ 需要审批 ─────────────────► complete tool result
                                        │
                                        ├─ resultType: approval_required
                                        ├─ approvalToken: apr_...
                                        └─ 审核卡片：确认执行 / 取消
                                                │
                         用户确认 + 业务参数一致 + token
                                                ▼
                                             真正执行
```

**写类 / 外带工具（write / edit / fetch）**：按 `workspace` 划一条线：

- `workspace` 内 → 直接执行（safe）：`write` 直接写、`edit` 直接改、`fetch` 直接签发链接
- `workspace` 外 → 返回 `approval_required` 审核卡片（dangerous）：`../` 穿越、绝对路径指向外部、父目录或目标本身是 symlink 逃逸，
  以及真实路径无法解析（symlink 环等，fail closed）
- 审核卡片包含一次性随机 `approvalToken`；调用方必须提供“确认执行 / 取消”选项，不能替用户做决定
- 确认前不产生任何副作用：不写文件、不签发下载链接；取消、token 失效/篡改、业务参数变化都不会执行；`goal` / `reason` 变化不影响授权
- `read` **不划线**：只读且无副作用，workspace 外也直接读、不产生确认卡片

**trash**：不按 workspace 划信任边界。无论目标是文件、目录、链接还是位于 workspace 内外，首次调用都必须返回
`approval_required`；确认后才逐项移动到操作系统回收站，永不 fallback 到永久删除。

**shell**：命中危险命令规则时要求审批；safe 与 unknown 都直接执行。顶层子命令按 `&&` / `||` / `&` / `;` / 管道 / 换行拆分，尊重引号与转义，因此 `echo 'a&b|c'` 不会被误拆。

- safe：`pwd` `ls` `cat` `head` `tail` `rg` `grep` `wc` 等只读命令、受限 `find`（无 `-exec` / `-delete` / `-fprint*`）、
  `git status|diff|log|show`、`pnpm test|typecheck|lint`、`vitest run`、`tsc --noEmit`
- 可撤回的本地 Git 操作直接执行，不要求审批：`git add`、`git mv`、`git apply`、`git fetch`、`git pull`、`git branch`、`git tag`、`git stash`、`git merge`、`git rebase`、`git switch`、切分支形式的 `git checkout`、`git config` 等。
  `git checkout` 的 path / force / merge / patch 形式、`git checkout -B`、`git switch --discard-changes/-C/-f`、`git stash drop/clear`、`git branch -D/-f/-M`、`git tag -f`、`git mv -f`、`git apply --unsafe-paths` 等可能丢弃或覆盖本地改动的形式仍需审批
- 危险（需要审批）：`rm`、危险的 `git` 子命令（包括 `push` / `reset` 等）、`mv` `cp` `touch` `mkdir` `chmod`、
  `shutdown` / `reboot` / `restart`、磁盘分区/格式化和防火墙命令、安装/删除依赖、`curl` / `wget`、`sudo` / `kill`、压缩解包、云与容器 CLI 等；部分危险命令按可执行文件名前缀匹配，带路径调用按 basename 检查
- unknown（直接执行，无需审批）：命令替换、反引号、重定向、子 shell / 分组、变量展开、未列入危险规则的命令及无法静态解析的语法；可解析的 `bash` / `sh` / `zsh -c` 会检查其命令字符串，内层命中危险规则时仍需审批，`node -e` 等未支持的包装仍按 unknown 放行
- Windows PowerShell 命令会先用 AST 静态解析；Parser 不可用或命令存在语法错误时拒绝执行，不按 unknown 放行

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
- token 绑定 sessionId / 工具名 / 业务参数摘要；参数变了（`git commit` → `git commit && git push`、换 `edits[]` / path / content / paths / delivery）旧 token 不授权
- 用户确认：用原业务参数携带 `approvalToken` + `approvalDecision=approve` 重试；`goal` / `reason` 可变化或省略，服务端消费 token 后才执行
- 用户取消：携带 `approvalToken` + `approvalDecision=cancel`；服务端消费 token 且不执行
- token 篡改、过期、跨服务重启或重复使用都会失败
- 确认中的调用不会写入 session history，只有真正执行或失败的调用才记录
- 客户端只需按 2026-07-28 要求提供 `clientCapabilities` 字段；可以是空对象，无需声明 `elicitation`

## Trash 与批量 Edit

### Trash（移入系统回收站）

`trash` 用于替代 agent 常见的 `rm` 场景，输入 `paths[]`（1–100 项，不支持 glob）：

```json
{ "sessionId": "ses_ab12cd34ef56", "paths": ["tmp/cache.db", "old.txt"] }
```

- 相对路径基于 `session.workspace`；绝对路径直接使用
- 所有调用都必须确认，确认前不会调用系统回收站 backend
- 预检使用 `lstat`：symlink / junction 只移动链接对象自身，不跟随真实目标
- 重复路径或祖先/后代重叠会让整批失败，且 0 个目标被移动
- 确认后按输入顺序逐项执行；单项失败不阻塞后续项，返回 `results / succeeded / failed`
- 永远不 fallback 到 `unlink` / `rm` / `rmdir` 等永久删除

### Edit（批量事务式精确替换）

`edit` 已改为只接受 `edits[]` 新 schema，旧 `path / oldText / newText` 参数会被拒绝：

```json
{
  "sessionId": "ses_ab12cd34ef56",
  "edits": [
    {
      "path": "src/config.ts",
      "replacements": [
        { "oldText": "timeout: 30,", "newText": "timeout: 60," }
      ]
    }
  ]
}
```

- 同一文件的 replacements 按数组顺序应用，后一项匹配前一项生成的中间内容
- 每一步 `oldText` 必须恰好出现一次；任意文件预检失败时整批 0 写入
- 同一个真实文件通过 symlink + real path 重复出现时整批拒绝
- 任一真实目标在 workspace 外时，整批只触发一次审批；token 绑定完整 `edits[]`
- 用户确认前后都会校验文件状态；审批等待期间内容变化会返回 `concurrent_modification`
- commit 逐文件原子写入；中途失败按逆序恢复已写文件；回滚失败会返回
  `rollbackSucceeded=false` 与 `uncertainPaths`

## OpenAI / ChatGPT 工具元数据

9 个工具都显式声明 `readOnlyHint` / `destructiveHint` / `openWorldHint`，避免宿主根据缺省值猜测副作用：

| 工具 | readOnly | destructive | openWorld |
| --- | --- | --- | --- |
| `session` | false | false | false |
| `skills` | true | false | false |
| `mcp_tool` | false | true | true |
| `read` | true | false | false |
| `write` | false | true | false |
| `edit` | false | true | false |
| `trash` | false | true | false |
| `shell` | false | true | true |
| `fetch` | true | false | false |

修改工具名称、description、input schema 或 annotations 后，重启 MCP 服务，并在 ChatGPT Developer Mode 中刷新 / 重新连接该 MCP connection，再重跑评估集。不要假设现有连接会立即重新扫描 metadata。

## Skills

- 扫描 `~/.agents/skills/<name>/SKILL.md` 与 `<workspace>/.agents/skills/<name>/SKILL.md`
- 同名时 project 覆盖 global
- `session create` / `resume` 只读取 frontmatter 元数据（`name` / `description`），**正文不自动加载**
- 需要时用 `skills get` 按需读取正文；`skills reload` 重新扫描磁盘

## MCP 网关（mcp_tool）

`mcp_tool` 是固定的顶层工具之一：mcpx-lite 自己作为 MCP client 连接下游 server，但**不会**把下游 tools 动态注册到 mcpx-lite 的 `tools/list`。这样宿主始终只看到稳定的 9 个工具，下游 catalog 变化通过 `mcp_tool inspect` 获取，不依赖宿主重新扫描 tool metadata。

配置来源：

- 全局：`~/.agents/mcp.json`
- 项目：`<session.workspace>/.mcp.json`
- project 中同名 server **整项覆盖** global

配置顶层使用 `mcpServers`，首版支持 stdio 与 Streamable HTTP：

```json
{
  "mcpServers": {
    "local": {
      "command": "npx",
      "args": ["-y", "@example/mcp"],
      "env": {
        "API_TOKEN": "${API_TOKEN}"
      }
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

只展开 `${NAME}` 环境变量占位符；不执行 `$()`、反引号等 shell substitution。配置里的 env/header 值不会出现在 `list` / `status` / history / 日志中。

`mcp_tool` actions：

| action | 作用 |
| --- | --- |
| `list` | 返回当前 Session 的 effective server 摘要，不主动连接 |
| `inspect` | 连接指定 server，返回 protocol/server info/instructions/capabilities，以及 tools/resources/resourceTemplates/prompts catalog |
| `call` | 调用下游 tool；首次调用该 server 时要求审批，批准后同 session + server + resolved config 免审批；保留 `content` / `structuredContent` / `isError` 等 MCP 结果结构 |
| `read_resource` | 透传下游 `resources/read` |
| `get_prompt` | 透传下游 `prompts/get` |
| `status` | 查看各 server 的 `disconnected / connecting / connected / failed` 状态，不主动连接 |
| `reload` | 重新读取 global + project 配置，并关闭当前 Session 不再引用的 stale connection |

安全规则：

- **global 配置**视为用户主动安装的能力，可按需连接。
- **project `.mcp.json`** 属于 repository-controlled input；第一次真正连接该配置前必须返回 `approval_required`。stdio 审批前不会 spawn 子进程，HTTP 审批前不会发网络请求。
- 下游 `call` 首次调用某个 server 时返回 `approval_required`；用户确认后，同 session + server + resolved config 的后续 `call` 免审批。mcpx-lite 不再按 downstream `readOnlyHint` / `destructiveHint` 逐次判断。
- `read_resource` / `get_prompt` 在连接建立后直接执行。project 配置首次连接仍需审批；若首次操作就是 `call`，同一张审批卡同时展示连接与首次工具调用，并绑定 `tool + arguments`，避免连续弹两张审批卡。
- project-connect approval 绑定 server resolved config；若同一张卡覆盖首次 `call`，会额外绑定 `tool + arguments`。`goal` / `reason` 仍是可选审计字段，不参与 token 一致性比对。
- 下游 `tools/call` / `resources/read` / `prompts/get` 的 MCP 2026-07-28 `input_required` 会原样透传；重试时 `requestState` 按 opaque 字符串 byte-exact 回送，并携带上游 `inputResponses`。
- 下游 connection 由进程级 `McpManager` 复用，按 server name + resolved config hash 隔离；不同项目对同名 server 的 override 不会串连接。
- 服务退出时会先关闭所有 downstream connection / stdio child process，再关闭 mcpx-lite HTTP server。
- 首版不专门支持 legacy SSE，也不让 mcpx-lite 充当 Sampling / Roots / LLM Provider。

示例：

```json
{ "action": "list", "sessionId": "ses_ab12cd34ef56" }
```

```json
{ "action": "inspect", "sessionId": "ses_ab12cd34ef56", "server": "github" }
```

```json
{
  "action": "call",
  "sessionId": "ses_ab12cd34ef56",
  "server": "github",
  "name": "search",
  "arguments": { "q": "mcp" }
}
```

## Download（fetch 工具）

`fetch` 把真实机器上的指定文件交给调用方，两种交付方式：

**`delivery: "link"`（默认）**：服务端只签发临时链接，实际下载由调用方完成：

```json
{
  "name": "report.pdf",
  "mimeType": "application/pdf",
  "size": 183402,
  "url": "http://127.0.0.1:29090/files/file_xxx",
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
- 目标在 `workspace` 外时先要求确认，**确认前不会读取内容、也不会签发任何 token**
- 返回 URL 的 `origin` 按顺序取：`Forwarded`（RFC 7239）→ `X-Forwarded-Proto` + `X-Forwarded-Host` →
  请求自身的绝对 URL（仅当 hostname 不是回环地址）→ 服务配置的 `host:port`；
  部署在反向代理后面时转发这些头，客户端就能拿到对外域名
- 这些值来自请求头（调用方自述），单用户 runtime 下可接受；只接受 `http` / `https`，
  并会丢掉路径与非法值
- 监听在通配地址（`0.0.0.0` / `::`）时，若又推断不出对外地址，会输出一条 `fetch-origin-warning`
  事件提醒：回退出来的链接客户端不可达，需要转发代理头或把 `MCPX_LITE_HOST` 设为客户端可达地址
- 返回 URL 的 `origin` 按顺序取：`Forwarded`（RFC 7239）→ `X-Forwarded-Proto` + `X-Forwarded-Host` →
  请求自身的绝对 URL（仅当 hostname 不是回环地址）→ 服务配置的 `host:port`；
  部署在反向代理后面时转发这些头，客户端就能拿到对外域名
- 这些值来自请求头（调用方自述），单用户 runtime 下可接受；只接受 `http` / `https`，
  并会丢掉路径与非法值
- 监听在通配地址（`0.0.0.0` / `::`）时，若又推断不出对外地址，会输出一条 `fetch-origin-warning`
  事件提醒：回退出来的链接客户端不可达，需要转发代理头或把 `MCPX_LITE_HOST` 设为客户端可达地址

## 终端观测日志

日志的重点是「看懂 agent 正在做什么」：每次调用渲染成紧凑的 agent transcript，而不是带边框的 dashboard。
日志写 stderr，不写文件。

```text
  goal 跑测试 · reason 改完确认没破坏 · session ses_ab12cd34ef56
• Ran  pnpm test
  └ > vitest run
    Test Files 26 passed | 1 skipped
    … (+382 chars)
  ✓ 483ms · exit 0 · stderr 0 chars

  goal 清理缓存 · reason 重新生成 · session ses_ab12cd34ef56
• Trashed  tmp/cache.db
  ! APPROVAL REQUIRED · trash.move · 将文件或目录移动到系统回收站

  goal 内联交付 · reason 链接不可达 · delivery base64 · session ses_ab12cd34ef56
• Fetched  dist/report.pdf
  ✓ 0ms · 2 blocks · resource, text

  goal 查看数据库表 · reason 需要确认 schema · session ses_ab12cd34ef56
• MCP  mcp:dbx call dbx_list_tables
  action call · server dbx · name dbx_list_tables
  ✓ 1 call
```

规则：

- 每个工具块先用一条 `session` / `goal` / `reason` 元数据行，再接 `• <动词>  <命令/路径>` 标题；动词使用工具稳定配色，命令和路径使用青色。
- `session` 始终可见并放在元数据行末尾；`goal` / `reason` 可选，有值时和 `session` 放在同一条紧凑元数据行，缺失时不占位；超宽时优先在字段边界换行。
- 工具专属参数（如 MCP 的 `action` / `server` / `name`）放在标题下方，不混进审计元数据行。
- 文件路径位于 `session.workspace` 内时显示为相对路径；workspace 外仍显示绝对路径，便于区分越界目标。
- shell 的 `stdout` 使用灰色输出块，默认最多展示 800 字符；超长时继续换行并以 `… (+N chars)` 收尾。
- `stderr` 非空时使用红色预览；结果状态始终放在最后一行：`✓ 耗时 · exit / result`，失败为 `✗`，安全确认为 `!`。
- 结果摘要不再输出 JSON：shell 显示退出码与 stderr 长度，edit / trash / read / fetch 等使用各自的一行摘要。
- 终端宽度按实际 columns 使用（夹在 40–160），东亚宽字符按 2 列计算，不强制补白，也不画边框。
- TTY 且未设 `NO_COLOR` 时启用 ANSI；非 TTY / `NO_COLOR` / 自定义 sink 下不输出转义序列，但保留同样层次。
- 安全确认不再画整张卡片：标题、审计字段和必要的 risk / command 行保留，最后一行明确 `APPROVAL REQUIRED` 或 `RISK UNKNOWN`。
- `debug`（默认）：调用起点 + transcript；`info`：结果 transcript + 安全事件；`off` / `quiet`：完全静默。
- 文件正文、fetch 内联 blob 与完整命令输出不会写入日志；shell stdout / stderr 只保留上面的截断预览，完整内容仍在工具响应中。

## 开发

```bash
pnpm test          # Vitest（含进程内 MCP 与真实 stdio / HTTP 端到端）
pnpm typecheck     # tsc --noEmit
pnpm test:watch
# 真实系统回收站 smoke（macOS / Linux；会向当前 OS Trash 写入测试文件）
MINI_PI_TRASH_SMOKE=1 pnpm vitest run test/trash-smoke.test.ts
```
Windows PowerShell 回收站 smoke（会保留空的临时父目录，便于恢复测试文件后再手动清理）：
```powershell
$env:MINI_PI_TRASH_SMOKE='1'
pnpm vitest run test/trash-smoke.test.ts
```

目录：

```text
src/
├── index.ts        # 入口：env、HTTP 路由（/mcp、/files/:token）、优雅退出
├── server.ts       # createMcpHandler 工厂 + 9 工具装配
├── registry.ts     # ToolDef、统一错误包装、审核 pending 识别、终端卡片、history 落盘
├── session.ts      # Session 持久化 + workspace 解析 + workspace 边界判定 + 动态网关提示词
├── skills.ts       # skill 扫描 / frontmatter / 去重 / 读正文
├── mcp-config.ts   # ~/.agents/mcp.json + <workspace>/.mcp.json 解析、覆盖、env 展开与 secret-safe metadata
├── mcp-client.ts   # downstream MCP client adapter（stdio / Streamable HTTP / manual MRTR）
├── mcp-manager.ts  # 进程级 downstream connection cache / reload / shutdown
├── mcp-trust.ts    # project 首次连接与首次 call 审批后的 session-scoped trust
├── downloads.ts    # 下载 token + GET /files/:token（transport 层，保留 download 命名）
├── paths.ts        # 原子写文件 + realpathDeep（目标可尚不存在的真实路径解析）
├── edit-batch.ts   # 批量 edit prepare / hash / commit / rollback
├── trash.ts        # TrashBackend seam + 跨平台 trash npm 后端
├── risk.ts         # shell 命令拆分 / tokenise / 危险命令分析
├── approval.ts     # 随机一次性 approvalToken + 审核卡片 + workspace 边界门禁 + 参数摘要
├── ansi.ts         # 可见宽度 / 宽度换行 / ANSI 着色 helper
├── log.ts          # 终端观测卡片（状态 / 配色 / 宽度自适应）
└── tools/          # 9 个工具（含 mcp_tool / trash）
```

## V1 不做

LLM / Provider / Agent Loop / Prompt Engine / RAG / Vector DB / Browser / Git 工具 /
grep / find / ls / PTY / 后台进程 / skill 全量预加载 / **入站** stdio transport / 鉴权。
需要 `grep`、`find`、`ls`、`git`、`npm`、`python` 时统一走 `shell`；删除文件/目录走 `trash`，shell 中的 `rm` / `rmdir` 仍保持 dangerous。

安全门禁本身也划定了 V1 不做的范围：OS sandbox / 容器 / seccomp / macOS sandbox、
完整 Shell AST 解释器、shell 命令里的路径归属分析、持久化 approval 与跨重启继续确认、
自定义 policy 配置与 RBAC、自动读取并分析脚本内容。
