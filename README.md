# Agent Watch

Track release stability for [OpenClaw](https://github.com/openclaw/openclaw), [Hermes](https://github.com/getzep/hermes), and any other open-source project. Built on Cloudflare Workers + D1.

**Live:** https://agentwatch.aicompass.dev

---

## How it works

1. **Hourly cron** pulls the 15 most-recent releases from GitHub for each configured project, plus issues updated since the last poll.
2. **LLM (OpenAI-compatible)** classifies each issue's sentiment (`positive` / `negative` / `neutral`), guesses which version tag the report targets, and gives a confidence score.
3. **Stability score (0–10)** per version blends:
   - Base 5
   - LLM-classified issues (negative → subtract, positive → add) weighted by confidence × comment-volume × recency-decay
   - User star ratings (1–10) — community ratings are blended with up to 60% weight at saturation
4. **New versions** (< 3 hours old) display a grey **5** with `analyzing…`.
5. **Color coding** is interpolated:
   - `< 5` shades of red, deeper for lower scores
   - `= 5` grey
   - `> 5` shades of green, deeper for higher scores
6. **Login** with GitHub or Google to add your own 1–10 rating with optional comment.

---

## Local development

```bash
npm install
cp .env.example .dev.vars            # populate at minimum LLM_API_KEY and GITHUB_TOKEN

# Validate everything once before deploy
npm run test                         # typecheck + sql validation + score smoke tests

# Run the worker locally
npm run db:migrate:local
npm run dev
```

`npm run dev` serves on `http://localhost:8787` with the static frontend mounted under `/`.

To trigger a one-off poll locally:

```bash
curl -X POST http://localhost:8787/cron/run -H "x-admin-token: $SESSION_SECRET"
```

---

## Configuration

All config is via environment variables — see `.env.example` for the full list.

| Variable | Purpose | Example |
| --- | --- | --- |
| `PROJECTS` | Comma-separated `slug=owner/repo` for projects to monitor | `openclaw=openclaw/openclaw,hermes=getzep/hermes` |
| `DEFAULT_PROJECT` | Slug shown on the homepage by default | `openclaw` |
| `PUBLIC_BASE_URL` | Origin used for OAuth `redirect_uri` | `https://agentwatch.aicompass.dev` |
| `GITHUB_TOKEN` | Bumps GitHub API rate-limit from 60 → 5000/hour | `ghp_…` |
| `LLM_BASE_URL` | OpenAI-compatible endpoint (works for OpenAI, Anthropic via proxy, third-party) | `https://api.openai.com/v1` |
| `LLM_MODEL_NAME` | Model used for issue analysis | `gpt-4o-mini` |
| `LLM_API_KEY` | API key for the LLM provider | `sk-…` |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | GitHub login app credentials | — |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google login app credentials | — |
| `SESSION_SECRET` | Random ≥32-char string; also gates `/cron/run` admin endpoint | — |
| `PUBLIC_GA_MEASUREMENT_ID` | Optional Google Analytics 4 measurement ID; leave empty to disable GA | `G-…` |

### OAuth callback URLs

When registering OAuth apps:

- **GitHub** → `https://agentwatch.aicompass.dev/auth/github/callback`
- **Google** → `https://agentwatch.aicompass.dev/auth/google/callback`

### LLM provider tips

`LLM_BASE_URL` accepts any OpenAI-Chat-Completions-compatible endpoint. Tested with:
- OpenAI (`https://api.openai.com/v1`)
- Anthropic via proxy (e.g. `https://api.anthropic.com/v1` with a compat shim)
- Self-hosted (`https://your-host/v1`)

If `LLM_API_KEY` is unset the worker still polls and stores issues, but every analysis defaults to `neutral / confidence 0` so versions show 5 / grey.

---

## Deploying to Cloudflare

```bash
# 1. Create the D1 database (capture the printed ID)
npx wrangler d1 create agent-watch
# → paste database_id into wrangler.jsonc

# 2. Create the KV namespace
npx wrangler kv namespace create CACHE
# → paste id into wrangler.jsonc

# 3. Apply migrations
npm run db:migrate         # remote
npm run db:migrate:local   # local emulator

# 4. Set secrets (NEVER commit these)
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put LLM_API_KEY
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET

# 5. Build & deploy
npm run deploy
```

### Custom domain `agentwatch.aicompass.dev`

`wrangler.jsonc` already declares a custom-domain route. Make sure:

1. The `aicompass.dev` zone exists in your Cloudflare account.
2. After the first `wrangler deploy`, attach the route in **Workers → agent-watch → Settings → Domains & Routes** (or wrangler will provision the certificate automatically when the route block above is present).
3. Update `PUBLIC_BASE_URL` to match — and update the OAuth app callback URLs.

---

## Architecture

```
┌──────────────┐     hourly cron     ┌──────────────────────┐
│   GitHub     │ ◀────────────────── │  Workers scheduled() │
│   REST API   │                     │     (poll.ts)        │
└──────────────┘                     └─────────┬────────────┘
                                               │
                                               ▼
┌──────────────┐                     ┌──────────────────────┐
│  LLM (any    │ ◀─────────────────  │   analyzeIssue()     │
│  OAI-compat) │                     │   sentiment + tag    │
└──────────────┘                     └─────────┬────────────┘
                                               │
                                               ▼
                                     ┌──────────────────────┐
                                     │   D1 (sqlite)        │
                                     │   versions / issues  │
                                     │   analyses / ratings │
                                     └─────────┬────────────┘
                                               │ HTTP API
                                               ▼
                                     ┌──────────────────────┐
                                     │ static SPA dashboard │
                                     │ (Cloudflare Assets)  │
                                     └──────────────────────┘
```

## License

MIT
