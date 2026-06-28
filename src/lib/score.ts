export interface AnalyzedIssue {
  sentiment: 'positive' | 'negative' | 'neutral';
  confidence: number;
  comment_count: number;
  created_at: string;
  severity?: IssueSeverity | null;
  impact_scope?: ImpactScope | null;
  functionality?: FunctionalityArea | null;
  affected_user_share?: AffectedUserShare | null;
  duplicate_cluster_size?: number | null;
  workaround_status?: WorkaroundStatus | null;
}

export interface UserRatingInput {
  score: number;
}

export interface VersionForScore {
  publishedAt: string;
  /**
   * ISO timestamp of the next-newer release that superseded this one (i.e. the
   * moment this version stopped being the "current" release). Omit/null for the
   * live (newest) version — its exposure window runs up to `now`.
   */
  supersededAt?: string | null;
}

export interface PeerContext {
  medianWeightedNeg: number;
}

export interface StabilityResult {
  score: number;
  color: string;
  state: 'analyzing' | 'rated';
  grade: StabilityGrade;
  breakdown: {
    ageHours: number;
    exposureDays: number;
    exposureFactor: number;
    weightedNegSum: number;
    normalizedNegSum: number;
    weightedPosSum: number;
    riskIndex: number;
    baseScore: number;
    blendedFromIssues: number;
    issueCount: number;
    negativeCount: number;
    positiveCount: number;
    coreIssueCount: number;
    coreSeriousCount: number;
    nicheIssueCount: number;
    workaroundCount: number;
    nicheRawSum: number;
    topRiskFactor: string;
    ratingAvg: number | null;
    ratingCount: number;
    signalCount: number;
    confidenceLevel: 'low' | 'medium' | 'high';
    floorApplied: 'none' | 'core' | 'peer';
  };
}

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ImpactScope = 'broad' | 'moderate' | 'niche';
export type FunctionalityArea = 'core' | 'integration' | 'provider' | 'docs' | 'unknown';
export type AffectedUserShare = 'many' | 'some' | 'few' | 'unknown';
export type WorkaroundStatus = 'none' | 'partial' | 'confirmed' | 'unknown';
export type StabilityGrade =
  | 'Stable'
  | 'Mostly stable'
  | 'Mixed'
  | 'Risky'
  | 'Unstable'
  | 'Insufficient signal';

const NEW_VERSION_GREY_HOURS = 3;
const POS_OFFSET = 0.7;
const PER_ISSUE_CAP = 5;
const OTHER_DROP_MAX = 2.0;
const OTHER_DROP_TAU = 3.0;
const PEER_MEDIAN_FLOOR = 5.5;
const MIN_SCORE = 1.0;
// Exposure-time normalization. Risk in this model is a *sum* of release-linked
// issue weight, so a release that stays current longer mechanically accumulates
// more of it — biasing long-lived / popular releases toward lower scores even at
// an equal per-day failure rate. We correct this with a ONE-SIDED deflator: with
// GRACE ≈ REF, a fresh release gets factor ≈ 1 (never amplified — this is the
// failure mode that got an earlier `riskSum / age` divisor removed), and only
// releases live longer than the reference window get risk relief, floored so a
// genuinely bad long-lived release is never fully exonerated. A release that
// keeps generating issues still accrues risk ∝ days, so its rate stays high.
const EXPOSURE_REF_DAYS = 30;
const EXPOSURE_GRACE_DAYS = 30;
const MIN_EXPOSURE_FACTOR = 0.5;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GREY = '#9ca3af';

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = {
  critical: 2.8,
  high: 1.9,
  medium: 1.0,
  low: 0.35,
};

const SCOPE_WEIGHT: Record<ImpactScope, number> = {
  broad: 1.75,
  moderate: 1.0,
  niche: 0.3,
};

const FUNCTION_WEIGHT: Record<FunctionalityArea, number> = {
  core: 1.65,
  provider: 0.75,
  integration: 0.45,
  docs: 0.15,
  unknown: 0.8,
};

const USER_SHARE_WEIGHT: Record<AffectedUserShare, number> = {
  many: 1.45,
  some: 0.9,
  few: 0.35,
  unknown: 0.75,
};

const WORKAROUND_WEIGHT: Record<WorkaroundStatus, number> = {
  none: 1,
  unknown: 0.85,
  partial: 0.65,
  confirmed: 0.35,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** One-sided exposure deflator in [MIN_EXPOSURE_FACTOR, 1]. See the constant block above for rationale. */
function exposureDeflator(exposureDays: number): number {
  const f =
    (EXPOSURE_REF_DAYS + EXPOSURE_GRACE_DAYS) / (Math.max(0, exposureDays) + EXPOSURE_GRACE_DAYS);
  return clamp(f, MIN_EXPOSURE_FACTOR, 1);
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

function issueRiskWeight(issue: AnalyzedIssue, now: number): number {
  const ageDays = Math.max(0, now - new Date(issue.created_at).getTime()) / DAY_MS;
  const recency = 0.55 + 0.45 * Math.exp(-ageDays / 45);
  const discussionBoost = 1 + Math.min(1.4, Math.log10(1 + issue.comment_count) * 0.45);
  const conf = Math.max(0.2, issue.confidence);
  const duplicateClusterSize = clamp(issue.duplicate_cluster_size ?? 1, 1, 100);
  const duplicateBoost = 1 + Math.log2(duplicateClusterSize) * 0.28;
  return (
    recency *
    discussionBoost *
    duplicateBoost *
    conf *
    SEVERITY_WEIGHT[issue.severity ?? 'medium'] *
    SCOPE_WEIGHT[issue.impact_scope ?? 'moderate'] *
    FUNCTION_WEIGHT[issue.functionality ?? 'unknown'] *
    USER_SHARE_WEIGHT[issue.affected_user_share ?? 'unknown'] *
    WORKAROUND_WEIGHT[issue.workaround_status ?? 'unknown']
  );
}

function positiveEvidenceWeight(issue: AnalyzedIssue, now: number): number {
  const ageDays = Math.max(0, now - new Date(issue.created_at).getTime()) / DAY_MS;
  const recency = 0.65 + 0.35 * Math.exp(-ageDays / 45);
  const discussionBoost = 1 + Math.min(0.8, Math.log10(1 + issue.comment_count) * 0.3);
  return recency * discussionBoost * Math.max(0.2, issue.confidence);
}

function scoreFromRiskIndex(riskIndex: number): number {
  return 10 / (1 + Math.pow(Math.max(0, riskIndex) / 4.2, 1.35));
}

function gradeForScore(score: number, issueCount: number): StabilityGrade {
  if (issueCount === 0 && score === 5) return 'Insufficient signal';
  if (score >= 8.2) return 'Stable';
  if (score >= 6.8) return 'Mostly stable';
  if (score >= 5.2) return 'Mixed';
  if (score >= 3.5) return 'Risky';
  return 'Unstable';
}

function topRiskFactor(coreSeriousCount: number, nicheIssueCount: number, workaroundCount: number, negativeCount: number): string {
  if (negativeCount === 0) return 'No negative release-linked issues';
  if (coreSeriousCount > 0) return `${coreSeriousCount} core-blocking signal${coreSeriousCount === 1 ? '' : 's'}`;
  if (nicheIssueCount > 0) return `${nicheIssueCount} niche/integration signal${nicheIssueCount === 1 ? '' : 's'} (capped)`;
  if (workaroundCount > 0) return `${workaroundCount} issue${workaroundCount === 1 ? '' : 's'} with confirmed workarounds`;
  return `${negativeCount} negative signal${negativeCount === 1 ? '' : 's'}`;
}

export function calculateStability(
  version: VersionForScore,
  issues: AnalyzedIssue[],
  ratings: UserRatingInput[],
  now: Date = new Date(),
  peerContext?: PeerContext,
): StabilityResult {
  const nowMs = now.getTime();
  const publishedMs = new Date(version.publishedAt).getTime();
  const ageMs = nowMs - publishedMs;
  const ageHours = ageMs / HOUR_MS;

  // Exposure window: from publish until the next release superseded this one
  // (or until `now` for the live version). Drives the one-sided risk deflator.
  const exposureEndMs = version.supersededAt ? new Date(version.supersededAt).getTime() : nowMs;
  const exposureDays = Math.max(0, (exposureEndMs - publishedMs) / DAY_MS);
  const exposureFactor = exposureDeflator(exposureDays);

  if (ageMs < NEW_VERSION_GREY_HOURS * HOUR_MS) {
    return {
      score: 5,
      color: GREY,
      state: 'analyzing',
      breakdown: {
        ageHours: Math.round(ageHours * 10) / 10,
        exposureDays: Math.round(exposureDays * 10) / 10,
        exposureFactor: Math.round(exposureFactor * 1000) / 1000,
        weightedNegSum: 0,
        normalizedNegSum: 0,
        weightedPosSum: 0,
        riskIndex: 0,
        baseScore: 5,
        blendedFromIssues: 5,
        issueCount: issues.length,
        negativeCount: 0,
        positiveCount: 0,
        coreIssueCount: 0,
        coreSeriousCount: 0,
        nicheIssueCount: 0,
        workaroundCount: 0,
        nicheRawSum: 0,
        topRiskFactor: 'Still collecting issue signal',
        ratingAvg: null,
        ratingCount: 0,
        signalCount: 0,
        confidenceLevel: 'low',
        floorApplied: 'none',
      },
      grade: 'Insufficient signal',
    };
  }

  let weightedNegCoreSerious = 0;
  let weightedNegOther = 0;
  let weightedNegNicheRaw = 0;
  let weightedPos = 0;
  let neg = 0;
  let pos = 0;
  let coreIssueCount = 0;
  let coreSeriousCount = 0;
  let nicheIssueCount = 0;
  let workaroundCount = 0;
  for (const issue of issues) {
    if (issue.sentiment === 'negative') {
      const raw = issueRiskWeight(issue, nowMs);
      const w = Math.min(raw, PER_ISSUE_CAP);
      const scope = issue.impact_scope ?? 'moderate';
      const fn = issue.functionality ?? 'unknown';
      const sev = issue.severity ?? 'medium';
      const isCoreSerious = fn === 'core' && (sev === 'critical' || sev === 'high');
      if (isCoreSerious) {
        weightedNegCoreSerious += w;
        coreSeriousCount++;
      } else {
        weightedNegOther += w;
      }
      if (fn === 'core') coreIssueCount++;
      if (scope === 'niche') {
        weightedNegNicheRaw += w;
        nicheIssueCount++;
      }
      if ((issue.workaround_status ?? 'unknown') === 'confirmed') workaroundCount++;
      neg++;
    } else if (issue.sentiment === 'positive') {
      const w = positiveEvidenceWeight(issue, nowMs);
      weightedPos += w;
      pos++;
    }
  }

  // Positives cancel non-core-serious negatives first (those are easier to dismiss),
  // residual positive budget then nibbles at core-serious negatives.
  const posBudget = POS_OFFSET * weightedPos;
  const otherCancel = Math.min(weightedNegOther, posBudget);
  const coreCancel = Math.min(weightedNegCoreSerious, Math.max(0, posBudget - otherCancel));
  const effectiveCore = Math.max(0, weightedNegCoreSerious - coreCancel);
  const effectiveOther = Math.max(0, weightedNegOther - otherCancel);

  // Deflate accumulated risk by the exposure factor (core + secondary buckets).
  const coreRiskIndex = effectiveCore * exposureFactor;
  const coreScore = issues.length === 0 ? 5 : scoreFromRiskIndex(coreRiskIndex);
  const otherDrop =
    OTHER_DROP_MAX * (1 - Math.exp(-(effectiveOther * exposureFactor) / OTHER_DROP_TAU));
  const baseScore = issues.length === 0 ? 5 : Math.max(MIN_SCORE, coreScore - otherDrop);

  let final = baseScore;
  let ratingAvg: number | null = null;
  if (ratings.length > 0) {
    const sum = ratings.reduce((acc, r) => acc + clamp(r.score, 1, 10), 0);
    ratingAvg = sum / ratings.length;
    const ratingWeight = clamp(ratings.length / (ratings.length + 5), 0, 0.6);
    final = baseScore * (1 - ratingWeight) + ratingAvg * ratingWeight;
  }

  let floorApplied: 'none' | 'core' | 'peer' = 'none';
  const totalWeightedNeg = weightedNegCoreSerious + weightedNegOther;
  if (
    peerContext &&
    Number.isFinite(peerContext.medianWeightedNeg) &&
    peerContext.medianWeightedNeg > 0 &&
    totalWeightedNeg <= peerContext.medianWeightedNeg &&
    final < PEER_MEDIAN_FLOOR
  ) {
    final = PEER_MEDIAN_FLOOR;
    floorApplied = 'peer';
  }

  const rounded = Math.round(clamp(final, MIN_SCORE, 10) * 10) / 10;
  const grade = gradeForScore(rounded, issues.length);
  const signalCount = neg + pos + ratings.length;
  const confidenceLevel: 'low' | 'medium' | 'high' =
    signalCount >= 8 ? 'high' : signalCount >= 3 ? 'medium' : 'low';
  return {
    score: rounded,
    color: colorForScore(rounded),
    state: 'rated',
    grade,
    breakdown: {
      ageHours: Math.round(ageHours * 10) / 10,
      exposureDays: Math.round(exposureDays * 10) / 10,
      exposureFactor: Math.round(exposureFactor * 1000) / 1000,
      weightedNegSum: Math.round(totalWeightedNeg * 100) / 100,
      normalizedNegSum: Math.round(totalWeightedNeg * exposureFactor * 100) / 100,
      weightedPosSum: Math.round(weightedPos * 100) / 100,
      riskIndex: Math.round(coreRiskIndex * 1000) / 1000,
      baseScore: Math.round(baseScore * 10) / 10,
      blendedFromIssues: Math.round(baseScore * 10) / 10,
      issueCount: issues.length,
      negativeCount: neg,
      positiveCount: pos,
      coreIssueCount,
      coreSeriousCount,
      nicheIssueCount,
      workaroundCount,
      nicheRawSum: Math.round(weightedNegNicheRaw * 100) / 100,
      topRiskFactor: topRiskFactor(coreSeriousCount, nicheIssueCount, workaroundCount, neg),
      ratingAvg: ratingAvg === null ? null : Math.round(ratingAvg * 10) / 10,
      ratingCount: ratings.length,
      signalCount,
      confidenceLevel,
      floorApplied,
    },
  };
}
