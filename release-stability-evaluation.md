# OpenClaw 与 Hermes 发行版稳定度评估流程

本文档总结 agent-watch 如何为 [openclaw/openclaw](https://github.com/openclaw/openclaw) 和 [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) 的每个 GitHub Release 计算 0–10 分的真实环境稳定度评分。流程分为 4 个阶段：**数据采集 → LLM 影响分析 → 数值打分 → 历史冻结**。

---

## 1. 监测对象

| Slug | GitHub Repo |
|---|---|
| `openclaw` | `openclaw/openclaw` |
| `hermes` | `nousresearch/hermes-agent` |

配置位于 `wrangler.jsonc` 的 `vars.PROJECTS`：`openclaw=openclaw/openclaw,hermes=nousresearch/hermes-agent`。新增项目只需追加配置项，cron 会自动同步。

---

## 2. 数据采集（cron 每 20 分钟一次）

入口：`src/lib/poll.ts::pollOnce`，由 Cloudflare Workers 的 `*/20 * * * *` cron 触发，亦可手动 `POST /cron/run`（需 admin token）。

### 2.1 Releases

- 调用 GitHub `/repos/{owner}/{repo}/releases`，最多取最新 30 个。
- 过滤掉 tag 含 `beta`（不区分大小写）的版本。
- 取过滤后的前 15 个写入 `versions` 表。
- 下载链接选取规则（`bestDownloadUrl`）：优先选体积最大的 release asset；若没有 asset，则回退到 `tarball_url` → `zipball_url` → `html_url`。

### 2.2 Issues

- 增量拉取：使用 `poll_state.last_issue_updated_at` 作为 GitHub `since` 参数，避免重复抓取。
- 每次最多 2 页（默认 100/页 = 200 条）。
- 每个 issue 写入 `issues` 表后，再拉取最多 10 条最新评论写入 `issue_comments`。
- 抓取完成后，将本批最大 `updated_at` 写回 `poll_state`。

### 2.3 失败隔离

每个项目、每个 release、每个 issue、每次评论拉取、每次 LLM 调用均 `try/catch` 独立隔离 —— 单点失败不会阻塞整批同步。

---

## 3. LLM 影响分析

入口：`src/lib/llm.ts::analyzeIssue`。仅当 `LLM_API_KEY` 配置时启用，否则该 issue 不进入打分。系统提示**按项目注入上下文**（`buildSystemPrompt(projectSlug)`），让模型在判断"core 还是 niche"时使用项目自己的功能边界。

### 3.1 输入

- 系统提示（`SYSTEM_PROMPT_BASE` + `PROJECT_CONTEXTS[slug]`）：要求模型返回**严格 JSON**，并附上当前项目的核心功能定义（参见 3.5）。
- 用户消息构造：
  - 最近版本 tag 列表（最新在前）
  - issue 编号、状态、标题、作者、创建时间
  - issue body（截断至 3000 字符）
  - 最近 10 条评论（每条 body 截断至 800 字符）

### 3.2 模型调用

- 端点：`${LLM_BASE_URL}/chat/completions`（默认 `https://api.openai.com/v1`）
- 模型：`LLM_MODEL_NAME`（生产环境默认 `gpt-5.4-mini`）
- 参数：`temperature: 0.1`，`response_format: { type: "json_object" }`
- 鉴权：`Authorization: Bearer ${LLM_API_KEY}`
- `poll.ts` 调用时透传 `project.slug`，保证模型看到匹配项目的核心功能描述。

### 3.3 输出

JSON 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sentiment` | `"positive" \| "negative" \| "neutral"` | bug/regression/抱怨 → negative；明确好评/"works for me" → positive；问题/feature request/不明确 → neutral |
| `target_version` | `string \| null` | 必须**精确匹配**输入版本列表，否则视为 null |
| `confidence` | `[0, 1]` | 对 target_version 的置信度；target_version 为 null 时强制为 0 |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | 启动失败 / 数据丢失 / 核心流程被阻塞才是 critical/high |
| `impact_scope` | `"broad" \| "moderate" \| "niche"` | 受影响范围；不确定时倾向 niche |
| `functionality` | `"core" \| "integration" \| "provider" \| "docs" \| "unknown"` | 影响的功能面；只有阻塞文档化核心流程时才标 core |
| `affected_user_share` | `"many" \| "some" \| "few" \| "unknown"` | 估算受影响用户比例；同一 niche 话题大量重复评论不等于 many |
| `duplicate_cluster_size` | `integer >= 1` | 重复报告数量（与 broad 概念解耦） |
| `workaround_status` | `"none" \| "partial" \| "confirmed" \| "unknown"` | 是否存在可确认的规避方案 |
| `summary` | `string` | ≤140 字符的英文摘要 |

### 3.4 容错

- 解析失败、模型返回非合法 JSON、或 target_version 不在版本列表内 → 该 issue 落到 `FALLBACK`（`neutral`/`null`/`0`），保留原始响应（截断至 4000 字符）写入 `issue_analyses.raw_response` 以便审计。

### 3.5 项目级 core/niche 规则

每个项目在 `PROJECT_CONTEXTS` 中维护一段精确描述，提示给模型注入在系统提示中：

- **openclaw (`openclaw/openclaw`)** —— 核心 = CLI（`openclaw onboard|gateway|agent|doctor|message`）、Gateway 守护进程、`npm/pnpm/bun` 的 install/update、agent 执行、DM pairing/security 默认值；**NOT core** = 任何单一频道适配器（WhatsApp、Telegram、Slack、Discord、iMessage、Signal、Microsoft Teams、Google Chat、Matrix、Feishu、LINE、Mattermost、Nextcloud Talk、Nostr、Synology Chat、Tlon、Twitch、Zalo、WeChat、QQ、WebChat、IRC 等）、单一模型 provider（OpenAI、Claude/Anthropic、Gemini、Azure、DeepSeek、Bedrock 等）、平台子特性、单一环境 edge case。
- **hermes (`NousResearch/hermes-agent`)** —— 核心 = CLI（`hermes`、`hermes model|tools|gateway|config|setup|doctor|update`）、TUI、agent loop / tool-calling、模型切换机制、`install.sh / install.ps1` 在 Linux/macOS/WSL2/Termux/Windows-beta 的安装、session/config 持久化；**NOT core** = 单一频道网关（Telegram、Discord、Slack、WhatsApp、Signal、Email）、单一 provider（Nous Portal、OpenRouter、NVIDIA NIM、Xiaomi MiMo、z.ai/GLM、Kimi/Moonshot、MiniMax、Hugging Face、OpenAI、自定义 endpoint）、单一终端后端（Docker、SSH、Singularity、Modal、Daytona、Vercel Sandbox）、语音音频特性、MCP-server 特定 bug、平台子特性。
- **fallback** —— 当 `slug` 没有匹配的项目上下文时，使用通用 AI 代理 CLI 描述。

提示中还包含 7 条强制 CORE-VS-NICHE 规则，关键几条：

1. 只有在阻塞**文档化核心流程**时，才能标 `core` + `critical|high`。
2. provider/channel/backend/OS-edge 特定 bug 应该是 `niche`，无论用户使用怎样严重的措辞。
3. 大量重复 niche 报告 ≠ core；`duplicate_cluster_size` 才是表达重复度的字段。
4. core/integration/provider/unknown 不确定时优先选更具体（非 core）的选项。
5. broad/moderate/niche 不确定时优先选 niche。
6. 同一线程内的正面评论会拉低对"广泛失败"的置信。

---

## 4. 数值打分（每次 API 请求即时计算）

入口：`src/lib/score.ts::calculateStability`。`/api/projects/:slug` 在请求时基于 issue + rating 数据合成评分；解释方向：**10 = 最稳定，0 = 最不稳定**。

### 4.1 关键常量

```
NEW_VERSION_GREY_HOURS = 3    // 发布后 3 小时内统一显示为灰色 5（"analyzing"）
POS_OFFSET             = 0.7  // 正面 issue 抵消负面风险的权重（≈ 旧版本的 2 倍）
PER_ISSUE_CAP          = 5    // 单条 issue 加权风险的上限
NICHE_TOTAL_CAP        = 1.0  // 所有 scope==='niche' issue 累计风险上限
CORE_SERIOUS_FLOOR     = 6.0  // 没有 core+critical|high 时的最低分（"Mostly stable"）
PEER_MEDIAN_FLOOR      = 5.5  // weightedNeg ≤ 项目历史中位数时的最低分（"Mixed"+）
```

### 4.2 新版本宽限期

`age < 3h` 时直接返回 `score=5, color=grey, state="analyzing"`，不参与任何聚合。

### 4.3 单条 issue 权重（带 cap）

```
ageDays        = max(0, now - issue.created_at) / 1 day
recency        = 0.55 + 0.45 * exp(-ageDays / 45)
discussion     = 1 + min(1.4, 0.45 * log10(1 + comment_count))
duplicateBoost = 1 + 0.28 * log2(duplicate_cluster_size)
conf           = max(0.2, issue.confidence)

rawWeight =
  recency * discussion * duplicateBoost * conf *
  severityWeight * scopeWeight * functionalityWeight *
  affectedUserShareWeight * workaroundWeight

negativeWeight = min(rawWeight, PER_ISSUE_CAP)   // 单条上限
```

核心功能（CLI、gateway、auth/session、agent/subagent execution、install/update、process stability）权重大于 integration/provider/docs。`impact_scope=niche`、`affected_user_share=few`、`workaround_status=confirmed` 会显著降低但不会清零风险。`duplicate_cluster_size` 使用对数增益。`PER_ISSUE_CAP` 防止单条被 LLM 过度标注（`critical+broad+core+many+huge cluster`）的 issue 直接拉爆分数。

仅 `sentiment === 'negative'` 计入风险，`sentiment === 'positive'` 计入 `weightedPos`，`neutral` 不参与（计入 `issueCount` 但不打分）。

### 4.4 niche 上限聚合

负面 issue 按 scope 分桶累加：

```
weightedNegMain      = sum(weight)  for scope ≠ 'niche'
weightedNegNicheRaw  = sum(weight)  for scope === 'niche'
cappedNiche          = min(weightedNegNicheRaw, NICHE_TOTAL_CAP)   // 1.0 总上限
weightedNeg          = weightedNegMain + cappedNiche
```

100 条 niche issue 的累计贡献仍然只有 1.0 —— 把"5 条 Azure-only bug 不该让发行版看上去无法用"这一直觉编码进算法。

### 4.5 base score（issue 派生）

```
effectiveNeg    = max(0, weightedNeg - 0.7 * weightedPos)
releaseMaturity = clamp(ageHours / (24 * 7), 0.35, 1)
riskIndex       = effectiveNeg / releaseMaturity
baseScore       = 10 / (1 + (riskIndex / 4.2) ^ 1.35)
```

### 4.6 融合用户评分

如果版本有用户 rating（`/api/ratings`，登录用户可提交 1–10 分）：

```
ratingAvg    = mean(clamp(rating.score, 1, 10))
ratingWeight = clamp(N / (N + 5), 0, 0.6)   // 5 票时权重 0.5，10 票时上限 0.6
final        = baseScore * (1 - ratingWeight) + ratingAvg * ratingWeight
```

无 rating 时 `final = baseScore`。

### 4.7 下限保护（Floors）

底部两道地板按需提升 `final`：

```
// 1. 核心稳定性下限：没有"core + critical|high"负面信号时，不让分数低于 6.0。
if (negativeCount > 0 && coreSeriousCount === 0 && final < CORE_SERIOUS_FLOOR) {
  final = CORE_SERIOUS_FLOOR;
  floorApplied = 'core';
}

// 2. 项目同侪中位数下限：本版本累计 weightedNeg 不高于项目历史中位数时不低于 5.5。
if (peerContext && weightedNeg <= peerContext.medianWeightedNeg && final < PEER_MEDIAN_FLOOR) {
  final = PEER_MEDIAN_FLOOR;
  if (floorApplied === 'none') floorApplied = 'peer';
}
```

`peerContext.medianWeightedNeg` 由调用方（`src/routes/api.ts`）提供：先用无 peer 的两阶段 pass 1 计算每个版本的 `weightedNegSum`，取**有负面信号的成熟版本**的中位数（≥ 3 个样本时启用），再 pass 2 重新打分。这把"工作正常的版本不应该看起来比项目历史更差"编码进算法。

### 4.8 输出

```
score : round(clamp(final, 0, 10) * 10) / 10   // 一位小数
color : <5 渐红 / =5 灰 / >5 渐绿
state : "analyzing" | "rated"
grade : "Stable" | "Mostly stable" | "Mixed" | "Risky" | "Unstable" | "Insufficient signal"
breakdown : {
  ageHours, weightedNegSum, weightedPosSum, riskIndex, baseScore, blendedFromIssues,
  issueCount, negativeCount, positiveCount,
  coreIssueCount, coreSeriousCount, nicheIssueCount, workaroundCount, nicheRawSum,
  topRiskFactor, ratingAvg, ratingCount,
  signalCount,                            // negativeCount + positiveCount + ratingCount
  confidenceLevel: 'low' | 'medium' | 'high',  // ≥8 high / ≥3 medium / 否则 low
  floorApplied:   'none' | 'core' | 'peer',
}
```

颜色映射：分数 5 为 `#9ca3af`（灰）；低于 5 由橙红向红渐变；高于 5 由浅绿向深绿渐变。`confidenceLevel` 让前端可以区分"打了低分但只有 1 条信号"和"打了低分且 10 条信号都印证"。

---

## 5. 历史评分冻结（`src/routes/api.ts`）

由于 `recency = exp(-ageDays/30)` 使用墙钟，旧版本在数据未变的情况下分数会**自然漂移**。为保证历史发行版的评分不会随时间无故升高，引入冻结规则：

```
LIVE_VERSION_COUNT = 3
```

- **最新 3 个版本**：使用墙钟 `now()` 实时计算（仍有动态衰减）。
- **第 4 个及更早版本**：`scoreNow` 被冻结为下列三者的最大值：
  - `version.published_at`
  - 所有相关 issue 的 `issues.updated_at`
  - 所有相关 rating 的 `user_ratings.updated_at`

只要 issue/rating 没有变化，对旧版本调用 `calculateStability` 会得到完全相同的分数；一旦有 issue 状态/评论或新增 rating，`updated_at` 会前进，分数也会随之刷新一次后再次冻结。

---

## 6. 缓存与一致性

| 层 | 机制 | TTL |
|---|---|---|
| `/api/projects/:slug` | Cloudflare KV (`CACHE`)，键 `project:v1:{slug}` | 60 秒 |
| 缓存失效 | 用户提交 rating → `POST /api/ratings` 主动 `KV.delete` 该项目缓存 | — |
| 数据更新 | cron 每 20 分钟同步 GitHub & 重跑 LLM | 20 分钟 |

KV 缓存窗口（≤60 秒）远小于 cron 周期（20 分钟），首页可视数据滞后上限可控。

---

## 7. 已知边界与权衡

1. **LLM 误判残余风险**：尽管系统提示已强制 core/niche 边界，`PER_ISSUE_CAP=5` 与 `NICHE_TOTAL_CAP=1.0` 还是单条/总量级别的"误判保险"。`target_version` 不在版本列表会被丢弃；`confidence=0` 的 issue 通过 `max(0.2, conf)` 仍以 0.2 权重参与，避免完全忽略。
2. **`neutral` issue**：仅计入展示用的 `issueCount`，不影响分数。
3. **新版本歧视**：发布 < 3h 强制灰 5；之后通过 `releaseMaturity` 防止极少 issue 直接拉爆风险指数；`coreSeriousCount === 0` 时还有 `CORE_SERIOUS_FLOOR=6.0` 兜底。
4. **正面言论稀缺补偿**：positive 通常少于 negative，`POS_OFFSET = 0.7`（旧版本的 2 倍）让一两条 "works for me" 评论能实质性抬升分数，对"沉默的多数"做反哺。
5. **影响范围估算**：severity/scope/functionality/user-share/workaround 都来自 issue 文本和评论的 LLM 判断；项目级 PROJECT_CONTEXTS 把"什么算 core"硬编码进 prompt，社区 rating 是另一个独立校准点。
6. **同侪基线**：`PEER_MEDIAN_FLOOR=5.5` 仅在项目里至少有 3 个成熟且有负面信号的版本时启用；新项目尚未建立基线时该地板不生效。
7. **打分可重放**：`calculateStability` 是纯函数，输入相同则输出相同；冻结规则确保旧版本输入也是稳定的。
8. **覆盖既有数据**：算法 + prompt 同步迭代后，DB 中已存在的 `issue_analyses` 仍是旧分类。`scripts/reanalyze-recent-issues.js --limit N` 用于按项目重新调用 LLM，覆盖最近 N 条 issue 的分类，并预览新评分。

---

## 8. 数据流速查图

```
GitHub API ──┐
             │   每 20 分钟
             ▼
      pollOnce()
        │
        ├─ upsertVersion (≤15 个/项目)
        │
        ├─ upsertIssue + upsertComment (incremental)
        │
        └─ analyzeIssue (LLM) ── setAnalysis
                                      │
                                      ▼
                                  D1 数据库
                                      │
                                      ▼
                          /api/projects/:slug (KV 缓存 60s)
                              │
                              ├─ 最新 3 版：实时打分
                              └─ 其余 12 版：冻结打分
                                      │
                                      ▼
                                  前端渲染
```

---

## 关键源文件索引

| 文件 | 职责 |
|---|---|
| `src/lib/poll.ts` | cron 主循环，调度 GitHub 抓取 + LLM 分析 |
| `src/lib/github.ts` | GitHub REST API 封装 |
| `src/lib/llm.ts` | LLM prompt 构造、调用、JSON 解析与归一化 |
| `src/lib/score.ts` | 打分公式（纯函数） |
| `src/routes/api.ts` | API 端点 + KV 缓存 + 历史冻结 |
| `src/lib/db.ts` | D1 SQL 封装 |
| `wrangler.jsonc` | 项目列表、cron、模型、绑定配置 |
