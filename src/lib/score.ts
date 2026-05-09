export interface AnalyzedIssue {
  sentiment: 'positive' | 'negative' | 'neutral';
  confidence: number;
  comment_count: number;
  created_at: string;
}

export interface UserRatingInput {
  score: number;
}

export interface VersionForScore {
  publishedAt: string;
}

export interface StabilityResult {
  score: number;
  color: string;
  state: 'analyzing' | 'rated';
  breakdown: {
    ageHours: number;
    weightedNegSum: number;
    weightedPosSum: number;
    bugRate: number;
    baseScore: number;
    blendedFromIssues: number;
    issueCount: number;
    negativeCount: number;
    positiveCount: number;
    ratingAvg: number | null;
    ratingCount: number;
  };
}

const NEW_VERSION_GREY_HOURS = 3;
const MIN_AGE_HOURS = 24;
const DECAY_K = 5;
const POS_OFFSET = 0.5;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GREY = '#9ca3af';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function colorForScore(score: number): string {
  if (score === 5) return GREY;
  if (score < 5) {
    const t = clamp((5 - score) / 5, 0, 1);
    return rgbHex(255, 180 - 130 * t, 180 - 130 * t);
  }
  const t = clamp((score - 5) / 5, 0, 1);
  return rgbHex(180 - 140 * t, 200 + 30 * t, 180 - 140 * t);
}

function weightForIssue(issue: AnalyzedIssue, now: number): number {
  const ageDays = Math.max(0, now - new Date(issue.created_at).getTime()) / DAY_MS;
  const recency = Math.exp(-ageDays / 30);
  const commentBoost = 1 + Math.min(2, Math.log10(1 + issue.comment_count) * 0.8);
  const conf = Math.max(0.2, issue.confidence);
  return recency * commentBoost * conf;
}

export function calculateStability(
  version: VersionForScore,
  issues: AnalyzedIssue[],
  ratings: UserRatingInput[],
  now: Date = new Date(),
): StabilityResult {
  const nowMs = now.getTime();
  const ageMs = nowMs - new Date(version.publishedAt).getTime();
  const ageHours = ageMs / HOUR_MS;

  if (ageMs < NEW_VERSION_GREY_HOURS * HOUR_MS) {
    return {
      score: 5,
      color: GREY,
      state: 'analyzing',
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
        ratingCount: 0,
      },
    };
  }

  let weightedNeg = 0;
  let weightedPos = 0;
  let neg = 0;
  let pos = 0;
  for (const issue of issues) {
    const w = weightForIssue(issue, nowMs);
    if (issue.sentiment === 'negative') {
      weightedNeg += w;
      neg++;
    } else if (issue.sentiment === 'positive') {
      weightedPos += w;
      pos++;
    }
  }

  const effectiveNeg = Math.max(0, weightedNeg - POS_OFFSET * weightedPos);
  const denomHours = Math.max(MIN_AGE_HOURS, ageHours);
  const bugRate = effectiveNeg / denomHours;
  const baseScore = 10 * Math.exp(-DECAY_K * bugRate);

  let final = baseScore;
  let ratingAvg: number | null = null;
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
    state: 'rated',
    breakdown: {
      ageHours: Math.round(ageHours * 10) / 10,
      weightedNegSum: Math.round(weightedNeg * 100) / 100,
      weightedPosSum: Math.round(weightedPos * 100) / 100,
      bugRate: Math.round(bugRate * 1000) / 1000,
      baseScore: Math.round(baseScore * 10) / 10,
      blendedFromIssues: Math.round(baseScore * 10) / 10,
      issueCount: issues.length,
      negativeCount: neg,
      positiveCount: pos,
      ratingAvg: ratingAvg === null ? null : Math.round(ratingAvg * 10) / 10,
      ratingCount: ratings.length,
    },
  };
}
