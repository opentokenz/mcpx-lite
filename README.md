# Mini Pi MCP

支持可接续 Session、按需 Skills 和本地文件传输的**极简无模型 Coding Runtime**。

- 协议：**MCP 2026-07-28**（无状态核心，无 `initialize` 握手）
- Transport：**Streamable HTTP**，入口 `POST /mcp`
- 工具：`session` / `skills` / `read` / `write` / `edit` / `bash` / `download`
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
| `MINI_PI_MCP_LOG` | `debug` | 终端观测日志级别：`debug` / `info`（只输出 done、fail、event）/ `off` |

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

`base` 是**项目锚点**，不是安全边界：

- 相对路径 → `resolve(base, path)`；绝对路径 → 直接使用；`..` 允许离开 `base`
- `read` / `write` / `edit` / `download` 都不限制路径必须位于 `base` 内
- `bash` 的默认 `cwd = base`，但可以 `cd ..`、`cd /tmp`、访问任意目录
- 真正的边界是运行 Mini Pi MCP 的进程所拥有的操作系统权限

## Skills

- 扫描 `~/.agents/skills/<name>/SKILL.md` 与 `<base>/.agents/skills/<name>/SKILL.md`
- 同名时 project 覆盖 global
- `session create` / `resume` 只读取 frontmatter 元数据（`name` / `description`），**正文不自动加载**
- 需要时用 `skills get` 按需读取正文；`skills reload` 重新扫描磁盘

## Download

`download` 把本机文件交给远端（PDF、图片、ZIP、Excel、构建产物等）：

```json
{
  "name": "report.pdf",
  "mimeType": "application/pdf",
  "size": 183402,
  "url": "http://127.0.0.1:8787/files/file_xxx",
  "expiresAt": "2026-09-26T00:05:00.000Z"
}
```

- 结果同时带一个 `resource_link`，支持它的客户端可以直接识别该文件
- `GET /files/<token>` 只认随机 token：不接受任何 `path` 参数、只对应一个具体文件、**5 分钟过期**
- 取文件时会重新确认文件仍存在且仍是普通文件

## 终端观测日志

每次工具调用都会打印一行 `call` / `done` / `fail`（含 sessionId、涉及文件、耗时、结果摘要/错误），
另外打印 `session-create`、`download-mint`、`files-fetch` 等事件。日志写 stderr，不写文件；
长值截断到 400 字符，不打印文件正文与完整命令输出。

```text
2026-09-26T08:12:41.010Z call  #1  read       session="ses_ab12cd34ef56" path="src/index.ts" goal="了解入口" reason="确认结构"
2026-09-26T08:12:41.052Z done  #1  read       ok ms=42 files=["/workspace/project-a/src/index.ts"] result={"path":"/workspace/project-a/src/index.ts","returnedLines":120}
2026-09-26T08:13:05.900Z event download-mint  session="ses_ab12cd34ef56" token="file_…" file="/workspace/project-a/dist/report.pdf" size=183402 mime="application/pdf"
```

## 开发

```bash
pnpm test          # vitest（100 个用例：单元 + 进程内 MCP + 真实 HTTP 端到端）
pnpm typecheck     # tsc --noEmit
pnpm test:watch
```

目录：

```text
src/
├── index.ts        # 入口：env、HTTP 路由（/mcp、/files/:token）、优雅退出
├── server.ts       # createMcpHandler 工厂 + 7 工具装配
├── registry.ts     # ToolDef、统一错误包装、观测日志、history 落盘
├── session.ts      # Session 持久化 + base 解析 + GATEWAY_INSTRUCTIONS
├── skills.ts       # skill 扫描 / frontmatter / 去重 / 读正文
├── downloads.ts    # 下载 token + GET /files/:token
├── paths.ts        # 原子写文件
├── log.ts          # 终端观测日志
└── tools/          # 7 个工具
```

## V1 不做

LLM / Provider / Agent Loop / Prompt Engine / RAG / Vector DB / Browser / Git 工具 /
grep / find / ls / PTY / 后台进程 / skill 全量预加载 / stdio transport / 鉴权。
需要 `grep`、`find`、`ls`、`git`、`npm`、`python` 时统一走 `bash`。
