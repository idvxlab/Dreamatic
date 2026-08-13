# Dreamatic

[English](README.md) | [简体中文](README.zh-CN.md)

**面向专业设计智能体的 Agent Harness** — 引导创造力，编排智能，交付专业设计。

![Dreamatic hero illustration](docs/assets/dreamatic-hero.png)

Dreamatic 是一个可控制的智能体运行时，超越了简单的对话。智能体可以在持久化会话中理解需求、规划工作、调用工具、保存上下文、请求人工批准、生成子智能体，并实时流式传输执行过程。

当前版本聚焦通用运行时层，适用于设计智能体、研究工作台、本地自动化助手，以及需要可预测执行、工具治理和可观察长任务的多智能体系统。

## 快速开始

### 1. 创建虚拟环境（推荐）

Dreamatic 需要 **Python >= 3.11**。

```bash
python3 -m venv .venv
source .venv/bin/activate        # macOS/Linux
# .venv\Scripts\activate         # Windows
pip install --upgrade pip
```

### 2. 安装依赖

```bash
pip install -e ".[dev]"
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 填写 provider 凭证
```

你可以直接编辑 `.env`，也可以在 Web UI 中打开 **Settings -> Models & API**。
设置面板管理的是同一组 Dreamatic 环境变量，并支持导入 `.env` profile 文件。

#### 模型 Provider

默认运行时 provider 使用 OpenAI-compatible 变量：

```env
DREAMATIC_API_KEY=your-api-key
DREAMATIC_BASE_URL=https://your-endpoint/v1
DREAMATIC_MODEL=gpt-4o
HARNESS_DEFAULT_PROVIDER=openai-hub
```

上下文压缩/摘要可以单独使用更便宜的小模型：

```env
DREAMATIC_SUMMARY_API_KEY=your-summary-api-key
DREAMATIC_SUMMARY_BASE_URL=https://your-endpoint/v1
DREAMATIC_SUMMARY_MODEL=gpt-4o-mini
```


#### 搜索工具

`web_search` 建议配置真实搜索 provider：

```env
DREAMATIC_SEARCH_PROVIDER=serper
DREAMATIC_SEARCH_API_KEY=your-search-key
```

当前搜索工具也兼容旧变量：

```env
SERPER_API_KEY=your-serper-key
BRAVE_SEARCH_API_KEY=your-brave-key
```

如果没有配置真实搜索 key，fallback 搜索可能只返回有限结果或空结果。

#### 图片生成与编辑

`image_generate` 和 `image_edit` 使用这些变量：

```env
DREAMATIC_IMAGE_API_KEY=your-image-api-key
DREAMATIC_IMAGE_BASE_URL=https://your-image-endpoint/v1
DREAMATIC_IMAGE_MODEL=gpt-image-2
DREAMATIC_IMAGE_GENERATION_ENDPOINT=https://your-image-endpoint/v1/images/generations
DREAMATIC_IMAGE_EDIT_ENDPOINT=https://your-image-endpoint/v1/images/edits
DREAMATIC_IMAGE_DEFAULT_SIZE=1024x1024
DREAMATIC_IMAGE_BACKEND=codex
```

`DREAMATIC_IMAGE_DEFAULT_SIZE` 只是默认尺寸。工作流或工具调用仍然可以为具体产物请求某个 provider 支持的尺寸。

#### 视频生成

`video_generate` 是可选工具，适合接入任务式视频生成 API：

```env
DREAMATIC_VIDEO_API_KEY=your-video-api-key
DREAMATIC_VIDEO_BASE_URL=https://ark.ap-southeast.bytepluses.com
DREAMATIC_VIDEO_MODEL=seedance-1-5-pro-251215
DREAMATIC_VIDEO_ENDPOINT=https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks
DREAMATIC_VIDEO_DEFAULT_RESOLUTION=720p
DREAMATIC_VIDEO_DEFAULT_DURATION=5
DREAMATIC_VIDEO_BACKEND=codex
```

不同 provider/模型的限制可能不同：文生视频和图生视频可能支持不同的时长、分辨率和输入模式。

#### 可选 3D 生成

`hunyuan3d` 是可选工具，只在用户明确要求 3D 模型，或要求 GLB、OBJ、FBX、STL、USDZ 等格式时使用。

```env
DREAMATIC_HUNYUAN3D_API_KEY=your-hunyuan3d-key
DREAMATIC_HUNYUAN3D_BASE_URL=https://tokenhub.tencentmaas.com/v1/api/3d
DREAMATIC_HUNYUAN3D_MODEL=hy-3d-3.1
```

生成的 3D 资产是补充产物。在设计工作流中，它们会保存到 `<runDir>/artifacts/models/` 和 `<runDir>/artifacts/model-renders/`；不会替代必需的 PNG 图像集和 gallery。

### 4. 启动 Web UI

```bash
python -m uvicorn api.rest:app --port 8000
# 打开 http://localhost:8000
```

> 务必使用 `python -m uvicorn` 而非裸 `uvicorn` 命令，以确保在当前的虚拟环境中运行。不建议使用 `--reload`，智能体写文件可能触发重启并中断会话。

### 5. 或使用 CLI

```bash
python cli.py --persona builder
```

## 核心特性

| 领域 | 能力 |
| --- | --- |
| **入口方式** | Web UI、交互式 CLI、REST + WebSocket API |
| **智能体运行时** | ReAct 风格循环，支持取消、恢复和实时流式传输 |
| **模型提供商** | OpenAI-compatible 和 Anthropic；通过 `config.yaml` 和 `.env` 配置 |
| **内置工具** | 30+ 工具：文件操作、搜索、命令行、网页搜索/抓取、图片/视频/3D 生成、记忆、规划、子智能体 |
| **持久化** | 基于 SQLite 的消息、计划、记忆、检查点和会话关系 |
| **安全** | 每工具审批门禁、persona 作用域权限、输出限制、SSRF 保护 |
| **可扩展性** | Personas（智能体角色）、Skills（可复用流程）、Commands（项目快捷命令）、MCP 桥接 |
| **上下文管理** | 长会话自动压缩和 prompt 缓存 |
| **多智能体** | 父会话可生成子智能体，用于调研、规划、评审和文档 |
| **可观察性** | WebSocket 流式传输模型轮次、工具调用、结果、计划变更和审批事件 |

## 架构

Dreamatic 分为六个运行时层级。

![Dreamatic 架构图](docs/assets/dreamatic-architect-v2.png)

| 层级 | 职责 |
|---|---|
| 入口层 | Web UI、CLI、REST API、WebSocket 流式事件 |
| 会话层 | 创建、恢复、重命名、置顶/归档、父子关系、运行模式 |
| 智能体运行层 | 状态机（6 种状态）、ReAct 控制器、prompt 组装、上下文压缩、prompt 缓存 |
| 工具与 Provider | 30+ 内置工具、OpenAI-compatible & Anthropic LLM 提供商、MCP 桥接 |
| 扩展层 | Personas（角色）、Skills（流程）、Commands（快捷命令）、MCP 桥接 |
| 存储层 | SQLite 或内存后端，支持 SessionStore、MemoryStore、PlanStore、CheckpointStore |

**执行流程**：用户发送请求 → 引擎组装 prompt（系统 + persona + skills + memory + plan + 历史）→ 模型回复或请求工具调用 → 工具通过审批门禁 → 结果流式传输到前端 → 循环继续或返回最终答案。

## 设计案例

每个案例包含全分辨率最终包和产物画廊。

### 品牌与文创：京剧国潮系列

一个基于京剧脸谱的文创系统。[打开包](examples/jingju-guochao-merch/final/00-index.html)

| 产品系统 | 包装 | 系列总览 |
|---|---|---|
| <img src="examples/jingju-guochao-merch/final/artifacts/generated-images/01-product-overview.png" width="220"> | <img src="examples/jingju-guochao-merch/final/artifacts/generated-images/07-packaging-application.png" width="220"> | <img src="examples/jingju-guochao-merch/final/artifacts/generated-images/10-series-overview.png" width="220"> |

### 品牌与文创：同济 IDVX 实验室

实验室周边——帆布袋、笔记本、徽章。[打开包](examples/tongji-idvx-lab-merch/final/00-index.html)

| 帆布袋主图 | 笔记本封面 | 徽章系统 |
|---|---|---|
| <img src="examples/tongji-idvx-lab-merch/final/artifacts/generated-images/01-tote-hero-front.png" width="220"> | <img src="examples/tongji-idvx-lab-merch/final/artifacts/generated-images/03-notebook-cover.png" width="220"> | <img src="examples/tongji-idvx-lab-merch/final/artifacts/generated-images/05-badge-set-board.png" width="220"> |

### 产品设计：面向老年人的 AI 陪伴设备

面向独居老人的陪伴设备概念。[打开包](examples/elderly-ai-companion-device/final/00-index.html)

| 主视觉渲染 | 三视图 | CMF 板 |
|---|---|---|
| <img src="examples/elderly-ai-companion-device/final/artifacts/generated-images/01-hero-render.png" width="220"> | <img src="examples/elderly-ai-companion-device/final/artifacts/generated-images/02-three-view.png" width="220"> | <img src="examples/elderly-ai-companion-device/final/artifacts/generated-images/06-cmf-board.png" width="220"> |

### 建筑与空间：朱家角游客中心

古镇游客中心概念。[打开包](examples/zhujiajiao-visitor-center-space/final/00-index.html)

| 场地关系 | 总平面分区 | 入口大厅 |
|---|---|---|
| <img src="examples/zhujiajiao-visitor-center-space/final/artifacts/generated-images/01-site-context-relation.png" width="220"> | <img src="examples/zhujiajiao-visitor-center-space/final/artifacts/generated-images/02-master-plan-zoning.png" width="220"> | <img src="examples/zhujiajiao-visitor-center-space/final/artifacts/generated-images/06-hero-entry-hall.png" width="220"> |

### 海报与广告：IEEE VIS 2026 宣传

会议宣传——海报、社交媒体、徽章、模板。[打开包](examples/ieee-vis-2026-promo/final/00-index.html)

| 主海报 | 主视觉 | 社交媒体 |
|---|---|---|
| <img src="examples/ieee-vis-2026-promo/final/artifacts/generated-images/01-main-poster.png" width="220"> | <img src="examples/ieee-vis-2026-promo/final/artifacts/generated-images/02-key-visual.png" width="220"> | <img src="examples/ieee-vis-2026-promo/final/artifacts/generated-images/05-social-twitter-post.png" width="220"> |

### 校园传播：上海创智学院

双语传播活动，含周边 mockup 和 moodboard。[打开包](examples/shanghai-chuangzhi-college-merch-system/final/00-index.html)

| 标志海报 | 中文海报 | 周边 mockup |
|---|---|---|
| <img src="examples/shanghai-chuangzhi-college-merch-system/final/artifacts/generated-images/01-logo-application-poster.png" width="220"> | <img src="examples/shanghai-chuangzhi-college-merch-system/final/artifacts/generated-images/02-campaign-poster-zh.png" width="220"> | <img src="examples/shanghai-chuangzhi-college-merch-system/final/artifacts/generated-images/07-merch-mockup.png" width="220"> |

## 仓库布局

```
.
|-- api/                # FastAPI REST + WebSocket 服务
|-- harness/            # 智能体运行时、工具、存储、LLM 提供商
|   |-- engine/         # 主循环、状态机、压缩、prompt 缓存
|   |-- tools/          # 内置工具和执行层
|   |-- storage/        # SQLite 和内存后端
|   |-- llm/            # Provider 抽象和实现
|   |-- mcp/            # MCP 桥接和传输层
|   `-- commands/       # 内置和项目命令系统
|-- static/             # 浏览器前端
|-- .myharness/         # Personas、skills、commands、transcripts
|-- tests/              # 测试
|-- cli.py              # CLI 入口
|-- config.yaml         # 运行时配置
`-- pyproject.toml
```

## 配置

### config.yaml

| 设置 | 说明 |
|---|---|
| `default_provider` | 默认模型提供商 |
| `providers` | Provider 定义（OpenAI-compatible / Anthropic） |
| `engine.max_rounds` | 每任务最大模型/工具循环轮数 |
| `compression` | Token 窗口、触发比例、摘要 provider |
| `storage` | SQLite 或内存 |
| `tools.enabled` | 全局启用工具 |
| `tools.confirm_tools` | 需要人工确认的工具 |
| `tools.limits` | 每工具输出/执行限制 |
| `mcp_servers` | 可选 MCP 服务定义 |

### Personas、Skills、Commands

项目本地行为配置位于 `.myharness/`：

```
.myharness/
|-- personas/    # 智能体角色（builder、planner、reviewer 等）
|-- skills/      # 可复用流程（每个 skill 一个 SKILL.md）
|-- commands/    # 项目级快捷命令
`-- transcripts/ # 运行记录
```

**Personas** 定义系统提示词、默认 provider、审批模式和允许工具。**Skills** 在启动时按名称注入；完整内容在使用 `use_skill` 时加载。**Commands** 是通过 CLI 和 Web UI 暴露的项目快捷方式。

### 内置工具

| 工具 | 用途 |
|---|---|
| `read_file`, `write_file`, `edit_file`, `create_directory`, `list_dir`, `write_json` | 文件操作 |
| `search`, `grep`, `glob` | 代码/文本搜索 |
| `shell`, `powershell` | 本地命令执行 |
| `web_search`, `web_fetch` | 网页搜索和页面提取 |
| `image_generate`, `image_edit` | 图片生成和编辑 |
| `video_generate` | 通过任务式视频 provider 进行可选视频生成 |
| `hunyuan3d` | 可选 3D 模型生成，包含预览图和 metadata |
| `todo_write` | 计划创建和更新 |
| `memory` | 持久化记忆读写 |
| `think` | 显式推理记录 |
| `background_task` | 后台长时间任务 |
| `spawn_agent`, `spawn_agents` | 子智能体创建 |
| `use_skill` | 按需加载 skill 指令 |

## Web UI

Web 工作台支持创建、切换、重命名、置顶、归档和删除会话；选择 provider/persona/审批模式；实时查看消息和工具调用；编辑历史消息并重新生成；编辑 skills/personas/config。

## 提问模式

两种会话级模式：`noquestion`（直接执行，默认）和 `question`（智能体在信息缺失时主动提问澄清）。

```bash
python cli.py --persona builder --question-mode question
curl -X PATCH http://localhost:8000/sessions/{id}/mode \
  -H "Content-Type: application/json" \
  -d '{"question_mode": "question"}'
```

## REST 与 WebSocket API

| 端点 | 用途 |
|---|---|
| `POST /sessions` | 创建/恢复会话 |
| `GET /sessions` | 列出会话 |
| `GET /sessions/{id}/state` | 会话快照 |
| `POST /sessions/{id}/messages` | 发送消息 |
| `PATCH /sessions/{id}/messages/{mid}` | 编辑并可选重新生成 |
| `POST /sessions/{id}/continue` | 从可恢复状态继续 |
| `POST /sessions/{id}/cancel` | 取消运行中的任务 |
| `POST /sessions/{id}/confirm` / `deny` | 批准/拒绝待审批工具调用 |
| `PATCH /sessions/{id}/approval-mode` | 更改审批模式 |
| `PATCH /sessions/{id}/mode` | 更改提问模式 |
| `GET /config/agents` | 列出智能体配置 |
| `GET /memory` / `POST /memory` | 管理记忆 |
| `GET /commands` | 列出项目命令 |
| `WS /ws/{session_id}` | 流式运行时事件 |

## 安全

内置控制：高风险工具（shell、powershell）的审批门禁、persona 作用域工具权限、输出上限、环境变量密钥、`web_fetch` 的 SSRF 保护、显式状态机控制运行时转换。如需暴露给不可信用户，请使用最小权限 persona、禁用不必要的工具、在受控网络中运行，并添加认证/限流/审计日志。

## 开发

```bash
pytest                              # 完整测试
pytest tests/test_engine.py         # 引擎测试
python scripts/loc.py               # 统计代码行数
```

## 常见问题

**Provider 不存在？** — 检查 `config.yaml` 中的 provider 名称，确认 `.env` 中的 `HARNESS_DEFAULT_PROVIDER` 指向其中一个名称。

**网页搜索无结果？** — 设置 `SERPER_API_KEY` 或 `BRAVE_SEARCH_API_KEY`；降级方案是有限的 DuckDuckGo。

**应该用 `uvicorn` 还是 `python -m uvicorn`？** — 始终使用 `python -m uvicorn`。裸 `uvicorn` 命令可能调用系统全局安装（如 pipx）的版本，使用不同的 Python 路径，无法找到虚拟环境中安装的项目依赖。

**避免 `uvicorn --reload`？** — 智能体写文件可能触发重启并中断会话。

**Skill 未自动触发？** — 确保其 `SKILL.md` 描述清晰。使用 `/<skill-name>` 手动调用。

## License

[MIT License](LICENSE)
