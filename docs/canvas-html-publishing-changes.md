# 画布与 HTML 导出功能：代码修改说明

## 文档范围

本文档总结“会话绑定无限画布”和“基于用户编辑画布导出 HTML”功能涉及的全部代码。

对比基线为导出功能开发前的提交 `76828ec`。当前实现包含以下提交：

```text
35e3734  新增 AI 画布 HTML 导出
3c587c1  修正导出 HTML 中的图片路径
c0f24cb  将会话与画布资产绑定
5a25ad5  增加运行过程面板折叠
```

## 文件修改总表

| 状态 | 文件 | 具体修改或新增内容 | 为什么需要 |
|---|---|---|---|
| 新增 | `.myharness/skills/canvas-html-publishing/SKILL.md` | 定义画布 HTML 发布规则，包括输入来源、章节组织、图片使用、文字保留、本地路径和输出格式。 | 为临时 Designer Agent 提供稳定、明确的 HTML 编排规范。 |
| 新增 | `.myharness/skills/canvas-html-publishing/agents/openai.yaml` | 声明 Skill 的元数据和默认调用提示。 | 让 Agent 系统能够识别和加载该 Skill。 |
| 新增 | `api/canvas_publish.py` | 实现画布状态保存、粘贴图片处理、精简发布 JSON、HTML 提取、图片路径修正、HTML 校验、版本编号和最终文件复制。 | 将复杂的导出业务从 API 接口层拆分出来，便于维护和测试。 |
| 新增 | `api/canvas_assets.py` | 读取 artifact manifest、图片 sidecar、实际图片文件和历史画布状态，并合并为统一的资产索引。 | 会话切换时能够加载正确 run 的最新图片和文字资产。 |
| 修改 | `api/rest.py` | 新增请求模型、画布资产接口、run 绑定接口、HTML 导出任务接口、后台导出任务、Skill 加载、临时 Designer Agent、进度状态、取消和版本化链接。 | 负责协调前端、画布数据、文件系统和 Agent 运行时。 |
| 修改 | `api/ws.py` | 增加 `canvas.run_bound` 事件转发。 | run 与会话绑定后，立即通知前端刷新右侧画布。 |
| 修改 | `harness/engine/engine.py` | 修改 `run_to_completion()`，支持临时 Agent 在完成一轮后继续补写，并正确响应取消。 | 解决长 HTML 被截断后无法续写，以及取消后仍继续运行的问题。 |
| 修改 | `harness/factory.py` | 包装 `run_init`，将 `active_run_id` 写入当前会话和父会话链。 | 子 Agent 创建 run 后，主会话也能知道应该显示哪个画布。 |
| 修改 | `harness/tools/builtin/spawn_agent.py` | 子 Agent 创建时继承父会话的 `active_run_id`。 | 保证主 Agent、子 Agent 和右侧画布使用同一个设计项目。 |
| 修改 | `static/index.html` | 新增会话对应画布加载、资产刷新、图片增删改、导出按钮、导出进度、取消、预览和下载；将当前 `elements[]` 转换为导出请求。 | 提供用户可操作的无限画布和完整的 HTML 导出交互。 |
| 新增 | `tests/test_canvas_publish.py` | 测试 run 校验、画布 JSON 保存、粘贴图片、删除资产、版本编号、HTML 渲染、图片路径修正、内容校验和任务取消。 | 防止导出和文件处理流程产生回归。 |
| 新增 | `tests/test_canvas_assets.py` | 测试编辑图片优先级、最终输出目录回退、画布状态恢复和删除资产过滤。 | 确保会话加载到正确的画布资产。 |
| 修改 | `tests/test_spawn_agent.py` | 增加 `run_to_completion()` 第一轮完成后继续执行的测试。 | 验证临时 Agent 可以继续生成被截断的 HTML。 |
| 修改 | `static/index.html`（提交 `5a25ad5`） | 增加运行过程面板的折叠按钮，默认展开，并将用户选择保存到 `localStorage`。 | 让用户可以隐藏运行日志，同时保留日志内容和实时更新能力。 |

## `api/rest.py` 新增的请求模型和接口

### 请求模型

| 模型 | 主要字段 | 作用 |
|---|---|---|
| `CanvasEmbeddedAsset` | `element_id`、`data_url`、`name` | 将用户粘贴或嵌入画布的图片从浏览器传到后端。 |
| `CanvasPublishRequest` | `run_id`、`canvas_state`、`embedded_assets` | 将用户编辑后的画布快照提交给 HTML 导出流程。 |
| `CanvasRunBindingRequest` | `run_id` | 将已有会话显式绑定到已有 run。 |

### 接口

| 接口 | 作用 |
|---|---|
| `GET /sessions/{session_id}/canvas-assets` | 返回会话对应的图片、文字和已保存画布状态。 |
| `PATCH /sessions/{session_id}/canvas-run` | 将旧会话绑定到已有 run。 |
| `POST /sessions/{session_id}/canvas-publish` | 保存画布快照并启动异步 HTML 导出。 |
| `GET /canvas-publish/jobs/{job_id}` | 查询导出阶段和最终结果链接。 |
| `POST /canvas-publish/jobs/{job_id}/cancel` | 取消正在运行的导出任务。 |

## 代码之间的数据流

```text
Agent 调用 run_init
        ↓
harness/factory.py + spawn_agent.py
        ↓
保存 active_run_id，并发送 canvas.run_bound
        ↓
api/ws.py 转发事件
        ↓
static/index.html 请求 /canvas-assets
        ↓
浏览器内存中的 elements[]
        ↓
用户编辑图片和文字
        ↓
prepareCanvasPublishPayload()
        ↓
POST /sessions/{session_id}/canvas-publish
        ↓
api/canvas_publish.py::persist_canvas_state()
        ↓
生成 canvas-state.json
        ↓
生成 canvas-publish-input.json
        ↓
api/rest.py::_run_canvas_publish_job()
        ↓
加载导出 Skill，创建临时 Designer Agent
        ↓
生成 HTML
        ↓
提取、修正并校验 HTML
        ↓
finalize_publish()
        ↓
输出带版本号的 gallery HTML
```

## 导出期间产生的文件

| 文件 | 产生位置 | 内容 |
|---|---|---|
| `canvas-state.json` | `.design-harness/runs/{runId}/canvas/` | 完整画布快照，包括位置、大小、文字、图片路径、元数据和发布标记。 |
| `canvas-publish-input.json` | `.design-harness/runs/{runId}/canvas/` | 提供给临时 Designer Agent 的语义化输入，包括图片、描述、元数据、文字和关联关系。 |
| `{version}-gallery-edited.html` | `.design-harness/runs/{runId}/artifacts/` | 临时 Agent 返回的 HTML，中间校验文件。 |
| `canvas-state.json` | `outputs/runs/{runId}/final/canvas/` | 完整画布快照的最终输出副本。 |
| `canvas-publish-input.json` | `outputs/runs/{runId}/final/canvas/` | 语义化发布输入的最终输出副本。 |
| `canvas-publish-manifest.json` | `outputs/runs/{runId}/final/canvas/` | 记录本次导出的 HTML、包含的图片、文字数量和画布版本。 |
| `{version}-gallery-edited.html` | `outputs/runs/{runId}/final/artifacts/` | 通过校验后正式交付的 HTML 文件。 |

## 画布状态的持久化说明

用户拖动图片、修改文字或调整字号时，最新状态会立即更新在浏览器内存的 `elements[]` 中。

当前实现不会在每次拖动或改字后立即写磁盘。用户点击“导出 HTML”时，前端把最新的
`elements[]` 作为一次完整快照发送到后端，后端再写入 `canvas-state.json`。

因此当前流程是：

```text
用户编辑画布
        ↓
实时更新浏览器内存 elements[]
        ↓
用户点击导出
        ↓
后端保存最新画布快照
        ↓
生成 canvas-state.json 和 canvas-publish-input.json
```

如果用户编辑后直接刷新页面、但没有点击导出，最近的修改可能还没有写入磁盘文件。
