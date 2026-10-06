# Agent Action 故障分析与修复（2026-10-05）

## 排查依据

检查了现有任务的 Run 文件、各 Agent 会话、工具结果和批准的 HTML 源码。重点任务为 `project-2026-10-05-cb33446c`（学术先锋 · 教授主页）：共记录 54 次失败 Action，Designer 12 次、Builder 36 次、Orchestrator 5 次、Reviewer 1 次。其中 `build_finalize` 27 次；该任务启动了 7 次 Builder。重复失败不代表 54 个独立缺陷。

上一任务 `project-2026-10-05-b9eb6533` 的 Researcher 会话记录为 aborted，不能据此认定模型服务故障。部分权限拒绝正确保护了成果和阶段边界；应修正调用方式，而不是取消保护。

## 主要原因与修改

| 原因 | 现场表现 | 修复 |
| --- | --- | --- |
| Specialist 原生工具使用 Run 相对路径，但实际解析到仓库根目录 | Researcher、Reviewer 的 write 被权限守卫拒绝 | 将已分配 Run 内的规范相对路径解析到该 Run；保持跨 Run、目录逃逸和角色权限检查 |
| UX 页面视觉风格被拆成独立媒体交付，领域覆盖要求又强制独立成果 | Designer 反复补计划，出现 CSS 类型伪页面和重复交付 | 补充分类指导；支持 `contributing_scopes`，明确多个领域共同贡献一个成果，保留每个领域的主 Skill、实际加载和覆盖校验 |
| Skill 计划角色与实际加载角色不一致 | 主 Skill、支持 Skill 校验失败 | 发现结果明确 primaryEligible，校验报告实际加载角色；跨领域通用 Skill 不能替代专业主 Skill |
| JSON 补丁使用错误 SHA、数组追加语义不足 | stale hash 和补丁失败 | 指明使用工具返回的完整 SHA，错误返回当前 SHA；支持 `/array/-` 追加，保留原子写入和结构校验 |
| Builder 手工重写 Designer 已批准的整页源码 | 长输出截断、缺少 write path、源码漂移、edit 权限拒绝 | HTML 工具直接落地批准源码；阻止原生工具覆盖映射输出，纯 HTML 任务按执行配置收紧写工具；旧图片和未映射 Gallery 路径保留 |
| HTML 静态规则误拒绝联系链接 | mailto 被移除后又违反批准源码一致性 | 允许导航中的 mailto、tel、查询、锚点及外部 HTTPS；嵌入资源仍检查，不允许脚本协议 |
| 浏览器断言混淆集合、单一动作目标和响应式条件 | 多匹配严格模式错误；桌面点击隐藏移动菜单，移动端点击隐藏桌面导航 | 可见断言默认任一匹配可见，隐藏默认全部隐藏或不存在；断言支持 any/all/unique，操作仍要求唯一目标；检查支持 viewport 范围，每项检查独立记录结果 |
| 设计失败与执行失败没有明确修复归属 | Orchestrator 反复调用 Builder，同一错误反复 finalize | 返回带 repairOwner 的结构化阻塞，保存审核版本与运行时指纹；同一批准版本和运行时阻止重复启动，Designer 修复并重新批准后可继续；正确记录 blocked，不伪造 build_done |
| 服务器 PATH 缺少已安装的 rg | Pi grep 工具无法发现搜索工具 | 使用 `DREAMATIC_TOOL_PATH` 显式添加本地工具目录，继续使用 Pi 原生工具解析，不复制 Pi 运行时 |

## 原任务回放与尚需修正的设计规格

仅复制原任务的 plan 到临时目录，使用批准的源文件通过 HTML 工具生成临时成果，再用本机 Chromium 验证。原任务文件、批准记录和历史成果均未修改。

静态检查通过。原计划的 7 组交互在 4 个视口上产生 28 项结果：18 项通过、10 项失败。论文年份筛选、主题筛选和加载更多在全部视口通过；修复后没有集合匹配导致的严格模式错误。

余下 10 项是原验收规格与实际页面不一致：移动菜单检查错误地在 1440、1024、768 宽度执行（3 项），桌面导航在 390 宽度执行（2 项），移动菜单使用 `.mobile-nav.open` 而实际是 `.mobile-nav-overlay.open`（1 项），计数器期待 `.animated` 类而实际 JavaScript 只更新数值（4 项）。

Designer 应按已有 CSS 的 767px 分界给检查设置 `viewport: {max_width: 767}` 或 `{min_width: 768}`，纠正移动菜单选择器，并根据计数器实际数值和进入视口后的行为重新设计验收。不能通过跳过所有检查或由 Builder 偷改已批准方案来消除失败。修改计划或源码后，必须再次由 Reviewer 审核，随后 Builder 机械落地。旧任务仍保留其原来的失败状态。

## 验证和使用

新增回归覆盖 Run 相对路径及越权、共享成果的领域覆盖、实际 Skill 角色、批准 HTML 的写入保护、JSON 追加和过期 SHA、联系链接、确定性阻塞和重新审核后的恢复、真实浏览器的响应式与集合断言，以及 Pi 原生 grep 的工具目录配置。

没有调用真实图片或文本模型做质量对照评估；本地测试证明执行合同和已有回归行为，不能证明模型创意质量绝对不变。原图片生成与编辑工具链未替换。现有 Agent Markdown 仅增补局部协议说明；Researcher 未修改，已有非 UX Skill 的知识正文未修改。

更新后需要重启 DreamaticArt 服务以载入新工具和环境配置。`DREAMATIC_TOOL_PATH` 是本机配置，可指定已安装 rg 的绝对目录；不自动下载搜索工具或浏览器。


## write_json 项目归属冲突（后续排查）

2026-10-05 15:14 的失败来自交接 ID 错误，不是设计系统 JSON 格式错误。
父会话 run_init 返回 `project-2026-10-05-e3d73c65`，Researcher 使用同一 ID；
但 Orchestrator 启动 Designer 时传入 `project-2026-10-05-e3d73c73`。
旧启动路径未校验会话归属，也允许缺少 Brief 的 Run 启动，直到 write_json
被项目归属守卫拦截，造成运行时分配与权限要求冲突。

现在 spawn_agent 在创建子会话前验证规范 Run ID、交接路径和已有 Brief；
所有 Run 工具沿用相同的项目归属检查，错误包含正确 ID 和恢复说明。
会话恢复或首次绑定项目后，扩展通过服务器提供的动态归属读取器继续执行
同一保护；子 Agent 获取启动时的固定归属。错误 ID 不会被静默改写。
原错误 Run 和历史会话保留，未迁移、覆盖或删除。恢复应由 Orchestrator
用 run_init 已返回的规范 ID 重新启动 Designer，继承正确项目的研究成果。


## Builder subset execution and conditional approval (2026-10-05)

Run `project-2026-10-05-08bcc1c0` approved both an HTML page and a required
concept-board image. Builder called `execute_design_plan` with only the HTML
task id. The missing-image finalization check was correct: HTML presentation
is an entry point, not permission to omit approved images. Subset execution
now returns `deliveryComplete` and `pendingOutputs`; incomplete finalization
returns a retryable Builder-owned result without committing `build_done`.
Re-executing the full plan reuses completed outputs and preserves image prompts.

Reviewer had passed an open major research-filter defect. Runtime formerly
rejected only open blocking issues, and valid hash receipts skipped semantic
checks. Pass publication and consumption now reject open blocking/major issues,
including historical passes with valid receipts. Builder launch is prevented,
and finalization returns Designer repair ownership. Minor suggestions and
explicit accepted risks remain permitted. Required fixes go through Designer
and a new Reviewer approval; Builder never silently patches approved sources.
Only small protocol clarifications were added to Reviewer/Builder prompts.
Historical Run files and events were not rewritten.


## Latest Designer/Builder log audit (Run 08bcc1c0)

The later invocations exposed additional contract gaps:

- `execute_design_plan`: `Plan design-concept-board needs acceptance criteria`.
  Designer supplied `acceptance`, which publication accepted while execution
  did not. Publication and executor now use the same criteria reader, including
  the approved manifest's acceptance test as fallback. No prompt is reconstructed.
- HTML checks placed `viewport` inside a step. Parsing silently discarded it,
  causing desktop hamburger clicks and mobile desktop-navigation clicks to
  time out. Unsupported placements now fail during specification validation,
  with the exact check/step and correct location. Real CSS breakpoint applicability
  and unique action selectors remain Designer responsibilities; controls and
  required viewport coverage must not be deleted to evade failures.
- Designer revision invocations repeatedly published without loading retained
  Skills, then loaded only professional primaries. Fresh sessions now receive a
  complete, executable reload checklist for both primary/supporting selections,
  in the runtime handoff and design_context_read. Each load lists remaining
  modules. Historical activation receipts still cannot substitute for knowledge.
- Native `read` used `runs/<id>/...` under the repository cwd rather than runtime
  workspace. Native path handling now resolves that explicit form to workspace,
  retaining cross-Run and traversal rejection.
- `image_generate` omitted required runId after the failed plan execution.
  The criteria fix removes that need for manual fallback; existing required Run
  identity validation remains intact. No missing identity is guessed.
- Image size above configured ceiling, nonunique click selectors and hidden
  controls are valid rejections, not permission to weaken validation.
- The last Designer session records `This operation was aborted`, with no
  recorded cause sufficient to attribute it to model/network/runtime failure.

Earlier missing-output recovery and open-major approval gates remain fixed.
This audit updates system code, not historical artifacts, approval receipts or
Run state. The interrupted Run still requires an actual corrected Designer
specification, new Reviewer approval and successful Builder validation.


### Audit status and verification

| Logged problem | Status after this audit |
| --- | --- |
| Required concept-board image missing after HTML-only execution | Already fixed: pending-output inventory, recoverable finalization, full-plan reuse |
| Reviewer pass with unresolved major filter defect | Already fixed: pass publication and consumption reject open major/blocking issues |
| `Plan design-concept-board needs acceptance criteria` | Fixed here: shared reader accepts declared `acceptance` and approved manifest fallback |
| Viewport inside click/assertion steps silently ignored | Fixed here: specification validation gives indexed error before approval/execution |
| Fresh Designer repeatedly missing primary/supporting loads | Fixed here: full retained selection checklist in handoff/context and remaining modules after each load; no implicit activation |
| Native `read` of `runs/<id>/...` under repository root | Fixed here: assigned Run resolution with traversal/sibling rejection |
| Missing runId in direct image generation | Valid identity rejection; full-plan execution no longer fails on the alias, so mechanical recovery needs no hand-written image call |
| Image exceeds configured 1024x1024 envelope | Valid rejection; later task was corrected to 1024x768 |
| Click selector matches two paper/nav elements | Valid rejection; Skill now explains scoped selectors and why first-of-type may remain ambiguous |
| Mobile/desktop hidden controls click timeout | Valid rejection; use the actual CSS breakpoint and a mobile menu opening step |
| Last Designer session aborted | Recorded interruption; log alone does not establish its trigger |

The page CSS switches navigation at **1199px**, not 767px: tablet width 768px
also needs mobile-menu interaction. Merely moving language checks to 1200px
without preserving a separate smaller-screen interaction leaves a coverage gap.
The last unapproved plan removed its hamburger check and all viewport bounds;
it must not be treated as a verified fix. Designer should retain mobile menu
coverage, provide desktop/mobile navigation and language paths, and assert that
filtering hides nonmatching groups as well as showing matching ones.

Validation: full application build passed; 191 tests passed (167 design-agent,
23 server and 1 real-browser Showcase test). No paid provider invocation was
needed; image executor tests verify exact prompt preservation with a mock
provider. Runtime Run files were read, not altered.


## Designer publication loop in Run d705df3b — repaired

The user confirmed that the final interruption was deliberately initiated
because Designer kept failing. It is not a model/runtime timeout incident.
Three sessions produced 40 failed tools, including 31 identical vague path
errors and five missing-summary errors caused by changing the envelope.

The initial Orchestrator task incorrectly said HTML code was Builder's job.
The draft grouped twelve image deliverables into one `decorative-images` task
and kept individual prompts in the legacy array. Contract validation accessed
a nonexistent matching deliverable's file before checking identity. Later
handoffs incorrectly demanded publish-only retries and supplied invented paths.

Repairs: UX ownership conflicts are rejected before dispatch; invalid drafts
cannot start a publish-only recovery. Runtime handoff/context contain read-only
draft diagnostics and retained Skill calls. Identity checks now precede path
access and list every missing task/deliverable. The mixed-delivery Skill explains
individual image tasks and dependencies without altering prompts. Source
diagnostics expose invalid viewports, missing source files and remote fonts
together, rather than hiding downstream issues. Typed failed publication no
longer runs legacy JSON normalization; hashes remain stable. Three unchanged
validation failures, including across fresh sessions, stop the specialist and
return structured repair ownership to Orchestrator. Changing an envelope does
not reset the count; actual draft/source/Skill changes do. Inventory image-path
objects normalize to exact string paths before validation; ownership checks
remain in force. Context documents include line counts for targeted reads.

No historical Run files, approval receipts or state were rewritten. Restart
the service to load the runtime and resume with a genuine Designer repair task,
then obtain Reviewer approval before Builder executes the complete plan.

Validation for this repair: complete build passed, and 198 tests passed (174
design-agent, 23 server, 1 real-browser Showcase). The real failing draft now
produces explicit missing image-task ids, the indexed min_width error and remote
font diagnostics in one read-only report. Regression checks verify unchanged
JSON after failed publication, cross-invocation loop termination without a
completion event, recovery after a real edit, invalid publish-only handoff
rejection, image inventory path compatibility and ownership enforcement.


## Scholar Nexus 首轮 Builder 验收延迟（cceab14f）

任务 `project-2026-10-05-cceab14f` 的首轮 `build_finalize` 正确拒绝了
4 个验收脚本错误：`a[href='#research']` 同时匹配导航链接和 Hero CTA，
在 1440/768/390 三个视口触发严格模式；手机端还点击了 CSS 隐藏的
`a[href='#publications']`，导致超时。后续 Designer 仅将这两处动作改为
唯一、跨视口可见的 Hero CTA 选择器；HTML/CSS/JS 无需修改，既有图片保留。

系统缺陷是错误发现过晚：此前这些源页面交互直到生成图片、落地页面后
才执行。新增 `html-preflight.ts` 复用既有隔离浏览器检查器，在 Designer
发布规格前检查实际源码；Builder 启动、typed plan/HTML 执行，以及原生
单张/批量图片生成和编辑入口均有兜底，兼容旧审批。不自动选择第一个
匹配元素，不忽略隐藏控件，也不删减检查或视口。

预检将原始源文件按声明的输出映射放入临时目录，静态素材使用原文件，
尚未生成的图片只使用私有预览占位图。预览不会写入 artifacts，不会调用
图片 API，也不产生完成事件。它只验证源页面交互，不认证最终图片质量
或布局；最终 `build_finalize` 仍用真实成果执行完整验收。缓存绑定源码、
静态资源、合同（含检查和视口）及运行时指纹，成功与失败均复用；实际
修改会重新检查。浏览器不可用沿用现有配置策略，强制验收配置下明确
归属 runtime，不要求 Designer 改设计。失败报告新增步骤号、动作与选择器。

本轮未改写既有 Agent prompt，HTML Skill 仅增加这项运行协议说明。
没有修改历史 Run、批准源码、图片 prompt、生成/编辑参数或 Showcase 入口。

真实任务只在临时源文件副本回放：原脚本复现相同 4 项失败；修正脚本
产生 15 项视口结果（13 通过、2 个移动菜单检查不适用、0 失败）。完整
构建通过，201 项回归测试全部通过，无跳过。新增测试覆盖发布前拦截、
修正后恢复、源码变化导致缓存失效、旧审批在任何图片调用前被阻止，以及
浏览器运行时修复归属。重启 DreamaticArt 服务后加载新的运行时。


## 晶格仿生肌肉 Designer 发布重复失败（ac3ab826）

依据用户粘贴的 21:38、21:40、21:42、21:43 工具记录，以及
`project-2026-10-05-ac3ab826` 的 Designer 会话，恢复了首次发布前的
plan/manifest 快照，仅在临时目录运行只读诊断。

直接错误来自 `plan/deliverable_manifest.json.presentation.entry` 缺失：
Designer 写的是 `presentation.artifacts`，但 schemaVersion 2 需要 `entry`。
`runPath` 只报 “path must be a non-empty string”，没有说明文件/字段。
Designer 因此给无关位置添加 path、调整 scope 和运行目录，重复失败。

同一草稿还混用了两种执行协议：12 个 execution_plan 任务用
`deliverable_id` 而非 `id`，只有调度元数据；完整 prompt/size 位于另一个
image_generation_plan 数组，schemaVersion 2 不会执行它。12 个输出名为
JPG，而图片工具保存 PNG。后来 Designer 改成 schemaVersion 1 才绕过
presentation 校验，并在 21:44 暴露配置为 1024x1024 时的尺寸超限。
目前保留的该 Run 草稿已恢复到旧图片协议，仍有 12 个 JPG 输出声明；
运行时应交回 Designer 修正并重新审核，不能改审批记录来伪造通过。

恢复计数也有缺陷：此前任何 plan/manifest/system/Skill 指纹变化都会把
次数重置为 1，即使同一个阻塞字段仍未解决。本轮按当前未解决的具体
诊断计数：修正其他字段不会清除剩余问题的计数；真正解决的诊断才被
移除。某个问题连续出现 3 次就返回 Orchestrator。内部哈希计数只写入
恢复记录，工具响应保留简明诊断和次数，避免把实现数据重复塞入上下文。

修复内容：

- presentation 错误指明完整文件/字段，并提供有效 Gallery/HTML 格式。
- 共享只读诊断一次列出任务 id、完整图片字段、PNG、尺寸及匹配问题；
  保存警告、Design Context 和发布校验一致，不因一个错误遮住其他错误。
- Designer 上下文提供运行时 outputContract，包含两个版本的执行数组、
  canonical 字段、展示入口和动态图片上限；图片 Skill 仅补充协议说明。
- 用户记录中的 research 引用不是上述 path 错误的直接来源，但此前会
  在下一层 ownership 校验被拒绝。现允许 Designer 附带本 Run 已声明的
  规范研究输入作为只读依据；仍自动附带并强制校验完整 Designer 输出。
  附加引用存入哈希回执，输入改动会阻止旧审批继续生效；写权限不放宽。
- 引用校验进入同一个恢复边界。已分类/typed 的旧批准方案在 Reviewer
  通过和 Builder 执行前再检查可执行性，不能只凭旧回执绕过已知错误。
  Reviewer 的失败评审仍能提交。旧无分类的精简图片执行记录不增加
  设计元数据要求，保留既有执行/复用兼容性。
- 图片尺寸函数仅提取为共享模块，数值默认值、环境配置与旋转规则未变。
  不自动改写设计 prompt、不偷偷降级 schema、不生成替代成果。

本轮没有改写任何既有 Agent prompt MD；image-prompting Skill 只增加
执行字段说明。历史 Run、图片 prompt、审批回执、成果和 Git 版本均未改动。

验证：完整构建通过，205 项回归测试通过，无跳过。新增覆盖同时诊断、
失败发布不改源码/不发事件、无关修改不能重置计数、真实修正后恢复、
研究引用与写权限、输入改动后的审批保护、纯图片发布、旧无效回执在
图片 API 前被拦截，以及失败评审能够交回 Designer。既有成果复用和
旧图片执行、HTML/混合任务、真实浏览器 Showcase 测试保持通过。
重启服务后载入新运行时，再由正常 Designer → Reviewer 流程修正旧草稿。


## presentation.entry 的来源和遗漏预防

进一步核查 ac3ab826 的 Designer 会话：首次发布前的三次清单保存
（13:35:29、13:36:57、13:37:38 UTC）都明确使用 schemaVersion 2，
均写入 `presentation: {mode: "gallery", artifacts: ["artifacts/00-gallery.html"]}`，
没有 entry。错误在保存阶段就存在，不是发布总线删除了字段。
项目中未找到要求 `presentation.artifacts` 代替 entry 的 Agent/Skill 示例；
不能据此断言是某条指令直接教错了字段。

entry 表示 Showcase 的单一首页，使用 Run 相对路径：Gallery 的固定首页，
或 Designer 明确声明的 HTML 页面。Builder 选择入口任务、成果元数据、
Server 的 Showcase 路径/受限预览、Web 的打开页面行为与导出都使用它。
`artifacts[]` 是列表，不能表达哪个页面是首页。最终交付契约需要一个唯一
入口，但这不意味着所有入口都应该交给 LLM 重复填写。

系统缺口：旧图片 schemaVersion 1 内置 Gallery 默认入口，新版本要求
重复声明；工具 data 为任意对象，入口只在稍后跨文件校验中被强制要求；
Agent 以文字描述协议，而专业图片 Skill 通常只关心具体图像成果。先前
只加强错误定位仍把固定元数据补全的责任交给模型，增加重试/token。

本轮把确定性补全放在 Designer 保存之前，统一在 design-contract 中：

- schemaVersion 2 Gallery 缺失 entry 时，补固定 artifacts/00-gallery.html；
  不参考错误或无关的 artifacts[] 列表，不更改图片任务、prompt 和输出。
- HTML 缺失 entry 且唯一 html_page 成果时，从其已声明的 file 补全。
  同一任务含多页面时仍使用成果声明的主页面，而非第一个源码文件。
- 全图片/全 HTML 成果可以确定缺失 mode。混合或 manual 成果必须明确
  选择 mode；多个 HTML 成果（含可选成果）必须明确选择首页。
- 已声明的错误模式/路径不会被覆盖；有歧义的结构化草稿首次保存就提示，
  native 写入则在执行前阻止并要求明确选择。结构化 patch 复用相同规则。
- 补全发生在序列化、SHA、Designer 发布和 Reviewer 审批之前。响应仅返回
  实际补全字段及最终 SHA，不增加模型/图片工具调用。首次先存 manifest
  或先存 plan 都支持，不会因补全另一个文件导致已有 SHA 失效。
- 发布/读取/执行不会补写草稿或已批准清单。旧错误记录仍应通过正常
  Designer 修正和 Reviewer 审核恢复；不修改历史 Run 或审批回执。

本轮没有改任何 Agent prompt MD，只在 image-prompting/html-interface
Skill 的执行协议中补充字段含义和自动补全边界，创意方法保持原样。
该机制避免确定性入口遗漏引起的重试，不承诺模型所有设计/交互一次正确。

验证：完整构建通过，212 项 design-agent/server/web 回归测试全部通过，
无失败、无跳过。新增覆盖先存 manifest 的 Gallery 固定入口、首次 UX
无 presentation 的单次发布与真实浏览器落地、混合 Gallery、多个 HTML
成果明确选择、patch 的实际 SHA、native 写入与权限、显式错误路径保留、
已批准内容修改被拒绝以及旧 schema 不变。原始失败清单的只读回放能
补齐 Gallery entry，12 项成果声明前后完全一致；其他原始执行字段错误
仍交由已有保存诊断修复，不伪称整份原始草稿因此自动合格。
重启 DreamaticArt 服务后加载新的运行时；没有手动更改历史工作流记录。


## Builder 图片批次等待至用户中断（ac3ab826，22:16）

依据同一 Run 的 Builder 会话、bus.jsonl 和图片请求指标，21:49:26
启动 6 项 image_generate_batch；22:16:04 由用户取消，批次持续约
1598.5 秒（26 分 39 秒）。不是 Builder 在等待模型输出，也没有证据
表明并发调度器死锁：IMG-02 占用一个槽，另一个槽继续完成其余请求。

- IMG-01/03/04/05/06 的 HTTP 请求分别用时约 31.5、57.7、59.1、
  28.9、61.5 秒，均完整收到约 1.6–2.1 MB 响应；随后被本地
  `Image outputs must use a .png path` 拒绝，因其输出声明为 JPG。
  此前路径在 saveImageResponse 内、模型调用完成后才校验，造成无效消耗。
  之前的 Designer/旧审批守卫已拦截原方案中的 JPG 声明，本轮仍补上
  低层图片工具的提前校验，覆盖独立工具和无分类的旧精简流程。
- IMG-02 在约 52.5 秒收到响应头，但正文没有完整结束。直到用户
  取消才退出，timedOut=false，未发生自动重试。当前 .env 的
  DREAMATIC_IMAGE_TIMEOUT_MS 为 3000000（50 分钟），而非默认的
  300000（5 分钟），与当时 26 分钟未到总期限的记录一致。
- 原正文指标只在成功读完后记录 bodyMs/responseBytes，失败时为 0。
  因此不能断言当时零字节传输，更不能单凭这些记录确定是图片服务、
  代理还是网络链路停滞。能确定的是停在 response body 阶段。
- 父会话没有处理 Pi 的 tool_execution_update，通用 15 秒心跳只显示
  executing image_generate_batch。图片计数另有总线记录，但请求阶段和
  重试细节未正确转发到当前工具。批次结构化失败的 isError=false，
  又令动作和错误计数显示为正常完成（旧记录 errors=0），加重误判。

本轮修复：

1. 复用 boundedResponseBytes 加入正文独立停滞保护，默认 60000 ms，
   由 DREAMATIC_IMAGE_BODY_IDLE_TIMEOUT_MS 配置。收到实际字节才重置，
   空块不能延长期限；总请求超时仍独立生效，用户原 .env 未擅自改动。
   保护覆盖生成、编辑、URL 下载及错误 HTTP 响应。它不限制模型在响应
   头之前的合法生成耗时，不能把 50 分钟配置误称为程序采用了 5 分钟。
2. 正文停滞明确报 TimeoutError，释放连接和调度槽，复用既有有限重试、
   幂等键和共享预算；取消动作不会生成额外重试。即使底层取消 Promise
   不结束，也不能阻止工具退出。实时接收的慢流仍保留完整内容。
3. 单图生成/编辑先验证输出路径；生成批次在任何付费请求前验证所有
   路径、大小和重复输出，不静默修改文件后缀或设计内容。
4. 工具更新显示图片 id、排队/等待响应/接收正文、尝试次数、接收字节
   和最后数据间隔；经 Pi SDK 事件转发到现有总线，Server 快照和 Web
   实时工具卡片均可见。正文失败指标保存真实耗时、已收字节和超时类型。
5. 用户取消向上传递为 interrupted；失败图片批次通过 details.ok 供
   父会话统计错误和展示失败状态，保留部分成功成果及既有复用机制。

本轮未改 Agent prompt 或 Skill 内容、图片提示词、模型/API 参数、
图片数量规则、历史成果、运行状态或审批回执；没有重启或继续原任务。

验证：完整构建通过，220 项 design-agent/server/web 回归测试全部通过，
无失败、无跳过。新增覆盖真实本地 HTTP 正文停滞、50 分钟总期限下的
独立停滞超时与有限重试、实际部分字节指标、不配合结束的取消操作、
持续接收的慢流/空块、提前路径校验零 API 调用、取消不重试及释放槽、
Server/Web 工具内进度一致性。所有模拟均未调用付费生图服务。
重启 Server/CLI 后加载新代码。旧 Run 仍需由 Designer 修正清单中的
JPG 输出并经 Reviewer 复审，再恢复 Builder；无需重做已通过的研究。


## JPG 路径来源与图片编码契约统一（对上一轮诊断的补充）

用户进一步要求检查路径本身为何出错。原始链路明确：Designer 最早在
13:35:29 UTC 的 deliverable_manifest.json 中声明 12 个 artifacts/*.jpg；
之后两次清单保存保留这些名称。Reviewer 在 13:47:51 UTC 通过，仅记录
文字、尺寸说明和生产风险等问题，未指出文件格式。Builder 在 13:49:26
UTC 的 image_generate_batch 原样传递清单前 6 个 JPG 路径，没有另起目录、
拼错名称或把原 PNG 改成 JPG。路径字符串早已存在，实际图片文件未创建
是因为后端 artifactOutputPath 在收到图片响应后拒绝了这个后缀。

根因是系统契约矛盾：底层工具硬编码只允许 PNG，设计清单的通用 file
描述和当时的发布/审核检查没有统一表达该限制。b64_json 仅指传输形式，
不能证明响应一定是 PNG，更不能成为拒绝合理 JPG 文件名的理由。之前
补充 PNG-only 诊断/提前拦截能阻止浪费，却仍要求模型重写已经约定的
文件名，并未解决能力和设计契约之间的矛盾。

本轮统一 image-output 契约，支持 PNG 与 JPG/JPEG，保留既有 PNG 默认。
Designer/Reviewer 诊断、输出能力上下文、图片工具、编码和最终交付共用
格式定义。真实 provider bytes 与目标扩展名不同时由现有 Photon 依赖
本地编码；不改变已约定路径，也不把 PNG 字节冒充 JPEG。相同格式保留
原始字节，转换不缩放；JPEG 使用 quality 95，属于有损且不透明的格式，
透明/无损需求仍使用 PNG。不会改写 prompt、改变模型参数或额外生图。

Builder 的计划内单图、批量生成和编辑按 id 取得 deliverables[].file，
可以省略 outputPath；重复填写不同路径、未知计划 id 或篡改审批输入
在调用 provider 前阻止。typed/已分类图片调用验证当前 Designer/Reviewer
回执；execute_image_plan 原有按 id 路径复用仍保留，并检查缓存编码匹配。
独立旧工具无计划时仍沿用原默认目录。typed finalization 检查实际编码与
扩展名，记录正确 MIME；HTML 的临时图片占位、资源依赖和真实 JPEG
输出一致。相同规则覆盖 URL 下载和 image_edit。

本轮没有修改 Agent prompt MD；image-prompting Skill 仅更新执行格式
约定。历史 Run 的计划、路径、成果和审批记录全部未动。上一轮“必须
先把 JPG 改成 PNG 再审核”的建议已由新编码支持取代；JPG 本身不再
需要修改，但任何其他未解决的计划或审核问题仍由既有守卫检查。

验证：完整构建通过，225 项 design-agent/server/web 回归测试全部通过，
无失败、无跳过。覆盖首次 JPEG 清单发布/审核、按 id 绑定约定路径、
真实 PNG/JPEG 转换及编辑/URL 下载、HTML 引用、编码与 MIME 校验、
成果缓存复用、审批后路径篡改在 provider 调用前拦截。只读检查原 Run
project-2026-10-05-ac3ab826：Designer 就绪检查通过（0 个问题），
16 个 Designer/Reviewer 审批输入文件哈希一致。没有继续原任务、
调用付费服务或恢复被丢弃的响应；重启 Server/CLI 后加载本轮修复。

## Export 下载只有 440 字节且不能解压

实际 Downloads/project-2026-10-05-ac3ab826.zip 为 440 字节，正文是
DreamaticArt 的 SPA index.html，而非 ZIP。运行中的旧 Server（PID 58679）
尚未加载新增 export 路由，GET /api/runs/:id/export 被静态首页回退处理，
响应 HTTP 200 / text/html。前端原先只检查 response.ok，于是把首页 Blob
直接命名为 .zip。这次并不是压缩程序生成了错误尺寸或传输中断。

修复：前端下载前要求 application/zip，核对未编码响应的 Content-Length，
检查 ZIP 头和末尾目录记录；HTML、截断 ZIP 不再触发浏览器下载。未知
/api 路径在 Server 明确返回 404 JSON，不再走 SPA fallback。浏览器回归
使用真实 ZIP 数据，并覆盖 HTTP 200 首页和截断 ZIP 的阻止下载行为。

确认所有会话 running=false 后重启本地开发服务，加载新接口及前端。
从实际 4310 服务以及 5173 前端代理分别下载原出错项目：均为
7,501,375 字节，133 个文件，解压总大小 9,020,547 字节，所有 ZIP CRC
通过。未知 API 实测返回 404。完整构建、28 项 Server/Web 回归全部通过，
无失败或跳过。没有改动原项目成果、工作流记录、Agent prompt 或 Skill。

## Reference-only material and mechanical Builder execution

The DreamaticArt Homepage Run project-2026-10-05-dd42724f approved a page with seven
example-image references and an empty resources array. Two Builder invocations
copied only the declared HTML. The first Designer revision changed src values
without importing assets or declaring producers; Reviewer approved the incomplete
pipeline again. Builder then incorrectly tried image_edit_batch as file copying;
undeclared ids were rejected before provider work. Finalization correctly found
missing page resources; these failures were not post-generation aesthetic audits.

The updated policy keeps research/repository images as reference material. Needed
page imagery must have an image_generate/image_edit deliverable/task, exact prompt,
size and acceptance, plus an HTML resource mapping and producer dependency.
Direct research/repository resource mappings are rejected. Designer-authored
SVG/CSS/JS is still valid design source; approved image editing can use reference
pixels as inputs to a planned transformation. Research Gallery appendices remain
reference libraries, not design assets.

Designer draft/publication and Reviewer approval now validate local reference
closure independent of browser loading, including lazy/offscreen images, CSS URLs,
relative page links and image fallbacks. Reviewer records runtime-derived
executionReadiness/source-preflight evidence in its sealed receipt. Source browser
validation stays before approval. Builder tools and build_finalize no longer run
browser/viewport/interaction audits; they retain approval hash gates, exact source
copying, dependencies, output encoding, file/resource integrity and completion.
The final report explicitly records browser validation as not_run, without claiming
post-build interactions passed. No prompts, image sizes or provider parameters are
rewritten. Prior image-only generation/editing/Gallery execution stays intact.

Validation: full build and 230 design-agent/server/web tests passed with no skips;
one additional UX-only generated-image-to-page integration case also passed.
Coverage includes rejection of direct research resources, lazy missing references
before publication/approval, recorded readiness, execution without a second browser
check, exact approved-source enforcement and generated dependencies/reuse. Only
mock image endpoints were used. Read-only diagnostics of the original Run now
catch the undeclared image references before Builder; its files/state were not
changed or resumed. Agent prompt edits were limited to the new ownership/resource
rules; the HTML expression Skill supplies the concrete producer mapping.

## User-provided material exception (2026-10-06)

The previous generated-assets rule intentionally prohibited arbitrary Researcher
asset reuse, but also rejected user-provided originals. The existing HTML copier
already preserves bytes; the missing boundary was trusted origin/import
metadata, not a new Builder audit or generative copy tool.

Added runtime user source recording, `user_asset_import`, content-addressed local
inputs, page-link verification, imported-source contract/approval hashes, common
video/document upload ingestion and local media MIME/CSP support. Designer maps
imported originals, Reviewer validates the executable mapping, and Builder uses
the existing mechanical copier. Export retains originals and delivered copies.
Researcher-discovered sources remain reference-only. Updated only the relevant
Agent tool declarations and material-policy instructions.

Regression coverage checks exact image/video/document bytes through import and
finalization, cross-Agent publication/approval/build with no network/generation
calls, permission derived from real root input, undeclared Researcher URL
rejection, source/output tampering, symlink escape, page-linked and extensionless
URL imports, cached imports, HTML gateway errors, private redirects and ZIP
contents/CRC. The Preview browser test verifies an explicit local PDF download while keeping
the iframe origin isolated. No production Run or application Server was started
by these tests.
