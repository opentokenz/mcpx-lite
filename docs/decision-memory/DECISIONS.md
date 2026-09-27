# 项目决策记录

<!-- next-adr-id: 002 -->

## 当前有效约束

- [ADR-001/accepted] Windows 10/11 的 x64 与 ARM64 使用原生 PowerShell 运行时；POSIX 继续使用 Bash。

## 决策记录 (Active ADRs)

### ADR-001 Windows 跨平台运行时

- id: ADR-001
- status: accepted
- decided_at: 2026-09-28
- type: architecture
- scope: Windows 10/11 x64 与 ARM64 的 shell、审批预检、文件/MCP 运行和 exe 分发
- search-terms: Windows compatibility, PowerShell AST, Windows exe

### 决策

Windows 使用系统自带 Windows PowerShell 5.1，macOS/Linux 保留 Bash；Windows 可执行文件用 Bun 编译为 x64 与 ARM64 `.exe`。

### 约束

- PowerShell 风险预检只用 AST 静态解析；解析失败或解析器不可用时拒绝执行，不回退放行。
- Windows 超时终止 shell 进程树；配置、skills 与 session 数据保留在外部磁盘。
- x64/ARM64 的 exe 和 Windows PowerShell AST 行为都需要各自原生环境验收。

### 理由

原生 PowerShell 不要求用户安装 Git Bash；POSIX 默认行为保持不变。确认的方案与验收条件见 [Windows 全面兼容计划](../plans/2026-09-28-windows-compatibility.md)。
