# mcpx-lite

把本机文件、Shell 和其他 MCP 服务接入 AI 客户端的轻量 MCP Runtime。它不包含模型或 Agent Loop；工具直接操作运行服务的真实机器，没有沙箱或文件系统级回滚。

## 快速开始

要求 Node.js 24+ 和 pnpm。安装依赖并启动服务：

```bash
pnpm install
pnpm start
```

默认只监听本机回环地址，MCP Streamable HTTP 地址为：

```text
http://127.0.0.1:29090/mcp
```

在支持 Streamable HTTP 的 MCP 客户端中添加此地址。服务使用 MCP 协议版本 `2026-07-28`。启动 Session 后，其余工具调用需要携带返回的 `sessionId`。

后台运行与停止：

```bash
pnpm start -- --daemon
pnpm start -- --daemon --port 3000
pnpm start -- --stop
```

`--port` 也可写作 `-p`。Windows 10/11 需要系统自带的 Windows PowerShell 5.1；macOS 和 Linux 使用 Bash。

## 工具

| 工具 | 用途 |
| --- | --- |
| `session` | 创建、恢复和查看会话 |
| `skills` | 查找 Skill 并按需读取正文 |
| `mcp_tool` | 查看配置、连接并调用下游 MCP 服务 |
| `read` / `write` / `edit` | 读取和修改文件 |
| `trash` | 将文件或目录移入系统回收站 |
| `shell` | 在本机执行命令 |
| `fetch` | 将本机文件交付给客户端 |

## 安全与审批

审批默认开启：危险 Shell 命令、workspace 外的 `write` / `edit` / `fetch`、所有 `trash`、项目 MCP 配置首次连接及下游 MCP 服务首次调用都需要确认。`read` 不受 workspace 限制；Shell 也能访问 workspace 之外的路径，因此 workspace 不是沙箱。

可以用 `--no-approval` 或 `MCPX_LITE_APPROVALS=off` 关闭全部审批。此时危险操作会直接执行；关闭审批不会增加隔离或回滚能力。将服务监听到非本机地址时也没有鉴权，请只在可信网络中使用。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MCPX_LITE_HOST` | `127.0.0.1` | 监听地址 |
| `MCPX_LITE_PORT` | `29090` | 监听端口；CLI 的 `--port` 优先 |
| `MCPX_LITE_HOME` | `~/.mcpx-lite` | Session 与后台运行数据目录 |
| `MCPX_LITE_GLOBAL_SKILLS` | `~/.agents/skills` | 全局 Skill 目录 |
| `MCPX_LITE_LOG` | `debug` | 日志级别：`debug`、`info` 或 `off` |
| `MCPX_LITE_APPROVALS` | `on` | 设为 `off` 关闭审批 |

下游 MCP 服务可配置在 `~/.agents/mcp.json`，或项目 workspace 下的 `.mcp.json`。同名项目配置覆盖全局配置；项目配置首次连接前需要审批。示例：

```json
{
  "mcpServers": {
    "local": {
      "command": "npx",
      "args": ["-y", "@example/mcp"],
      "env": { "API_TOKEN": "${API_TOKEN}" }
    }
  }
}
```

配置支持 stdio 和 Streamable HTTP；只展开 `${NAME}` 环境变量，不执行 Shell 表达式。密钥不会显示在配置摘要或日志中。

## 文件交付

`fetch` 默认返回 5 分钟有效的下载链接，也可使用 `delivery: "base64"` 将文件内容放入响应；内联文件上限为 1 MiB。workspace 外文件在审批通过前不会被读取或签发链接。

## 构建与开发

构建平台可执行文件需要安装 Bun 和项目依赖：

```bash
pnpm build:macos
pnpm build:linux
pnpm build:windows
```

macOS/Linux 可用 `pnpm install:local` 将当前代码构建并安装到 `~/.local/bin/mcpx-lite`。Windows ARM64 可执行文件需在原生 ARM64 设备上验收。

```bash
pnpm test
pnpm typecheck
```
