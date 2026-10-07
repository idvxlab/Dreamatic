# DreamaticArt

**从设计需求到经过审阅的设计方案、设计图与交互界面。**

DreamaticArt 是基于 Pi 的开源 AI 设计智能体系统。它组织多个具有明确职责的 Agent，完成需求澄清、资料研究、专业设计、方案审查和设计落实，并将过程与结果保存在本地项目中。你可以通过 macOS 桌面应用、Web 界面或命令行使用同一套设计能力。

官方网站：[https://www.dreamatic.art](https://www.dreamatic.art) · 源码：[GitHub](https://github.com/idvxlab/Dreamatic)

当前源码版本为 **2.0.3**。官网安装包可能与源码版本不同，请以下载页面和安装包版本为准。

![DreamaticArt](docs/assets/dreamatic-hero.png)

## 核心功能

### 多领域设计与两类交付

系统根据需求识别设计类型，支持品牌与视觉传播、工业与产品、建筑与空间、媒体等设计，以及 UX/UI 界面设计。一个项目可以包含多个设计领域。

| 设计任务 | 当前交付方式 |
| --- | --- |
| UX/UI 设计 | 根据经过审阅的方案，通过 HTML 编码工具生成 HTML/CSS/JavaScript 页面及本地交互 |
| 品牌、产品、工业、建筑、媒体等视觉设计 | 调用生图或图像编辑工具，生成设计图、不同视角及细节图 |
| 混合设计 | 按方案分别落实图像与 HTML 交付物，并通过指定的展示入口查看 |

设计方案与设计图用于表达和验证设计意图。当前没有 CAD、工程级 3D、视频或游戏引擎输出；HTML 交付支持本地交互，真实业务后端需要另行接入。

### 职责明确的设计工作流

```text
用户需求 → 需求澄清与调度 → 资料研究 → 专业设计 → 方案审查
                                           ↑           ↓
                                           └── 修改 ───┘
                                               审批通过
                                                   ↓
                                           执行方案 → Preview
```

| Agent | 职责 |
| --- | --- |
| Orchestrator | 理解目标，澄清不确定的需求，判断设计类型，组织和调度工作；不直接研究、设计或审计 |
| Researcher | 自主检索资料，并从用户提供的 URL、文件中提取有用文字与图片 |
| Designer | 按设计类型选择并加载独立、可复用的 Skill，形成明确、详细且可执行的设计方案 |
| Reviewer | 检查方案与用户需求的一致性、重要信息完整性和可执行性，审批或要求修订 |
| Builder | 机械执行 Designer 制定且经 Reviewer 审批的方案，不做二次设计审查；为图像交付编写具有层次的展示页面 |

Skill 提供领域知识和操作方法。Designer 选择性参考研究资料；当用户明确要求使用或复用指定文本、图片时，按照要求将相关材料纳入设计。

### 资料、项目与结果管理

- **资料输入**：通过对话提交 URL、图片和文档，并明确说明需要参考、提取还是原样复用。网页、文本及现代 Office 文件支持文字或图片提取；扫描件、PDF 和旧格式文件的提取能力存在限制，系统会报告无法提取的部分。
- **项目持久化**：保存需求、研究资料、方案、审查记录和交付物，可重新打开、重命名或移入本地回收站。
- **Canvas**：查看和排列参考资料、设计说明及生成结果。
- **Preview**：图像项目以有层次的展示页呈现；UX/UI 项目直接预览实际生成的 HTML 页面，多页面项目支持切换页面。
- **Export**：下载包含交付物、源文件、资源、方案与研究资料的 ZIP；保留相对路径，不包含会话和系统凭据。
- **中英文界面**：系统语言设置实时生效并在本机保存，对话框沿用系统语言；项目内容不会被自动翻译。
- **模型记录**：最终交付和 Preview 展示推理、生图或图像编辑模型信息。发布旧项目时，缺失记录按当前配置补录并注明来源，不覆盖已有记录。

### 发布与分享

完成图像设计后，可以从 **Preview → Publish** 将完整项目发布到官网 Gallery。发布前确认公开分享，并可填写姓名、组织和个人网站；不填写姓名时显示匿名用户。当前署名是轻量信息标识，不代表已验证账号。

发布过程显示打包、上传进度和部署等待状态，防止重复提交。同一项目再次发布时，确认后覆盖原作品，保留原链接。发布标识由系统生成，更新凭据保存在本机，不进入公开 ZIP。

**HTML 类型的 UX/UI 项目暂不允许通过 Publish 上传官网，包括含 HTML 交付物的混合项目。** 图像项目的 HTML 展示页不受此限制，HTML 项目仍可 Preview 和 Export。

## 安装

### macOS 桌面应用

适用于 **Apple Silicon Mac（arm64）**。

1. 在[官网](https://www.dreamatic.art/#download)下载 macOS 安装包。
2. 打开 DMG，将应用拖入 **Applications**，然后启动。
3. 点击左下角 **Designer → Settings（设置）**，配置推理和图像模型服务。
4. 点击 **New project（新建项目）**，开始设计。

桌面版内置运行环境，无需单独安装 Node.js。模型和搜索服务仍需要网络，模型调用使用你配置的 API 密钥。配置和项目保存在 `~/Library/Application Support/Dreamatic/`，应用升级后保留；源码版项目不会自动导入。

本地构建安装包使用 ad-hoc 签名。如果 macOS 阻止打开，请确认安装包来源后，在系统设置的“隐私与安全性”中允许打开。

<a id="web-and-cli-installation"></a>

### 从源码安装 Web / CLI

准备以下环境：

- Node.js **22.19 或更新版本**、npm **10 或更新版本**及 Git。
- 支持视觉输入的推理模型服务，兼容 OpenAI Chat Completions 或 Responses 协议。
- 进行图像任务时，需要兼容的生图／图像编辑服务。
- 系统 `PATH` 中可用的 `zip` 命令，用于导出和发布。
- 进行 HTML 浏览器验证时，需要已安装的 Chromium 系浏览器，如 Chrome；源码版不会自动下载浏览器。

```bash
git clone https://github.com/idvxlab/Dreamatic.git
cd Dreamatic
npm ci
cp .env.example .env
```

Windows PowerShell 使用 `Copy-Item .env.example .env`，并确保安装了可用的 `zip` 程序。

编辑 `.env`，填写自己的服务配置：

```env
DREAMATIC_API_KEY=your-reasoning-api-key
DREAMATIC_BASE_URL=https://your-reasoning-provider/v1
DREAMATIC_MODEL=your-vision-capable-model

DREAMATIC_IMAGE_API_KEY=your-image-api-key
DREAMATIC_IMAGE_BASE_URL=https://your-image-provider/v1
DREAMATIC_IMAGE_MODEL=your-image-model
```

推理服务默认使用 Chat Completions；使用 Responses 协议时设置 `DREAMATIC_PROVIDER_TYPE=openai-responses`。图像服务使用标准接口路径，非标准服务可单独配置生成和编辑端点。图像 API 密钥为空时沿用推理密钥。

网页搜索默认使用 DuckDuckGo，也可配置 Serper。各 Agent 的独立模型、超时、并发、重试及浏览器选项见 [.env.example](.env.example)。不要提交包含密钥的 `.env`。

### 启动 Web 界面

开发模式：

```bash
npm run dev
```

打开终端输出的地址，通常为 **http://localhost:5173**；API 默认运行在 **http://localhost:4310**。保持终端进程运行。

构建后运行：

```bash
npm run build
npm start
```

打开 **http://localhost:4310**。Web 与 CLI 默认共用仓库中的 `workspace/`；相对的 `DREAMATIC_WORKSPACE` 路径从仓库根目录解析。以上是本地使用方式，HTML 预览使用独立的本机服务地址。

## 使用方法

### 1. 配置服务并创建项目

进入 **Designer → Settings**，按“搜索、推理模型、图像模型、系统参数”填写服务信息。各 Agent 可以指定独立推理模型，未指定时使用默认模型。只保存修改过的字段，密钥输入留空会保留原值；端口和工作区变更需要重启。

**没有项目时，系统不会自动创建项目，对话输入、附件和发送按钮均不可用。** 点击 **New project** 手动创建项目后才能对话。删除最后一个项目后，对话会再次禁用。

### 2. 描述目标和材料要求

说明设计对象、受众、用途、风格、交付物和必须保留的内容。例如：

> 为一个当代茶品牌设计包装与主视觉。面向年轻消费者，采用克制的东方风格，交付包装主视图、使用场景和系列关系图。

> 根据我提供的网站 URL，提取并复用研究简介、论文文字和人物照片，设计一个响应式学术主页，包含中英文切换、论文筛选及移动端导航。

可以上传相关图片和文档。如果要求复用材料，明确指出要使用哪些文字、图片或页面内容。回答系统提出的澄清问题，再由各 Agent 推进工作。

### 3. 查看过程并预览成果

对话区域显示智能体进度，Canvas 展示项目资料与结果。完成后进入 **Preview**：

- **Open**：单独打开结果；桌面版使用预览窗口。
- **Export**：下载完整项目 ZIP；桌面版使用原生保存对话框。
- **Publish**：发布符合条件的图像设计项目。

解压导出包后，通过 `index.html` 进入预览。后续修改可在同一项目中继续提出，方案需要重新设计和审阅后落实。

### 4. 发布到官网

1. 在完成的图像项目中打开 **Preview → Publish**。
2. 核对目标网站，填写可选创作者信息。
3. 确认项目内容可以公开分享；如果作品已存在，同时确认覆盖。
4. 等待上传和部署完成，打开返回的作品链接。

默认目标为 [https://www.dreamatic.art](https://www.dreamatic.art)，可在系统参数 `DREAMATIC_SITE_URL` 中修改。官网首页展示最新作品，独立 Gallery 页面支持分类、搜索和分页，作品卡片展示署名、日期和模型信息。

发布 ZIP 上限为 **128 MiB**，包含设计输出、源文件和参考材料；系统会排除会话、私密运行记录和隐藏杂项文件。旧版本发布的作品如果没有本地更新凭据，不能自动认领并覆盖。

如果你维护 DreamaticSite，也可直接把项目文件夹复制到其 `gallery/<项目名>/` 中。网站识别 `final/artifacts/` 或 `artifacts/`，刷新后自动展示，无需重建前端。官网部署与目录配置见 DreamaticSite 项目文档。

### CLI 使用

```bash
# 首次使用前构建
npm run build

# 设计任务
npm run cli -- "为一个科技展览设计主视觉和海报系统"

# HTML 界面任务
npm run cli -- "设计一个响应式学术主页，包含论文筛选和移动端导航"

# 附加图片
npm run cli -- --image ./reference.png "保留标志，设计一套发布海报"

# 交互模式
npm run cli

# 机器可读事件流
npm run cli -- --json "设计一个产品概念"

# 原进程停止后，恢复已有任务
npm run cli -- --resume <run-id>
```

CLI 任务直接从命令行发起，不受 Web 界面的项目输入禁用状态影响。更多选项见 `npm run cli -- --help`。

## 开发与更新

DreamaticArt 使用 Pi SDK、Extensions、Skills 和会话接口扩展设计能力，Pi 保持为上游依赖。主要目录：

| 目录 | 内容 |
| --- | --- |
| `apps/web` | React 界面、Canvas 与 Preview |
| `apps/server` | HTTP/SSE、会话、资源及应用策略 |
| `apps/cli` | 命令行入口 |
| `apps/desktop` | macOS 桌面应用 |
| `packages/design-agent` | 设计工具、工作流和交付契约 |
| `.pi/agents`、`.pi/skills` | Agent 指令与专业 Skill |
| `workspace` | 本地项目与会话输出，不提交生成任务 |

```bash
npm run check
npm run build
```

更新源码后重新安装锁定依赖、构建并重启服务；刷新浏览器。仅构建不会更新已经运行的后端。

在 Apple Silicon Mac 上构建安装包：

```bash
npm run release:mac
```

发布分支必须命名为 `v<major>.<minor>.<patch>`，如 `v2.0.3`。脚本执行构建、检查、回归及桌面验证，生成 `release/DreamaticArt-<version>-mac-arm64.dmg` 和 SHA256 文件。桌面开发使用 `npm run desktop`。

## 常见问题

- **模型调用失败**：检查 API 密钥、服务地址、模型名称及协议；图像服务还需支持相应的生成或编辑接口。
- **没有项目，无法输入**：点击“新建项目”，系统不会自动创建空白项目。
- **更新后界面或行为没变化**：重新构建、重启服务并刷新浏览器；桌面版需使用重新构建的应用。
- **发布失败**：确认 ZIP 大小、官网版本与存储权限。官网并发队列可能要求等待；每 IP 的小时次数限制默认关闭，可由官网管理员配置。
- **官网手动删除作品后仍有本地记录**：发布对话框会核对官网列表；官网不可达时会保守保留不确定提示。
- **旧项目缺少模型记录**：发布包按发布时配置补录，并注明来源；这不代表已恢复历史实际使用模型。

进一步阅读：[系统架构](docs/ARCHITECTURE.md) · [设计与执行契约](docs/V2.0.3.md) · [性能与诊断](docs/PERFORMANCE.md)

## 许可证

[MIT](LICENSE)
