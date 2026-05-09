# OpenClaw 与 Hermes 发行版稳定度评估流程

本文档总结 agent-watch 如何为 [openclaw/openclaw](https://github.com/openclaw/openclaw) 和 [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) 的每个 GitHub Release 计算 0–10 分的稳定度评分（"capability score"）。流程分为 4 个阶段：**数据采集 → LLM 情感分析 → 数值打分 → 历史冻结**。

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

## 3. LLM 情感分析

入口：`src/lib/llm.ts::analyzeIssue`。仅当 `LLM_API_KEY` 配置时启用，否则该 issue 不进入打分。

### 3.1 输入

- 系统提示（`SYSTEM_PROMPT`）：要求模型返回**严格 JSON**。
- 用户消息构造：
  - 最近版本 tag 列表（最新在前）
  - issue 编号、状态、标题、作者、创建时间
  - issue body（截断至 3000 字符）
  - 最近 10 条评论（每条 body 截断至 800 字符）

### 3.2 模型调用

- 端点：`${LLM_BASE_URL}/chat/completions`（默认 `https://api.openai.com/v1`）
- 模型：`LLM_MODEL_NAME`（生产环境为 `gpt-5.4-mini`）
- 参数：`temperature: 0.1`，`response_format: { type: "json_object" }`
- 鉴权：`Authorization: Bearer ${LLM_API_KEY}`

### 3.3 输出

JSON 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sentiment` | `"positive" \| "negative" \| "neutral"` | bug/regression/抱怨 → negative；好评/确认正常 → positive；问题/feature request/不明确 → neutral |
| `target_version` | `string \| null` | 必须**精确匹配**输入版本列表，否则视为 null |
| `confidence` | `[0, 1]` | 对 target_version 的置信度；target_version 为 null 时强制为 0 |
| `summary` | `string` | ≤140 字符的英文摘要 |

### 3.4 容错

- 解析失败、模型返回非合法 JSON、或 target_version 不在版本列表内 → 该 issue 落到 `FALLBACK`（`neutral`/`null`/`0`），保留原始响应（截断至 4000 字符）写入 `issue_analyses.raw_response` 以便审计。

---

## 4. 数值打分（每次 API 请求即时计算）

入口：`src/lib/score.ts::calculateStability`。`/api/projects/:slug` 在请求时基于 issue + rating 数据合成评分。

### 4.1 关键常量

```
NEW_VERSION_GREY_HOURS = 3   // 发布后 3 小时内统一显示为灰色 5（"analyzing"）
MIN_AGE_HOURS          = 24  // bug rate 分母下限，避免新版本被"放大"
DECAY_K                = 5   // 指数衰减强度
POS_OFFSET             = 0.5 // 正面 issue 抵消负面 issue 的权重
```

### 4.2 新版本宽限期

`age < 3h` 时直接返回 `score=5, color=grey, state="analyzing"`，不参与任何聚合。

### 4.3 单条 issue 权重

```
ageDays      = max(0, now - issue.created_at) / 1 day
recency      = exp(-ageDays / 30)        // 30 天半衰意味影响逐渐淡出
commentBoost = 1 + min(2, 0.8 * log10(1 + comment_count))
conf         = max(0.2, issue.confidence) // 设置 0.2 下限避免低置信 issue 完全被忽略

weight = recency * commentBoost * conf
```

仅 `sentiment === 'negative'` 计入 `weightedNeg`，`sentiment === 'positive'` 计入 `weightedPos`，`neutral` 不参与（计入 `issueCount` 但不打分）。

### 4.4 base score（issue 派生）

```
effectiveNeg = max(0, weightedNeg - 0.5 * weightedPos)
denomHours   = max(24, ageHours)
bugRate      = effectiveNeg / denomHours
baseScore    = 10 * exp(-5 * bugRate)   // bugRate=0 → 10；bugRate=0.2 → 3.7；bugRate=1 → 0.07
```

### 4.5 融合用户评分

如果版本有用户 rating（`/api/ratings`，登录用户可提交 1–10 分）：

```
ratingAvg    = mean(clamp(rating.score, 1, 10))
ratingWeight = clamp(N / (N + 5), 0, 0.6)   // 5 票时权重 0.5，10 票时上限 0.6
final        = baseScore * (1 - ratingWeight) + ratingAvg * ratingWeight
```

无 rating 时 `final = baseScore`。

### 4.6 输出

```
score : round(clamp(final, 0, 10) * 10) / 10   // 一位小数
color : <5 渐红 / =5 灰 / >5 渐绿
state : "analyzing" | "rated"
breakdown : 详细中间值（age, weighted sums, bug rate, base, blended, counts, rating avg）
```

颜色映射：分数 5 为 `#9ca3af`（灰）；低于 5 由橙红向红渐变；高于 5 由浅绿向深绿渐变。

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

1. **LLM 误判**：`target_version` 不在版本列表会被丢弃，`confidence` 为 0 的 issue 通过 `max(0.2, conf)` 仍以 0.2 权重参与计算，避免完全忽略。
2. **`neutral` issue**：仅计入展示用的 `issueCount`，不影响分数。
3. **新版本歧视**：发布 < 3h 强制灰 5；3–24h 通过 `denomHours = max(24, ageHours)` 防止极少 issue 直接拉爆 bug rate。
4. **正面言论稀缺**：positive 通常少于 negative，`POS_OFFSET = 0.5` 让一个正面 issue 抵消半个负面 issue，避免"用户基本不发好评"导致系统性偏低。
5. **打分可重放**：`calculateStability` 是纯函数，输入相同则输出相同；冻结规则确保旧版本输入也是稳定的。

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
