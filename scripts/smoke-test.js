#!/usr/bin/env node
// Smoke-test the score module without bundling the worker.
// Compiles via esbuild on the fly to plain JS, then exercises calculateStability.
import { build } from 'esbuild';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmpDir = join(root, '.smoke-score');

async function main() {
  await mkdir(tmpDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'src/lib/score.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile: join(tmpDir, 'score.mjs'),
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(join(tmpDir, 'score.mjs')).href);
  const { calculateStability } = mod;

  const now = new Date('2026-05-09T06:00:00Z');

  // Case 1: brand-new version (1 hour old) → grey 5
  const a = calculateStability({ publishedAt: '2026-05-09T05:00:00Z' }, [], [], now);
  assert(a.score === 5 && a.color === '#9ca3af' && a.state === 'analyzing', 'new version should be grey 5', a);

  // Case 2: old version with core negative issues → score < 5
  const b = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [
      {
        sentiment: 'negative',
        confidence: 0.9,
        comment_count: 12,
        created_at: '2026-04-15T00:00:00Z',
        severity: 'high',
        impact_scope: 'broad',
        functionality: 'core',
        affected_user_share: 'many',
        duplicate_cluster_size: 3,
        workaround_status: 'none',
      },
      {
        sentiment: 'negative',
        confidence: 0.8,
        comment_count: 5,
        created_at: '2026-04-20T00:00:00Z',
        severity: 'medium',
        impact_scope: 'moderate',
        functionality: 'core',
        affected_user_share: 'some',
        duplicate_cluster_size: 1,
        workaround_status: 'partial',
      },
    ],
    [],
    now,
  );
  assert(b.score < 5 && b.color.startsWith('#'), 'negative issues should drop score below 5', b);

  // Case 3: old version with positive issues → score > 5
  const c = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [
      { sentiment: 'positive', confidence: 0.9, comment_count: 3, created_at: '2026-04-20T00:00:00Z' },
      { sentiment: 'positive', confidence: 0.8, comment_count: 1, created_at: '2026-04-25T00:00:00Z' },
    ],
    [],
    now,
  );
  assert(c.score > 5, 'positive issues should raise score above 5', c);

  // Case 4: high user ratings should pull blended score up
  const d = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [],
    [{ score: 9 }, { score: 10 }, { score: 8 }, { score: 9 }, { score: 10 }],
    now,
  );
  assert(d.score > 5, 'high user ratings should pull score above 5', d);

  // Case 5: score must clamp to [0,10]
  const heavyNeg = Array.from({ length: 50 }, (_, i) => ({
    sentiment: 'negative',
    confidence: 1.0,
    comment_count: 30,
    created_at: '2026-05-01T00:00:00Z',
    severity: 'critical',
    impact_scope: 'broad',
    functionality: 'core',
    affected_user_share: 'many',
    duplicate_cluster_size: 1,
    workaround_status: 'none',
  }));
  const e = calculateStability({ publishedAt: '2026-04-01T00:00:00Z' }, heavyNeg, [], now);
  assert(e.score >= 1 && e.score <= 10, 'score must remain in [1,10]', e);

  // Case 6: color for score=5 is grey
  const f = calculateStability({ publishedAt: '2026-04-01T00:00:00Z' }, [], [], now);
  assert(f.score === 5 && f.color === '#9ca3af' && f.grade === 'Insufficient signal', 'no signals should give grey 5', f);

  // Case 7: many narrow integration issues should not imply the release is unusable.
  const nicheIssues = Array.from({ length: 30 }, () => ({
    sentiment: 'negative',
    confidence: 0.9,
    comment_count: 2,
    created_at: '2026-05-01T00:00:00Z',
    severity: 'low',
    impact_scope: 'niche',
    functionality: 'integration',
    affected_user_share: 'few',
    duplicate_cluster_size: 1,
    workaround_status: 'confirmed',
  }));
  const g = calculateStability({ publishedAt: '2026-04-01T00:00:00Z' }, nicheIssues, [], now);
  assert(g.score >= 6.5, 'niche integration issues with workarounds should not collapse the release grade', g);

  // Case 8: duplicate clusters should compress repeated reports but still carry real signal.
  const duplicateCluster = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [
      {
        sentiment: 'negative',
        confidence: 0.9,
        comment_count: 20,
        created_at: '2026-05-01T00:00:00Z',
        severity: 'high',
        impact_scope: 'moderate',
        functionality: 'core',
        affected_user_share: 'some',
        duplicate_cluster_size: 10,
        workaround_status: 'partial',
      },
    ],
    [],
    now,
  );
  const tenSeparate = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    Array.from({ length: 10 }, () => ({
      sentiment: 'negative',
      confidence: 0.9,
      comment_count: 2,
      created_at: '2026-05-01T00:00:00Z',
      severity: 'high',
      impact_scope: 'moderate',
      functionality: 'core',
      affected_user_share: 'some',
      duplicate_cluster_size: 1,
      workaround_status: 'partial',
    })),
    [],
    now,
  );
  assert(
    duplicateCluster.score > tenSeparate.score,
    'duplicate clusters should count less than the same number of independent failures',
    { duplicateCluster, tenSeparate },
  );

  // Case 9: many provider/integration issues (LLM mis-tagged as broad+core+critical) with niche scope
  // should be capped — score should not collapse below 5 thanks to NICHE_TOTAL_CAP=1.0.
  const inflatedNiche = Array.from({ length: 20 }, () => ({
    sentiment: 'negative',
    confidence: 1.0,
    comment_count: 50,
    created_at: '2026-05-01T00:00:00Z',
    severity: 'critical',
    impact_scope: 'niche',
    functionality: 'integration',
    affected_user_share: 'many',
    duplicate_cluster_size: 5,
    workaround_status: 'none',
  }));
  const h = calculateStability({ publishedAt: '2026-04-01T00:00:00Z' }, inflatedNiche, [], now);
  assert(
    h.score >= 6.0,
    'a flood of niche issues (even severely-tagged) should be capped and not crash the score',
    h,
  );
  assert(
    h.breakdown.nicheRawSum >= 1.0 && h.breakdown.weightedNegSum <= h.breakdown.nicheRawSum + 0.01,
    'nicheRawSum should reflect the uncapped sum while weightedNegSum reflects the capped contribution',
    h,
  );

  // Case 10: core-stability floor — negative issues that are NOT core+critical/high should
  // never push a release below "Mostly stable" (6.0).
  const noCoreSerious = Array.from({ length: 30 }, () => ({
    sentiment: 'negative',
    confidence: 0.9,
    comment_count: 8,
    created_at: '2026-05-01T00:00:00Z',
    severity: 'medium',
    impact_scope: 'moderate',
    functionality: 'provider',
    affected_user_share: 'some',
    duplicate_cluster_size: 1,
    workaround_status: 'none',
  }));
  const i9 = calculateStability({ publishedAt: '2026-04-01T00:00:00Z' }, noCoreSerious, [], now);
  assert(
    i9.score >= 8.0 && i9.breakdown.coreSeriousCount === 0,
    'absent any core+critical/high issue, non-core negatives can drop at most 2 points (score >= 8.0)',
    i9,
  );

  // Case 11: per-issue cap — a single overly-tagged "critical+broad+core+many+huge-cluster" issue
  // should not produce an unstable score on its own.
  const oneInflated = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [
      {
        sentiment: 'negative',
        confidence: 1.0,
        comment_count: 200,
        created_at: '2026-05-01T00:00:00Z',
        severity: 'critical',
        impact_scope: 'broad',
        functionality: 'core',
        affected_user_share: 'many',
        duplicate_cluster_size: 100,
        workaround_status: 'none',
      },
    ],
    [],
    now,
  );
  assert(
    oneInflated.score >= 3.0,
    'per-issue cap should keep one max-tagged issue from producing an unstable verdict',
    oneInflated,
  );

  // Case 12: peer-median floor — a version whose weightedNeg is at or below project peer median
  // should not be marked Risky/Unstable just because its absolute count is non-zero.
  const sampleNegativeIssue = (severity = 'high', functionality = 'core') => ({
    sentiment: 'negative',
    confidence: 0.9,
    comment_count: 5,
    created_at: '2026-05-01T00:00:00Z',
    severity,
    impact_scope: 'moderate',
    functionality,
    affected_user_share: 'some',
    duplicate_cluster_size: 1,
    workaround_status: 'partial',
  });
  const peerHeavy = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [sampleNegativeIssue(), sampleNegativeIssue(), sampleNegativeIssue()],
    [],
    now,
  );
  const peerLight = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [sampleNegativeIssue('medium', 'core')],
    [],
    now,
    { medianWeightedNeg: peerHeavy.breakdown.weightedNegSum },
  );
  assert(
    peerLight.score >= 5.5,
    'a release at-or-below project peer median should respect the peer floor',
    { peerHeavy, peerLight },
  );

  // Case 13: stronger positive offset — a release with several "works for me" issues should
  // pull the score up materially even with one moderate negative.
  const balanced = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [
      { sentiment: 'negative', confidence: 0.9, comment_count: 3, created_at: '2026-05-01T00:00:00Z', severity: 'medium', impact_scope: 'moderate', functionality: 'integration', affected_user_share: 'some', duplicate_cluster_size: 1, workaround_status: 'partial' },
      { sentiment: 'positive', confidence: 0.9, comment_count: 5, created_at: '2026-05-01T00:00:00Z' },
      { sentiment: 'positive', confidence: 0.9, comment_count: 5, created_at: '2026-05-01T00:00:00Z' },
      { sentiment: 'positive', confidence: 0.9, comment_count: 5, created_at: '2026-05-01T00:00:00Z' },
    ],
    [],
    now,
  );
  assert(
    balanced.score >= 7.0,
    'positive evidence with stronger offset should raise score with one minor negative present',
    balanced,
  );

  // Case 15: brand-new release (analyzing branch) must still surface real
  // issueCount when issues are already attached, otherwise the dashboard
  // total under-reports the issues users can see when they click through.
  const newWithIssues = calculateStability(
    { publishedAt: '2026-05-09T05:00:00Z' },
    [
      {
        sentiment: 'negative',
        confidence: 0.8,
        comment_count: 1,
        created_at: '2026-05-09T05:30:00Z',
        severity: 'high',
        impact_scope: 'broad',
        functionality: 'core',
        affected_user_share: 'some',
        duplicate_cluster_size: 1,
        workaround_status: 'unknown',
      },
      {
        sentiment: 'neutral',
        confidence: 0,
        comment_count: 0,
        created_at: '2026-05-09T05:30:00Z',
      },
    ],
    [],
    now,
  );
  assert(
    newWithIssues.state === 'analyzing' && newWithIssues.breakdown.issueCount === 2,
    'analyzing branch should surface real issue count, not zero',
    newWithIssues,
  );

  // Case 16: neutral / unsentimented issues count toward issueCount but do
  // not change neg/pos weighting.
  const onlyNeutral = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [
      { sentiment: 'neutral', confidence: 0.3, comment_count: 0, created_at: '2026-05-01T00:00:00Z' },
      { sentiment: 'neutral', confidence: 0.3, comment_count: 0, created_at: '2026-05-01T00:00:00Z' },
      { sentiment: 'neutral', confidence: 0.3, comment_count: 0, created_at: '2026-05-01T00:00:00Z' },
    ],
    [],
    now,
  );
  assert(
    onlyNeutral.breakdown.issueCount === 3 &&
      onlyNeutral.breakdown.negativeCount === 0 &&
      onlyNeutral.breakdown.positiveCount === 0,
    'neutral issues count toward issueCount but contribute no negative/positive weight',
    onlyNeutral,
  );

  // Case 14: signalCount and confidenceLevel are exposed for UI display.
  const lowSignal = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [{ sentiment: 'negative', confidence: 0.5, comment_count: 0, created_at: '2026-05-01T00:00:00Z', severity: 'low', impact_scope: 'niche', functionality: 'docs', affected_user_share: 'few', duplicate_cluster_size: 1, workaround_status: 'unknown' }],
    [],
    now,
  );
  assert(
    lowSignal.breakdown.confidenceLevel === 'low' && lowSignal.breakdown.signalCount === 1,
    'low-signal release should expose confidenceLevel="low" and a signalCount',
    lowSignal,
  );

  console.log('✔ smoke tests pass');
  await rm(tmpDir, { recursive: true, force: true });
}

function assert(cond, msg, ctx) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    console.error(JSON.stringify(ctx, null, 2));
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
