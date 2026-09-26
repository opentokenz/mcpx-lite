# 工具改名（bash → shell、download → export）+ 文件类工具 base 边界门禁

## Goal

在 API 稳定前修正两个 MCP Tool 的公开名称，使其准确表达能力而不是实现：

- `bash` → `shell`：工具本质是「在真实机器上执行 Shell 命令」，不应把 API 绑定到 `/bin/bash`。
- `download` → `export`：服务端做的是「把本机文件导出给调用方」，`download` 是 Client 侧动作。

同时把 base 边界门禁从 `edit` 扩展到**会修改真实状态 / 把文件交给外部的工具**（`write` / `edit` / `export`）：
目标真实路径在 `session.base` 内视为 safe 直接执行；在 base 外（含 symlink 逃逸）视为 dangerous，
返回 `input_required`，用户确认后才真正执行。

`read` 不参与边界判定：只读不产生副作用，base 外也能直接读。

## Context

上一增量（`2026-09-25-bash-risk-mrtr-approval.md`）为 `bash` 增加了风险分析与 MRTR 强制确认门禁，
并为 `edit` 增加了 base 边界确认；`write` 当时没有门禁，可以静默写 base 之外的任意路径。

本次改名是 **MCP Tool API 的 breaking change**，项目仍在早期版本，一次性完成优于长期维护双名称。

## Decisions

- `bash` → `shell`、`download` → `export`；**不提供 alias**，旧名称按未知工具失败（`-32602 Tool … not found`）。
- 参数结构、返回值、`annotations` 语义保持不变，迁移只做名称映射。
- Shell 风险分析去 Bash 化：`ShellRisk` / `ShellFinding` / `ShellRiskAnalysis` /
  `analyzeShellCommand` / `classifyShellCommand`；Policy 分析的是 Shell command。
- Transport 层命名**不改**：`src/downloads.ts`、`TokenStore`、`DownloadRecord`、`/files/:token`、
  `download token` 描述的是真实 HTTP 文件下载机制，不是 MCP Tool API。
- 文件改名：`src/tools/bash.ts` → `src/tools/shell.ts`、`src/tools/download.ts` → `src/tools/export.ts`、
  `test/bash.test.ts` → `test/shell.test.ts`；`src/downloads.ts` / `test/downloads.test.ts` 保持不动。
- `write` / `export` 与 `edit` 同一套 base 边界判定：base 内 = safe（无确认），base 外 = dangerous（确认）。
  即：**不在 base 目录下且会改动状态或把文件交出去的操作一律 dangerous**。
- `read` **不做**边界判定：只读、无副作用，base 内/base 外都直接读，不要求确认。
- `shell` 不做路径级判定：命令目标无法可靠静态解析，它由命令白名单（safe / dangerous / unknown）负责；
  `cd ..` 这类只读命令仍可视为 safe。
- 边界判定统一以 **realpath 后的真实目标**为准（拒绝字符串前缀判断），并抽成共享 helper
  （`enforceBaseBoundary` / `realpathDeep`）避免三个工具各写一份。
- `export` 会把真实文件字节交给调用方（数据外带），因此与 `write` / `edit` 同样按 base 划线；
  它属于写类效果（签发下载凭据）而不是纯读。
- 已有 Session history 里的 `bash` / `download` 记录不改写：history 是历史事实。
- 旧计划文档 `docs/plans/2026-09-25-bash-risk-mrtr-approval.md` 原文保留（记录当时的命名与事实）。

## Rationale

工具名是长期契约：`bash` 会在未来引入 zsh / sh runtime 时立刻过期，`download` 会让模型误以为
「从网络下载到本机」。改名的成本集中在代码与文档的一次性替换，收益是 API 语义与实现解耦。

`write` / `export` 增加边界门禁的理由与 `edit` 一致：base 内是 agent 自己的项目，逐次确认会破坏
coding 工作流；base 外是外部状态（系统配置、其他仓库、用户数据，以及把文件交给外部）。
三个工具共用同一判定语义后，"base 内自由操作、base 外必需确认" 成为一条可解释、可测试的规则。

`read` 不划线：它既不改变机器状态，也不把内容交给一个新的接收方（内容本来就回到调用它的 client），
逐次确认只会让"看日志、看其他仓库、看临时产物"这类日常动作变成噪音。

## Alternatives Considered

### 保留 `bash` / `download` 并加废弃 alias

Client 迁移零成本，但服务端要长期维护两套工具名、两套日志配色与两套文档，且 `tools/list` 会同时
暴露新旧名称，反而扩大契约面。早期版本一次性改名更干净。

### 运行时自动探测 / 配置 Shell

需要 session 级 runtime 配置（`session.shell = /bin/zsh`）与跨平台落地策略，超出本次范围；
本次只把 API 与实现解耦，保留 `spawn('/bin/bash', ['-c', …])` 作为 runtime 实现细节。

### `write` 也逐次确认

会给最常见的「新建文件」操作加弹窗，直接破坏 coding agent 工作流；按 base 划界与 `edit` 一致。

### 只对 `write` / `edit` 做边界判定

`export` 看上去是"读 + 交付"，但它把真实字节交给调用方（数据外带）并签发一个下载凭据（写类效果），
与 `read` 不同；不划线会让"导出 base 外任意文件"变成无需知情的默认能力。

## Scope

### In

- 两个工具的公开名称、工具描述、标题与内部符号改名。
- Shell 风险分析的类型 / 函数去 Bash 化，日志与确认文案统一用 shell / Shell command。
- **写类/外带工具的 base 边界门禁（write / edit / export 统一）**：base 内直接执行；
  base 外（`../` 穿越、绝对路径、父目录或目标 symlink 逃逸、真实路径无法解析）返回 `input_required`。
- `read` 保持不受 base 限制（本次确认不划线）。
- 测试与文档同步：`tools/list`、未知旧名称、shell/export 行为回归、logger 卡片、history 记录、
  四个文件类工具的边界行为。
- 本计划文档。

### Out

- Shell 风险策略、命令分析器行为、MRTR 机制、`requestState` 绑定规则的重新设计。
- Shell 命令里的路径级判定（`cd ..`、`rm /etc/x` 这类目标由白名单/确认机制负责，不做路径归属分析）。
- `/files/:token` 路由改名、TokenStore / downloads transport 重构。
- Shell Runtime 自动切换（`session.shell`）。
- 旧名称 alias、历史 history 迁移、旧计划文档改写。

## Design

### 改名映射

| 现在 | 之后 |
| --- | --- |
| tool `bash` | tool `shell` |
| tool `download` | tool `export` |
| `src/tools/bash.ts` | `src/tools/shell.ts` |
| `src/tools/download.ts` | `src/tools/export.ts` |
| `test/bash.test.ts` | `test/shell.test.ts` |
| `createBashTool` | `createShellTool` |
| `bashSchema` / `BASH_DESCRIPTION` | `shellSchema` / `SHELL_DESCRIPTION` |
| `createDownloadTool` / `downloadSchema` / `DOWNLOAD_DESCRIPTION` | `createExportTool` / `exportSchema` / `EXPORT_DESCRIPTION` |
| `BashRisk` / `BashFinding` / `BashRiskAnalysis` | `ShellRisk` / `ShellFinding` / `ShellRiskAnalysis` |
| `analyzeBash` / `classify` | `analyzeShellCommand` / `classifyShellCommand` |
| `TOOL_COLORS.bash` / `.download` | `TOOL_COLORS.shell` / `.export` |
| README / GATEWAY_INSTRUCTIONS / 工具描述里的「bash 工具」「download 工具」 | 「shell 工具」「export 工具」 |

保留 Bash / HTTP 原词的场景：`/bin/bash -c`、`bash -c` 风险样例、Bash 语法与拆分说明、
`/files/:token`、download token / download transport。

### write / edit / export 的 base 边界门禁

三个工具共用同一条规则：**真实路径不在 base 下 = dangerous**（`read` 不参与）。

判定以 realpath 后的目标为准（不是字符串前缀），共享实现放在 `approval.ts` / `paths.ts`：

| 工具 | 真实目标怎么算 | requestState 绑定的参数 |
| --- | --- | --- |
| `write` | 目标可能尚不存在 → `realpathDeep()`（最深存在祖先 + 剩余段） | path / content |
| `edit` | 文件必须存在 → `realpath()` | path / oldText / newText |
| `export` | 文件必须存在 → `realpath()` | path |

- `realpathDeep()` 返回 `null`（symlink 环、权限问题等）时 fail closed，同样要求确认。
- `export` 在确认前先做无副作用的存在性检查（`inspectExportable`），**不签发任何 token**；
  确认后才 `mint` 下载链接。
- 确认卡片只展示 `path` / `target` / `bytes` 等元信息，不打印正文；确认中的调用不写 history。
- `read` 直接执行：不受 base 限制，也不产生任何安全事件卡片。

## Acceptance Criteria

- `tools/list` 恰好返回 `session` / `skills` / `read` / `write` / `edit` / `shell` / `export`。
- 调用 `bash` / `download` 按未知工具失败（`-32602 Tool … not found`），不产生副作用。
- `shell` 的执行、风险分析、MRTR 确认行为与改名前的 `bash` 完全一致。
- `export` 的 resource_link 与 `/files/:token` 行为与改名前的 `download` 完全一致。
- 日志卡片分别显示 `SHELL` / `EXPORT`，并保持原有稳定配色与宽度规则。
- 新调用在 history 中记录 `tool: "shell"` / `tool: "export"`；旧记录不被改写。
- `write` / `edit` / `export` 在 base 内直接成功；在 base 外返回 `input_required`。
- `read` 在 base 内/base 外都直接返回内容，不返回 `input_required`。
- base 外的三种工具在确认前都不产生副作用：不写文件、不签发下载链接。
- 用户确认后 base 外操作成功；拒绝 / 取消 / 参数变化都不执行。
- 边界判定对 symlink 逃逸（父目录与目标本身）有效；真实路径无法解析时 fail closed。
- log 卡片里出现对应的 `write.outside-base` / `edit.outside-base` / `export.outside-base`。
- `pnpm typecheck` 与 `pnpm test` 全绿。

## Test Strategy

- 改名回归：`tools/list` 名称集合、旧名称 `-32602`、shell 行为（原 bash 用例迁移）、
  export 行为（原 download 用例）、logger 卡片 `SHELL` / `EXPORT`、history `tool` 字段。
- 边界门禁 RED 测试（先失败）：三个工具的 base 内无确认、base 外 `input_required` 且无副作用、
  确认后成功、拒绝 / 取消 / 参数变化不执行、symlink 逃逸、fail closed、history 与卡片字段。
- `read` 的反向测试：base 外直接读、不返回 `input_required`、不产生安全事件。
- `/files/:token` 行为无回归（原 downloads 测试保持）。
- 全量 `pnpm typecheck` + `pnpm test`。

## Implementation Plan

1. 落本计划文档。
2. 机械改名（先更新测试期望 → RED → 改生产代码 → GREEN）：文件重命名、符号重命名、
   `tools/list` 与文档术语。
3. 为写类/外带工具的 base 边界门禁写 RED 测试（write / export；edit 已有）。
4. 实现共享门禁：`paths.realpathDeep` + `approval.enforceBaseBoundary` +
   `downloads.inspectExportable`，接到 write / edit / export，GREEN。
5. 更新 README、GATEWAY_INSTRUCTIONS、工具描述与目录树。
6. 完整验证。

## Verification

- `pnpm typecheck`
- `pnpm test`
- `git diff --check`
- `git status --short`（确认只含本次范围内文件）

## 后续调整（同一增量内）

落地后按实际使用反馈追加三项，均已实现并测过：

### 1. `export` 增加 `delivery` 交付方式

- `delivery: "link"`（默认）：签发临时链接，行为不变。
- `delivery: "base64"`：把内容内联返回（`embedded resource` 的 `blob` + JSON 摘要 `name / mimeType / size / path / encoding / sha256`），
  用于调用方拿不到链接的场景（反代域名不可达、内网隔离、只能读响应体）。
- 上限 `1 MiB`（`MAX_INLINE_BYTES`），超限直接报错并提示改用 `link`；上限检查在 base 边界确认**之前**，
  不再让用户为一个无法交付的请求确认。
- 内联模式不签发 token（不会出现「已确认但拿不到内容」的中间态）；`delivery` 参与 requestState 参数摘要，
  确认后改交付方式必须重新确认。

### 2. 终端日志：调用起点与确认结果并为单行

- 一次调用只保留**一张结果卡片**；`call` / `approved` / `declined` 改为单行：
  `→ TOOL #id target`、`✓ TOOL #id risk`、`✗ TOOL #id reason`，不再重复 session / goal / reason 等字段。
- `APPROVAL REQUIRED` / `RISK UNKNOWN` 仍是完整卡片：那是用户做决定的时刻，需要看到完整上下文。
- 状态不再用 `RUNNING` / `APPROVAL ACCEPTED` / `APPROVAL DECLINED` 文字卡片表达，改由 `→ / ✓ / ✗` 单行 + 卡片状态文字承担。

### 3. `export` 链接 origin 支持反向代理

- `resolveRequestOrigin`：`Forwarded`（RFC 7239）→ `X-Forwarded-Proto` + `X-Forwarded-Host` →
  请求自身绝对 URL（仅非回环）→ 配置的 `host:port`；只接受 `http` / `https`，丢弃路径与非法值。
- 监听在通配地址且推断不出对外地址时输出 `export-origin-warning` 事件。
