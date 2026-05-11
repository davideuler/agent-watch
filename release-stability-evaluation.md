# Release Stability Evaluation

Agent Watch grades every release on a **0–10 stability scale** (10 = most stable, 0 = least stable) using GitHub issue data, LLM classification, and community ratings.

---

## Grade Thresholds

| Score | Grade | Meaning |
|---|---|---|
| 8.2 – 10 | **STABLE** | Low observed release risk |
| 6.8 – 8.1 | **MOSTLY STABLE** | Real issues exist but no broad breakage |
| 5.2 – 6.7 | **MIXED** | Enough risk to check affected workflows |
| 3.5 – 5.1 | **RISKY** | Core or broad failures present |
| 0 – 3.4 | **UNSTABLE** | Severe/broad/core signals dominate |
| 5.0 (grey) | **COLLECTING SIGNAL** | First 3 hours after release |

---

## Step 1 — New Version Grace Period

If a release is less than **3 hours** old, Agent Watch returns a neutral score of **5** and marks it *Analyzing*. No scoring is performed until enough signal accumulates.

---

## Step 2 — Per-Issue Risk Weight

Every negative GitHub issue linked to the release is assigned a raw risk weight:

```
raw = recency × discussionBoost × duplicateBoost × confidence
      × severityWeight × scopeWeight × functionWeight × userShareWeight × workaroundWeight
```

**Capped at 5 per issue** (`PER_ISSUE_CAP = 5`) so a single extreme issue cannot collapse the score alone.

### Factor weights

| Factor | Values → Weights |
|---|---|
| **Severity** | critical → 2.8 · high → 1.9 · medium → 1.0 · low → 0.35 |
| **Impact scope** | broad → 1.75 · moderate → 1.0 · niche → 0.3 |
| **Functionality area** | core → 1.65 · provider → 0.75 · integration → 0.45 · docs → 0.15 · unknown → 0.8 |
| **Affected user share** | many → 1.45 · some → 0.9 · few → 0.35 · unknown → 0.75 |
| **Workaround status** | none → 1.0 · unknown → 0.85 · partial → 0.65 · confirmed → 0.35 |

### Recency decay (per-issue)
```
recency = 0.55 + 0.45 × exp(−ageDays / 45)
```
Fresh issues carry full weight; issues older than ~45 days decay toward 0.55.

### Discussion boost
```
discussionBoost = 1 + min(1.4, log10(1 + comments) × 0.45)
```
Highly-commented issues signal broader impact.

### Duplicate cluster boost
```
duplicateBoost = 1 + log2(clusterSize) × 0.28
```
Duplicate clusters confirm broader reproduction.

---

## Step 3 — Core-Serious Split

Issues are split into two buckets:

- **Core-serious**: `functionality == core` AND (`severity == critical` OR `severity == high`)
- **Other**: everything else (niche issues, provider/integration bugs, low-severity core issues, etc.)

Positive issues generate a **positive budget**:
```
posBudget = 0.7 × weightedPos
```

Positives cancel *other* negatives first, then residual budget cancels core-serious negatives:
```
effectiveCore  = max(0, weightedNegCoreSerious − min(weightedNegCoreSerious, max(0, posBudget − otherCancel)))
effectiveOther = max(0, weightedNegOther − min(weightedNegOther, posBudget))
```

---

## Step 4 — Score Formula

### Core score (main driver)
```
coreRiskIndex = effectiveCore
coreScore     = 10 / (1 + (coreRiskIndex / 4.2) ^ 1.35)
```

One core+critical bug at full weight (≈4–5) → `coreScore ≈ 4–5` (Risky range).  
Zero core-serious issues → `coreScore = 5` (neutral baseline).

### Other-issues drop (capped at 2 points)
```
otherDrop = 2.0 × (1 − exp(−effectiveOther / 3.0))
```
No matter how many non-core-serious issues exist, their total contribution is **at most −2 points**.

### Base score
```
baseScore = max(1.0, coreScore − otherDrop)
```
Hard floor of **1.0** — the lowest possible non-grey score.

---

## Step 5 — Community Ratings Blend

If users have submitted ratings (1–10 stars):
```
ratingAvg    = average of all submitted ratings
ratingWeight = clamp(ratingCount / (ratingCount + 5), 0, 0.60)
final        = baseScore × (1 − ratingWeight) + ratingAvg × ratingWeight
```

Ratings carry up to **60% weight** once enough votes accumulate (≥5 ratings for meaningful influence).

---

## Step 6 — Peer Median Floor

If a release's total negative signal (`weightedNegCoreSerious + weightedNegOther`) is **at or below the median** across all tracked versions of the same project, and the score has fallen below **5.5**, it is floored to **5.5**.

This prevents a version with average-or-better signal from being punished by the absolute scale alone.

---

## Score Interpretation Summary

| What's present | Typical score range |
|---|---|
| No negative issues | 5.0 (neutral) |
| Only niche/low-severity issues | 3.0 – 5.0 (max −2 from baseline) |
| 1 core+critical/high bug | 3.5 – 5.5 (Risky / Mixed) |
| 2–3 core+critical/high bugs | 2.0 – 4.0 (Risky / Unstable) |
| Many core+critical bugs | 1.0 – 2.5 (Unstable) |
| Strong positive community ratings | +0 to +3 boost via blend |
| Below peer median signal | Floored to 5.5 |

---

## Update Frequency

Scores are recalculated every **20 minutes** via cron, pulling fresh data from GitHub issues and LLM classification. Historical releases (2+ versions behind the latest) are frozen once their GitHub issue and rating inputs stop changing.
