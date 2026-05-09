export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;

  PROJECTS?: string;
  DEFAULT_PROJECT?: string;
  PUBLIC_BASE_URL?: string;

  GITHUB_TOKEN?: string;

  LLM_BASE_URL?: string;
  LLM_MODEL_NAME?: string;
  LLM_API_KEY?: string;

  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;

  SESSION_SECRET?: string;
}

export interface ProjectConfig {
  slug: string;
  name: string;
  repo: string;
  githubUrl: string;
}

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  github_repo: string;
  github_url: string;
  created_at: string;
}

export interface VersionRow {
  id: number;
  project_id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string | null;
  download_url: string | null;
  published_at: string;
  is_prerelease: number;
  raw_json: string | null;
}

export interface IssueRow {
  id: number;
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

export interface IssueAnalysisRow {
  issue_id: number;
  sentiment: 'positive' | 'negative' | 'neutral';
  target_version: string | null;
  confidence: number;
  summary: string | null;
  raw_response: string | null;
  analyzed_at: string;
}

export interface UserRow {
  id: number;
  provider: string;
  provider_id: string;
  email: string | null;
  name: string | null;
  login: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface RatingRow {
  id: number;
  user_id: number;
  version_id: number;
  score: number;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionUser {
  id: number;
  provider: string;
  name: string | null;
  login: string | null;
  email: string | null;
  avatar_url: string | null;
}
