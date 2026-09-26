# Trash 工具与批量 Edit

## Goal

为 mini-pi 增加一个可恢复的跨平台文件移除工具 `trash`，用于替代 agent 常见的 `rm` 场景；同时把现有单文件单替换的 `edit` 重构为支持多文件、多 replacement 的批量事务式编辑。

最终目标：

- 文件/目录删除默认进入系统回收站，而不是永久删除。
- 所有 trash 操作都必须人工确认。
- 批量 edit 在预检阶段保证零写入，并在提交失败时尽力回滚，避免仓库处于半编辑状态。
- 顶层 MCP 工具从 8 个扩展为 9 个。

## Context

当前 `edit` 只接受：

- `path`
- `oldText`
- `newText`

并要求 `oldText` 在单个文件中恰好出现一次，然后通过 `writeFileAtomic()` 写回。

当前删除文件/目录只能经由 `shell`，而 `rm` / `rmdir` 在风险分析中被明确标记为 dangerous。用户希望新增结构化、可恢复的文件移除能力，避免依赖 shell 永久删除。

现有审批体系具有以下重要语义：

- approval token 绑定 session / tool / 业务参数。
- `goal` / `reason` 仅用于审计，不参与授权比对。
- 用户确认前不得产生受保护副作用。
- base 外写操作使用 approval_required 门禁。

## Decisions

### Trash

- 新增顶层 `trash` 工具，顶层固定工具数从 8 变为 9。
- 支持 macOS、Linux、Windows。
- 采用 `TrashBackend` 抽象；首版 backend 使用跨平台 `trash` npm 依赖。
- mini-pi 自己负责严格预检、审批、审计和逐项结果；第三方依赖只负责真正把单个目标送入 OS Trash / Recycle Bin。
- 所有 trash 调用无条件要求 approval，无论目标是否位于 `session.base` 内。
- `paths[]` 支持文件与目录，至少 1 项，并设置合理上限。
- 不支持 glob；底层调用固定关闭 glob。
- 预检阶段使用 `lstat`，symlink / junction 只移动链接对象自身，不跟随真实目标。
- 重复路径或祖先/后代重叠路径直接导致整批预检失败。
- 任意预检失败保证 0 个目标被移动。
- 预检全部通过后，一次 approval 绑定完整规范化路径列表及其顺序。
- 用户批准后逐项执行；某一项系统回收站失败不尝试伪事务回滚，继续执行剩余项并返回逐项结果。
- 永远不 fallback 到 `unlink` / `rm` / `rmdir` 等永久删除。

### Batch Edit

- 废弃旧的顶层 `path / oldText / newText` schema，不提供兼容层。
- 新 schema 统一为 `edits[]`：
  - 每项包含 `path`
  - 每个 path 包含 `replacements[]`
  - 每个 replacement 包含 `oldText / newText`
- 同一文件内 replacements 按数组顺序应用；后一个 replacement 基于前一个 replacement 生成的中间内容继续匹配。
- 每一步 `oldText` 都必须在当时内容中恰好出现一次。
- 整个 `edits[]` 是一个事务单元：所有文件和 replacement 全部预检成功前，磁盘 0 写入。
- 同一个真实文件如果通过不同 path（包括 symlink + real path）在 batch 中重复出现，整批拒绝。
- 任意真实目标位于 `session.base` 外时，整批只产生一次 approval_required；token 绑定完整 `edits[]`。
- 用户确认后重新 prepare，避免审批等待期间文件状态已经变化。
- prepare 记录原始内容 hash；commit 前进行乐观并发检查，检测到修改则整批 abort。
- commit 逐文件使用现有原子写 helper；如中途失败，对已写成功文件按逆序恢复原始内容。
- rollback 本身失败时必须显式返回不确定路径，不能声称事务已完整恢复。

## Rationale

### 为什么使用 TrashBackend + 第三方 trash 依赖

直接把第三方 `trash(paths)` 暴露为 MCP 工具会把其 glob、缺失路径处理和批量错误语义泄漏进我们的 API，不符合已确定的安全模型。

完全自建 macOS / Linux / Windows 三套系统回收站实现成本过高，且容易在外部卷、恢复元信息、Windows Recycle Bin、Linux XDG Trash metadata 等细节上产生不可靠行为。

因此由 mini-pi 掌控契约和安全边界，只把单项 OS Trash 动作委托给 backend。未来如某个平台实现需要替换，可以不改变 MCP API。

### 为什么所有 trash 都审批

即使目标位于项目 base 内，把文件或目录移出原位置仍然是明显的破坏性副作用。用户明确要求所有移除都确认，因此 `trash` 不复用 edit/write 的“base 内直接执行”策略。

### 为什么 batch edit 要应用层事务

coding agent 常见的批量修改如果做到一半失败，会让后续推理基于不完整状态。批量 edit 因而优先保证：

- prepare 阶段零写入
- commit 失败后尽力恢复
- rollback 失败时明确暴露不确定状态

这不是文件系统级 ACID；设计只承诺应用层尽最大努力恢复。

## Alternatives Considered

### Trash：直接使用 `trash` 包暴露批量调用

优点是代码最少；缺点是第三方库的 glob、缺失路径和错误行为不符合严格预检与逐项结果契约，因此不采用。

### Trash：自行实现三平台系统回收站

控制力最高，但平台细节复杂，维护成本和错误风险都显著高于当前需求，因此不采用。

### Edit：保留旧 schema 并增加 `edits[]`

兼容性最好，但模型会同时面对两种等价调用方式，增加工具契约复杂度。用户明确选择 breaking change，统一为 `edits[]`。

### Edit：新增独立 `batch_edit` 工具

职责看似清晰，但会与 `edit` 高度重复并继续膨胀顶层工具面，因此不采用。

### Trash：跨平台事务式回滚

OS Trash / Recycle Bin 没有可靠统一的跨平台“恢复原位置”事务接口。伪造全局原子性风险高，因此执行阶段采用逐项 best-effort 并如实返回结果。

## Scope

### In

- 新增 `trash` MCP 工具。
- 新增 `TrashBackend` 抽象和跨平台系统回收站 backend。
- 引入并锁定合适版本的跨平台 `trash` npm 依赖。
- trash 批量预检、无条件审批、逐项执行与结果汇总。
- trash symlink/junction 自身语义。
- trash 重复/父子重叠路径检测。
- edit schema breaking change 为 `edits[]`。
- edit 多文件、多 replacement 顺序应用。
- edit 全量 prepare、base 外整批审批、并发修改检测、commit + rollback。
- 更新顶层工具装配、annotations、描述、README 与测试基线。

### Out

- 永久删除 API。
- trash restore / undo API。
- trash glob。
- 目录内容逐项展开。
- shell `rm` 风险规则的放宽或删除。
- legacy SSE、MCP gateway 其他能力变更。
- 旧 edit schema 兼容层。
- 文件系统级 ACID 保证。

## Design

### Trash API

建议 MCP 输入：

```ts
{
  sessionId: string,
  paths: string[],
  approvalToken?: string,
  approvalDecision?: 'approve' | 'cancel',
  goal?: string,
  reason?: string
}
```

`paths` 设置合理的最大项数，避免单次请求无限扩大影响面。

路径流程：

1. 相对路径基于 `session.base` 解析，绝对路径直接使用。
2. 使用 `lstat` 验证存在性和对象类型，不通过 `realpath` 跟随链接。
3. 规范化路径字符串。
4. 检测重复路径。
5. 检测祖先/后代重叠。
6. 任意失败则整批 preflight failed，且 backend 调用次数必须为 0。
7. 预检通过仍然无条件走 approval。
8. 批准后按输入顺序逐项调用 backend。

approval token 至少绑定：

- sessionId
- tool = trash
- 规范化后的完整 paths[]
- paths 顺序

`goal/reason` 不参与授权比对。

结果返回逐项状态：

```json
{
  "results": [
    { "path": "/repo/a.txt", "ok": true },
    { "path": "/repo/b.txt", "ok": false, "error": "permission denied" }
  ],
  "succeeded": 1,
  "failed": 1
}
```

预检失败属于整批错误；执行阶段部分失败属于已执行批次的结构化结果。

### TrashBackend

接口保持最小：

```ts
interface TrashBackend {
  trash(path: string): Promise<void>;
}
```

生产 backend 对第三方库按单项调用，并显式关闭 glob。

不提供永久删除 fallback。

### Edit API

新 schema：

```ts
{
  sessionId: string,
  edits: Array<{
    path: string,
    replacements: Array<{
      oldText: string,
      newText: string
    }>
  }>,
  approvalToken?: string,
  approvalDecision?: 'approve' | 'cancel',
  goal?: string,
  reason?: string
}
```

旧 `path / oldText / newText` schema 直接失效。

### Edit Prepare

prepare 对整个 batch 进行纯计算与验证：

1. resolve path。
2. stat 并要求普通文件。
3. realpath，沿用现有 edit 的“修改真实文件”语义。
4. 检测相同真实文件重复出现。
5. 读取原始内容。
6. 按顺序模拟每个 replacement。
7. 每一步要求 `oldText` 恰好出现一次。
8. 生成最终内容。
9. 记录原始内容及 hash。
10. 标记是否存在 base 外目标。

任何一步失败，磁盘 0 写入。

### Edit Approval

只要至少一个真实目标位于 base 外：

- 整批返回一个 approval_required。
- 确认前 0 写入。
- token 绑定完整 `edits[]`，包括 path、replacement 顺序、oldText、newText。
- 修改任一业务参数都使旧 token 无效。
- `goal/reason` 可变化或省略。

确认重试后重新 prepare。

### Edit Commit / Rollback

提交前重新读取目标并比较 prepare 记录的原始 hash；任意变化则返回 `concurrent_modification`，0 写入。

commit：

- 使用现有 `writeFileAtomic()` 逐文件写最终内容。
- 记录成功写入的文件。

若第 N 个文件写失败：

- 对前 N-1 个已经写成功的文件按逆序恢复原始内容。
- rollback 全成功：调用失败，并标明 `rollbackSucceeded: true`。
- rollback 有失败：调用失败，`rollbackSucceeded: false`，并返回 `uncertainPaths[]`。

### Error Model

Trash preflight 至少覆盖：

- not_found
- duplicate_path
- overlapping_paths
- invalid_path / unsupported target（若平台 backend 有明确限制）

Edit validation 至少覆盖：

- not_found
- not_regular_file
- duplicate_target
- old_text_not_found
- multiple_matches
- concurrent_modification
- commit_failed
- rollback_failed

错误应带 editIndex / replacementIndex / path 等定位信息，但不输出第三方库内部堆栈。

### History

approval_required 阶段不写 history。

真正执行后：

- trash 整批只记一条顶层 history，摘要包含目标数量、成功数、失败数和必要的路径/错误摘要。
- edit 整批只记一条顶层 history，摘要包含文件数、replacement 数和路径。
- 不把完整 oldText/newText 重复写入 history，避免历史膨胀。

## Acceptance Criteria

1. 顶层固定工具数从 8 变为 9，并新增 `trash`。
2. `trash` 支持文件、目录和多路径输入。
3. `trash` 在 macOS / Linux / Windows 使用系统回收站语义。
4. `trash` 永远不降级为永久删除。
5. `trash` 任意调用都必须先获得用户 approval。
6. `trash` 确认前 backend 调用次数为 0。
7. 不存在、重复、父子重叠等 preflight 问题导致整批 0 移动。
8. symlink / junction 只处理链接对象自身。
9. `trash` 不展开 glob。
10. 用户确认后，系统回收站阶段某一项失败不阻塞剩余目标，并返回逐项结果。
11. `edit` 只接受 `edits[]` 新 schema，旧 schema 被拒绝。
12. `edit` 支持单文件多 replacement 和多文件。
13. 同一文件内 replacement 严格按数组顺序应用。
14. 任意 prepare 错误时所有文件保持原样。
15. 同一真实文件重复出现时整批拒绝。
16. 任一目标越出 base 时只触发一次整批 approval。
17. edit approval token 绑定完整 `edits[]`，但不绑定 goal/reason。
18. 审批等待期间文件变化会触发 concurrent_modification 且 0 写入。
19. commit 中途失败时自动回滚已写文件。
20. rollback 不完整时返回明确的 uncertainPaths。
21. README、tool description、package metadata、顶层工具数量与测试说明同步。

## Test Strategy

### Trash

单元测试使用 fake `TrashBackend`，覆盖：

- 单文件、单目录、多路径。
- base 内与 base 外均无条件 approval。
- approval 前 0 backend calls。
- token 对 paths / 顺序 / 数量敏感。
- goal/reason 在二次确认时可变化或省略。
- symlink 不跟随真实目标。
- missing path 导致整批 preflight fail。
- duplicate path 拒绝。
- ancestor/descendant overlap 拒绝。
- glob 字符按普通路径处理。
- 单项 backend 失败后继续后续项，并正确汇总 succeeded/failed。
- history 只记录一次实际批次。

backend 集成测试使用临时文件做 smoke test：

- macOS：原路径在 trash 后消失。
- Linux：按 CI 可用环境验证系统 Trash 行为。
- Windows：按 CI 可用环境验证 Recycle Bin 行为。

无法实际运行的平台不能只凭 mock 宣称完成真实平台验证；交付说明需列明实际跑过的平台。

### Edit

按 TDD 覆盖：

- 单文件单 replacement。
- 单文件多个顺序 replacement。
- 后一个 replacement 匹配前一个 replacement 生成的内容。
- 多文件 happy path。
- oldText 0 次匹配 → 0 写入。
- oldText 多次匹配 → 0 写入。
- 后续文件失败 → 前面文件也保持原样。
- symlink + real path 指向同一真实文件 → duplicate_target。
- 任一 base 外目标 → 整批 approval，一次确认后执行。
- token 对任意 edit / replacement 业务参数变化敏感。
- goal/reason 不参与 token 比对。
- 审批确认前 0 写入。
- 并发修改检测 → 0 写入。
- 注入第 N 个 write failure → 前 N-1 个回滚。
- rollback 全成功路径。
- rollback 注入失败 → uncertainPaths。
- history 只写一条批次记录。
- 旧 schema 明确 schema reject。

### Regression

- 现有 read/write/shell/export/mcp_tool/session/skills 行为不回退。
- shell 中 `rm/rmdir` 仍保持 dangerous，不因新增 trash 而放宽。
- MCP tools/list 固定数量更新为 9，并验证 `trash` annotations。
- 现有 approval 的 goal/reason 语义继续保持。

## Implementation Plan

1. **锁定 Trash 契约与 backend seam（RED → GREEN）**
   - 先写 `TrashBackend` 与 `trash` 工具 schema/预检/approval 的失败测试。
   - 引入 `trash` 依赖并实现最小 production backend。
   - 完成文件/目录、多路径、symlink、自身语义、重复/重叠检测和逐项结果。

2. **把 edit 重构为批量 prepare 模型（RED → GREEN）**
   - 先用测试固定新 `edits[]` schema、顺序 replacement、多文件全量预检和 duplicate real target。
   - 移除旧 schema。
   - 把纯 prepare 逻辑提取为可独立测试的批量编辑单元。

3. **加入 edit 整批 approval、并发检查和 commit/rollback（RED → GREEN）**
   - 先写 base 外整批审批、token 绑定、并发修改、写失败与 rollback 失败测试。
   - 复用现有 `writeFileAtomic()` 实现最小提交/回滚机制。
   - 明确 rollbackSucceeded / uncertainPaths 结果。

4. **装配第 9 个工具并补齐跨工具回归（RED → GREEN）**
   - 更新 server 工具装配、metadata、session 说明和 transport/e2e 断言。
   - 保持 shell `rm/rmdir` risk 不变。
   - 验证 history 与 approval 现有约束没有回退。

5. **文档与跨平台验证**
   - README 更新为 9 个工具并写明 trash 安全语义、edit breaking schema。
   - 加入可运行的平台 backend smoke test。
   - 根据实际验证结果记录哪些 OS 已真实跑过，哪些仅由单元测试覆盖。

## Verification

实现完成后至少执行：

```bash
pnpm test
pnpm typecheck
git diff --check
```

并重点确认：

- trash confirmation 前无任何 backend side effect。
- edit prepare / approval 阶段无任何文件写入。
- rollback failure 路径有确定的回归测试。
- tools/list 数量为 9。
- README 中测试数量必须以最后一次真实 `pnpm test` 输出为准，不预先猜测。
- 实际可用平台上的系统 Trash smoke test 结果要在交付说明中明确列出。
