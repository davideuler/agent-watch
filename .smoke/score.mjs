// src/lib/score.ts
var NEW_VERSION_GREY_HOURS = 3;
var MIN_AGE_HOURS = 24;
var DECAY_K = 5;
var POS_OFFSET = 0.5;
var HOUR_MS = 60 * 60 * 1e3;
var DAY_MS = 24 * HOUR_MS;
var GREY = "#9ca3af";
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function rgbHex(r, g, b) {
  const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function colorForScore(score) {
  if (score === 5) return GREY;
  if (score < 5) {
    const t2 = clamp((5 - score) / 5, 0, 1);
    return rgbHex(255, 180 - 130 * t2, 180 - 130 * t2);
  }
  const t = clamp((score - 5) / 5, 0, 1);
  return rgbHex(180 - 140 * t, 200 + 30 * t, 180 - 140 * t);
}
function weightForIssue(issue, now) {
  const ageDays = Math.max(0, now - new Date(issue.created_at).getTime()) / DAY_MS;
  const recency = Math.exp(-ageDays / 30);
  const commentBoost = 1 + Math.min(2, Math.log10(1 + issue.comment_count) * 0.8);
  const conf = Math.max(0.2, issue.confidence);
  return recency * commentBoost * conf;
}
function calculateStability(version, issues, ratings, now = /* @__PURE__ */ new Date()) {
  const nowMs = now.getTime();
  const ageMs = nowMs - new Date(version.publishedAt).getTime();
  const ageHours = ageMs / HOUR_MS;
  if (ageMs < NEW_VERSION_GREY_HOURS * HOUR_MS) {
    return {
      score: 5,
      color: GREY,
      state: "analyzing",
      breakdown: {
        ageHours: Math.round(ageHours * 10) / 10,
        weightedNegSum: 0,
        weightedPosSum: 0,
        bugRate: 0,
        baseScore: 5,
        blendedFromIssues: 5,
        issueCount: 0,
        negativeCount: 0,
        positiveCount: 0,
        ratingAvg: null,
        ratingCount: 0
      }
    };
  }
  let weightedNeg = 0;
  let weightedPos = 0;
  let neg = 0;
  let pos = 0;
  for (const issue of issues) {
    const w = weightForIssue(issue, nowMs);
    if (issue.sentiment === "negative") {
      weightedNeg += w;
      neg++;
    } else if (issue.sentiment === "positive") {
      weightedPos += w;
      pos++;
    }
  }
  const effectiveNeg = Math.max(0, weightedNeg - POS_OFFSET * weightedPos);
  const denomHours = Math.max(MIN_AGE_HOURS, ageHours);
  const bugRate = effectiveNeg / denomHours;
  const baseScore = 10 * Math.exp(-DECAY_K * bugRate);
  let final = baseScore;
  let ratingAvg = null;
  if (ratings.length > 0) {
    const sum = ratings.reduce((acc, r) => acc + clamp(r.score, 1, 10), 0);
    ratingAvg = sum / ratings.length;
    const ratingWeight = clamp(ratings.length / (ratings.length + 5), 0, 0.6);
    final = baseScore * (1 - ratingWeight) + ratingAvg * ratingWeight;
  }
  const rounded = Math.round(clamp(final, 0, 10) * 10) / 10;
  return {
    score: rounded,
    color: colorForScore(rounded),
    state: "rated",
    breakdown: {
      ageHours: Math.round(ageHours * 10) / 10,
      weightedNegSum: Math.round(weightedNeg * 100) / 100,
      weightedPosSum: Math.round(weightedPos * 100) / 100,
      bugRate: Math.round(bugRate * 1e3) / 1e3,
      baseScore: Math.round(baseScore * 10) / 10,
      blendedFromIssues: Math.round(baseScore * 10) / 10,
      issueCount: issues.length,
      negativeCount: neg,
      positiveCount: pos,
      ratingAvg: ratingAvg === null ? null : Math.round(ratingAvg * 10) / 10,
      ratingCount: ratings.length
    }
  };
}
export {
  calculateStability
};
