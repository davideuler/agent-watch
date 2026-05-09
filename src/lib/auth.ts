import type { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { Env, SessionUser } from './types';
import { createSession, deleteSession, getSessionUser } from './db';

export const SESSION_COOKIE = 'aw_session';
const SESSION_TTL_DAYS = 30;

export function randomToken(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function startSession(c: Context<{ Bindings: Env }>, userId: number): Promise<string> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await createSession(c.env, userId, token, expires.toISOString());
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    expires,
  });
  return token;
}

export async function endSession(c: Context<{ Bindings: Env }>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSession(c.env, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function currentUser(c: Context<{ Bindings: Env }>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return getSessionUser(c.env, token);
}

export function setOAuthState(c: Context<{ Bindings: Env }>, provider: string, state: string): void {
  setCookie(c, `aw_oauth_${provider}`, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });
}

export function readOAuthState(c: Context<{ Bindings: Env }>, provider: string): string | undefined {
  const v = getCookie(c, `aw_oauth_${provider}`);
  deleteCookie(c, `aw_oauth_${provider}`, { path: '/' });
  return v;
}
