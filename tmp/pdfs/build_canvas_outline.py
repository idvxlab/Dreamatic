from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import letter
from xml.sax.saxutils import escape
from pathlib import Path
pdfmetrics.registerFont(TTFont('CJK','/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
pdfmetrics.registerFont(TTFont('Times','/System/Library/Fonts/Supplemental/Times New Roman.ttf'))
pdfmetrics.registerFont(TTFont('TimesB','/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf'))
root=Path('/Users/nancao/Projects/Dreamatic/output/pdf')
styles={
'body':ParagraphStyle('body',fontName='CJK',fontSize=10,leading=16,spaceAfter=8,wordWrap='CJK'),
'heading':ParagraphStyle('heading',fontName='CJK',fontSize=14,leading=20,spaceAfter=12),
'sub':ParagraphStyle('sub',fontName='CJK',fontSize=11,leading=17,spaceBefore=5,spaceAfter=6),
'en':ParagraphStyle('en',fontName='Times',fontSize=11,leading=15,spaceAfter=8),
'small':ParagraphStyle('small',fontName='CJK',fontSize=8,leading=11.5,spaceAfter=7,wordWrap='CJK'),
 'title':ParagraphStyle('title',fontName='TimesB',fontSize=20,leading=24,spaceAfter=12),
}
story=[]; md=[]
def p(t,sty='body'):
 story.append(Paragraph(escape(t),styles[sty])); md.append(t+'\n')
def h(t): p(t,'heading');md.append('')
def sub(t):p(t,'sub')
def page():story.append(PageBreak());md.append('\n---\n')
def block(label,t):sub(label);p(t)
p('Dreamatic Canvas: Negotiating Emerging Design Intent through Visual References and Concept Groups','title')
p('Dreamatic Canvas：通过视觉引用与概念组协商逐渐形成的设计意图','heading')
p('ANONYMOUS AUTHOR(S) · Research outline / 研究计划 · 9 October 2026','small')
sub('ABSTRACT')
p('Early-stage visual design involves intentions that emerge through arranging, comparing, and reinterpreting materials. Chat-based generative systems require users to verbalize these intentions, while output-oriented canvases provide limited support for specifying which reference properties to adopt and which design decisions to preserve. We propose Dreamatic Canvas, an interaction prototype for a single designer collaborating with AI. The proposed system combines region-level visual references, concept groups, editable AI interpretations, and versioned design decisions to support a cycle of externalization, negotiation, exploration, and revision. We outline a formative study, a technical evaluation of intent translation and constraint preservation, and a controlled user study comparing chat, annotated canvas, and negotiable canvas conditions. The evaluation will examine intent misunderstanding, correction effort, conceptual diversity, artifact quality, and perceived agency. The intended contribution is an interaction model and empirical account of how emerging design intent can remain inspectable and revisable across creative iterations. This abstract describes planned work; no empirical outcomes are claimed.','en')
sub('摘要')
p('本研究聚焦单个设计师与 AI 的早期视觉创作。我们计划将 Dreamatic 的展示型画布扩展为意图协商空间：用户圈选参考属性、组织概念组、修正 AI 的解释，并在候选比较和局部修改中持续保留设计决定。研究将通过形成性访谈、技术评测及受控用户研究，检验这些机制对意图误解、修正负担、概念多样性与控制感的影响。本文件是论文提纲和执行计划，所有贡献、样本量与假设均有待实施和验证。')
sub('CCS CONCEPTS / KEYWORDS')
p('Human-centered computing → Human computer interaction (HCI); Interactive systems and tools. Keywords: human-AI co-creation; creativity support; visual references; design intent; spatial canvas.','en')
p('格式说明：按 ACM CHI 单栏 manuscript 的章节结构、标题层级、页码与数字引用组织；为中文研究讨论稿的版式适配，由 ReportLab 生成，未使用官方 acmart 编译，不是可直接提交的正式稿件。正式投稿需转为官方模板并复核目标年份要求 [7]。','small')
page()
h('1 INTRODUCTION / 引言')
block('研究内容','提出核心张力：设计意图通常在处理材料的过程中形成，而不是先完整形成再被执行。聊天要求用户提前语言化；展示型画布又无法把用户的视觉判断传递给 AI。论文关注“意图的形成与协商”，而非新增多 Agent 编排、生成模型或多人编辑能力。')
block('1.1 问题场景','以茶品牌包装为贯穿案例：用户喜欢 A 图的纸张质感、B 图的开合结构，希望自然但轻巧。AI 若把整张参考的颜色和器型都带入，便误解了引用范围。用户需要以局部引用表达偏好、检视解释，并在下一轮保留已确认的结构。')
block('1.2 核心研究问题','RQ1：局部视觉引用与概念组如何帮助用户表达尚未完整语言化的设计意图？RQ2：可编辑的 AI 解释如何影响误解发现、修正负担与用户控制感？RQ3：版本化设计决定如何支持跨轮次探索与约束保留，且是否限制意外发现？')
block('1.3 计划贡献','C1：一种将局部参考、概念组与可修订解释连接起来的意图协商交互模型。C2：实现上述模型的 Canvas 原型及可追踪的意图到执行适配机制。C3：关于其表达、探索和修订效果及代价的实证证据。不能将现有系统功能或未来预期效果表述为已证实贡献。')
block('本章任务与技术路线','收集至少三个真实的误解或返工片段；分别展示聊天指代、参考范围和跨轮保留的问题。绘制一张“材料 → 意图对象 → 协商 → 候选 → 比较与修改”的总览图。形成需求、机制、研究问题与测量的映射，并检查每项贡献是否有对应证据。')
h('2 RELATED WORK / 相关工作')
block('研究内容','组织四条文献线索：共同创造的沟通与轮流贡献 [1]；空间画布与直接操控 [2]；结构化探索及发散/收敛 [3,4]；显式设计语义和意图符合度 [5,6]。已有研究已经覆盖画布提示、历史回访和语义指导，不能以“Canvas 可与 AI 交互”作为新颖性声明。')
block('本章任务与技术路线','阅读全文后建立对照矩阵：引用粒度、意图是否可编辑、概念分组、跨轮保留、评价方式和应用阶段。重点比较局部属性是否能从参考引用延续到候选判断与修改。研究差异应由矩阵和形成性数据支持，而不是由系统名称或媒介差异推导。')
page()
h('3 FORMATIVE STUDY AND DESIGN GOALS / 形成性研究与设计目标')
block('研究内容','理解设计师如何使用参考、哪些意图难以语言化、何时希望 AI 解释、何时希望直接尝试，以及哪些旧决定应保留或允许被打破。验证 proposed 交互需求，而非只让参与者评价预设功能。')
block('3.1 参与者与活动','计划招募 8–12 名有视觉、品牌或包装经验的设计师，作为初始招募范围而非充分性承诺。结合近期作品回顾和一项短设计任务。先观察自然工作，再使用纸面/低保真原型讨论。记录参考选择、局部指代、候选比较、意外发现与返工片段。')
block('3.2 数据与分析','采集屏幕记录、口述、作品轨迹和访谈。采用反思性主题分析，说明研究者立场、编码演变和反例；不将编码者一致性强行作为该方法的有效性标准。观察性行为计数另用明确代码本，在抽样片段上校准标注。')
block('3.3 初始设计目标','DG1：允许不完整表达，便签和参考可以先于结构化决定。DG2：将参考作用限定到局部和属性，减少整体误借用。DG3：AI 解释可查看、可修改，确认不应成为每一步的强制门槛。DG4：保留空间组织和版本，让旧想法可回访。DG5：同时支持保留决定与主动放开约束，避免早期锁死。')
block('本章任务','编制访谈提纲、任务说明、同意书和记录方案；完成伦理审查或所在机构要求的审批。把观察片段映射到设计目标，并记录不支持原假设的案例。根据反馈删减不必要的标签与确认步骤。')
block('技术路线与产出','先使用可移动图片、区域框、概念组和解释卡的低保真原型，不接生成模型。以“观察 → 初始目标 → 原型 → 反例 → 修订目标”迭代，产出经证据支持的交互需求、设计理由和机制边界。')
h('4 INTERACTION MODEL / 意图协商交互模型')
block('研究内容','定义闭环：外化材料 → 指明参考作用 → 组织概念组 → 查看/修正解释 → 探索候选 → 比较局部优点 → 保留或修改决定。允许跳过解释直接探索，也允许回到材料重组；不是强制线性向导。')
block('4.1 对象与状态','对象包括素材引用、区域引用、自由便签、概念组、意图条目、候选和比较记录。意图状态为用户表达、AI 假设、用户采纳、被替代/撤回。采纳表示当前方向认可，不是永久硬约束；每条意图有范围和可变性。')
block('本章任务与技术路线','绘制对象关系、状态转换和关键交互序列。用同一案例验证：一个素材可被不同组以不同属性引用；空间邻近不自动意味着组合；确认意图不等于证明结果已满足它。最终形成可复用的交互原则，而非纯功能清单。')
page()
h('5 SYSTEM DESIGN / Canvas 原型设计')
block('5.1 稳定且可组织的空间','研究内容：空间布局作为用户思考记录。任务：实现增量放置、多选、真实分组、便签、缩放、撤销和素材多重引用。技术路线：分离资源标识与画布实例标识，组维护成员关系；新结果放到发起操作的组附近；自动整理只在用户请求时作用于选中范围。')
block('5.2 局部引用与属性表达','研究内容：用户表达“参考哪里、参考什么、用于哪个方向”。任务：实现区域框/自由圈选、参考/保留/避免以及自由说明。技术路线：存储原图坐标系中的归一化区域、资源版本和属性描述；提供原图与裁剪上下文。区域引用、像素复用、编辑蒙版分别建模，防止圈选被错误解释为复制。')
block('5.3 概念组与可编辑解释','研究内容：一个方向成为可独立探索的上下文。任务：组内组织材料与目标；AI 返回简短解释、待确认假设和矛盾。技术路线：按组提取显式关系，AI 推断单独呈现；用户修改解释或直接探索。只有关键歧义可能导致高返工时，提出针对性澄清，不以数值置信度制造虚假精确性。')
block('5.4 有目的的探索操作','研究内容：候选服务于设计假设。任务：支持探索其他方向、细化、改变指定属性、组合局部优点。技术路线：请求携带目标、允许变化项和保留项；结果卡附一句“本次测试什么”。概念探索可使用说明、草图或局部视觉试验，不必每次执行完整交付流程。')
block('5.5 比较、派生与局部修改','研究内容：把视觉判断转成下一轮材料。任务：支持 2–4 个候选比较，标记值得保留的局部，组合后派生新方向。技术路线：比较记录链接候选版本与区域；局部修改请求同时携带变化项和保留项；生成后展示新旧候选与尚未验证的条件。避免默认总分和自动宣布赢家。')
block('5.6 历史回访与约束释放','研究内容：保持探索可逆，保留暂不采用的方向。任务：记录派生、采用、放弃理由，支持恢复旧方向和主动释放某条保留约束。技术路线：非破坏性版本关系和按需展开的历史；取消或撤回请求不删除既有结果。将“已采纳”与“已验证满足”分别显示。')
block('本章总体产出','图 1：完整使用场景；图 2：局部引用与解释修正；图 3：候选比较与派生。正文以交互目的和设计理由组织，避免用 API 清单代替系统说明。首轮研究仅覆盖静态品牌/包装概念，不扩张到工程 CAD、多用户或所有设计门类。')
page()
h('6 IMPLEMENTATION / 技术实现与系统集成')
block('6.1 现有能力与待实现能力','当前已有：素材与文本展示、拖动/缩放、状态保存、HTML 预览、设计规格与执行契约。待实现：用户可写对象、实际分组、区域引用、意图语义、局部操作请求、解释协商、比较与非破坏版本。当前新素材触发整体重排，优先改为增量同步。本文不将计划能力写成已经存在。')
block('6.2 数据模型','Asset 保存资源来源与内容哈希；CanvasInstance 保存位置及 resourceId；RegionReference 保存资源版本、归一化区域和上下文；ConceptGroup 保存成员和方向；Intent 保存文字、来源、作用范围、状态与可变性；Candidate 保存执行请求及派生关系；Operation 保存请求版本、状态和结果。布局改变不自动改变意图。')
block('6.3 意图到执行的适配','选择范围 → 结构化上下文 → 模型解释 → 用户可选修正 → 请求快照 → 设计任务 → 结果关联。上下文仅包含所选概念组及必要来源，不把整张画布截图当唯一输入。解释输出需符合 schema，来源指针与资源路径用确定性校验；无法支持的编辑方式明确返回能力边界。')
block('6.4 探索与正式交付','增加 exploration 请求语义，允许 Designer 生成小范围草稿，不触发完整交付。用户选择成熟方向后，将采纳意图投影到现有设计 context，进入 Reviewer 与 Builder 契约。探索产物带草稿标识；不绕过正式规格审批，不修改 Pi 上游运行时。')
block('6.5 异步、版本与恢复','每次请求绑定组与意图快照，模型运行期间允许继续整理。若组已被修改，返回结果标注“基于上一版本”，避免覆盖新决定。请求用幂等标识关联重试，状态包括 pending/running/completed/failed/cancelled；撤销布局和取消执行是不同操作。')
block('6.6 模型能力与验证边界','视觉参考、近似风格保持和精确像素保留使用不同任务约束。优先使用可信复制满足原样复用；生成式保持需另行检查。试验用语义标注不承诺精确几何控制，避免把属性滑块描述成底层模型的连续可控参数。')
block('本章任务与技术路线','apps/web 实现直接操控和对象视图；apps/server 保存对象、请求与版本；packages/design-agent 实现意图适配与探索任务；.pi/skills 提供设计知识。沿用 Pi SDK、会话和工具协议。测试围绕有意义的失效：引用版本失配、错误范围、过期结果、重复请求、撤销后恢复与正式交付契约失效。')
page()
h('7 TECHNICAL EVALUATION / 技术验证')
block('研究内容','先确认系统能正确传递意图，再研究体验效果。区分两类问题：翻译阶段遗漏/扩张了要求；模型接收正确要求但生成没有实现。否则用户研究难以解释失败来源。')
block('7.1 评测材料','计划构建约 40–60 个小型案例，包含属性引用、区域引用、冲突参考、跨轮保留、方向切换和释放约束。由设计师给出预期含义与可接受解释范围，避免只有唯一文字答案。数据按项目和来源拆分开发/测试，保留未见参考与任务。规模根据先导标注负担调整。')
block('7.2 翻译正确性','比较聊天文本上下文、区域标注上下文和完整协商上下文。以人工标注的必要意图为依据，测意图遗漏率、无依据新增要求率、来源归属正确率和引用范围错误率。报告语义分歧，不把模型自评作为真值。')
block('7.3 修改与保留','对每个候选标注本轮变化项与应保留项。人工盲评分别判断修改实现、保留实现和非目标属性破坏。记录单位有效候选的调用成本、延迟与失败率。程序验证用于哈希、资源引用与文件状态；视觉或审美判断需要独立证据。')
block('本章任务与技术路线','制定标注手册、预先固定测试集、冻结模型配置与提示版本。关键评分采用至少两名独立标注者，报告一致性与争议处理。运行多次随机生成并记录种子（若支持）；分析以案例/项目为单位，不把同一案例的重复图片当独立样本。')
block('判定与修改','若对象指代仍频繁错误，先修复引用与上下文再进入主实验；若翻译正确但保持能力弱，收窄任务或调整操作表达。失败本身应被报告，不为获得正向效果排除困难案例。')
h('8 USER STUDY / 受控用户研究')
block('8.1 研究内容与假设','H1：局部标注相较聊天减少意图误解与修正负担。H2：可编辑解释相较只有标注提高误解发现和控制感，但可能增加操作负担。H3：意图协商与版本记录支持跨轮保留和概念探索；探索效果使用双侧分析，不假定结构化必然提高创造力。')
block('8.2 三个条件','A：聊天与图片附件；B：稳定画布、局部标注、概念组与基础历史，直接提交结构化请求；C：B 加可查看、可编辑的 AI 意图解释。B 与 C 的比较主要识别协商机制的增量效果；A 与 B 只解释为整体交互方式差异，不归因于某个单独组件。')
page()
h('8 USER STUDY (CONTINUED) / 用户研究续')
block('8.3 样本与实验设计','计划先进行 4–6 人先导研究，校准任务、时长和测量；主研究可从 24–36 人的设计范围估算，最终依据最小关注效应、先导方差与功效模拟确定，不将此范围当作既定充分样本。采用被试内设计，使用六种条件顺序和轮换任务匹配顺序/学习效应。')
block('8.4 任务与流程','准备三项难度接近的品牌/包装概念任务，避免相同主题的直接复用。每项要求：选择性借用参考 → 探索不同概念 → 选择/组合 → 响应一轮新要求且保留指定属性。任务约 20–25 分钟，以先导研究调整。培训、练习、实验、回顾访谈分开；使用中性说明，避免暗示 C 条件更先进。')
block('8.5 控制与记录','条件共用模型、生成工具、素材访问、参数及相同最大调用/时间预算；报告实际使用而非强制填满预算。实验期间冻结版本，记录 API 故障与恢复规则。两种条件都提供可比的视觉查看与结果回访能力；C 的解释成本计入实际负担。')
block('8.6 指标与分析','预设主要指标为经标注的意图误解事件数及修正时间/行动负担；先导后固定一个主要端点或明确多重比较校正。次要指标：盲评意图符合度、新颖性与适用性、概念多样性、跨轮保留、主观控制感与工作负荷。概念多样性按设计机制分类，不用图片数量或嵌入距离直接替代创造力。')
block('8.7 统计与质性解释','使用适合计数/连续/有序数据的混合效应模型，参与者和任务作为随机效应，条件、顺序和经验作为预设项。报告效应量、区间、缺失与排除。作品匿名盲评，评分者无法看到条件；质性分析解释用户何时接受、纠正或跳过解释，以及意外发现是否被限制。')
block('本章任务与技术路线','完成预注册、样本量依据、任务平衡表、日志代码本、盲评材料及访谈脚本。记录 consent、数据最小化和参与补偿。分析主/次要指标时分开表达证据强度；满意度提升不能证明创造力提升。')
h('9 RESULTS / 结果章节的写作计划')
block('研究内容、任务与路线','目前无结果，本章只规划报告结构。9.1 报告样本与运行情况；9.2 意图误解及修正；9.3 作品质量和概念探索；9.4 跨轮保留；9.5 控制感、工作负荷与机制体验；9.6 失败与反例。每节给出定量差异、区间、代表性过程片段与解释边界。图表待实验后填入，不预置提升百分比、显著性或正向结论。')
page()
h('10 DISCUSSION / 讨论')
block('研究内容','围绕三项张力解释结果：显式意图是否帮助表达或过早固化；解释确认是否建立共同理解或打断创作；保留旧决定是否保障控制或减少意外发现。讨论用户跳过、修正和主动释放意图时的行为，而不把所有变化归为系统失败。')
block('本章任务与技术路线','从数据提出有边界的原则：局部引用帮助细粒度表达；概念组限定上下文；推断必须可修订；确认应与后果匹配；版本记录支持回访。每条原则链接证据和反例。与空间提示 [2]、结构化探索 [3,4] 和语义指导 [5,6] 比较，指出支持、扩展或冲突。')
block('10.1 与 Dreamatic 主论文的关系','本子论文的分析单位是用户的视觉表达、AI 意图解释和迭代决定。Dreamatic 全系统的多 Agent 工作流、工具编排、广泛设计门类与交付可靠性不作为本篇主贡献。系统架构只作为实现背景；如后续主论文复用同一数据，应披露并清晰区分问题与分析，避免重复贡献。')
block('10.2 局限性与伦理','静态品牌/包装任务不能代表全部专业设计；短时实验不能证明长期实践效果；生成模型与文化语境会影响结果；解释文本可能诱导用户迎合 AI。处理参考授权、作品隐私与数据留存。精确工程、多人创作和自主代理行为不在本研究范围。')
h('11 CONCLUSION / 结论')
block('研究内容、任务与技术路线','最终以实证结果总结哪些交互支持了意图形成、协商和修订，哪些增加负担或限制探索。在数据尚未完成时，结论仅写研究目标和贡献计划。避免宣称提升普遍创造力；将推广范围限定为实际研究任务、参与者和模型条件。')
h('APPENDIX A / 执行顺序与最小研究原型')
block('阶段 A：研究准备','完成相关工作矩阵与形成性访谈。验收：至少有真实过程片段支撑核心问题，并明确最接近已有系统的差异。若差异不足，调整研究问题再扩展工程。')
block('阶段 B：最小闭环','依次实现稳定布局/分组 → 区域引用/便签 → 概念组请求 → 可编辑解释 → 候选关联 → 比较和保留/修改。验收：一个完整案例能跨两轮运行，已有卡片不被重排，来源与旧版本可回访。')
block('阶段 C：验证与实验','先验证语义翻译及修改保持，再进行先导与主研究。验收：条件实现对等、任务平衡、预注册和测量方案固定。最后完成结果、讨论和贡献重写。主动介入、连续风格滑块、大规模推荐暂不加入，减少机制混杂。')
page()
h('APPENDIX B / 研究问题与证据映射')
block('RQ1：意图表达','机制：局部引用、属性说明、概念组。证据：形成性片段、A/B 条件比较、翻译遗漏和范围错误。能支持：表达与纠错差异。不能单独支持：普遍创造力或自主规划提升。')
block('RQ2：意图协商','机制：可编辑解释、关键歧义澄清、可跳过确认。证据：B/C 比较、误解发现、实际修正负担和控制感。能支持：解释协商的增量价值与代价。不能支持：自然语言解释必然忠实于模型内部推理。')
block('RQ3：迭代设计','机制：比较记录、保留/改变范围、版本与释放约束。证据：多轮任务、保持评测、回访轨迹和探索盲评。能支持：此任务中的迭代效果。各条件共有历史，主实验不能单独证明历史组件的因果作用；若需此结论另做消融。')
h('REFERENCES / 参考文献')
refs=[
('[1]','Jeba Rezwana and Mary Lou Maher. 2022. Designing Creative AI Partners with COFI: A Framework for Modeling Interaction in Human-AI Co-Creative Systems. arXiv:2204.07666.','https://arxiv.org/abs/2204.07666'),
('[2]','Nicolai Marquardt et al. 2025. ImaginationVellum: Generative-AI Ideation Canvas with Spatial Prompts, Generative Strokes, and Ideation History. UIST 2025. Microsoft Research publication record.','https://www.microsoft.com/en-us/research/publication/imaginationvellum-generative-ai-ideation-canvas-with-spatial-prompts-generative-strokes-and-ideation-history/'),
('[3]','Luminate: Structured Generation and Exploration of Design Space with Large Language Models for Human-AI Co-Creation. 2023. arXiv:2310.12953.','https://arxiv.org/abs/2310.12953'),
('[4]','Chao Wen et al. 2026 (revised preprint). Exploration vs. Fixation: Scaffolding Divergent and Convergent Thinking for Human-AI Co-Creation with Generative Models. arXiv:2512.18388v2.','https://arxiv.org/abs/2512.18388'),
('[5]','Seokhyeon Park et al. 2026. Bridging Gulfs in UI Generation through Semantic Guidance. CHI 2026. DOI: 10.1145/3772318.3791966.','https://arxiv.org/abs/2601.19171'),
('[6]','Hyewon Lee et al. 2026. GUIDE: Designer-in-the-loop Authoring of Conformant Generative User Interfaces. Preprint, arXiv:2609.21285.','https://arxiv.org/abs/2609.21285'),
('[7]','ACM CHI 2027. CHI Publication Formats. Official formatting guidance; accessed 9 October 2026.','https://chi2027.acm.org/chi-publication-formats/')]
for n,t,u in refs:
 p(n+' '+t,'small');story.append(Paragraph('<link href="'+u+'" color="#164d84">'+escape(u)+'</link>',styles['small']));md.append(u+'\n')
p('参考文献为提纲阶段经核对的阅读入口，部分采用预印本信息和简略作者表；正式稿需从原文导入完整 BibTeX，并阅读全文核对机制与研究差异。','small')
p('实现依据：Dreamatic 当前工作区的 Canvas.tsx、canvas-store.ts、types.ts、App.tsx 与 docs/DESIGN-CONTEXT.md；其中统一上下文部分包含尚未提交的本地修改。代码观察说明当前状态，不等同于运行测试或用户研究证据。','small')
def footer(c,d):
 c.saveState();c.setFont('Times',8);c.setFillColor(colors.HexColor('#555555'));c.drawString(54,756,'Dreamatic Canvas | Research Outline | ACM CHI manuscript-style adaptation');c.drawString(54,30,'Research plan; no empirical results claimed.');c.drawRightString(558,30,str(d.page));c.restoreState()
doc=SimpleDocTemplate(str(root/'Dreamatic_Canvas_CHI_Outline.pdf'),pagesize=letter,rightMargin=54,leftMargin=54,topMargin=57,bottomMargin=51,title='Dreamatic Canvas: CHI Research Outline',author='Research outline')
doc.build(story,onFirstPage=footer,onLaterPages=footer)
(root/'Dreamatic_Canvas_CHI_Outline.md').write_text('\n'.join(md),encoding='utf-8')
print(root/'Dreamatic_Canvas_CHI_Outline.pdf')
