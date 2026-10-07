# DreamaticArt 设计流程排查与修复（2026-10-07）

## 故障证据

检查对象：`workspace/runs/project-2026-10-06-dbf878c4`（Dreamatic Homepage）的 Brief、Design Context、Bus、各 Agent 会话、研究、设计、审核及预检结果。

- 用户要求参考 `https://github.com/idvxlab/Dreamatic/tree/dev` 的内容和素材，展示真实作品 Gallery。
- Run 状态为 interrupted；research completed，design/review failed，build/export pending。没有 Builder 执行或 build_done。
- Researcher 有 17 次 read 错误，包括读目录的 EISDIR、猜测不存在的路径和跨 Run 读取。其研究记录提到了仓库作品，但没有把所需原图导入为 HTML 可交付资源。
- Designer 有 16 次 user_asset_import 失败，包括超时、fetch failed 和“Material URL is not linked by the user-provided page”。旧导入器对一般网页要求直接链接，对 GitHub tree/blob/Markdown 没有对应的文件内容处理。
- 第一版 HTML 使用渐变占位卡。Reviewer 于 2026-10-06 15:20:26 UTC 提交 design_review_fail，没有错误放行。但其修复目标建议引用 examples 目录，未遵循可交付资源映射契约，进一步放大了后续修订困难。
- 后续 Designer 在原图未导入时引用 `../../../../../examples/...`，触发路径逃逸/未声明资源诊断。
- 四次设计提交失败分别涉及未重新加载保留的 Skills，以及 HTML 操作选择器匹配多个元素、移动端尝试点击隐藏的桌面导航。这些是明确诊断，不能通过取消预检或放宽原图复用规则来解决。

## 逐环节检查

| 环节 | 保留的职责与规则 | 本次处理 |
| --- | --- | --- |
| 用户输入 / Orchestrator | 保存原始请求和用户补充，确定任务与分类，安排各 Agent | 保留原始来源记录；补充材料获取缺口应交 Researcher 的短指引 |
| Researcher | 获取、提取并整理用户指定内容和研究依据，不做创意决策 | 新增 user_material_extract，优先处理用户内容，获取文字与图片来源并导入所需原图 |
| Designer | 决定设计、撰写完整 HTML 源码或设计图规格 | 复用原图使用可信导入路径；新图/实际修改分别声明生产任务；要求的一份内容不能同时被定义为原样复用与重新生成 |
| 类型分流 | UX/UI 由 Builder 调用 html_generate；其他独立设计范围有设计图生产任务 | 补齐非 UX 独立范围的图片输出验证；多个专业共同参与页面时保留 contributing_scopes，避免人为重复任务 |
| Reviewer | 独立检查要求、资源策略、方案一致性及可执行性，指出问题，不代写设计 | 修复建议也须遵循可信导入与映射契约；不得要求引用未验证的 examples/research 路径或生成作品替身 |
| 审批门禁 | 验证方案、任务、生产依赖、来源凭据、HTML 源码及交互；未解决 blocking/major 问题不能通过 | 保留并回归验证此前的一致性校验、accepted_risk 拒绝、历史批准重检、源码哈希与未声明资源拒绝 |
| Builder | 执行已批准的完整任务集，不重新定义方案 | 保留依赖排序、图片生成/实际编辑、原图复制、HTML 源码落地、完整性校验、完成/错误归属和复用机制 |
| 预览 / 交付 | 保留页面主入口、隔离预览和本地资源，完成后才导出 | 全部回归验证；未降低浏览器交互检查，不修改 Pi 运行时 |

HTML 工具负责将 Designer 的完整批准源码和资源映射生成到 artifacts；Builder 继续负责调用该工具。设计职责与现有 Agent 边界均未改变。

## 材料提取与导入修复

- `user_material_extract(runId, source, sourcePageUrl?, imageUrls?)` 仅由 Researcher 使用。支持网页 HTML、GitHub 目录 README、Markdown、文本、CSV，以及 DOCX/PPTX/XLSX 的文字和支持的内嵌图片。
- 网页用户内容保留 Logo、作品图等候选，区别于普通研究图的杂项排除。完整文字、图片链接、导入结果和来源保存到 `research/user-materials/`。
- selected imageUrls 和 Office 内嵌图使用原始字节保存到 `inputs/user-assets/`，记录 SHA-256、大小和来源；HTML 资源必须引用这些可信路径。
- GitHub tree/blob/raw 来源使用 Contents API 的 raw 表示，避免下载 GitHub HTML 文件浏览器。仓库目录授权限制到相同 owner/repo/ref 和目录子树；一般网站仅接受实际链接，不能据一个站点 URL 任意复制整个域名内容。
- 工具保存已获取网页的链接证据，后续图片导入复用该来源快照，减少重复下载与验证。嵌套内容页保持源页面的验证链。
- 网页发生重定向后，以实际取得页面的位置解析相对图片链接，避免正确素材链接被误判或指向错误目录。
- Design Context 向各阶段提供工具维护的用户材料来源和导入凭据，减少 Agent 猜测路径或自行重复获取。
- 上传入口新增 HTML 文件；HTML 源材料用于内容提取，未被直接作为可执行的交付页面导入。

## 验证

- `npm run check` 与 `npm run build`：通过。
- `npm run test -w @dreamatic/design-agent`：217 项通过，无跳过。覆盖原图复制与完整性、材料提取、GitHub 分支/仓库边界、类型分流、Reviewer 阻断、图片依赖、真实浏览器交互、批准失效及交付。
- `node --test --test-concurrency=1 apps/server/test/*.test.mjs`：35 项通过。顺序执行避免不同导出测试同时创建临时目录，影响发布测试对全局临时目录的断言。
- `node --test apps/web/test/*.test.mjs apps/desktop/test/*.test.mjs`：4 项通过。包含实际 Preview、设置与桌面本地服务生命周期。
- `git diff --check`：通过。
- 真实 GitHub 只读验证：README 提取成功、22 个图片链接；上次失败的 `examples/jingju-guochao-merch/final/artifacts/generated-images/01-product-overview.png` 从文件内容 API 导入成功（1,828,848 字节），PNG 签名与可信导入完整性验证通过。测试临时目录随后删除。

本机沙箱内浏览器测试首次出现 localhost listen EPERM；允许本地测试进程监听后全部通过。这是测试环境限制，不能把它当成原任务故障原因。

## 验证范围与剩余限制

- 未调用付费模型重新跑整轮生成；以上结果验证工具链、流程规则和故障相关回归，不能保证任意模型输出的审美、内容完整性或一次成功率。
- 原 Run 的历史记录、失败草稿和阶段状态保持原样；未把它标记为成功或修改其批准证据。重试须使用更新后的运行时并形成新的有效方案与审核。
- 上传 HTML 的相对图片路径需要配套的已上传原图；不会据文件名读取任意本机路径。内联 data URI 与无法获取的外部图片仍需明确素材处理，不能将缺少资源的页面视为内容齐全。
- PDF/扫描件、旧版 DOC/PPT/XLS、需要 OCR 或仅由客户端脚本呈现的内容尚无通用自动提取能力；不得将二进制/验证页当作已读取内容。Researcher 应报告具体缺口，由 Orchestrator 获取可读版本或必要用户材料。
- GitHub API 仍可能受网络、权限和限流影响；HTTP 成功和文件获取也不能替代 Researcher 的内容判断。不得捏造未取得内容或隐瞒失败。
- 无法用结构校验证明所有跨文件语义一致性；Reviewer 仍须逐项检查复用、生成、占位和用户内容要求。本次保留了已有机械门禁并补充对应职责指引。
