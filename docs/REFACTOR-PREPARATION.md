# Dreamatic 重构准备

## 项目边界与执行前清单

本次范围仅为 `/Users/nancao/Projects/Dreamatic`。DreamaticMake、DreamaticWeb
以及其他独立仓库不在范围内；未读取或修改其代码、文档。

保留：前端页面、布局、样式和交互；配置字段、格式、校验、密钥规则及 HTTP
接口；应用层项目管理、资产、Canvas、预览、导出、发布；历史数据展示与设计知识。
前端仅更换共享模块导入路径，不调整界面实现。

删除：`packages/design-agent` 的运行时、扩展、角色调度、提示词、工具、重试恢复、
Context 写入和审批执行协议及其专属测试；`.pi/agents`、`.pi/APPEND_SYSTEM.md`；
旧 CLI 执行流程；旧技能运行时检查、会话压缩、图像执行诊断脚本；旧架构、Context、
迁移、技能加载、流程审计、故障分析和版本说明 Markdown。README 改为当前准备状态。
设计知识中与旧角色分工、Context 工具和执行协议绑定的内容一并清理。

共享代码先迁入 `packages/project-data` 再删除旧包。该包仅提供配置能力声明校验、
历史数据投影、展示事件归并、路径检查、预览安全策略及导出模型归属信息。
历史记录中的角色名、事件名与文件路径用于兼容读取，不表示仍保留角色执行机制。
Pi SessionManager 仅用于读取已有会话，未复制或修改 Pi 内部实现。

## 配置接入契约

`apps/server/src/config-store.ts` 的字段定义和读写逻辑保持原样，仅变更
`modelCapabilities` 的导入来源；校验实现从旧 provider 原样提取。

- 继续使用 `.env`、`DREAMATIC_CONFIG_DIR` 和原有环境变量名。
- `GET /api/config`、`PUT /api/config` 的输入、输出与密钥遮蔽/空值保留规则不变。
- 保留高级角色模型等字段，以便未来系统接入；本次不映射到新角色或执行器。
- 保存配置继续支持热应用、工作区切换、端口切换及失败回滚。
- 发布期间仍拒绝配置保存；旧智能体执行已删除，不再存在其忙碌状态。
- 后续系统必须通过现有配置层读取已生效配置，不另建不兼容的配置来源。

## 当前运行边界

设计任务接口在修改项目 brief、保存附件或调用服务商之前返回 503 和
`AGENT_RUNTIME_UNAVAILABLE`。前端保留原有交互并显示该错误；不模拟任务成功。
CLI 非帮助调用返回非零退出码。没有实现新的智能体架构。

应用会话记录持久化在工作区 `sessions/registry.json`，旧 Pi JSONL 文件通过
上游 SessionManager 读取。工作区切换可重新载入记录，配置保存不修改历史消息。
已有 workspace、data、output、research 和 release 数据不删除、不提交。
已有安装包属于历史产物，需重新构建才能体现本次代码变更。

## 本轮复核与补充清理（2026-10-23）

检查基线为 `5d66293`。该提交已完成上文的大规模删除；本轮先核对实际源码、
导入关系、工作区清单、锁文件、Settings 调用链及全部受版本控制的 Markdown，
再清理遗漏，不重复删除历史展示所需的兼容代码。未引入替代执行架构。

| 范围 | 处理与依据 |
| --- | --- |
| `apps/web` | 全部原样保留，含 AgentPanel、澄清表单、工作流展示和现有请求处理；这些属于前端保留范围 |
| Settings | 53 个字段及其默认值、选项、校验、密钥读写、profiles、热应用和回滚逻辑原样保留；角色模型、重试、超时等字段也不删除 |
| 应用接口 | 保留 config、health、sessions、runs、assets、canvas、workflow、preview、export、publish 等接口；消息执行仍返回已有的 503 |
| `packages/project-data` | 保留历史 Context 投影、设计分类、澄清结果解析、工作流归并、模型归属和路径/预览工具；均由现有 UI、历史读取或导出使用 |
| Pi | 保留上游 `SessionManager` 历史读取依赖及其传递依赖；不创建 AgentSession、不注册执行工具 |
| `.pi/skills`、设计文档 | 保留通用设计知识、来源与前端设计规范；旧智能体角色/架构文档已在基线删除 |
| `workspace` | 不清理、不修改、不提交历史项目与运行数据 |

本轮修改文件：

- `apps/server/src/stream-writer.ts`：删除无人调用的 `compactPromptEvent`，
  清除旧执行消息流的转换协议；保留工作流 SSE 使用的背压写入器。
- `apps/server/test/performance.test.mjs`：删除上述旧执行函数的专属测试，
  保留 JSONL、背压和项目摘要回归。
- `scripts/diagnose-performance.mjs`：删除只分析旧角色执行/图像请求遥测的专属诊断脚本。
- `package.json`：删除对应 `diagnose:performance` 命令。
- `package-lock.json`：删除已不存在的 `packages/design-agent` extraneous 条目，
  其中还残留 photon-node、typebox 等旧依赖声明；不升级依赖。
- `packages/project-data/src/design-categories.ts`：仅修正两处旧运行时职责注释，
  明确其历史数据展示用途。
- `.env.example`：仅修改注释，说明执行设置暂不生效，移除已删除的
  `docs/PERFORMANCE.md` 引用；所有变量名、值及示例配置保持一致。
- 本文与 `README.md`：记录复核范围、保留理由、实际验证和风险。

风险与后续接入要求：

- 设计执行当前不可用；保留的前端执行入口会显示现有错误，后续重构需接入执行能力。
- 保留的角色名、工具名和旧事件格式是历史读取/展示契约，不能据名称全局删除。
- Settings 中的执行配置可保存，但目前不会触发模型、图像、搜索或重试行为；
  新系统接入时必须继续遵守这些配置格式和接口。
- Pi 的上游包仍包含其自身运行时及服务商依赖，这是历史读取所需的上游依赖树；
  本仓库未复制 Pi 内部实现。
- 桌面暂存目录、安装包和 Windows 平台未在本轮重建验证；已安装版本需重新打包。

## 验证

验证涵盖类型检查、完整构建、配置读写与热应用、端口回滚、工作区切换、执行不可用
响应、历史数据展示、预览、导出与发布传输，以及现有前端浏览器回归。
桌面安装包与 Windows 平台需单独构建验证，源代码检查不代表安装包已更新。

基线提交记录的验证结果（不代表本轮重跑）：

- `npm run build`、`npm run check` 通过。
- 服务端回归及桌面版本测试共 64 项通过。
- 前端浏览器回归共 7 项通过：首次执行 6 项通过，旧模型执行断言调整为
  503/零模型调用后，该配置测试单独重跑通过。
- 逐文件比较确认 `apps/web/src` 仅有导入路径替换；配置存储与模型能力校验
  实现与修改前一致。
- 本地 HTTP 测试需在允许监听回环端口的环境运行；受限沙箱会报 `listen EPERM`。
- 现有 `.desktop-runtime` 旧暂存包的运行测试未通过；本次未重建暂存包、安装包，
  未验证 macOS 安装包或 Windows 构建。打包脚本已改用共享数据包并清理旧包残留。

本轮验证结果：

- `npm ci --ignore-scripts --no-audit --no-fund` 使用清理后的锁文件安装成功，未升级依赖。
- `npm run build`、`npm run check`、`git diff --check` 均通过。
- `node --test --test-concurrency=1 apps/server/test/*.test.mjs apps/web/test/*.test.mjs apps/desktop/test/version.test.mjs`：70 项通过，0 失败、0 跳过。
- 回归覆盖 Settings 桌面/窄屏显示、配置与密钥保留、语言切换、端口切换/失败回滚、
  工作区切换、503 停用响应、历史澄清与工作流展示、Canvas、预览、导出及本地发布传输。
- 逐范围比较确认 `apps/web`、`config-store.ts`、`provider.ts`、服务端路由、
  会话注册表和 `workspace` 与本轮基线一致；`.env.example` 的全部赋值逐项一致。
- 确认旧包目录、角色目录、追加系统提示词均不存在，锁文件无旧 Dreamatic 智能体包记录。
  CLI 普通调用退出 1，`--help` 退出 0。
- 首轮受限沙箱测试遇到 `listen EPERM`（并伴随 Node 25 子进程异常），
  获准在允许本地监听和浏览器启动的环境中重跑后，全套通过。
- 未重建或测试桌面安装包，不将桌面版本测试等同于安装包运行验证。
