import type { Env, ProjectRow, VersionRow, IssueRow, IssueAnalysisRow, UserRow, RatingRow, SessionUser } from './types';

const NOW = () => new Date().toISOString();

export async function getProjectBySlug(env: Env, slug: string): Promise<ProjectRow | null> {
  return (await env.DB.prepare('SELECT * FROM projects WHERE slug = ? LIMIT 1').bind(slug).first<ProjectRow>()) ?? null;
}

export async function listProjects(env: Env): Promise<ProjectRow[]> {
  const r = await env.DB.prepare('SELECT * FROM projects ORDER BY id ASC').all<ProjectRow>();
  return r.results ?? [];
}

export async function upsertProject(env: Env, slug: string, name: string, repo: string): Promise<ProjectRow> {
  const url = `https://github.com/${repo}`;
  await env.DB.prepare(
    `INSERT INTO projects (slug, name, github_repo, github_url) VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name, github_repo=excluded.github_repo, github_url=excluded.github_url`,
  )
    .bind(slug, name, repo, url)
    .run();
  const row = await getProjectBySlug(env, slug);
  if (!row) throw new Error(`Failed to upsert project ${slug}`);
  return row;
}

export async function listVersions(env: Env, projectId: number, limit = 15): Promise<VersionRow[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM versions WHERE project_id = ? ORDER BY published_at DESC LIMIT ?',
  )
    .bind(projectId, limit)
    .all<VersionRow>();
  return r.results ?? [];
}

export async function getVersionById(env: Env, id: number): Promise<VersionRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM versions WHERE id = ? LIMIT 1').bind(id).first<VersionRow>()) ?? null
  );
}

export async function getVersionByTag(
  env: Env,
  projectId: number,
  tagName: string,
): Promise<VersionRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM versions WHERE project_id = ? AND tag_name = ? LIMIT 1')
      .bind(projectId, tagName)
      .first<VersionRow>()) ?? null
  );
}

export interface UpsertVersionInput {
  project_id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string | null;
  download_url: string | null;
  published_at: string;
  is_prerelease: boolean;
  raw_json: string | null;
}

export async function upsertVersion(env: Env, v: UpsertVersionInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO versions (project_id, tag_name, name, body, html_url, download_url, published_at, is_prerelease, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, tag_name) DO UPDATE SET
       name=excluded.name, body=excluded.body, html_url=excluded.html_url, download_url=excluded.download_url,
       published_at=excluded.published_at, is_prerelease=excluded.is_prerelease, raw_json=excluded.raw_json`,
  )
    .bind(
      v.project_id,
      v.tag_name,
      v.name,
      v.body,
      v.html_url,
      v.download_url,
      v.published_at,
      v.is_prerelease ? 1 : 0,
      v.raw_json,
    )
    .run();
}

export interface UpsertIssueInput {
  project_id: number;
  github_id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user_login: string | null;
  comment_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export async function upsertIssue(env: Env, i: UpsertIssueInput): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO issues (project_id, github_id, number, title, body, state, html_url, user_login, comment_count, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, github_id) DO UPDATE SET
       title=excluded.title, body=excluded.body, state=excluded.state, html_url=excluded.html_url,
       user_login=excluded.user_login, comment_count=excluded.comment_count,
       updated_at=excluded.updated_at, closed_at=excluded.closed_at`,
  )
    .bind(
      i.project_id,
      i.github_id,
      i.number,
      i.title,
      i.body,
      i.state,
      i.html_url,
      i.user_login,
      i.comment_count,
      i.created_at,
      i.updated_at,
      i.closed_at,
    )
    .run();
  const row = await env.DB.prepare('SELECT id FROM issues WHERE project_id=? AND github_id=?')
    .bind(i.project_id, i.github_id)
    .first<{ id: number }>();
  if (!row) throw new Error('Failed to upsert issue');
  return row.id;
}

export async function upsertComment(
  env: Env,
  issue_id: number,
  github_id: number,
  body: string | null,
  user_login: string | null,
  created_at: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO issue_comments (issue_id, github_id, body, user_login, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(issue_id, github_id) DO UPDATE SET body=excluded.body`,
  )
    .bind(issue_id, github_id, body, user_login, created_at)
    .run();
}

export async function setAnalysis(env: Env, a: Omit<IssueAnalysisRow, 'analyzed_at'>): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO issue_analyses (
       issue_id, sentiment, target_version, confidence, severity, impact_scope, functionality,
       affected_user_share, duplicate_cluster_size, workaround_status, is_ai_generated,
       summary, raw_response, analyzed_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET
       sentiment=excluded.sentiment, target_version=excluded.target_version, confidence=excluded.confidence,
       severity=excluded.severity, impact_scope=excluded.impact_scope, functionality=excluded.functionality,
       affected_user_share=excluded.affected_user_share, duplicate_cluster_size=excluded.duplicate_cluster_size,
       workaround_status=excluded.workaround_status, is_ai_generated=excluded.is_ai_generated,
       summary=excluded.summary, raw_response=excluded.raw_response, analyzed_at=excluded.analyzed_at`,
  )
    .bind(
      a.issue_id,
      a.sentiment,
      a.target_version,
      a.confidence,
      a.severity,
      a.impact_scope,
      a.functionality,
      a.affected_user_share,
      a.duplicate_cluster_size,
      a.workaround_status,
      a.is_ai_generated ? 1 : 0,
      a.summary,
      a.raw_response,
      NOW(),
    )
    .run();
}

export interface IssueWithAnalysis extends IssueRow {
  sentiment: string | null;
  target_version: string | null;
  confidence: number | null;
  severity: string | null;
  impact_scope: string | null;
  functionality: string | null;
  affected_user_share: string | null;
  duplicate_cluster_size: number | null;
  workaround_status: string | null;
  is_ai_generated: number | null;
  summary: string | null;
}

export async function listIssuesForProject(env: Env, projectId: number): Promise<IssueWithAnalysis[]> {
  const r = await env.DB.prepare(
    `SELECT i.*, a.sentiment, a.target_version, a.confidence, a.severity, a.impact_scope, a.functionality,
            a.affected_user_share, a.duplicate_cluster_size, a.workaround_status, a.is_ai_generated, a.summary
     FROM issues i LEFT JOIN issue_analyses a ON a.issue_id = i.id
     WHERE i.project_id = ? AND COALESCE(a.is_ai_generated, 0) = 0
     ORDER BY i.created_at DESC`,
  )
    .bind(projectId)
    .all<IssueWithAnalysis>();
  return r.results ?? [];
}

export async function listRatingsForVersion(env: Env, versionId: number): Promise<RatingRow[]> {
  const r = await env.DB.prepare('SELECT * FROM user_ratings WHERE version_id = ? ORDER BY updated_at DESC')
    .bind(versionId)
    .all<RatingRow>();
  return r.results ?? [];
}

export async function listRatingsForProject(
  env: Env,
  projectId: number,
): Promise<Array<RatingRow & { tag_name: string }>> {
  const r = await env.DB.prepare(
    `SELECT r.*, v.tag_name FROM user_ratings r JOIN versions v ON v.id = r.version_id WHERE v.project_id = ?`,
  )
    .bind(projectId)
    .all<RatingRow & { tag_name: string }>();
  return r.results ?? [];
}

export async function upsertRating(
  env: Env,
  user_id: number,
  version_id: number,
  score: number,
  comment: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_ratings (user_id, version_id, score, comment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, version_id) DO UPDATE SET
       score=excluded.score, comment=excluded.comment, updated_at=excluded.updated_at`,
  )
    .bind(user_id, version_id, score, comment, NOW(), NOW())
    .run();
}

export async function upsertUser(
  env: Env,
  provider: string,
  provider_id: string,
  data: { email: string | null; name: string | null; login: string | null; avatar_url: string | null },
): Promise<UserRow> {
  await env.DB.prepare(
    `INSERT INTO users (provider, provider_id, email, name, login, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_id) DO UPDATE SET
       email=excluded.email, name=excluded.name, login=excluded.login, avatar_url=excluded.avatar_url`,
  )
    .bind(provider, provider_id, data.email, data.name, data.login, data.avatar_url)
    .run();
  const row = await env.DB.prepare('SELECT * FROM users WHERE provider=? AND provider_id=?')
    .bind(provider, provider_id)
    .first<UserRow>();
  if (!row) throw new Error('Failed to upsert user');
  return row;
}

export async function createSession(env: Env, userId: number, token: string, expiresAt: string): Promise<void> {
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt)
    .run();
}

export async function getSessionUser(env: Env, token: string): Promise<SessionUser | null> {
  const r = await env.DB.prepare(
    `SELECT u.id, u.provider, u.name, u.login, u.email, u.avatar_url, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? LIMIT 1`,
  )
    .bind(token)
    .first<SessionUser & { expires_at: string }>();
  if (!r) return null;
  if (new Date(r.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  const { expires_at: _ignored, ...user } = r;
  return user;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

export async function getPollState(
  env: Env,
  projectId: number,
): Promise<{ last_issue_updated_at: string | null; last_polled_at: string | null }> {
  const r = await env.DB.prepare('SELECT last_issue_updated_at, last_polled_at FROM poll_state WHERE project_id=?')
    .bind(projectId)
    .first<{ last_issue_updated_at: string | null; last_polled_at: string | null }>();
  return r ?? { last_issue_updated_at: null, last_polled_at: null };
}

export async function setPollState(env: Env, projectId: number, lastIssueUpdated: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO poll_state (project_id, last_issue_updated_at, last_polled_at) VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET last_issue_updated_at=excluded.last_issue_updated_at, last_polled_at=excluded.last_polled_at`,
  )
    .bind(projectId, lastIssueUpdated, NOW())
    .run();
}
