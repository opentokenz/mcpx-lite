# Bash 风险分析与 MRTR 确认门禁

## Goal

在不降低日常 Coding Agent 效率的前提下，把高风险 Bash 操作从“提示模型先确认”的软约束升级为 MCP Server 强制执行的安全边界：明确安全的命令直接运行；任一危险或无法可靠判断的子命令触发 MCP 2026-07-28 `input_required`，只有用户确认原始调用后才允许执行。

## Context

当前 `bash` 直接执行 `/bin/bash -c`，风险说明只存在于 tool description / server instructions 中。模型即使违反说明，服务端也不会阻止执行。刚才本地 `git commit` 未等待再次确认就执行，说明需要服务端门禁。

项目已使用 `@modelcontextprotocol/server@2.1.0`，SDK 原生提供 `inputRequired`、`acceptedContent`、`createRequestStateCodec` 以及 `ServerOptions.requestState.verify`，无需自行实现 MRTR 或 HMAC。

## Decisions

- 对 `bash` 增加强制确认；同时对 `edit` 增加 base 边界确认：仅目标文件真实路径位于 `session.base` 内时直接允许，base 外必须 `input_required`。
- `read/write` 本次仍不增加新的确认策略。
- 终端日志升级为开发者观测 UI：突出工具调用、结果、耗时、安全确认和关键目标；HTTP/MCP 原始请求日志不再作为主要展示。
- Bash 风险分析采用“明确安全白名单 + fail closed”：所有可识别子命令必须都是 safe 才直接执行；任一 dangerous 或 unknown 都要求确认。
- 支持常见复合命令的顶层拆分（`&&`、`||`、`;`、pipeline），拆分过程尊重单/双引号和转义。
- 遇到无法安全静态解释的 Shell 构造（命令替换、反引号、重定向、子 Shell、动态变量/解释器包装等）直接判为 unknown，不尝试证明安全。
- 风险分析返回结构化 findings，用同一份结果驱动确认文案、日志与测试。
- MRTR 使用 SDK 原生 `inputRequired.elicit` + `acceptedContent`。
- `requestState` 使用 SDK 原生 `createRequestStateCodec` 完整性保护；payload 绑定 sessionId、bash 参数摘要和风险摘要。重试时原始参数变化则拒绝执行并重新确认。
- request-state key v1 使用进程生命周期内随机 32-byte key。服务重启会使未完成确认失效，用户重新发起即可；本次不新增持久化密钥管理。
- 用户拒绝/取消确认时不执行命令，并返回明确的非成功结果。

## Rationale

Mini Pi 的定位是极简真实机器 runtime。对所有文件编辑逐次确认会显著破坏 Coding Agent 工作流，而 unrestricted Bash 是能力最大的逃逸面，因此优先把强制门禁放在 Bash 上。

不用危险关键字黑名单，因为任意 Shell 可以通过组合、包装或动态解释绕过；采用“只有明确证明安全才自动执行”的策略，复杂语法自然进入确认流程。

v1 不引入第三方 Shell parser：目标不是完整模拟 Bash，而是可靠识别高频安全路径并对其余情况 fail closed。这样避免新增依赖和 parser 兼容性风险，同时保留后续替换为 AST parser 的接口空间。

## Alternatives Considered

### 所有 Bash 调用都确认

安全简单，但 `git status`、`pnpm test`、`rg` 等高频只读/验证命令都会打断工作流，体验过重。

### 危险关键字黑名单

实现简单，但容易被 `sh -c`、脚本、变量、命令替换等绕过，不能作为系统安全边界。

### 完整 Bash AST 第三方解析器

表达力更强，但需要新增依赖并承担 Bash 方言覆盖、维护与供应链成本。当前需求只需要“能明确判 safe，否则确认”，保守 parser 足够。

## Scope

### In

- Bash 命令风险分析与结构化 findings。
- 常见复合命令拆分和 safe/dangerous/unknown 聚合。
- Git、包管理、测试/类型检查、基础只读 Unix 命令的首批规则。
- `edit` 的 base 边界判定：`../` 相对路径、绝对路径和 symlink 解析后只要目标真实路径落在 base 外就要求确认。
- MCP `input_required` 确认流程。
- requestState 完整性保护与原始参数绑定。
- 单元测试、HTTP/MCP 回归测试和 README 行为说明。
- 终端观测 UI：ANSI 颜色、工具稳定配色、对齐布局、状态图标/标签、慢调用耗时强调，以及安全门禁事件展示。

### Out

- 对 base 内 `edit` 增加逐次确认；base 内仍保持无弹窗编辑。
- 对 `read/write` 增加新的确认策略。
- OS sandbox、容器、seccomp/macOS sandbox。
- 完整 Bash 语法/语义解释器。
- 持久化 approval 或跨服务重启继续确认。
- 用户自定义 policy 配置与 RBAC。
- 自动读取并分析任意 shell/node/python 脚本内容。
- 全屏 TUI、交互式 dashboard、日志持久化/查询系统；本次只优化流式终端观测输出。

## Design

### Risk model

```ts
type BashRisk = 'safe' | 'dangerous' | 'unknown'

interface BashFinding {
  command: string
  kind: string
  risk: BashRisk
  reason: string
}

interface BashRiskAnalysis {
  risk: BashRisk
  findings: BashFinding[]
}
```

聚合规则：

1. 任一 `dangerous` -> overall `dangerous`。
2. 否则任一 `unknown` -> overall `unknown`。
3. 全部 `safe` -> overall `safe`。

### Conservative command splitting

解析顶层命令连接符时跟踪 quote/escape 状态，只在未被引号包裹时拆分。

首版支持：
- `&&`
- `||`
- `;`
- `|`

以下结构直接使相关命令为 unknown：
- `$(...)` / backticks
- 输入/输出重定向
- 子 shell / grouping
- `eval`
- `bash -c` / `sh -c` / `zsh -c`
- `node -e` / `python -c` / 类似动态解释
- 无法稳定 tokenise 的语法

Pipeline 中每一段都必须 safe；例如 `git status | cat` 可 safe，而 `git status | tee x` 因写文件而要求确认。

### Initial command policy

明确 safe 的典型命令：
- `pwd`, `ls`, `cat`, `head`, `tail`, `rg`, `grep`, 受限只读 `find`
- `git status`, `git diff`, `git log`, `git show`
- `pnpm test`, `pnpm typecheck`, `pnpm lint`
- `vitest run`, `tsc --noEmit`

明确 dangerous：
- `git add/commit/push/reset/clean/rebase/merge` 以及会修改工作区/索引/历史的 checkout/restore 形式
- `rm`, `mv`, `cp`, `touch`, `mkdir`, `chmod`, `chown`
- 安装/删除/升级依赖
- `curl/wget` 等网络 + 任意外部副作用命令
- `sudo`, `kill`
- 其他明确写入或发布类动作

未列入且无法证明只读的命令为 unknown。

### Edit base boundary

`edit` 在执行前解析目标文件的真实路径：

1. `session.base` 使用创建 Session 时已经规范化后的真实路径。
2. 相对路径先按 `resolve(base, path)` 解析；绝对路径直接使用。
3. 因为 `edit` 只允许修改已存在普通文件，对目标执行 `realpath()`，以真实目标而不是字符串路径判断边界。
4. 使用 `path.relative(baseReal, targetReal)` 判断目标是否真正位于 base 内；不能使用 `startsWith(base)`。
5. 只要解析后的真实目标位于 base 外（包括 `../` 穿越、绝对路径指向外部、base 内 symlink 指向外部），返回 `input_required`，不读取并写回文件。
6. base 内普通文件保持现有无确认编辑流程。

base 外 `edit` 的 requestState 同样绑定 sessionId、tool=`edit` 以及完整 edit 参数摘要，确认不能被复用于另一个路径或另一组 oldText/newText。

### MRTR flow

首次危险调用：

1. analyze command。
2. safe -> 直接执行。
3. dangerous/unknown -> mint requestState，payload 包含：
   - version
   - sessionId
   - args hash（至少 command + timeout）
   - risk
   - expiry 由 SDK codec 管理
4. 返回 `inputRequired({ inputRequests: { confirm: inputRequired.elicit(...) }, requestState })`。
5. 不 spawn shell。

重试：

1. SDK `ServerOptions.requestState.verify` 先验证 MAC/TTL。
2. handler 读取 `ctx.mcpReq.requestState<T>()`。
3. 重新计算当前 args hash，并与已验证 payload 比较。
4. 用 schema-aware `acceptedContent` 读取 `confirm: boolean`。
5. 只有 `confirm === true` 且 state 与原参数一致才执行。
6. 参数不一致、缺少/无效 state 或确认被拒绝时不执行。

### Server wiring

在进程级 deps 中创建 request-state codec，确保每次 HTTP 请求新建的 `McpServer` 使用同一 codec key。构建 `McpServer` 时设置 `requestState.verify = codec.verify`；需要确认的 `bash` / `edit` 工具通过 deps 或闭包获得 codec 的 `mint`。

### Terminal observability UI

日志默认服务于“看懂 agent 正在做什么”，而不是复刻 HTTP access log。

展示层采用“每次工具调用一个卡片”的终端布局。一次交互的 call / approval / done / fail 信息以独立视觉块展示，而不是散成普通文本日志。每张卡片固定包含 `sessionId`、`goal`、`reason`，并根据工具补充 command/path/action/result/risk 等核心字段：

```text
┌─ BASH  #12  RUNNING ─────────────────────────────────────────────┐
│ session  ses_2e04168f07b1                                      │
│ goal     验证当前代码                                           │
│ reason   提交前确认类型与测试通过                                │
│ command  pnpm test && pnpm typecheck                            │
└──────────────────────────────────────────────────────────────────┘

┌─ BASH  #12  SUCCESS  6.8s ──────────────────────────────────────┐
│ session  ses_2e04168f07b1                                      │
│ goal     验证当前代码                                           │
│ reason   提交前确认类型与测试通过                                │
│ result   tests=101 passed                                      │
└──────────────────────────────────────────────────────────────────┘

┌─ BASH  #13  APPROVAL REQUIRED ──────────────────────────────────┐
│ session  ses_2e04168f07b1                                      │
│ goal     提交当前代码                                           │
│ reason   创建本地 Git 提交                                      │
│ command  git commit -m "..."                                   │
│ risk     git.commit · 会创建本地 Git 提交                       │
└──────────────────────────────────────────────────────────────────┘
```

设计规则：

- 每次工具调用渲染为独立卡片；卡片头展示工具名、调用编号、状态和耗时。
- `sessionId`、`goal`、`reason` 是卡片内默认可见的一等信息，不能只在 debug 展示。
- 工具相关 target/result/risk 放在固定 label 列，例如 `command`、`path`、`action`、`result`、`risk`。
- 状态使用 RUNNING / SUCCESS / FAILED / APPROVAL REQUIRED 等明确文字，可辅以 `→/✓/×/!`，不能只依赖颜色传达语义。
- 工具名使用稳定 ANSI 颜色；同一工具跨调用颜色一致。状态颜色独立：成功绿色、失败红色、确认/风险黄色或琥珀色、运行中弱化。
- duration 使用人类可读格式（如 `42ms`、`1.8s`），慢调用可增强强调但不改变含义。
- 卡片宽度根据 TTY columns 自适应，并设置合理最小/最大宽度；ANSI escape 不计入可见宽度，避免边框错位。
- 长字段按终端宽度截断或换行；仍保持现有敏感正文不打印、超长值截断原则。
- `mcp-request` 原始协议请求不渲染主卡片；仅 debug 模式以弱化单行诊断信息展示。info 级别聚焦工具卡片、安全确认事件、listening/shutdown。
- TTY 且未设置 `NO_COLOR` 时启用 ANSI。非 TTY、`NO_COLOR`、测试或自定义 sink 下仍保留无 ANSI 的纯文本卡片布局，便于重定向和 snapshot。
- 不引入第三方终端 UI 依赖，使用轻量 ANSI helper、可见宽度/换行 helper 和现有 logger 抽象实现。

安全相关状态作为卡片的一等状态，例如 `APPROVAL REQUIRED`、`APPROVAL ACCEPTED`、`APPROVAL DECLINED`、`RISK UNKNOWN`，并展示触发风险的命令或路径摘要，但不打印敏感文件正文或完整大型参数。

## Acceptance Criteria

- `git status` 可一次调用直接执行，不返回确认。
- `pnpm typecheck && pnpm test` 两个子命令都判 safe 时直接执行。
- `git status && git commit -m x` 不执行任何 shell，返回 `input_required`。
- 用户确认后，完全相同的危险调用执行一次。
- 用户拒绝/取消后不执行。
- 把已确认调用从 `git commit` 改成 `git commit && git push` 时，旧 requestState 不能授权新命令。
- `bash -c 'git commit ...'`、`node -e ...`、command substitution 等无法可靠分析的命令要求确认。
- 风险 finding 能指出触发确认的子命令及原因。
- `edit src/foo.ts` 等 base 内真实文件保持直接执行。
- `edit ../other/file.ts` 在解析后位于 base 外时不修改文件并返回 `input_required`。
- `edit /absolute/outside/file.ts` 位于 base 外时不修改文件并返回 `input_required`。
- base 内 symlink 指向 base 外文件时按真实路径判为 base 外并要求确认。
- 用户确认后，只允许完全相同的 base 外 edit 参数执行；修改 path / oldText / newText 后旧 requestState 不再授权。
- TTY 下每次工具调用以独立卡片展示，有稳定工具配色、状态颜色、边框与字段对齐；`sessionId`、`goal`、`reason` 默认展示。
- 非 TTY/`NO_COLOR` 下不输出 ANSI 转义序列，但仍保留可读的纯文本卡片结构。
- info 级别默认聚焦工具结果和安全事件，不被每个 MCP HTTP request 淹没。
- debug 级别仍可观察调用起点和底层请求信息，但层级视觉弱于工具事件。
- 日志继续避免输出文件正文；长字段保持截断。
- 现有所有测试继续通过。

## Test Strategy

- Risk analyzer 单元测试：safe 单命令、危险单命令、多个 safe 链、mixed chain、quotes、pipeline、复杂语法 fail closed。
- Git/package-manager 参数边界测试，避免把有副作用的变体误判 safe。
- Bash handler RED tests：危险命令首次调用不得触发 spawn/副作用，必须返回 `input_required`。
- MRTR tests：accept / decline / cancel / tampered or changed args / expired-invalid state。
- Edit boundary tests：base 内、`../` 越界、绝对路径越界、base 内 symlink 指向外部、确认后参数变化。
- Logger tests：TTY/非 TTY、`NO_COLOR`、卡片边框与可见宽度、各状态颜色、工具稳定配色、字段列对齐、终端宽度自适应、长字段截断/换行、`sessionId/goal/reason` 默认展示、info/debug 层级差异。
- HTTP e2e：按 2026-07-28 envelope 完成首次请求和 retry，验证 Bash 与 base 外 edit 的真实副作用都只发生在确认后，并验证 approval 事件进入观测日志。
- 全量 `pnpm typecheck && pnpm test`。

## Implementation Plan

1. 先为 Bash risk analyzer 写失败测试，再实现保守拆分、tokenise 和首批命令 policy。
2. 为危险 Bash 首轮请求写失败测试，再接入 SDK `inputRequired` / `acceptedContent`，确保未确认时完全不 spawn。
3. 接入进程级 `createRequestStateCodec` 和 `ServerOptions.requestState.verify`，用失败测试固化 Bash 参数绑定、篡改/过期/拒绝行为。
4. 为 `edit` 增加真实路径 base 边界判定与 base 外 MRTR 门禁，先覆盖 `../`、绝对路径和 symlink 逃逸的失败测试。
5. 重构 logger 展示层，将每次工具调用渲染为独立终端卡片，加入 TTY 感知 ANSI 颜色、稳定工具配色、状态/耗时头部、`sessionId/goal/reason` 固定字段、宽度自适应和安全状态；同时把原始 `mcp-request` 降级为 debug 细节。
6. 增加 HTTP 端到端 MRTR 测试，覆盖 Bash safe fast path、危险命令、base 外 edit 两轮流程以及 approval 日志事件。
7. 更新 README 中 Bash、edit 安全语义和终端观测输出说明，最后执行完整验证。

## Verification

- `pnpm typecheck`
- `pnpm test`
- 检查 `git diff --check`
- 检查 `git status --short`，确认只包含本次计划范围内文件
