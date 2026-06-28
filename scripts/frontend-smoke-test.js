#!/usr/bin/env node
// Smoke-test browser-facing helper logic without requiring a browser runtime.
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmpDir = join(root, '.smoke-frontend');

async function main() {
  await mkdir(tmpDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'src/public/release-display.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: join(tmpDir, 'release-display.mjs'),
    logLevel: 'silent',
  });

  const mod = await import(pathToFileURL(join(tmpDir, 'release-display.mjs')).href);
  const {
    formatReleaseDate,
    getReleaseDisplay,
    googleAnalyticsScriptSrc,
    formatCompactCount,
    reportsPerThousandDownloads,
  } = mod;

  const hermes = getReleaseDisplay({
    tag_name: 'v2026.5.7',
    name: 'Hermes Agent v0.13.0 (2026.5.7) - The Tenacity Release',
    published_at: '2026-05-07T16:23:08Z',
  });
  assert(hermes.version === 'v0.13.0', 'Hermes release name version should be primary', hermes);
  assert(hermes.subtitle === 'Hermes Agent - The Tenacity Release', 'Hermes release name should remain as subtitle without duplicate version/date', hermes);

  const openclaw = getReleaseDisplay({
    tag_name: 'v1.2.3',
    name: 'v1.2.3',
    published_at: '2026-05-07T16:23:08Z',
  });
  assert(openclaw.version === 'v1.2.3', 'normal semantic tags should remain primary', openclaw);
  assert(openclaw.subtitle === '', 'duplicate release names should be suppressed', openclaw);
  assert(
    formatReleaseDate('2026-05-07T16:23:08Z', 'en-US') === 'May 7, 2026',
    'release dates should format as a compact readable label',
  );

  assert(
    googleAnalyticsScriptSrc('G-ABC123XYZ') === 'https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ',
    'valid GA measurement IDs should produce the gtag source URL',
  );
  assert(googleAnalyticsScriptSrc('') === null, 'missing GA measurement IDs should be disabled');
  assert(googleAnalyticsScriptSrc('UA-123') === null, 'legacy or malformed GA IDs should be disabled');

  // Phase 2: usage-context display helpers.
  assert(formatCompactCount(842) === '842', 'compact count under 1k is verbatim', formatCompactCount(842));
  assert(formatCompactCount(12345) === '12.3k', 'compact count thousands → k', formatCompactCount(12345));
  assert(formatCompactCount(1_200_000) === '1.2M', 'compact count millions → M', formatCompactCount(1_200_000));
  assert(
    formatCompactCount(null) === null && formatCompactCount(-5) === null,
    'compact count returns null for missing/invalid input',
    [formatCompactCount(null), formatCompactCount(-5)],
  );
  assert(
    reportsPerThousandDownloads(4, 2000) === 2,
    'reports-per-1k = negatives / downloads * 1000',
    reportsPerThousandDownloads(4, 2000),
  );
  assert(
    reportsPerThousandDownloads(3, null) === null && reportsPerThousandDownloads(3, 0) === null,
    'reports-per-1k is null when there is no download signal (source-only release)',
    [reportsPerThousandDownloads(3, null), reportsPerThousandDownloads(3, 0)],
  );

  console.log('✔ frontend smoke tests pass');
  await rm(tmpDir, { recursive: true, force: true });
}

function assert(cond, msg, ctx) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    if (ctx !== undefined) console.error(JSON.stringify(ctx, null, 2));
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
