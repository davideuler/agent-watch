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

const PROJECT_CACHE_VERSION = 'v1';
const PROJECT_CACHE_TTL = 60;
const projectCacheKey = (slug: string) => `project:${PROJECT_CACHE_VERSION}:${slug}`;

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

api.get('/projects/:slug', async (c) => {
  const slug = c.req.param('slug');
  const cacheKey = projectCacheKey(slug);

  try {
    const cached = await c.env.CACHE.get(cacheKey);
    if (cached) {
      c.header('content-type', 'application/json; charset=utf-8');
      c.header('X-Cache', 'HIT');
      return c.body(cached);
    }
  } catch (err) {
    console.error('[cache] read failed', err);
  }

  let project = await getProjectBySlug(c.env, slug);
  if (!project) {
    // Lazy bootstrap: only run config sync when the slug is configured but the row is missing
    const cfgEntry = getProjects(c.env).find((p) => p.slug === slug);
    if (cfgEntry) {
      await ensureProjects(c.env);
      project = await getProjectBySlug(c.env, slug);
    }
    if (!project) return c.json({ error: 'project not found' }, 404);
  }

  const [versions, issues, ratings] = await Promise.all([
    listVersions(c.env, project.id, 15),
    listIssuesForProject(c.env, project.id),
    listRatingsForProject(c.env, project.id),
  ]);

  const ratingsByVersion = new Map<number, Array<UserRatingInput & { updated_at: string }>>();
  for (const r of ratings) {
    if (!ratingsByVersion.has(r.version_id)) ratingsByVersion.set(r.version_id, []);
    ratingsByVersion.get(r.version_id)!.push({ score: r.score, updated_at: r.updated_at });
  }

  // Freeze scores for releases older than the top LIVE_VERSION_COUNT.
  // Old releases recompute against the latest input-change time (max of
  // version.published_at, related issue.updated_at, related rating.updated_at)
  // instead of wall-clock now — so unchanged inputs produce a stable score.
  const LIVE_VERSION_COUNT = 3;

  const versionsWithScore = versions.map((v, idx) => {
    const relatedIssues = issues.filter((i) => i.target_version === v.tag_name && i.sentiment);
    const versionIssues: AnalyzedIssue[] = relatedIssues.map((i) => ({
      sentiment: (i.sentiment as 'positive' | 'negative' | 'neutral') ?? 'neutral',
      confidence: i.confidence ?? 0,
      comment_count: i.comment_count,
      created_at: i.created_at,
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

    const stability = calculateStability(
      { publishedAt: v.published_at },
      versionIssues,
      versionRatings.map((r) => ({ score: r.score })),
      scoreNow,
    );
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
  const body = JSON.stringify(payload);
  c.executionCtx.waitUntil(
    c.env.CACHE.put(cacheKey, body, { expirationTtl: PROJECT_CACHE_TTL }).catch((err) =>
      console.error('[cache] write failed', err),
    ),
  );
  c.header('content-type', 'application/json; charset=utf-8');
  c.header('X-Cache', 'MISS');
  return c.body(body);
});

const ISSUES_HARD_CAP = 200;

function clampIssueLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(ISSUES_HARD_CAP, Math.max(1, Math.floor(n)));
}

async function buildVersionIssuesPayload(c: any, version: VersionRow, limit: number) {
  const issues = await listIssuesForProject(c.env, version.project_id);
  const related = issues
    .filter((i) => i.target_version === version.tag_name)
    .slice(0, limit)
    .map((i) => ({
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
      summary: i.summary,
    }));
  const totalRelated = issues.filter((i) => i.target_version === version.tag_name).length;
  const ratings = await listRatingsForVersion(c.env, version.id);
  return {
    version: {
      id: version.id,
      tag_name: version.tag_name,
      name: version.name,
      published_at: version.published_at,
      download_url: version.download_url,
      html_url: version.html_url,
    },
    issues: related,
    issues_total: totalRelated,
    ratings: ratings.map((r) => ({
      score: r.score,
      comment: r.comment,
      created_at: r.created_at,
    })),
  };
}

api.get('/versions/:id/issues', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
  const version = await getVersionById(c.env, id);
  if (!version) return c.json({ error: 'version not found' }, 404);
  const limit = clampIssueLimit(c.req.query('limit'), ISSUES_HARD_CAP);
  return c.json(await buildVersionIssuesPayload(c, version, limit));
});

api.get('/projects/:slug/versions/:tag/issues', async (c) => {
  const slug = c.req.param('slug');
  const tag = c.req.param('tag');
  const project = await getProjectBySlug(c.env, slug);
  if (!project) return c.json({ error: 'project not found' }, 404);
  const version = await getVersionByTag(c.env, project.id, tag);
  if (!version) return c.json({ error: 'version not found' }, 404);
  const limit = clampIssueLimit(c.req.query('limit'), ISSUES_HARD_CAP);
  const payload = await buildVersionIssuesPayload(c, version, limit);
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

  // Invalidate cached project payload so the new rating is visible immediately
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const projects = await listProjects(c.env);
        const project = projects.find((p) => p.id === version.project_id);
        if (project) await c.env.CACHE.delete(projectCacheKey(project.slug));
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
