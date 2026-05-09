import { Hono } from 'hono';
import api from './routes/api';
import auth from './routes/auth';
import type { Env } from './lib/types';
import { pollOnce } from './lib/poll';

const app = new Hono<{ Bindings: Env }>();

app.route('/api', api);
app.route('/auth', auth);

app.post('/cron/run', async (c) => {
  if (c.req.header('x-admin-token') !== c.env.SESSION_SECRET) return c.text('forbidden', 403);
  const summary = await pollOnce(c.env);
  return c.json({ ok: true, summary });
});

app.get('/healthz', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.all('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      pollOnce(env)
        .then((s) => console.log('[cron] poll done', s))
        .catch((e) => console.error('[cron] poll failed', e)),
    );
  },
} satisfies ExportedHandler<Env>;
