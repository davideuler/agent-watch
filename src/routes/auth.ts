import { Hono } from 'hono';
import type { Env } from '../lib/types';
import { upsertUser } from '../lib/db';
import { randomToken, readOAuthState, setOAuthState, startSession } from '../lib/auth';
import { getPublicBaseUrl } from '../lib/config';

const auth = new Hono<{ Bindings: Env }>();

const GH_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GH_TOKEN = 'https://github.com/login/oauth/access_token';
const GH_USER = 'https://api.github.com/user';
const GH_EMAILS = 'https://api.github.com/user/emails';

const GOOG_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOG_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOG_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

function configError(provider: string): Response {
  return new Response(`${provider} OAuth is not configured. Set ${provider.toUpperCase()}_OAUTH_CLIENT_ID and CLIENT_SECRET.`, {
    status: 503,
    headers: { 'content-type': 'text/plain' },
  });
}

auth.get('/github', (c) => {
  const env = c.env;
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return configError('github');
  const state = randomToken(16);
  setOAuthState(c, 'github', state);
  const redirectUri = `${getPublicBaseUrl(env, c.req.raw)}/auth/github/callback`;
  const url = new URL(GH_AUTHORIZE);
  url.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return c.redirect(url.toString());
});

auth.get('/github/callback', async (c) => {
  const env = c.env;
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return configError('github');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = readOAuthState(c, 'github');
  if (!code || !state || state !== expected) return c.text('Invalid OAuth state', 400);

  const tokRes = await fetch(GH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  if (!tokRes.ok) return c.text(`GitHub token exchange failed: ${tokRes.status}`, 502);
  const tokJson = (await tokRes.json()) as { access_token?: string; error?: string };
  const accessToken = tokJson.access_token;
  if (!accessToken) return c.text(`GitHub OAuth: ${tokJson.error ?? 'no token'}`, 502);

  const ghHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'agent-watch',
    Accept: 'application/vnd.github+json',
  };
  const userRes = await fetch(GH_USER, { headers: ghHeaders });
  if (!userRes.ok) return c.text('Failed to fetch GitHub user', 502);
  const ghUser = (await userRes.json()) as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  };

  let email = ghUser.email;
  if (!email) {
    const emRes = await fetch(GH_EMAILS, { headers: ghHeaders });
    if (emRes.ok) {
      const emails = (await emRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      email = primary?.email ?? null;
    }
  }

  const user = await upsertUser(env, 'github', String(ghUser.id), {
    email,
    name: ghUser.name ?? ghUser.login,
    login: ghUser.login,
    avatar_url: ghUser.avatar_url,
  });
  await startSession(c, user.id);
  return c.redirect('/');
});

auth.get('/google', (c) => {
  const env = c.env;
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return configError('google');
  const state = randomToken(16);
  setOAuthState(c, 'google', state);
  const redirectUri = `${getPublicBaseUrl(env, c.req.raw)}/auth/google/callback`;
  const url = new URL(GOOG_AUTHORIZE);
  url.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'online');
  url.searchParams.set('prompt', 'select_account');
  return c.redirect(url.toString());
});

auth.get('/google/callback', async (c) => {
  const env = c.env;
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return configError('google');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = readOAuthState(c, 'google');
  if (!code || !state || state !== expected) return c.text('Invalid OAuth state', 400);

  const redirectUri = `${getPublicBaseUrl(env, c.req.raw)}/auth/google/callback`;
  const tokRes = await fetch(GOOG_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokRes.ok) return c.text(`Google token exchange failed: ${tokRes.status}`, 502);
  const tokJson = (await tokRes.json()) as { access_token?: string };
  const accessToken = tokJson.access_token;
  if (!accessToken) return c.text('Google OAuth: no token', 502);

  const userRes = await fetch(GOOG_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!userRes.ok) return c.text('Failed to fetch Google user', 502);
  const gUser = (await userRes.json()) as {
    sub: string;
    email: string | null;
    name: string | null;
    picture: string | null;
  };

  const user = await upsertUser(env, 'google', gUser.sub, {
    email: gUser.email,
    name: gUser.name,
    login: gUser.email,
    avatar_url: gUser.picture,
  });
  await startSession(c, user.id);
  return c.redirect('/');
});

export default auth;
