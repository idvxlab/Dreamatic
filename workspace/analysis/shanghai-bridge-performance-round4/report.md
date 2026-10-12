# 上海长江大桥性能分析：第四轮

分析日期：2026-10-12（Asia/Shanghai）。累计 13 次相关运行。最新项目 37287fbf，上海时间 11:20:06 至 11:43:36；上次为 8f5c190b，较好参照为 f1a694d9。

**最新总历时 23.50 分钟，比上次下降 12.3%；总 Token 1,436,013，比上次下降 28.8%，为累计 13 次最低。主要改善是 Designer 的往返次数与上下文重复消耗减少；研究抓取变慢抵消了一部分时间收益。**

## 最近三次同交付规模对比

三次 artifact-manifest 都为 7 张 image_generate 图片 + 1 个 html_generate 页面。最新与上次 originalRequest 完全相同；resolvedScope 均拆为 space 桥梁概念和 media_communication 展示两个范围。

| 指标 | f1a694d9 | 8f5c190b | 最新 37287fbf | 最新对上次 |
|---|---:|---:|---:|---:|
| 总历时 min | 23.00 | 26.80 | 23.50 | -12.3% |
| 流程历时 min | 21.95 | 26.06 | 23.17 | -11.1% |
| 总 Token | 1,629,106.00 | 2,017,825.00 | 1,436,013.00 | -28.8% |
| 未缓存输入 | 453,921.00 | 592,173.00 | 472,858.00 | -20.1% |
| 缓存读取 | 1,128,832.00 | 1,383,168.00 | 915,584.00 | -33.8% |
| 输出 Token | 46,353.00 | 42,484.00 | 47,571.00 | +12.0% |
| 文本请求 | 48.00 | 52.00 | 43.00 | -17.3% |
| 工具错误 | 0 | 1 | 1 | Reviewer 字段嵌套错误 |
| 图像调用 / 重试 | 7 / 0 | 8 / 1 | 7 / 0 | 无重试 |

总历时含前期等待；流程历时从 design_categories_identified 到 export_done。本次前期仅约 19.5 秒，上次约 44.2 秒；排除前期后流程仍缩短 2.89 分钟（约 11.1%）。

## 阶段增量

| 阶段 | f1a694d9 min | 8f5c190b min | 最新 min | 最新对上次 min |
|---|---:|---:|---:|---:|
| researcher | 3.56 | 3.34 | 5.91 | +2.57 |
| designer | 6.75 | 9.80 | 6.91 | -2.89 |
| reviewer | 1.48 | 2.11 | 2.27 | +0.16 |
| builder | 7.72 | 8.35 | 6.17 | -2.18 |

Researcher 增加约 2.57 分钟、Designer 减少 2.89 分钟、Reviewer 增加 0.16 分钟、Builder 减少 2.18 分钟。专业阶段之外还有调度及导出时间，阶段差值不会严格等于总历时差。

## 主要改善：Designer 请求减少，输出并未缩减

- Designer 请求从 17 次减至 9 次（-47.1%），Token 从 1,051,613 减至 502,474（-52.2%）。Designer 减少 549,139 Token，约占项目总降幅 581,812 的 94.4%。
- Designer 阶段从 9.80 降至 6.91 分钟（-29.5%）；累计模型响应从 586.5 降至 410.6 秒。
- Designer 输出由 18,050 增至 23,036 Token（+27.6%）；页面 HTML+CSS 原始大小由 23,125 增至 26,995 字节（+16.7%）。并未通过大幅减少文本输出或页面体量来降低总 Token，但字节数不能证明内容质量更高。
- 平均 Designer 输入上下文从约 60,798 降至 53,271 Token（-12.4%）。请求次数近乎减半是总输入下降的主要可观察因素，不能仅归因于每次上下文变小。
- 最新以 design_context_read 选择 research findings，未使用 read 读取完整研究文件；上次是完整读取研究文件。最新一轮 use_skill 配置正确，无 skill_scope_mismatch。
- 最新只调用两次 update_design_context，而上次七次；工具日志显示集中写入系统设计与交付清单，减少逐项往返。两次都仅一次设计发布，没有跨角色返工。
- 与 f1a694d9 相比，Designer 输出相近（23,036 vs 22,674），阶段时间也相近（6.91 vs 6.75 分钟），但请求从 15 减至 9，Designer Token 从 788,488 减至 502,474。

## 研究阶段变慢：主要来自抓取工具等待

- Researcher 从 3.34 增至 5.91 分钟（+2.57 分钟）。
- research_fetch_batch 累计耗时从 39.6 增至 140.6 秒，增加约 101 秒；文本模型响应累计从 157.1 增至 203.1 秒，增加约 46 秒。二者解释了大部分研究阶段增长。
- websearch_batch 从约 6.8 增至 10.7 秒。没有研究工具失败记录；日志只能定位到抓取与文本响应等待，不能确定网站、网络或供应商哪一端负责。

## 图像没有重试，但存在成功响应长尾

- 7 张图均首次成功；6 次调用约 28–82 秒，另一个 bridge-aerial-context 用时 336.6 秒（5.61 分钟）。
- 长尾请求 headers 约 45.9 秒、body 约 290.7 秒，没有 bodyIdleTimedOut；这是一次较慢的成功响应，不能称为超时。
- execute_design_plan 约 336.7 秒，与最长图像请求基本一致；图像任务内部并行，长尾图像决定工具完成时间。
- Builder 从 8.35 降至 6.17 分钟，减少约 2.18 分钟。最新 Builder 文本响应累计约 29.6 秒，大部分时间仍处于生成工具等待。
- 最新图像请求中位数 46.8 秒，上次 120.7 秒；但单个成功请求的长尾仍明显。

## 剩余错误：Reviewer 一次字段嵌套错误

- Reviewer 将 issues、resolved_issue_ids、remaining_risks 放在不允许的 changes 根字段，update_design_context 拒绝保存。
- 本次错误返回明确指示将这些字段放入 changes.assessment 下；下一次提交约 33.7 秒后发生并成功。只出现一次此类错误，未演化为重复失败或重派发。
- Reviewer 总 Token 319,878，较上次 338,427 略降；耗时从 2.11 增至 2.27 分钟。该单次错误仍值得消除，但不是本次主要瓶颈。

## 费用与质量解释

最新 1,436,013 Token = 472,858 未缓存输入 + 915,584 缓存读取 + 47,571 输出；未缓存输入下降 20.1%，缓存读取下降 33.8%，输出增加 12.0%。本次节省同时出现在缓存外输入和重复缓存读取，不是只增加缓存命中造成总量变化。输入侧缓存占比约 65.9%，低于上次约 70.0%；缓存占比降低与总成本可能降低并不矛盾。实际费率与图片 Token 未记录，不能给出账单金额。

最新 status=complete，fileIntegrity/interactions=passed；visualFidelity=not_assessed、engineeringFeasibility=not_validated、userAcceptance=pending。原始请求仍提及 3D 模型，但设计交付清单仅包含图片与 HTML，不应计作可编辑 3D 模型交付。性能改善不能替代视觉或工程质量评估。

## 历史位置与建议

- 累计 13 次，总 Token 最低；总历时按升序排第 5。相比 f1a694d9，总 Token 下降 11.9%，总历时略增 0.49 分钟（+2.1%）。
- 本次证据支持保留集中更新设计清单、研究结论选择性读取和正确 Skill 配置的流程，再固定输入与版本复测。
- 继续单独监控 research_fetch_batch 和图像成功请求的尾部等待；两者决定本次没有刷新最佳耗时。
- 为 Reviewer 在提交前校验 assessment 嵌套，避免一轮额外模型生成。
- 最新代码指纹为 61f883262d；上次为 0fa8a952dd。模型仍 qwen3.7-plus、configuredThinkingLevel=off、Pi 0.85.1、full 工作流。即便 originalRequest 相同，代码和生成内容不同，单次结果不能证明某次代码变更的因果效应。

## 数据核验

- 最新 43/43 文本请求有 provider_response_complete，按 requestId 去重；四个专业角色 Token 与 session 文件逐项一致。
- 阶段按全部 agent_finished/agent_interrupted 指标累加，本次仅四个专业调用。
- metrics.json 保存全部 13 次指标；comparison.csv 保存逐项目数值；latest-vs-previous.csv 保存最新与上次差值。
- 原始证据来自各项目 brief、run-state、bus、model-requests、sessions、skills-designer 和 artifact-manifest；未改动运行记录。
