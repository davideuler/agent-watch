export interface ReleaseDisplayInput {
  tag_name: string;
  name: string | null;
  published_at: string;
}

export interface ReleaseDisplay {
  version: string;
  subtitle: string;
}

const VERSION_PATTERN = /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;
const DATE_TAG_PATTERN = /^v?\d{4}\.\d{1,2}\.\d{1,2}$/;
const DATE_IN_PARENS_PATTERN = /\s*\((?:v?\d{4}\.\d{1,2}\.\d{1,2}|\d{4}-\d{1,2}-\d{1,2})\)\s*/g;

export function getReleaseDisplay(release: ReleaseDisplayInput): ReleaseDisplay {
  const tagName = release.tag_name.trim();
  const releaseName = release.name?.trim() ?? '';
  const versionFromName = extractReleaseVersion(releaseName);
  const shouldPreferNameVersion = versionFromName && isDateLikeTag(tagName);
  const version = shouldPreferNameVersion ? versionFromName : tagName;
  const subtitle = buildReleaseSubtitle(releaseName, version, tagName);

  return { version, subtitle };
}

export function googleAnalyticsScriptSrc(measurementId: string | null | undefined): string | null {
  const id = measurementId?.trim();
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return null;
  return `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
}

export function formatReleaseDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Compact count for adoption/usage display: 1234 → "1.2k", 1_200_000 → "1.2M". */
export function formatCompactCount(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

/**
 * Usage-normalized companion metric: negative reports per 1k uploaded-asset
 * downloads. Returns null when there is no download signal (source-only release),
 * so callers can show the raw score with an "install base unknown" caveat instead.
 */
export function reportsPerThousandDownloads(
  negativeCount: number,
  downloadCount: number | null | undefined,
): number | null {
  if (downloadCount == null || downloadCount <= 0) return null;
  return Math.round((negativeCount / downloadCount) * 1000 * 100) / 100;
}

function extractReleaseVersion(name: string): string | null {
  const match = name.match(VERSION_PATTERN);
  return match?.[0] ?? null;
}

function isDateLikeTag(tagName: string): boolean {
  return DATE_TAG_PATTERN.test(tagName);
}

function buildReleaseSubtitle(name: string, version: string, tagName: string): string {
  if (!name || name === version || name === tagName) return '';
  const escapedVersion = escapeRegExp(version);
  const escapedTag = escapeRegExp(tagName);
  return name
    .replace(new RegExp(`\\b${escapedVersion}\\b`, 'g'), '')
    .replace(new RegExp(`\\b${escapedTag}\\b`, 'g'), '')
    .replace(DATE_IN_PARENS_PATTERN, ' ')
    .replace(/\s+[–—-]\s*$/, '')
    .replace(/^\s*[–—-]\s+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
