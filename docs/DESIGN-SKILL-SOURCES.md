# 设计知识 Skill 来源

调研日期：2026-10-11。新增 7 个可选辅助 Skill，沿用 `.pi/skills`、
设计方法与素材规范。旧运行时的加载工具已移除；本文仅保留知识来源。
本文件供维护者追溯，不注入智能体提示词。

## 来源筛选

星数通过公开 GitHub API 查询，仅表示整个仓库的关注度，不能推断单个
Skill 的安装人数或效果。筛选同时检查具体设计方法、许可证和运行环境。

| 仓库 | 查询时星数 | 阅读内容及许可证 |
| --- | ---: | --- |
| [anthropics/skills](https://github.com/anthropics/skills) | 180,310 | frontend-design、algorithmic-art；分别检查其 LICENSE.txt，均为 Apache-2.0 |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | 134,457 | 图标与展示策略参考；MIT |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | 79,320 | typeset、clarify、animate；Apache-2.0 |
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | 32,168 | web-design-guidelines 的路由方式；具体规则来自其链接的 web-interface-guidelines（MIT），不假定整个 agent-skills 仓库有统一许可证 |

无障碍要求另外核对 [W3C WCAG 2.2](https://www.w3.org/WAI/WCAG22/quickref/)。
公开热门库主要偏网页设计，因此本次补充可服务各领域展示的专项知识；
不把网页规则冒充工业、空间或服装领域的专业方法。

## 新增内容与边界

| Skill | 补充能力 | 与现有知识的分工 |
| --- | --- | --- |
| typographic-detail | 混合文字、光学对齐、数字与回退字体、内容适应 | visual-composition 管整体层级，本模块处理文字细节 |
| accessible-interface | 键盘路径、焦点恢复、语义、对比与缩放 | ui-web-design 管界面设计，本模块细化访问路径 |
| interface-writing | 术语、状态文案、错误恢复、本地化 | ux-design 管行为，本模块编写实际文字 |
| interaction-motion | 状态动效、中断、性能与减弱动画 | media-motion-design 管影视/静态关键帧，本模块管浏览器交互 |
| concept-showcase-storytelling | 概念命题、作品证据、阅读节奏与细节展示 | html-interface 管交付机制，本模块管展示内容与叙事 |
| icon-system | 符号语义、家族几何、尺寸适配与 SVG 表达 | brand-identity 管身份体系，本模块管图标细节 |
| generative-art | 程序化视觉规则、种子与参数、浏览器绘制 | illustration-art-direction 管画面指导，本模块增加生成过程设计 |

这些内容为跨领域设计知识，不指定新的智能体加载方式。
跨领域可用表示可辅助其图形或展示，不替代该领域的专业主 Skill。
HTML 类知识保留本地源文件组织与交付方法，不绑定旧角色执行协议。
不新增工具、模型调用、安装依赖、审批阶段、固定产物数量或第二套规格文件。

内容为独立编写的设计知识，参考方法而非复制上游正文、代码、数据或模板。
每篇保留具体来源链接。上游的命令、子智能体工作流、远程字体/CDN、强制
品牌模板及新模型生成脚本均未移植。来源链接用于追溯，不要求每次加载联网。

## 阅读快照

- Anthropic：`dbd4588f9e1033efb41dad4bef2f7947c8993d44`
- UI UX Pro Max：`50d8a7de0900119855614541f15a1a616691eb33`
- Impeccable：`d631a8827f99414d2b6daba4ef08b7f8701751d7`
- Vercel Agent Skills：`063bee94c3f4df8453406c830b0a7df0f2860278`
- Vercel Interface Guidelines：`434b7f91364665f2f733b310ec54809bf8f37937`

快照为调研时 GitHub API 返回的分支提交；正文阅读使用公开原文页面，
不是持续同步的镜像。升级参考资料应再次核对内容与 Dreamatic 执行边界。
