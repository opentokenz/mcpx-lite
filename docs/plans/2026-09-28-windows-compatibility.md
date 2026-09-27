# Windows 全面兼容计划

## Goal

在不改变 macOS/Linux 现有行为的前提下，让 mini-pi-mcp 可在 Windows 10/11 的 x64 与 ARM64 环境中以 Node.js 源码和独立 `.exe` 运行，并覆盖 shell、风险审批、文件路径、回收站与 MCP 子进程。

## Context

- 项目要求 Node.js `>=22`，使用 TypeScript、Vitest；目前提供 `tsx src/index.ts` 启动，没有二进制构建入口或 Windows CI。
- `src/tools/shell.ts` 当前固定启动 `/bin/bash`，并通过 POSIX 进程组信号处理超时；该路径在 Windows 不可用。
- `src/risk.ts` 的命令识别面向 Bash；Windows PowerShell 语法需要单独解析，不能把 Bash tokenization 当作 PowerShell 安全边界。
- 路径、home 目录与 MCP 配置主要使用 Node.js 的 `path`、`os` API；`trash@10.1.1` 声明支持 Windows，但其回收站能力依赖交互式用户配置文件。
- `src/index.ts` 的直接运行判断依赖 `import.meta.url`，编译成单文件程序时需要专用启动入口。
- Node.js 22 发布 Windows ARM64 构建；Windows PowerShell 5.1 随 Windows 10/11 提供，但 ARM64 上的实际可用性与 Parser 行为仍需在原生设备验证，不能只依据 x64 结果推断。
- 官方资料：
  - [Node.js 子进程：Windows `.bat` / `.cmd` 文件](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
  - [Node.js `process.kill()`](https://nodejs.org/api/process.html#processkillpid-signal)
  - [Node.js 22 Windows ARM64 发布包](https://nodejs.org/en/download/archive/v22.22.0)
  - [Windows PowerShell 5.1 可用性](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1?view=powershell-5.1)
  - [Microsoft `taskkill`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
  - [Windows PowerShell 5.1 命令行参数](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)
  - [PowerShell `Parser.ParseInput`](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.parser.parseinput?view=powershellsdk-7.4.0)
  - [Bun 可执行文件编译](https://bun.sh/docs/bundler/executables)
  - [`trash` Windows 支持与限制](https://github.com/sindresorhus/trash/blob/main/readme.md)

## Decisions

- Windows 使用系统自带的 Windows PowerShell 5.1（`powershell.exe`）；macOS/Linux 继续使用 Bash。两者共享现有 shell 工具入口与返回结构，不新增用户 shell 配置项。
- PowerShell 以 `-NoProfile -NonInteractive -EncodedCommand` 启动；命令以 UTF-16LE Base64 编码传入，输出使用 UTF-8，并按平台约定返回原生命令退出码或 PowerShell 成功/失败状态。
- 保留 POSIX 进程组超时终止；Windows 超时通过 `taskkill /PID <pid> /T /F` 终止 shell 及其子进程树。
- Bash 风险分析器仅用于 POSIX；Windows 使用 Windows PowerShell 内置的 `System.Management.Automation.Language.Parser.ParseInput` 解析 AST，不执行待分析命令。危险 cmdlet、常见别名与危险参数触发原有审批；未知命令沿用当前直通策略；解析器启动失败或解析报错时 fail closed，不执行命令。
- 文件与用户数据留在外部磁盘，继续使用 Node.js 平台路径/home API；保留 `trash` 依赖并验证实际回收站行为。
- 使用专用二进制入口与 Bun 编译 Windows x64、ARM64 `.exe`；不将用户配置、skills、session 数据打包进可执行文件。
- Windows MCP stdio 支持 `.exe` 与 `.cmd` 命令，并验证独立参数、含空格路径与参数转发；HTTP MCP 行为保持不变。

## Rationale

- 使用原生 PowerShell 避免要求 Windows 用户额外安装 Git Bash，并让系统命令与 Windows 路径自然工作；保留 Bash 可避免改变已有 POSIX 工作流。
- PowerShell AST 能识别命令调用、别名与参数结构，比按字符串拆词更适合作为审批前置检查。预检只做静态解析；实际命令仍仅在审批策略允许后执行。
- Windows 不支持 POSIX 负 PID 进程组信号语义；官方提供的 `taskkill /T` 用于终止目标进程及其子进程。
- Bun 的编译器支持 Windows x64 与 ARM64 目标，并能将 TypeScript 入口及运行时打包成可执行文件；专用入口避免依赖源码执行时的模块 URL 判断。
- `.cmd` 不是 Windows 原生可执行映像，Node.js 文档要求经由命令解释器启动；因此必须单独验证启动适配和参数转发，不能把 `.cmd` 当作 `.exe` 直接 spawn。

## Alternatives Considered

- **要求 Windows 安装 Git Bash：** 不选。会增加环境前置条件，且不能提供原生 PowerShell 体验。
- **允许用户为每个平台配置任意 shell：** 不选。增加配置状态与排错面；本次按操作系统选择默认 shell 已满足目标。
- **Node.js Single Executable Applications：** 不选。已确认的方案采用 Bun 编译 Windows x64/ARM64，避免为此再引入另一套打包流程。

## Scope

### In

- Windows 10/11、x64 与 ARM64 的 Node.js 源码运行和独立 `.exe`；PowerShell 5.1 与 AST Parser 必须在目标 ARM64 系统通过原生 smoke test。
- 跨平台 shell 启动、编码、输出、退出状态和超时进程树清理。
- PowerShell AST 风险预检，以及危险命令审批、未知命令直通、解析失败拒绝执行。
- Windows drive/UNC 路径、workspace 边界、文件读写与含空格路径测试。
- Windows 回收站验证；MCP stdio `.exe` / `.cmd` 与 HTTP transport 验证。
- Windows x64 自动化测试与 ARM64 构建、原生运行验收记录。

### Out

- 更换 `trash` 依赖或实现自有回收站后端；服务账户等没有可用用户回收站的环境不承诺回收站能力。
- 改变 macOS/Linux 的默认 shell、Bash 风险规则或进程终止语义。
- 将配置、skills、session 持久化到 exe 内，或新增配置迁移。
- 为 Windows 引入第三方 PowerShell 运行时；目标使用系统自带 Windows PowerShell 5.1。

## Design

### Shell 运行时

- 保持现有 shell 工具的调用契约、workspace cwd、继承环境、stdout/stderr 采集、超时和工具错误格式。
- 按 `process.platform` 选择启动方式：POSIX 仍为 Bash；Windows 启动 `powershell.exe`，禁用 profile 与交互输入，并以编码命令传递用户脚本，避免命令文本经过额外的 `cmd.exe` 拼接。
- 在启动脚本中统一 UTF-8 管道输出；Windows 原生命令退出码取自 `$LASTEXITCODE`，PowerShell 语句失败映射为非零。对空输出、Unicode、错误输出和连续命令建立测试。
- POSIX 保留 detached 进程组终止；Windows 超时对 shell PID 调用 `taskkill /T /F`，并验证孙进程也退出。若进程已结束或 `taskkill` 失败，按现有错误清理路径收尾，不挂住工具调用。

### 风险审批

- 新增 Windows PowerShell AST 分析路径，保持现有审批结果类型和调用顺序。固定 Parser bootstrap 从标准输入读取待分析脚本，并将其作为数据传给 `Parser.ParseInput`；不得把用户脚本插入 bootstrap 字符串。AST 检查只收集静态命令名、别名及参数；禁止在预检阶段调用 `Invoke-Expression`、执行脚本块或导入用户模块。
- 危险规则复用现有风险类别与审批行为；为 PowerShell cmdlet、常见别名及危险参数建立明确映射。未知命令不新增拦截。
- PowerShell 不存在、启动失败、输出无法解析或 Parser 返回语法错误时，返回审批前置错误并拒绝执行；不回退到字符串扫描后放行。
- 继续保留 POSIX Bash 分析和原有测试，确保本次不会把 PowerShell 语法规则应用到 Bash。

### 路径、文件与回收站

- 优先沿用 `node:path` 与 `node:os`，不手写第二套通用路径库。
- 在 Windows 上验证盘符、UNC、路径大小写、分隔符、含空格路径和跨盘符边界；workspace 校验不得把 workspace 前缀相同的兄弟目录误判为内部路径。
- 对文件读、写、编辑与删除工具覆盖 workspace 内外边界、无效路径和失败反馈；测试只操作临时目录。
- 保留 `trash` 调用封装。以普通登录用户在 Windows 10/11 验证临时文件进入回收站并可恢复；记录服务账户无回收站时的限制，不把永久删除当作静默 fallback。

### MCP 与二进制

- 保留 MCP 配置中的 `command`、`args`、`env` 字段契约。Windows `.exe` 直接启动；`.cmd` 走显式 Windows 启动适配，并使用带空格、引号和 shell 元字符的参数用例验证无错位或额外命令执行。
- 保留 HTTP transport 路径，并在 Windows 上验证连接、关闭和错误处理。
- 增加复用同一 server startup 的专用二进制入口；源码 `start` 入口不变。增加 Bun 构建脚本，分别产出 Windows x64 与 ARM64 exe；构建产物位于忽略目录，不提交生成文件。
- 用户级配置、项目级 `.mcp.json`、skills 与 session 文件仍从磁盘读取，路径继续遵循 Windows 的用户 home 与 workspace。
- 自动化环境至少包含 Windows x64；ARM64 目标需交叉构建并在原生 Windows ARM64 设备或 runner 上执行 smoke tests，不以 x64 上“成功构建”替代 ARM64 运行验收。

## Acceptance Criteria

- Windows 10/11 x64 与 ARM64 均可用 Node.js `>=22` 启动源码版本；两个架构的 exe 均可原生启动并连接 MCP 客户端。
- macOS/Linux 仍启动 Bash，现有 shell、风险审批及超时行为无回归。
- PowerShell happy path 正确处理 workspace cwd、环境变量、UTF-8 Unicode stdout/stderr、退出码、超时；超时后 shell 与其后代进程全部退出。
- 危险 PowerShell cmdlet、常见别名和危险参数触发审批；未知命令仍按既有策略直通；语法错误或 AST 分析失败时用户命令从未执行。
- Windows drive 与 UNC 路径下的 workspace 边界正确；文件读写编辑及错误路径行为通过测试，路径含空格时不截断。
- Windows `.exe` 与 `.cmd` MCP stdio server 的命令、独立参数、含空格路径均正确转发；HTTP MCP smoke test 通过。
- 使用普通交互式用户验证 `trash` 将测试文件放入回收站并可恢复；服务账户限制有清晰说明且不触发永久删除 fallback。
- Windows x64 CI 运行类型检查及完整测试；x64/ARM64 exe 构建成功；Windows ARM64 原生运行验收覆盖启动、shell、MCP stdio 与文件基本操作。

## Test Strategy

- **RED → GREEN：** 在 Windows 可执行的 Vitest 用例中先固化平台行为，再实现最小改动；保持现有 POSIX 测试并在 macOS/Linux 与 Windows 分别运行。
- **Shell：** 测正常命令、PowerShell 内建命令与原生命令退出码、Unicode/空输出/stderr、含空格 cwd、无效命令、超时及生成子进程；断言超时后进程树无残留。
- **审批：** 测 Bash 旧用例不变；PowerShell 危险 cmdlet、alias、参数组合、普通未知命令、复杂语法、Parser 错误与 Parser 启动失败；对解析失败场景断言 marker 文件未创建，以证明命令未执行。
- **文件与路径：** 在 Windows 临时 workspace 中测盘符、UNC 格式路径、大小写、兄弟目录前缀、跨卷路径、空格、读写编辑以及拒绝越界；POSIX 路径用例继续运行。
- **Trash：** 在普通 Windows 用户会话中对临时文件做可恢复的回收站集成验证；其他平台沿用现有测试。
- **MCP：** 启动临时 `.exe` / `.cmd` 测试 server，校验 argv 原样收到并完成握手；覆盖路径与参数含空格、引号和元字符；HTTP transport 做连接/关闭测试。
- **打包：** 分别构建 x64 与 ARM64；在各自 Windows 架构运行 exe smoke tests，确保外部用户数据不依赖当前工作目录或解包目录。

## Implementation Plan

1. **固定平台行为契约：** 先在 Windows 10/11 x64 与 ARM64 原生环境验证 `powershell.exe` 和 `Parser.ParseInput`；为 shell 启动、编码、退出状态、超时及进程树清理补充跨平台测试夹具，并记录 Bash 回归基线。若目标 ARM64 系统无法使用 Windows PowerShell 5.1 Parser，暂停实现并更新设计，不得绕过 fail-closed 审批门禁，也不得宣称 ARM64 兼容已验收。
2. **实现 Windows shell 与超时清理：** 通过失败测试驱动 PowerShell 启动、UTF-8 输出/退出码映射和 Windows 子进程树终止，保留 POSIX 实现。
3. **实现 PowerShell AST 风险预检：** 先为危险 cmdlet/别名/参数、未知命令和 fail-closed 情况添加测试，再接入静态 Parser；维持原审批接口。
4. **验证 Windows 路径与文件工具：** 增加 drive/UNC/workspace 边界和临时文件读写编辑测试；执行真实用户回收站集成验收。
5. **验证 MCP Windows 启动：** 固化 `.exe` 与 `.cmd` 独立参数转发测试，按测试结果加入最小 `.cmd` 启动适配；保持 HTTP transport 不变。
6. **交付 Windows 二进制与矩阵验证：** 增加共享启动逻辑的专用入口、Bun x64/ARM64 构建脚本和 Windows x64 自动化工作流；在 ARM64 原生环境执行 exe smoke tests，更新 Windows 使用说明与已知限制。

## Verification

- 在 POSIX 与 Windows 环境运行 `npm test` 和 `npm run typecheck`；Windows x64 上执行完整 Vitest suite。
- 使用 Windows 10/11 x64 与 ARM64 分别验证 Node 源码启动及对应 exe 启动、PowerShell 5.1 AST Parser、shell 输出/退出码/超时进程树、审批拦截、文件读写、MCP stdio 与 HTTP。
- 以普通登录用户完成一次 `trash` 回收与恢复；确认服务账户限制不会导致永久删除。
- 构建 Windows x64、ARM64 产物，检查构建脚本退出状态与产物架构；复查 tracked/untracked diff，确保没有生成物、用户数据或密钥进入变更。
