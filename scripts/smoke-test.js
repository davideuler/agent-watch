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

  // Case 2: old version with negative issues → score < 5
  const b = calculateStability(
    { publishedAt: '2026-04-01T00:00:00Z' },
    [
      { sentiment: 'negative', confidence: 0.9, comment_count: 12, created_at: '2026-04-15T00:00:00Z' },
      { sentiment: 'negative', confidence: 0.8, comment_count: 5, created_at: '2026-04-20T00:00:00Z' },
      { sentiment: 'negative', confidence: 0.7, comment_count: 0, created_at: '2026-04-25T00:00:00Z' },
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
  }));
  const e = calculateStability({ publishedAt: '2026-04-01T00:00:00Z' }, heavyNeg, [], now);
  assert(e.score >= 0 && e.score <= 10, 'score must remain in [0,10]', e);

  // Case 6: color for score=5 is grey
  const f = calculateStability({ publishedAt: '2026-04-01T00:00:00Z' }, [], [], now);
  assert(f.score === 5 && f.color === '#9ca3af', 'no signals should give grey 5', f);

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
