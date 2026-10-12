# 上海长江大桥性能分析：第三轮，重点比较最新运行

分析日期：2026-10-12（Asia/Shanghai）。累计 12 个项目。最新项目 project-2026-10-12-8f5c190b，于上海时间 08:54:45 启动、09:21:33 导出完成。直接基准为前一次 project-2026-10-11-f1a694d9。

**最新运行比上一次慢 3.79 分钟（+16.5%），文本 Token 增加 388,719（+23.9%）。主要新增时间和 Token 在 Designer；页面预检没有重复失败，不能把此次退步主要解释为页面修复。**

## 同规模直接比较

两次最终 artifact-manifest 都包含 7 张 image_generate 图片 + 1 个 html_generate 页面。均 full 工作流、Pi 0.85.1、设计契约 v2、qwen3.7-plus 文本模型、configuredThinkingLevel=off；图像模型均 gpt-image-2。研究预算均为 8 查询/10 抓取。

| 指标 | 上一次 f1a694d9 | 最新 8f5c190b | 变化 |
|---|---:|---:|---:|
| 总历时 min | 23.00 | 26.80 | +16.5% |
| 流程历时 min | 21.95 | 26.06 | +18.7% |
| 总 Token | 1,629,106.00 | 2,017,825.00 | +23.9% |
| 未缓存输入 Token | 453,921.00 | 592,173.00 | +30.5% |
| 缓存读取 Token | 1,128,832.00 | 1,383,168.00 | +22.5% |
| 输出 Token | 46,353.00 | 42,484.00 | -8.3% |
| 文本请求数 | 48.00 | 52.00 | +8.3% |
| 输入侧缓存占比 | 71.3% | 70.0% | -1.3 个百分点 |
| 工具错误 | 0 | 1 | Skill 选择错误 |
| 图像调用 / 重试 | 7 / 0 | 8 / 1 | 增加一次重试 |

总历时包含前期澄清/等待；流程历时从 design_categories_identified 到 export_done。最新前期耗时较短（约 0.74 分钟 vs 1.06 分钟），所以流程实际增长 4.11 分钟，比总历时增长更大。

## 阶段增量

| 阶段 | 上次 min | 最新 min | 增量 min | 上次 / 最新 Token |
|---|---:|---:|---:|---:|
| researcher | 3.56 | 3.34 | -0.22 | 271,341 / 306,674 |
| designer | 6.75 | 9.80 | +3.05 | 788,488 / 1,051,613 |
| reviewer | 1.48 | 2.11 | +0.63 | 242,862 / 338,427 |
| builder | 7.72 | 8.35 | +0.63 | 44,523 / 71,884 |

Designer 增加 3.05 分钟，Reviewer 增加 0.63 分钟，Builder 增加 0.63 分钟；Researcher 反而快 0.22 分钟。阶段之和不含 Orchestrator 调度、前期澄清和最终导出，不能要求其差值严格等于总历时差。

## Designer：上下文增大，同时响应吞吐下降

- 请求数由 15 增至 17；Token 从 788,488 增至 1,051,613（+33.4%），增加 263,125，占项目 Token 增量约 67.7%。
- 平均每次 Designer 输入上下文（input + cacheRead）由 51,054 增至 60,798 Token（+19.1%）；序列化请求体字符由约 171,759 增至 208,360（+21.3%）。
- 输出从 22,674 降至 18,050 Token（-20.4%），但 Designer 文本模型响应累计从 403.7 秒增至 586.5 秒（+45.3%）。Designer 阶段约 588.2 秒，基本都落在文本模型响应时段，工具执行只占较小部分。
- 输出 Token / 完整模型响应秒数由约 56.2 降至 30.8。此指标包含首响应等待及推理，不是模型纯解码速度；不能据此确定供应商性能退化。
- 页面 HTML+CSS 原始大小仅从 22,115 增至 23,125 字节（+4.6%），因此没有证据表明是页面代码体量大幅增加导致慢了三分钟。
- 最新 Designer 有一次 use_skill 错误：将 concept-showcase-storytelling 作为 bridge-showcase 的 primary，触发 skill_scope_mismatch；随后采用 editorial-design primary、storytelling supporting。按工具时间戳，约 34 秒后加载正确的 supporting 组合，属于早期额外往返，无法解释全部 3.05 分钟增量。
- 两次均只有一次设计发布；最新另有一次 design_context_validate，预检通过，没有 HTML 预检失败、重新派发 Designer 或跨角色返工。

## 任务拆分与读取方式也发生了变化

- 上次 resolvedScope 是一个 space scope（bridge-concept）；最新拆为 bridge-design（space）与 bridge-showcase（media_communication）两个 scope。
- 上次加载 4 个有效 Skill；最新加载 5 个，并新增展示方向的 editorial-design。跨域任务拆分与 Skill 内容使输入上下文具有差异，应作为性能比较的混杂因素。
- 上次通过 design_context_read 选择性读取研究 sections；最新先获取角色上下文，再使用 read 读取完整 context/research.json。日志确认读取方式改变，整体平均上下文变大；不能将所有上下文增长单独归因于该次完整读取。
- 两次代码指纹不同：上次 1b0225f9e4，最新 0fa8a952dd；部分 Skill 内容 SHA 也发生变化，因此并非严格相同运行环境下的重复试验。

## 图像：有一次重试，但构建只增加约 38 秒

- bridge-tower-detail 首次请求 157.3 秒后记录 response body stalled（连续 60 秒无数据），随后重试 78.4 秒成功。该图片两次尝试加退避约 237 秒。
- 最新 Builder 从 7.72 增至 8.35 分钟；execute_design_plan 从 449.9 增至 481.4 秒。增加一次失败尝试不能直接当作增加了 157 秒墙钟时间，因为任务存在并行。
- 最新 7 次成功图像请求约 78.4–147.0 秒，上次约 78.0–174.4 秒。成功请求自身未呈现明显整体恶化；此次主要新增现象是一个失败尝试。
- 已完成图像被保留，本次只有失败的 tower-detail 重试；7 个 image_item_finished 均完成。
- 最新 Builder 文本响应累计约 18.5 秒，其余主要处于执行工具/图像等待。

## Token 与费用解释

最新总 Token = 592,173 未缓存输入 + 1,383,168 缓存读取 + 42,484 输出。相对上次，未缓存输入增加 138,252（+30.5%），缓存读取增加 254,336（+22.5%），输出减少 3,869（-8.3%）。输入侧缓存占比略降，所以此次总量增加不能解释为只增加廉价缓存；但图片 Token 和真实费率仍缺失，无法计算实际账单。

## 放回历史样本

| 同为 7 图 + HTML 的项目 | 总历时 min | 总 Token | 工具错误 | 图像重试 |
|---|---:|---:|---:|---:|
| 2b32009b | 22.03 | 1,654,126 | 4 | 1 |
| 5c05dd55 | 27.15 | 2,607,385 | 7 | 1 |
| f1a694d9 | 23.00 | 1,629,106 | 0 | 0 |
| 8f5c190b | 26.80 | 2,017,825 | 1 | 1 |

最新相对 5c05dd55（同规模）仍少约 22.6% Token、耗时少约 1.3%；相对较早的 2b32009b 则耗时增加约 21.7%、Token 增加约 22.0%。累计 12 次按总耗时升序排第 8、总 Token 升序排第 6：处于历史中段，未刷新最佳表现，也没有重现 51 分钟异常。

## 优化重点

1. 优先对照 Designer 每次请求的输入大小、首响应等待、输出与总响应时间。此次主要时间增量在文本模型响应，先区分请求体膨胀和外部响应波动。
2. 统一研究上下文读取口径，尽可能使用角色视图与选定 sections；在同一任务/版本下衡量输入是否减少。
3. 在 Skill 选择前明确 primary/supporting 资格，避免再次把跨域 supporting Skill 当作不兼容类别的 primary。
4. 保留失败图像单项重试，并持续记录 body 停滞与成功调用时间；无需把此次整体退步主要归因于图像链路。
5. 固定相同 brief、scope 拆分、Skill 内容、模型和 7 图尺寸后再复测；当前比较支持“最新这次更慢、输入更多”，不支持把差异直接归因于某一次代码修改。

## 数据核验与限制

- 最新 52/52 文本请求有 provider_response_complete，按 requestId 去重；四个专业角色与 session 文件 Token 一致，不叠加重复统计。
- 阶段按全部 agent_finished/agent_interrupted 指标累加；本次仅 4 个专业调用。
- 最新 status=complete，fileIntegrity/interactions=passed；visualFidelity=not_assessed、engineeringFeasibility=not_validated、userAcceptance=pending。
- 两次 brief 均提及 3D 模型，但实际设计成果清单只有图片和 HTML；不把本轮计作可编辑 3D 模型交付，也未独立审查视觉质量。
- 原始证据：各项目 brief.json、run-state.json、bus.jsonl、.performance/model-requests.jsonl、.performance/skills-designer.json、sessions 与 artifact-manifest。
- 文件：metrics.json 为全部 12 次原始汇总；comparison.csv 为全部项目数值；latest-vs-previous.csv 为最新与上次直接对比。
