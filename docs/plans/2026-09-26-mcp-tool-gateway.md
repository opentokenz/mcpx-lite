# mcp_tool 单一 MCP 网关

## Goal

为 mini-pi-mcp 增加第 8 个稳定工具 `mcp_tool`，让 mini-pi 作为 MCP client 读取全局与项目级 MCP 配置，连接下游 MCP server，并通过一个固定网关透传 tools / resources / prompts 等能力，而不动态改变 mini-pi 自身的 `tools/list`。

该能力要保持 mini-pi 当前定位：它仍然是无模型的 Coding Runtime / Gateway，不承担 LLM Provider、Agent Loop、Planner 或 Sampling Provider 职责。

## Context

当前 mini-pi-mcp 的工具集合由 `createTools()` 静态装配，现有 7 个工具分别是 `session / skills / read / write / edit / shell / export`。Session 持久化只记录 `base / skills / history`，服务端尚无 MCP client、下游连接池或动态 MCP catalog。

此前实测 OpenAI / ChatGPT connector 对 MCP tool metadata 可能保留旧 schema / description，因此本设计避免将下游 MCP tools 动态展开到 mini-pi 自己的 `tools/list`。下游能力变化只通过稳定的 `mcp_tool` 返回。

配置来源采用两级约定：

- 全局：`~/.agents/mcp.json`
- 项目：`<session.base>/.mcp.json`

项目级配置中的同名 server 整项覆盖全局配置。

## Decisions

- mini-pi 只新增一个稳定工具：`mcp_tool`，不把下游 tools 动态注册成 mini-pi 一等工具。
- `mcp_tool` 首版支持 7 个 action：`list / inspect / call / read_resource / get_prompt / status / reload`。
- 配置顶层使用事实通用格式 `mcpServers`；首版不增加 mini-pi 私有 server 字段。
- transport 首版支持：
  - stdio：`command + args + env`
  - Streamable HTTP：`url + headers`
- 不专门实现 legacy SSE transport。
- 全局配置路径为 `~/.agents/mcp.json`；项目配置路径为 `<base>/.mcp.json`。
- project 同名 server 整项覆盖 global，不做字段级 deep merge。
- 环境变量只支持 `${NAME}` 占位符展开；不支持 shell substitution、反引号或算术展开。
- 下游 connection 由进程级 `McpManager` 复用；Session 不持久化 client/connection 状态。
- connection cache key 基于 `server name + resolved config hash`，避免不同 project 对同名 server 的 override 串线。
- `inspect` 是 catalog / metadata 的主要入口，透传 server info、protocol version、instructions、capabilities、tools、resources、resource templates、prompts。
- `call` 尽量保留下游 `CallToolResult` 的 MCP 结构，包括 `content / structuredContent / isError / _meta`，不统一降级成 JSON 文本。
- 项目级 `.mcp.json` 属于 repository-controlled input：第一次真正连接 project server 时必须经过 mini-pi 审批。
- 全局 `~/.agents/mcp.json` 视为用户主动安装的配置，可按需连接，不额外要求“首次连接”审批。
- 下游 tool 调用的 mini-pi 审批策略：
  - `readOnlyHint === true` 且 `destructiveHint !== true`：可直接调用；
  - 其他情况或 annotations 缺失：返回 mini-pi `approval_required`。
- 下游调用 approval token 绑定至少包含：`sessionId + server config hash + primitive + tool name + arguments`；`goal / reason` 仍仅用于审计，不参与比对。
- 下游需要交互输入时，优先透传 MCP 2026-07-28 的 MRTR / `input_required` 语义；`requestState` 视为 opaque，不解析、不重建。
- mini-pi 不实现下游 Sampling / Roots Provider；legacy server 要求这类 client capability 时返回明确 unsupported。
- 下游 catalog 的变化不触发 mini-pi 自己的 dynamic registration；下一次 `inspect` / `status` / `reload` 反映最新状态。
- secret（env value、Authorization、token、headers secret）不得出现在 `list / inspect / status / history / log` 中。

## Rationale

### 单一网关而不是动态工具注册

稳定的 `mcp_tool` schema 能避免宿主缓存动态 tool metadata 导致的不可预测行为，同时天然解决下游 tool name 冲突、project override、reload 与连接生命周期问题。模型先 `inspect` 再 `call`，下游 catalog 不需要成为 mini-pi 自身 catalog 的一部分。

### 配置两级来源

`~/.agents/mcp.json` 与现有 `~/.agents/skills` 共同构成用户级 Agent 能力；项目级采用根目录 `.mcp.json`，避免再定义 `.agents/mcp.json` 与现有 portable MCP 约定竞争。

### 进程级连接复用

stdio server 往往对应一个 child process；若每个 Session 都独立 spawn，同一配置会无意义地产生多个进程。使用 resolved config hash 作为连接标识，可在复用连接的同时隔离 project override。

### 二层安全模型

“配置一个 MCP server”本身可能引入本机进程执行或网络访问；而“调用下游 tool”还可能产生独立副作用。项目配置属于仓库内容，不能因为打开项目就隐式执行，所以 project server 首次连接需要审批。连接后的具体 tool 调用再依据 annotations 决定是否需要第二层审批。

## Alternatives Considered

### 动态把下游 tools 注册成 mini-pi 一等工具

优点是模型调用自然，缺点是每次下游 catalog 变化都会改变 mini-pi `tools/list`，与已观察到的宿主 metadata 缓存冲突；同时 resources / prompts 仍需要另一套动态注册与命名空间方案。首版不采用。

### Hybrid：常用下游 tool 可提升成一等工具

可以作为未来扩展，但会重新引入 dynamic metadata 与命名冲突问题。首版不做，避免提前设计 `expose` 规则。

### 每个 Session 独占下游 connection

实现直观，但 stdio server 会按 Session 重复 spawn，资源浪费明显，而且连接状态不是 Session 业务数据。首版采用 process-wide manager。

## Scope

### In

- 新增 `mcp_tool`。
- 新增 MCP config loader：
  - `~/.agents/mcp.json`
  - `<session.base>/.mcp.json`
  - project 同名覆盖 global。
- 解析 / 验证 stdio 与 Streamable HTTP 配置。
- `${ENV}` 展开与 secret-safe metadata。
- 新增进程级 `McpManager`。
- 使用官方 TypeScript client SDK 建立 stdio / HTTP connection。
- 支持 tools / resources / resource templates / prompts 的发现与调用。
- 支持下游 MRTR / `input_required` 的透明转发。
- project server 首次连接审批。
- non-readonly / destructive / unknown 下游 tool 的调用审批。
- history / logger 接入。
- README 配置与使用说明。
- 完整单元测试、进程内 MCP 测试和必要的真实 HTTP / stdio e2e fixture。

### Out

- 动态修改 mini-pi 自身 `tools/list`。
- legacy SSE 专属 transport。
- mini-pi 充当 Sampling Provider、Roots Provider 或 LLM Provider。
- OAuth / 浏览器登录流程的通用编排。
- 自动从 Cursor / Claude / Codex 等客户端配置位置导入 MCP。
- 私有 `enabled / expose / timeout / reconnectPolicy` 等扩展 schema。
- MCP Marketplace / 自动安装。
- 跨进程持久化连接状态。
- tool result 内容级的业务 secret 自动脱敏；仅保证 mini-pi 自身配置 secret 不泄漏。

## Design

### 1. Config Loader

定义内部 normalized config，但输入仍兼容：

```json
{
  "mcpServers": {
    "local": {
      "command": "npx",
      "args": ["-y", "@example/mcp"],
      "env": {
        "TOKEN": "${TOKEN}"
      }
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${TOKEN}"
      }
    }
  }
}
```

规则：

- server name 非空且唯一。
- 一个 server 必须恰好属于 stdio 或 HTTP：
  - stdio：存在非空 `command`，不得同时有 `url`。
  - HTTP：存在合法 `http/https` `url`，不得同时有 `command`。
- `args` 仅字符串数组。
- `env / headers` 仅字符串键值。
- `${NAME}` 在真正建立连接前展开；缺失 env 变量时连接失败并给出变量名，但不打印其他 secret。
- project 同名 entry 整体覆盖 global entry。
- loader 返回：
  - effective server map
  - 每个 server 的 source：`global | project`
  - secret-safe display metadata
  - resolved config hash。

### 2. McpManager

进程级依赖，生命周期与 mini-pi 服务一致。

职责：

- 按 effective server config 获取或创建 client connection。
- 维护 `configHash -> connection` cache。
- stdio：spawn child process 并持有 client/transport。
- HTTP：持有 Streamable HTTP client/transport。
- config reload 后：
  - 未变化 config 继续复用；
  - 被删除或 hash 改变的连接 close 并移除；
  - 新配置延迟到真正访问时连接。
- 单个 server connect failure 不影响其他 server。
- server 状态至少包含：`disconnected / connecting / connected / failed` 与 sanitized error。
- 服务 shutdown 时 close 所有 transport / child process。

### 3. mcp_tool Contract

公共字段：

- `sessionId`
- `action`
- `server?`
- `name?`
- `arguments?`
- `uri?`
- `goal?`
- `reason?`
- 审批字段按现有统一协议复用。

Actions：

#### list

返回当前 Session 的 effective server 列表：

- name
- source
- transport
- connected/status

不建立不必要的连接，不返回 secret。

#### inspect

需要 `server`。建立连接后返回：

- negotiated protocol version
- serverInfo
- instructions
- capabilities
- tools
- resources
- resourceTemplates
- prompts

list 调用若某 primitive 不受下游支持，则返回空数组并保留 capability 信息，而不是把整个 inspect 失败。

#### call

需要 `server + name + arguments`。

流程：

1. resolve effective config。
2. 如为 project source 且该 configHash 尚未被当前安全机制批准连接，走首次连接审批。
3. connect / reuse client。
4. 获取目标 tool metadata（必要时 listTools）。
5. 根据 annotations 判断 mini-pi 是否要求 tool-call approval。
6. 调用下游 tool。
7. 下游正常 result 尽量保持 MCP content block 结构返回。

#### read_resource

需要 `server + uri`，调用下游 `resources/read` 并保留 text/blob 等 resource content。

#### get_prompt

需要 `server + name + arguments`，透传 prompt description / messages / metadata。

#### status

返回所有 effective server 的连接状态与最近 sanitized error。单个失败不使 action 整体失败。

#### reload

重新读取 global + project config，计算 effective config，清理 stale connection，并返回新的 server 摘要与配置诊断。

### 4. Approval Model

#### Project server 首次连接

project source server 在真正 connect 前返回 `approval_required`。

审批摘要显示：

- server name
- source = project
- transport
- stdio command + args（secret-safe）
- 或 HTTP origin / URL（headers value 不显示）

token 绑定：

- sessionId
- server name
- config hash
- operation = connect

`goal / reason` 不参与。

#### Downstream tool call

若：

```text
readOnlyHint === true
AND destructiveHint !== true
```

则可直接调用。

否则先返回 `approval_required`。

token 绑定：

- sessionId
- config hash
- primitive = tool
- tool name
- arguments canonical hash

审批卡片不得把大型 / secret-like argument 全量打印到日志；采用可控摘要。

### 5. MRTR / Error Forwarding

- 下游普通 `isError` 结果保持为 tool result，不转换成 transport-level exception。
- connect / protocol / config 错误转成稳定的 mini-pi ToolError，包含 server + action + sanitized message。
- 下游返回 `input_required` 时：
  - 保留并透传 `requestState`；
  - 不解析、不改写 opaque state；
  - 上游重试时将 `inputResponses` 与原 state 送回对应 downstream operation。
- 若下游要求 mini-pi 未声明 / 不支持的 legacy client capability，则返回明确 unsupported，不伪造能力。

### 6. History / Logging

history target 使用稳定可读形式：

```text
mcp:list
mcp:github inspect
mcp:github tool:create_issue
mcp:docs resource:docs://architecture
mcp:assistant prompt:review-code
```

日志：

- 不记录 env/header secret。
- approval required 卡片只显示 sanitized config / argument summary。
- downstream result 内容不默认完整写入日志。
- history 保持现有 `goal / reason / target / ok / error` 结构，不新增持久化 connection 字段。

### 7. Dependency / Assembly

- 新增官方 `@modelcontextprotocol/client` 直接依赖。
- `createDeps()` 构建 process-wide `McpManager`。
- `Deps` 注入 manager 与必要 config path resolver。
- `createTools()` 注册第 8 个 `mcp_tool`。
- shutdown 流程先关闭 manager，再关闭 HTTP server / 退出进程。
- server info / README 的工具计数同步为 8。

## Acceptance Criteria

- 没有 MCP 配置时，现有 7 个工具行为完全不变；`mcp_tool list` 返回空列表。
- global `~/.agents/mcp.json` 能发现 stdio 与 HTTP server。
- project `.mcp.json` 能新增 server，并能按同名整项覆盖 global。
- 无效配置提供明确错误且不泄漏 secret。
- `${ENV}` 正常展开；缺失变量给出可诊断错误。
- `mcp_tool inspect` 能返回下游 server metadata 与 tools/resources/prompts catalog。
- `mcp_tool call` 能调用下游 tool 并保留结构化结果。
- `read_resource / get_prompt` 能透传对应 primitive。
- project MCP 第一次真正 connect 前不会 spawn stdio process / 发出 HTTP 请求，必须先经过 approval。
- readonly 下游 tool 可直接调用；destructive / unknown tool 必须审批。
- `goal / reason` 改变或省略不会使 project-connect / downstream-call approval token 失效；真正业务参数变化会失效。
- 两个 Session 对同一 resolved config 可复用 connection；同名但不同 project config 不会共享。
- `reload` 会关闭 stale connection，不改变 mini-pi 自身 `tools/list`。
- 一个 downstream server 挂掉不会导致其他 server 的 `list/status/inspect` 不可用。
- config secret 不出现在 logger、history、list、inspect、status。
- 下游 MRTR 的 `requestState` 能 byte-for-byte 往返。
- 全量现有测试保持通过，并新增 mcp_tool 覆盖。

## Test Strategy

### Config

- global-only / project-only / merge / same-name override。
- invalid JSON、缺少 `mcpServers`、stdio/http 字段冲突、非法 URL、非法 args/env/headers。
- env expansion 成功 / 缺失变量 / secret 不泄漏。
- config hash 对业务字段敏感，对 display/redaction 不敏感。

### McpManager

- lazy connect。
- 同 hash connection reuse。
- 不同 hash isolation。
- concurrent connect 只创建一个 client。
- reload 后 unchanged reuse / changed close / removed close。
- failed connection 独立，不污染其他 server。
- shutdown close。

### stdio E2E Fixture

实现测试专用最小 MCP server：

- 暴露 readonly tool。
- 暴露 destructive / unannotated tool。
- 暴露 resource / resource template / prompt。
- 返回 structuredContent。
- 可触发 MRTR。
- 记录是否被 spawn / 调用，验证 project approval 前零副作用。

### HTTP E2E Fixture

本地随机端口启动 Streamable HTTP MCP fixture，覆盖：

- connect + inspect。
- tool/resource/prompt。
- headers/env-like secret 不泄漏。
- server 失败 / 重启后的错误状态。

### Approval Regression

- project connect 首轮只返回 approval，不 spawn / 不发 HTTP。
- approve 后执行一次。
- cancel 后零副作用。
- config hash 改变后旧 token 失效。
- downstream tool arguments 改变后旧 token 失效。
- `goal/reason` 改变或省略仍可批准。
- readonly direct；destructive / unknown requires approval。

### Gateway Regression

- tools/list 始终是固定 8 个工具，不随下游 catalog 改变。
- mcp_tool annotations / schema / description 稳定。
- 原 7 工具 schema / annotation / history 行为不回归。

### Error / MRTR

- downstream `isError` 保留语义。
- connect/config errors sanitized。
- opaque `requestState` 精确往返。
- unsupported legacy client capability 返回明确错误。

## Implementation Plan

1. **建立 config contract 与 RED tests**
   - 为 global/project loader、override、transport 判定、env expansion、redaction、hash 写失败测试。
   - 实现最小 config loader 与 normalized config。

2. **建立 McpManager 生命周期与 RED tests**
   - 增加 client dependency。
   - 用 fake connector/transport 测 lazy connect、dedupe、hash isolation、reload、shutdown。
   - 实现 process-wide manager，不先接入工具。

3. **建立 stdio / HTTP downstream fixtures**
   - 创建最小测试 MCP server fixtures。
   - 验证 client SDK 的 connect / list / call / resource / prompt 行为和结果结构。

4. **实现固定 `mcp_tool` catalog actions**
   - 先为 `list / inspect / status / reload` 写失败测试。
   - 接入 Session-aware effective config 与 manager。
   - 确保 mini-pi 自身 tools/list 只从 7 变 8，不随 downstream 改变。

5. **实现 primitive proxy**
   - 为 `call / read_resource / get_prompt` 写失败测试。
   - 保留下游 MCP content / structured result。
   - 接入 history / logger，验证结果内容不被默认写日志。

6. **实现两层 approval**
   - RED tests 固化 project-connect approval 与 downstream-tool approval。
   - 复用现有 `ApprovalCodec / enforceApproval`。
   - hash 排除 `goal / reason`，覆盖参数篡改与取消路径。

7. **实现 MRTR 与错误边界**
   - RED tests 覆盖 downstream `input_required` opaque state 往返、普通 `isError`、unsupported capability 与 sanitized connection error。
   - 只实现当前协议需要的最小转发，不引入 sampling/roots provider。

8. **装配、文档与全量回归**
   - 将 manager 注入 server deps 与 shutdown。
   - README 增加 config path、schema、action、审批语义、secret 规则。
   - 更新工具计数及 metadata tests。
   - 跑全量测试、typecheck、diff check，并做一个本机真实 global/project MCP smoke test。

## Verification

最终至少执行：

```bash
pnpm test
pnpm typecheck
git diff --check
```

并进行实际 smoke test：

1. 临时 global MCP fixture → `mcp_tool list / inspect / call`。
2. project `.mcp.json` 同名覆盖 global。
3. project stdio / HTTP 首次连接 approval 前确认零副作用。
4. 修改 `goal/reason` 后使用同一 approval token 成功。
5. 修改真正业务参数后旧 token 被拒绝。
6. 下游 destructive tool 审批后成功执行。
7. `reload` 后 stale connection 被关闭。
8. OpenAI / ChatGPT 侧确认 mini-pi 始终只多出固定一个 `mcp_tool`，下游 catalog 不改变宿主 tool metadata。
