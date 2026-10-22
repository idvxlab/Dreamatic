# Skill 目录、命名与分类审查

审查日期：2026-10-15。对象为当前工作区，包含上一轮尚未提交的动态加载改动。
以下清单记录审查时的状态；随后按优先级进行了修复，见下方处理记录。

## 后续处理记录

- 保留全部 28 个有效 Skill 的名称、路径和现有知识内容。
- 为全部入口补齐能力标签和选用描述，为相邻或多类别专业补充选用边界。
- 收紧游戏、插画和服务设计的 UX primary 资格，保留其跨领域 supporting 用途。
  保留包装、导视和信息设计有依据的多类别归属。
- 编辑设计、游戏体验和媒体动效补充 HTML 输出；插画和物理产品仍以图像为核心。
- 移除没有入口且未被运行时代码使用的 canvas-html-publishing 配置和空的
  showcase-layout 目录；历史文档保持原样。
- 增加不依赖固定名称清单的结构校验，接入 npm run check 和 check:skills。
- 暂缓改名、强制版本号与长篇入口拆分；不手改构建副本。

当前字段含义、兼容行为与检查命令见 [Skill 加载规范](SKILL-LOADING.md)。
下文的数量、问题和表格均为修复前审查记录，不代表当前库仍有同样的问题。

## 结论与范围

形式规范较统一，语义边界与发现元数据还不充分。现有目录可以使用，但还不能
保证 Agent 仅凭名称、能力标签和类别就稳定选出恰当的知识。

源码 `.pi/skills` 有 30 个直接子目录：28 个有效 Skill、1 个只有界面配置的目录、
1 个空目录。28 个有效 Skill 均使用小写连字符命名，目录名与 frontmatter.name
完全一致，均有 description、一级标题和基本设计元数据。

有效 Skill 分为 17 个 discipline、9 个 cross_domain、2 个 execution，audience
均为 designer。只有 2 个声明 capabilities，7 个声明 version，7 个声明 license。
后两项不是当前加载的必填字段，缺失不等于加载失败。

另检查了 `.desktop-runtime/.pi/skills` 和
`release/mac-arm64/DreamaticArt.app/Contents/Resources/runtime/.pi/skills`：
各有 28 个入口文件，各有 9 个入口文件与源码不同。差异对应本轮工作区中的
Skill 改动，属于构建快照尚未同步，不能据此判定为独立的命名问题。
打包脚本会复制源码 `.pi`，后续发布应重新构建，避免手工维护多份 Skill。

## 需要处理的问题

### 1. 发现元数据覆盖不足，存在可复现的漏检

目前只有 html-interface 和 image-prompting 提供能力标签；其余 26 个 Skill
无法通过 capabilities 精确匹配。以 accessible-interface 为例，虽然正文讨论
无障碍，但名称和描述使用 accessible，domain_type 使用 accessible_interface，
没有 accessibility 标签。

用当前发现逻辑检查源码目录，`capabilities:["accessibility"]` 和
`query:"accessibility"` 都找不到任何内置 Skill。查询是子串匹配，不包含词形、
同义词或中英文语义转换；这不是 Skill 缺失，而是发现信息缺失。

建议为全部 Skill 补充稳定的能力标签，并在描述中覆盖常用术语。
标签可自由扩展，但同一能力应采用一致拼写；不必为每个标签增加程序分支。

证据：[无障碍 Skill 元数据](../.pi/skills/accessible-interface/SKILL.md)，
[发现过滤](../packages/design-agent/src/extension.ts)。

### 2. 有目录存在，却没有可加载的 Skill

- canvas-html-publishing 只有 agents/openai.yaml，没有 SKILL.md。
  配置中的默认提示引用了同名 Skill，但 Pi 无法从此目录发现它。
  需要先确认功能是否保留，再补全入口或删除遗留配置。
- showcase-layout 是空目录；历史文档仍提及它，但当前库中没有对应知识。
  历史版本文档可以保留历史记录，当前安装目录不应继续充当失效能力的暗示。

当前 Pi 目录发现没有为这两个目录产生诊断，因此 diagnostics 为空不能证明
所有 Skill 目录都完整。现有目录测试读取入口失败后直接跳过，也未覆盖此情况。

审查时遗留配置位于 `.pi/skills/canvas-html-publishing/agents/openai.yaml`，
现已清理；[原目录测试所在文件](../packages/design-agent/test/extension.test.mjs)
也已移除固定名称清单和读取失败后静默跳过的行为。

### 3. 名称不同，但专业责任重叠

product-design 与 industrial-design 都是 industrial 的专业模块，均面向硬件、
家具、人体工学、形态、材料和产品结构；正文也有明显交叉。二者各自合理，
但没有明确的“何时选我、何时选另一个”的分界。

建议 product-design 至少改为 physical-product-design，以消除物理产品与数字
产品的歧义；更关键的是决定二者合并，还是明确产品概念与使用体验、结构与
制造意图的分工。单纯改名不会解决内容重叠。

digital-product-design、ux-design、ui-web-design 的内容已有大致层次：产品价值
与能力、任务与交互、界面布局与状态。但三者描述未统一交代选用边界，且在
同一 UX scope 中都可充当 primary，容易使 Agent 只按词面选择。
建议保留这种专业分工，并在三份描述中明确各自的主要决策和相邻模块边界。

证据：[物理产品设计](../.pi/skills/product-design/SKILL.md)，
[工业设计](../.pi/skills/industrial-design/SKILL.md)，
[数字产品设计](../.pi/skills/digital-product-design/SKILL.md)，
[UX](../.pi/skills/ux-design/SKILL.md)，[UI](../.pi/skills/ui-web-design/SKILL.md)。

### 4. 专业归属与可辅助的领域混在同一个字段中

game-experience-design 声明 [game, ux]，illustration-art-direction 声明
[media_communication, ux]，二者都因此成为 UX 的合法 primary 候选；其
supported_outputs 却只有 image。

游戏经验、插画当然可以帮助界面设计，但“能帮助 UX”不必然意味着“能承担
完整 UX 专业责任”。当前按 module_type 和 design_categories 判断 primary
资格，无法表达这种区别。这是候选范围过宽的风险，不代表 Agent 每次都会选错。

建议 design_categories 只声明可承担 primary 责任的专业类别；跨领域贡献通过
能力、描述及 supporting 选择表达。exhibition-wayfinding、packaging-design、
information-design、service-design 的多类别归属也应逐项核对实际专业责任，
不要一律删除多类别支持。

证据：[游戏 Skill](../.pi/skills/game-experience-design/SKILL.md)，
[插画 Skill](../.pi/skills/illustration-art-direction/SKILL.md)，
[primary 候选生成](../packages/design-agent/src/extension.ts)。

### 5. 输出声明与正文不完全一致

editorial-design、game-experience-design、illustration-art-direction 和
media-motion-design 都只声明 image，但正文明确涉及 authored HTML 或浏览器
原型/动效。按 output:"html" 查询时，这些 Skill 都被过滤掉。

需要先统一 supported_outputs 的含义：它表示该知识可指导的交付媒介，还是
该专业最典型的输出。当前发现工具将其用作严格过滤，推荐采用前一种含义，
并依据实际内容补全。不能把“指导视频概念”误写成“运行时能生成视频”；
生产工具能力仍由运行时独立声明。

证据：[编辑设计](../.pi/skills/editorial-design/SKILL.md)，
[游戏体验](../.pi/skills/game-experience-design/SKILL.md)，
[插画](../.pi/skills/illustration-art-direction/SKILL.md)，
[媒体动效](../.pi/skills/media-motion-design/SKILL.md)。

### 6. 少数描述、名称与流程位置容易误解

- html-interface 实际指导 HTML 源码创作、资源映射、验证和提交，html-authoring
  更准确，也更容易与 UI 专业设计区分。module_type:execution 表示表达与交付
  方法，不表示 Designer 获得 Builder 的生产权限，应在规范中明确这一点。
- accessible-interface 建议使用 interface-accessibility，补齐标准术语的可检索性。
- typographic-detail 建议考虑 typography-refinement，直接表明是排版细化方法。
- concept-showcase-storytelling 的 description 写 approved design work，但
  Designer 在审批前就需要撰写完整展示页；容易被理解成审批后才能加载。
  建议表达为“组织已有设计提案”，并明确不负责批准设计。
- media-motion-design 与 interaction-motion 分别用于媒体叙事和浏览器微交互。
  后者描述已明确排除电影/分镜用途，这是值得其他相邻 Skill 采用的边界写法。

### 7. 元数据和文件组织的可维护性尚不统一

domain_type 有时重复名称，有时扩大或改变含义，例如 poster-advertising 对应
graphic_campaign_design、html-interface 对应 html_interface_expression；
design-system 又加入 cross_domain 前缀，与 module_type 重复。
目前它不是独立的受控分类注册表，不宜向使用者解释成另一套严格类别。

version 只有 7 个 Skill 提供，规范中应明确是否统一维护；正文 hash 已经用于
实际加载复用，版本号主要帮助人理解知识修订，不能替代内容 hash。
license 的填写也不一致，本轮只记录字段差异，未做外部许可证或来源合规审计。

全部有效 Skill 都有一级标题，名称与标题在语义上基本一致；每份通常有 3—5
个方法章节。html-interface 长达 232 行，同时承载方法、参考文献、运行时协议
和交互检查细节，明显重于多数 44—81 行的 Skill。可将按需查询的协议示例
拆到 references/，保留入口中的选用条件、核心方法和引用说明。

不建议为形式统一而给所有 Skill 机械添加 -design 后缀，也不建议仅因所有
Skill 当前位于一层目录就视为结构错误。平铺目录便于保持稳定路径；类别和
模块类型可以由元数据生成视图。若后续改路径，需同时考虑已保存名称和回执。

## 全部有效 Skill 清单

下表按当前 metadata 分类，D 为 discipline、C 为 cross_domain、E 为 execution。
空类别的 C/E 模块表示通用辅助知识，不是缺失分类。primary/supporting 是
scope 内的使用角色，不能简单当作 Skill 的固定目录类别。

| 当前名称 | 类型 | 当前专业类别 | 审查意见 |
| --- | --- | --- | --- |
| accessible-interface | C | 通用 | 改善 accessibility 术语与标签 |
| architecture-space | D | space | 范围清楚；可选统一为 architecture-space-design |
| brand-identity | D | media_communication | 名称与内容清楚，可保留 |
| concept-showcase-storytelling | C | 通用 | 澄清审批前使用；可考虑 design-showcase-storytelling |
| design-system | C | 通用 | 说明是跨交付物一致性体系，不仅是 UI 组件库 |
| digital-product-design | D | ux | 明确产品价值与能力层面的主要责任 |
| editorial-design | D | media_communication | 名称合理，补齐正文涉及的输出媒介 |
| exhibition-wayfinding | D | space、media_communication | 跨领域合理，明确空间与导视责任 |
| fashion-textile-design | D | fashion | 名称与范围清楚，可保留 |
| game-experience-design | D | game、ux | 核对 UX primary 资格和 HTML 输出 |
| generative-art | C | 通用 | 名称清楚，补算法与可复现性标签 |
| html-interface | E | 通用 | 建议 html-authoring，区分媒介方法与专业设计 |
| icon-system | C | 通用 | 名称清楚，区分图标设计与可编辑矢量导出 |
| illustration-art-direction | D | media_communication、ux | 核对 UX primary 资格与确定性文字输出 |
| image-prompting | E | 通用 | 名称清楚，保留生成/编辑规格边界 |
| industrial-design | D | industrial | 与 product-design 的专业边界需先解决 |
| information-design | D | media_communication、ux | 数据可视化可检索性可用标签增强 |
| interaction-motion | C | 通用 | 已明确浏览器范围，与媒体动效分界较好 |
| interface-writing | C | 通用 | 名称清楚，补 ux-writing、microcopy 等标签 |
| media-motion-design | D | media_communication | 明确概念设计与实际视频生产的区别 |
| packaging-design | D | industrial、media_communication | 多类别有依据，明确结构与图形责任 |
| poster-advertising | D | media_communication | 可考虑 poster-campaign-design，统一标题与领域措辞 |
| product-design | D | industrial | 建议 physical-product-design；与 industrial 明确分工 |
| service-design | D | service、ux | 核对 UX primary 责任，区分服务蓝图与界面设计 |
| typographic-detail | C | 通用 | 可考虑 typography-refinement，名称更直接 |
| ui-web-design | D | ux | 说明含移动界面；与 UX、数字产品区分 |
| ux-design | D | ux | 明确任务/信息架构/交互模型责任 |
| visual-composition | C | 通用 | 名称与内容清楚，可保留 |

## 建议采用的统一规范与处理顺序

1. 先处理失效目录、发现漏检、primary 资格过宽和输出声明不一致。
2. 再确定产品/工业、数字产品/UX/UI 的内容分工，最后决定必要的改名。
3. 对全部 Skill 统一元数据字段说明和描述模板，补能力标签及常用检索词。
4. 将长篇协议示例按需拆分，保留当前清楚的专业方法内容。
5. 为目录完整性、元数据、类别/输出合法性和标签覆盖建立结构校验；现有测试
   的固定名称清单只验证已知库，没有验证每个直接子目录都完整。
6. 改名时提供旧名称迁移策略，处理 Context.skill_selection、skill_refs 和历史回执；
   不要只改目录名，也不要把别名重新写成散落各处的加载条件。

推荐描述模板：主要负责的专业决策；何时选用；与相邻知识的边界；
交付形式和实际生产限制。稳定标识使用小写连字符；人类可读标题与标识保持
清楚的对应关系。category 表达专业归属，module_type 表达知识性质，capabilities
表达具体方法，supported_outputs 表达可指导的交付媒介，四者各司其职。

## 验证方式与限制

已读取全部 28 份源码入口及唯一的 agents/openai.yaml，检查目录、名称、标题、
描述、类别、输出和能力元数据；比较了两份构建快照的入口文件；通过当前
SkillCatalog 和实际筛选规则复核发现结果。未执行设计任务、外部引用链接核验、
专业知识正确性评审或许可审计，也未为本次只读审查重跑应用测试。
