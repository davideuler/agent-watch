import type { Env } from './types';

const API_ROOT = 'https://api.github.com';
const UA = 'agent-watch';

export interface GhRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
    download_count: number;
  }>;
  tarball_url: string | null;
  zipball_url: string | null;
}

export interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

export interface GhComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
}

function authHeaders(env: Env): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
  if (env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

async function ghFetch<T>(env: Env, url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders(env) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${res.statusText} — ${url} — ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export interface GhRepoMeta {
  stargazers_count: number;
  subscribers_count?: number;
  open_issues_count?: number;
}

/** Repo-level metadata (adoption proxy). Used for display-only usage context. */
export async function fetchRepoMeta(env: Env, repo: string): Promise<GhRepoMeta> {
  return ghFetch<GhRepoMeta>(env, `${API_ROOT}/repos/${repo}`);
}

export async function fetchReleases(env: Env, repo: string, limit = 15): Promise<GhRelease[]> {
  const perPage = Math.min(100, Math.max(1, limit));
  const url = `${API_ROOT}/repos/${repo}/releases?per_page=${perPage}`;
  const releases = await ghFetch<GhRelease[]>(env, url);
  return releases.filter((r) => !r.draft).slice(0, limit);
}

export interface FetchIssuesOpts {
  since?: string;
  perPage?: number;
  pages?: number;
  state?: 'open' | 'closed' | 'all';
}

export async function fetchIssues(env: Env, repo: string, opts: FetchIssuesOpts = {}): Promise<GhIssue[]> {
  const perPage = Math.min(100, opts.perPage ?? 100);
  const pages = Math.max(1, opts.pages ?? 3);
  const state = opts.state ?? 'all';
  const out: GhIssue[] = [];
  for (let page = 1; page <= pages; page++) {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      state,
      sort: 'updated',
      direction: 'desc',
    });
    if (opts.since) params.set('since', opts.since);
    const url = `${API_ROOT}/repos/${repo}/issues?${params}`;
    const batch = await ghFetch<GhIssue[]>(env, url);
    const filtered = batch.filter((i) => !i.pull_request);
    out.push(...filtered);
    if (batch.length < perPage) break;
  }
  return out;
}

export async function fetchIssueComments(
  env: Env,
  repo: string,
  issueNumber: number,
  limit = 10,
): Promise<GhComment[]> {
  const url = `${API_ROOT}/repos/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const all = await ghFetch<GhComment[]>(env, url);
  return all.slice(-limit);
}
