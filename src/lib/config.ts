import type { Env, ProjectConfig } from './types';

const DEFAULT_PROJECTS = 'openclaw=openclaw/openclaw,hermes=getzep/hermes';

const friendlyName = (slug: string): string => slug.charAt(0).toUpperCase() + slug.slice(1);

export function getProjects(env: Env): ProjectConfig[] {
  const raw = env.PROJECTS && env.PROJECTS.trim().length > 0 ? env.PROJECTS : DEFAULT_PROJECTS;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [slug, repo] = entry.split('=').map((p) => p.trim());
      if (!slug || !repo || !repo.includes('/')) {
        throw new Error(`Invalid PROJECTS entry: "${entry}" — expected format "slug=owner/repo"`);
      }
      return {
        slug,
        name: friendlyName(slug),
        repo,
        githubUrl: `https://github.com/${repo}`,
      };
    });
}

export function getDefaultProjectSlug(env: Env): string {
  const explicit = env.DEFAULT_PROJECT?.trim();
  if (explicit) return explicit;
  const list = getProjects(env);
  return list[0]?.slug ?? 'openclaw';
}

export function getPublicBaseUrl(env: Env, request?: Request): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (request) {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  }
  return 'https://agentwatch.aicompass.dev';
}
