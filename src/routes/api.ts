import { Hono } from 'hono';
import type { Env, VersionRow } from '../lib/types';
import { getDefaultProjectSlug, getProjects } from '../lib/config';
import {
  getProjectBySlug,
  getVersionById,
  getVersionByTag,
  listIssuesForProject,
  listProjects,
  listRatingsForProject,
  listRatingsForVersion,
  listVersions,
  upsertProject,
  upsertRating,
} from '../lib/db';
import { calculateStability, type AnalyzedIssue, type UserRatingInput } from '../lib/score';
import { currentUser, endSession } from '../lib/auth';

const api = new Hono<{ Bindings: Env }>();

// Cache strategy: stale-while-revalidate.
// - Long backing TTL (1 day) so the cached payload is almost always available.
// - Fresh window of 5 minutes; beyond that we still serve the cached value
//   immediately and kick off a background refresh via waitUntil.
// - A short-lived "refreshing" marker prevents stampedes when many requests
//   arrive simultaneously while the cache is stale.
const PROJECT_CACHE_VERSION = 'v2';
const PROJECT_CACHE_TTL = 86400;
const PROJECT_CACHE_FRESH_SECONDS = 300;
const PROJECT_REFRESH_LOCK_SECONDS = 60;
const projectCacheKey = (slug: string) => `project:${PROJECT_CACHE_VERSION}:${slug}`;
const projectRefreshKey = (slug: string) => `project:${PROJECT_CACHE_VERSION}:${slug}:refreshing`;

interface CachedEntry {
  cached_at: string;
  payload: string;
}

function parseCachedEntry(raw: string | null): CachedEntry | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<CachedEntry>;
    if (typeof obj.cached_at === 'string' && typeof obj.payload === 'string') return obj as CachedEntry;
  } catch {
    // ignore — fall through to null so the caller treats it as cold cache
  }
  return null;
}

function entryAgeSeconds(entry: CachedEntry): number {
  return (Date.now() - new Date(entry.cached_at).getTime()) / 1000;
}

async function ensureProjects(env: Env): Promise<void> {
  const cfg = getProjects(env);
  for (const p of cfg) {
    const existing = await getProjectBySlug(env, p.slug);
    if (!existing) await upsertProject(env, p.slug, p.name, p.repo);
  }
}

api.get('/projects', async (c) => {
  const cfg = getProjects(c.env);
  const defaultSlug = getDefaultProjectSlug(c.env);
  const rows = await listProjects(c.env);
  const byslug = new Map(rows.map((r) => [r.slug, r]));
  const out = cfg.map((p) => ({
    slug: p.slug,
    name: p.name,
    github_url: p.githubUrl,
    is_default: p.slug === defaultSlug,
    has_data: byslug.has(p.slug),
  }));
  return c.json({ projects: out, default: defaultSlug });
});

async function computeProjectPayload(env: Env, slug: string): Promise<string | null> {
  let project = await getProjectBySlug(env, slug);
  if (!project) {
    const cfgEntry = getProjects(env).find((p) => p.slug === slug);
    if (cfgEntry) {
      await ensureProjects(env);
      project = await getProjectBySlug(env, slug);
    }
    if (!project) return null;
  }

  const [versions, issues, ratings] = await Promise.all([
    listVersions(env, project.id, 15),
    listIssuesForProject(env, project.id),
    listRatingsForProject(env, project.id),
  ]);

  const ratingsByVersion = new Map<number, Array<UserRatingInput & { updated_at: string }>>();
  for (const r of ratings) {
    if (!ratingsByVersion.has(r.version_id)) ratingsByVersion.set(r.version_id, []);
    ratingsByVersion.get(r.version_id)!.push({ score: r.score, updated_at: r.updated_at });
  }

  // Freeze scores for releases older than the top LIVE_VERSION_COUNT.
  const LIVE_VERSION_COUNT = 3;

  type ScoreInputs = {
    v: (typeof versions)[number];
    versionIssues: AnalyzedIssue[];
    ratings: { score: number }[];
    scoreNow: Date | undefined;
  };
  const inputs: ScoreInputs[] = versions.map((v, idx) => {
    // All issues whose analyzer placed them in this release. Unsentimented
    // issues default to "neutral" so they still count toward issueCount but
    // contribute zero weight to the risk/positive sums.
    const relatedIssues = issues.filter((i) => i.target_version === v.tag_name);
    const versionIssues: AnalyzedIssue[] = relatedIssues.map((i) => ({
      sentiment: (i.sentiment as 'positive' | 'negative' | 'neutral') ?? 'neutral',
      confidence: i.confidence ?? 0,
      comment_count: i.comment_count,
      created_at: i.created_at,
      severity: (i.severity as AnalyzedIssue['severity']) ?? 'medium',
      impact_scope: (i.impact_scope as AnalyzedIssue['impact_scope']) ?? 'moderate',
      functionality: (i.functionality as AnalyzedIssue['functionality']) ?? 'unknown',
      affected_user_share: (i.affected_user_share as AnalyzedIssue['affected_user_share']) ?? 'unknown',
      duplicate_cluster_size: i.duplicate_cluster_size ?? 1,
      workaround_status: (i.workaround_status as AnalyzedIssue['workaround_status']) ?? 'unknown',
    }));
    const versionRatings = ratingsByVersion.get(v.id) ?? [];

    let scoreNow: Date | undefined;
    if (idx >= LIVE_VERSION_COUNT) {
      let freezeMs = new Date(v.published_at).getTime();
      for (const i of relatedIssues) {
        const t = new Date(i.updated_at).getTime();
        if (t > freezeMs) freezeMs = t;
      }
      for (const r of versionRatings) {
        const t = new Date(r.updated_at).getTime();
        if (t > freezeMs) freezeMs = t;
      }
      scoreNow = new Date(freezeMs);
    }

    return {
      v,
      versionIssues,
      ratings: versionRatings.map((r) => ({ score: r.score })),
      scoreNow,
    };
  });

  const pass1 = inputs.map((inp) =>
    calculateStability({ publishedAt: inp.v.published_at }, inp.versionIssues, inp.ratings, inp.scoreNow),
  );
  const matureNegSums = pass1
    .filter((s) => s.state === 'rated' && s.breakdown.negativeCount > 0)
    .map((s) => s.breakdown.weightedNegSum)
    .sort((a, b) => a - b);
  let peerContext: { medianWeightedNeg: number } | undefined;
  if (matureNegSums.length >= 3) {
    const mid = Math.floor(matureNegSums.length / 2);
    const a = matureNegSums[mid] ?? 0;
    const b = matureNegSums[mid - 1] ?? a;
    const median = matureNegSums.length % 2 === 0 ? (a + b) / 2 : a;
    peerContext = { medianWeightedNeg: median };
  }

  const versionsWithScore = inputs.map((inp) => {
    const v = inp.v;
    const stability = calculateStability(
      { publishedAt: v.published_at },
      inp.versionIssues,
      inp.ratings,
      inp.scoreNow,
      peerContext,
    );
    const versionIssues = inp.versionIssues;
    return {
      id: v.id,
      tag_name: v.tag_name,
      name: v.name,
      body: v.body,
      html_url: v.html_url,
      download_url: v.download_url,
      published_at: v.published_at,
      is_prerelease: !!v.is_prerelease,
      stability,
      issue_count: versionIssues.length,
      rating_count: (ratingsByVersion.get(v.id) ?? []).length,
    };
  });

  const payload = {
    project: {
      slug: project.slug,
      name: project.name,
      github_repo: project.github_repo,
      github_url: project.github_url,
    },
    versions: versionsWithScore,
  };
  return JSON.stringify(payload);
}

async function refreshProjectCache(env: Env, slug: string): Promise<void> {
  const lockKey = projectRefreshKey(slug);
  // Stampede control: only one refresh runs at a time per slug.
  try {
    const existingLock = await env.CACHE.get(lockKey);
    if (existingLock) return;
    await env.CACHE.put(lockKey, '1', { expirationTtl: PROJECT_REFRESH_LOCK_SECONDS });
  } catch (err) {
    console.error('[cache] lock check failed', err);
    return;
  }

  try {
    const payload = await computeProjectPayload(env, slug);
    if (!payload) return;
    const entry: CachedEntry = { cached_at: new Date().toISOString(), payload };
    await env.CACHE.put(projectCacheKey(slug), JSON.stringify(entry), { expirationTtl: PROJECT_CACHE_TTL });
  } catch (err) {
    console.error('[cache] refresh failed', err);
  } finally {
    try {
      await env.CACHE.delete(lockKey);
    } catch (err) {
      // best effort — lock will expire on its own
      console.error('[cache] lock release failed', err);
    }
  }
}

api.get('/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  const cacheKey = projectCacheKey(slug);

  let cachedRaw: string | null = null;
  try {
    cachedRaw = await c.env.CACHE.get(cacheKey);
  } catch (err) {
    console.error('[cache] read failed', err);
  }

  const entry = parseCachedEntry(cachedRaw);
  if (entry) {
    const ageSec = entryAgeSeconds(entry);
    const isStale = ageSec >= PROJECT_CACHE_FRESH_SECONDS;
    if (isStale) {
      // Stale-while-revalidate: serve stale payload now, refresh in background.
      c.executionCtx.waitUntil(refreshProjectCache(c.env, slug));
    }
    c.header('content-type', 'application/json; charset=utf-8');
    c.header('X-Cache', isStale ? 'STALE' : 'HIT');
    c.header('X-Cache-Age', String(Math.round(ageSec)));
    return c.body(entry.payload);
  }

  // Cold cache: compute synchronously so the user gets data on first hit.
  const payload = await computeProjectPayload(c.env, slug);
  if (!payload) return c.json({ error: 'project not found' }, 404);

  const fresh: CachedEntry = { cached_at: new Date().toISOString(), payload };
  c.executionCtx.waitUntil(
    c.env.CACHE.put(cacheKey, JSON.stringify(fresh), { expirationTtl: PROJECT_CACHE_TTL }).catch((err) =>
      console.error('[cache] write failed', err),
    ),
  );
  c.header('content-type', 'application/json; charset=utf-8');
  c.header('X-Cache', 'MISS');
  return c.body(payload);
});

const ISSUES_PER_PAGE_MAX = 40;
const ISSUES_MAX_PAGES = 30;
const ISSUES_HARD_CAP = ISSUES_PER_PAGE_MAX * ISSUES_MAX_PAGES;

const ISSUES_CACHE_VERSION = 'v1';
const ISSUES_CACHE_TTL = 600;
const ISSUES_CACHE_FRESH_SECONDS = 300;
const ISSUES_REFRESH_LOCK_SECONDS = 30;
const issuesCacheKey = (versionId: number, page: number, perPage: number) =>
  `issues:${ISSUES_CACHE_VERSION}:${versionId}:${page}:${perPage}`;
const issuesRefreshKey = (versionId: number, page: number, perPage: number) =>
  `issues:${ISSUES_CACHE_VERSION}:${versionId}:${page}:${perPage}:r`;

function clampPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

type VersionIssuesPayload = Awaited<ReturnType<typeof buildVersionIssuesPayload>>;
type ProjectIssuesList = Awaited<ReturnType<typeof listIssuesForProject>>;

// In-isolate dedupe: coalesces concurrent identical work within the same
// Worker isolate so a project page hitting 6 parallel version endpoints only
// runs one D1 scan per project (and one payload build per cache key) on a
// cold KV miss. Different isolates still each do their own work, but KV
// catches them on subsequent reads.
const inflightPayloads = new Map<string, Promise<VersionIssuesPayload>>();
const inflightProjectIssues = new Map<number, Promise<ProjectIssuesList>>();

function memoizeInflight<K, V>(map: Map<K, Promise<V>>, key: K, fn: () => Promise<V>): Promise<V> {
  const existing = map.get(key);
  if (existing) return existing;
  const p = (async () => {
    try { return await fn(); } finally { map.delete(key); }
  })();
  map.set(key, p);
  return p;
}

function loadProjectIssuesShared(env: Env, projectId: number): Promise<ProjectIssuesList> {
  return memoizeInflight(inflightProjectIssues, projectId, () => listIssuesForProject(env, projectId));
}

async function buildVersionIssuesPayload(
  env: Env,
  version: VersionRow,
  page: number,
  perPage: number,
) {
  const issues = await loadProjectIssuesShared(env, version.project_id);
  const allRelated = issues.filter((i) => i.target_version === version.tag_name);
  const totalRelated = allRelated.length;
  const considered = Math.min(totalRelated, ISSUES_HARD_CAP);
  const totalPages = Math.max(1, Math.min(ISSUES_MAX_PAGES, Math.ceil(considered / perPage)));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * perPage;
  const endIdx = Math.min(startIdx + perPage, considered);

  const pageItems = allRelated.slice(startIdx, endIdx).map((i) => ({
    id: i.id,
    number: i.number,
    title: i.title,
    html_url: i.html_url,
    state: i.state,
    user_login: i.user_login,
    comment_count: i.comment_count,
    created_at: i.created_at,
    sentiment: i.sentiment,
    confidence: i.confidence,
    severity: i.severity,
    impact_scope: i.impact_scope,
    functionality: i.functionality,
    affected_user_share: i.affected_user_share,
    duplicate_cluster_size: i.duplicate_cluster_size,
    workaround_status: i.workaround_status,
    summary: i.summary,
  }));

  const facetFields: Array<[string, string[]]> = [
    ['sentiment', ['negative', 'positive', 'neutral']],
    ['severity', ['critical', 'high', 'medium', 'low']],
    ['functionality', ['core', 'integration', 'provider', 'docs', 'unknown']],
    ['impact_scope', ['broad', 'moderate', 'niche']],
    ['affected_user_share', ['many', 'some', 'few', 'unknown']],
    ['workaround_status', ['none', 'partial', 'confirmed', 'unknown']],
  ];
  const facets: Record<string, Record<string, number>> = {};
  for (const [field, values] of facetFields) {
    const map: Record<string, number> = Object.fromEntries(values.map((v) => [v, 0]));
    for (const i of allRelated) {
      const v = ((i as unknown as Record<string, string | null>)[field] ?? 'unknown') as string;
      if (v in map) map[v] = (map[v] ?? 0) + 1;
    }
    facets[field] = map;
  }
  const confThresholds: Array<[string, number]> = [['all', 0], ['q30', 0.3], ['q50', 0.5], ['q70', 0.7], ['q90', 0.9]];
  const confCounts: Record<string, number> = {};
  for (const [id, min] of confThresholds) {
    confCounts[id] = allRelated.filter((i) => (i.confidence ?? 0) >= min).length;
  }
  facets['confidence'] = confCounts;

  const all_stats = {
    total: totalRelated,
    negative: allRelated.filter((i) => i.sentiment === 'negative').length,
    positive: allRelated.filter((i) => i.sentiment === 'positive').length,
    core: allRelated.filter((i) => i.functionality === 'core').length,
    niche: allRelated.filter((i) => i.impact_scope === 'niche').length,
    workarounds: allRelated.filter((i) => i.workaround_status === 'confirmed').length,
    facets,
  };

  const ratings = await listRatingsForVersion(env, version.id);
  return {
    version: {
      id: version.id,
      tag_name: version.tag_name,
      name: version.name,
      published_at: version.published_at,
      download_url: version.download_url,
      html_url: version.html_url,
    },
    issues: pageItems,
    page: safePage,
    per_page: perPage,
    total: totalRelated,
    total_considered: considered,
    total_pages: totalPages,
    max_pages: ISSUES_MAX_PAGES,
    max_per_page: ISSUES_PER_PAGE_MAX,
    issues_total: totalRelated,
    all_stats,
    ratings: ratings.map((r) => ({
      score: r.score,
      comment: r.comment,
      created_at: r.created_at,
    })),
  };
}

async function refreshIssuesCache(
  env: Env,
  version: VersionRow,
  page: number,
  perPage: number,
): Promise<void> {
  const lockKey = issuesRefreshKey(version.id, page, perPage);
  try {
    const existing = await env.CACHE.get(lockKey);
    if (existing) return;
    await env.CACHE.put(lockKey, '1', { expirationTtl: ISSUES_REFRESH_LOCK_SECONDS });
  } catch (err) {
    console.error('[issues-cache] lock failed', err);
    return;
  }
  try {
    const cacheKey = issuesCacheKey(version.id, page, perPage);
    const payload = await memoizeInflight(inflightPayloads, cacheKey, () =>
      buildVersionIssuesPayload(env, version, page, perPage),
    );
    const entry: CachedEntry = { cached_at: new Date().toISOString(), payload: JSON.stringify(payload) };
    await env.CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: ISSUES_CACHE_TTL });
  } catch (err) {
    console.error('[issues-cache] refresh failed', err);
  } finally {
    try { await env.CACHE.delete(lockKey); } catch { /* best effort */ }
  }
}

async function getVersionIssuesWithCache(
  c: { env: Env; executionCtx: { waitUntil: (p: Promise<unknown>) => void } },
  version: VersionRow,
  page: number,
  perPage: number,
): Promise<ReturnType<typeof buildVersionIssuesPayload> extends Promise<infer T> ? T : never> {
  const cacheKey = issuesCacheKey(version.id, page, perPage);
  let cachedRaw: string | null = null;
  try { cachedRaw = await c.env.CACHE.get(cacheKey); } catch { /* ignore */ }

  const entry = parseCachedEntry(cachedRaw);
  if (entry) {
    const ageSec = entryAgeSeconds(entry);
    if (ageSec >= ISSUES_CACHE_FRESH_SECONDS) {
      c.executionCtx.waitUntil(refreshIssuesCache(c.env, version, page, perPage));
    }
    try {
      return JSON.parse(entry.payload);
    } catch { /* fall through */ }
  }

  const payload = await memoizeInflight(inflightPayloads, cacheKey, () =>
    buildVersionIssuesPayload(c.env, version, page, perPage),
  );
  const fresh: CachedEntry = { cached_at: new Date().toISOString(), payload: JSON.stringify(payload) };
  c.executionCtx.waitUntil(
    c.env.CACHE.put(cacheKey, JSON.stringify(fresh), { expirationTtl: ISSUES_CACHE_TTL }).catch((err) =>
      console.error('[issues-cache] write failed', err),
    ),
  );
  return payload;
}

api.get('/versions/:id/issues', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
  const version = await getVersionById(c.env, id);
  if (!version) return c.json({ error: 'version not found' }, 404);
  const perPage = clampPositiveInt(c.req.query('per_page') ?? c.req.query('limit'), ISSUES_PER_PAGE_MAX, ISSUES_HARD_CAP);
  const page = clampPositiveInt(c.req.query('page'), 1, ISSUES_MAX_PAGES);
  return c.json(await getVersionIssuesWithCache(c, version, page, perPage));
});

api.get('/projects/:slug/versions/:tag/issues', async (c) => {
  const slug = c.req.param('slug');
  const tag = c.req.param('tag');
  const project = await getProjectBySlug(c.env, slug);
  if (!project) return c.json({ error: 'project not found' }, 404);
  const version = await getVersionByTag(c.env, project.id, tag);
  if (!version) return c.json({ error: 'version not found' }, 404);
  const perPage = clampPositiveInt(c.req.query('per_page') ?? c.req.query('limit'), ISSUES_PER_PAGE_MAX, ISSUES_HARD_CAP);
  const page = clampPositiveInt(c.req.query('page'), 1, ISSUES_MAX_PAGES);
  const payload = await getVersionIssuesWithCache(c, version, page, perPage);
  return c.json({
    ...payload,
    project: {
      slug: project.slug,
      name: project.name,
      github_url: project.github_url,
    },
  });
});

api.post('/ratings', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req
    .json<{ version_id?: number; score?: number; comment?: string }>()
    .catch(() => ({}))) as { version_id?: number; score?: number; comment?: string };
  const versionId = Number(body.version_id);
  const score = Number(body.score);
  const comment = body.comment ? String(body.comment).slice(0, 2000) : null;
  if (!Number.isInteger(versionId)) return c.json({ error: 'version_id required' }, 400);
  if (!Number.isInteger(score) || score < 1 || score > 10) return c.json({ error: 'score must be 1..10' }, 400);
  const version = await getVersionById(c.env, versionId);
  if (!version) return c.json({ error: 'version not found' }, 404);
  await upsertRating(c.env, user.id, versionId, score, comment);

  // Invalidate cached project payload so the new rating is visible immediately.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const projects = await listProjects(c.env);
        const project = projects.find((p) => p.id === version.project_id);
        if (project) {
          await c.env.CACHE.delete(projectCacheKey(project.slug));
          // Trigger an immediate background refresh so the next request finds
          // a fresh entry instead of paying the cold-cache cost.
          c.executionCtx.waitUntil(refreshProjectCache(c.env, project.slug));
        }
      } catch (err) {
        console.error('[cache] invalidate failed', err);
      }
    })(),
  );

  return c.json({ ok: true });
});

api.get('/auth/me', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ user: null });
  return c.json({
    user: {
      id: user.id,
      provider: user.provider,
      name: user.name,
      login: user.login,
      avatar_url: user.avatar_url,
    },
  });
});

api.post('/auth/logout', async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

api.all('*', (c) => c.json({ error: 'not found' }, 404));

export default api;
