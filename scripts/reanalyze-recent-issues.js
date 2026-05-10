#!/usr/bin/env node
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmpDir = join(root, '.reanalyze-score');
const API_ROOT = 'https://api.github.com';
const DEFAULT_PROJECTS = 'openclaw=openclaw/openclaw,hermes=nousresearch/hermes-agent';

const PROJECT_CONTEXTS = {
  openclaw: `PROJECT CONTEXT — openclaw (openclaw/openclaw)
A personal AI assistant. Core surface = the CLI ("openclaw onboard", "openclaw gateway", "openclaw agent", "openclaw doctor", "openclaw message"), the Gateway daemon (launchd/systemd) staying up, install/update via npm/pnpm/bun on macOS/Linux/Windows-WSL2, agent execution, and DM pairing/security defaults.
NOT core: any single channel adapter (WhatsApp, Telegram, Slack, Discord, iMessage, Signal, Microsoft Teams, Google Chat, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, WeChat, QQ, WebChat, IRC, etc.), any specific model provider (OpenAI, Claude/Anthropic, Gemini, Azure, DeepSeek, Bedrock, etc.), specific OS subfeatures (Canvas on iOS, voice on Android), or environment-specific bugs (one shell, one Node version edge case).`,
  hermes: `PROJECT CONTEXT — hermes (NousResearch/hermes-agent)
A self-improving AI agent CLI. Core surface = the CLI ("hermes", "hermes model", "hermes tools", "hermes gateway", "hermes config", "hermes setup", "hermes doctor", "hermes update"), the TUI (multiline editing, slash autocomplete, streaming output), the agent loop / tool-calling loop, model switching mechanics, install scripts (install.sh, install.ps1) on Linux/macOS/WSL2/Termux/native-Windows-beta, and session/config persistence.
NOT core: any single channel gateway (Telegram, Discord, Slack, WhatsApp, Signal, Email), any specific model provider (Nous Portal, OpenRouter, NVIDIA NIM, Xiaomi MiMo, z.ai/GLM, Kimi/Moonshot, MiniMax, Hugging Face, OpenAI, custom endpoints), any specific terminal backend (Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox), voice/audio features, MCP-server-specific bugs, or platform-specific subfeatures (browser dashboard, Termux quirks).`,
};

const FALLBACK_PROJECT_CONTEXT = `PROJECT CONTEXT — generic AI agent CLI
Core surface = CLI start, install/update path, the agent loop, gateway/daemon process stability, session/config persistence.
NOT core: any single channel adapter, any single model/provider, any single OS-specific subfeature, terminal-backend-specific bugs, or platform-specific edge cases.`;

const SYSTEM_PROMPT_BASE = `You analyze GitHub issues for an open-source project release-stability tracker. The classification you produce drives a public stability score that real users see, so misclassifying a niche/provider/channel-specific bug as a "core+broad+critical" issue will materially mislead them. Be conservative and precise.

Given an issue (title + body + recent comments) and a list of recently published version tags, return STRICT JSON with these keys:

- sentiment: "positive" | "negative" | "neutral"
  negative = bug report / regression / complaint that the release is broken for the author.
  positive = praise / explicit confirmation that things work / "5.7 works great for me" / "no issues after upgrade".
  neutral = question / feature request / unclear / configuration help.

- target_version: the version tag this issue most likely affects, copied EXACTLY from the provided list, or null if not derivable.

- confidence: number in [0, 1] representing your confidence in target_version (0 if null).

- severity: "critical" | "high" | "medium" | "low".
  critical = the release cannot start at all OR causes data loss / security issue affecting the documented core flow for typical users.
  high = the documented core flow (see PROJECT CONTEXT below) is BLOCKED for typical users with no workaround. NOT every "this is broken" comment qualifies — the failure must affect the main intended use of the tool.
  medium = an important but non-blocking flow is degraded, OR a clear workaround exists, OR the failure is scoped to a specific configuration.
  low = cosmetic / docs / minor edge case / single-user environment quirk.

- impact_scope: "broad" | "moderate" | "niche".
  broad = clearly affects MOST users running the release on its supported platforms with default config.
  moderate = affects a meaningful but bounded subset (e.g., one major OS, one default-on integration).
  niche = specific adapter / provider / channel / platform / OS edge / shell / Node version / non-default config.
  When uncertain between moderate and niche, choose niche.

- functionality: "core" | "integration" | "provider" | "docs" | "unknown".
  core = ONLY use this when the issue blocks the project's documented core flow (see PROJECT CONTEXT). Generic "the app crashed for me" without identifiable root cause defaults to "unknown", not "core".
  integration = a specific channel / messenger / chat platform adapter, or a specific terminal backend / containerization layer.
  provider = a specific model provider, model SKU, or auth subsystem of a provider.
  docs = docs, examples, wording, packaging metadata, README typos.
  unknown = cause unclear from the report.

- affected_user_share: "many" | "some" | "few" | "unknown".
  many = user comments / reactions show the failure reproduces broadly.
  some = a small handful of independent users confirm.
  few = single reporter, or only users on one specific config.
  unknown = signal not present in thread.
  Issue volume on a niche topic does NOT imply "many" users — five duplicate Azure-only reports are still "few" in terms of total user share.

- duplicate_cluster_size: integer >= 1 estimating how many independent reports/comments describe the same underlying failure. Cluster size is about duplication, NOT about how broad the failure is.

- workaround_status: "none" | "partial" | "confirmed" | "unknown".

- is_ai_generated: boolean. Set true ONLY when the issue body is unambiguously LLM-authored noise rather than a real user reproduction. Strong signals: suspiciously polished prose without any concrete error message / stack trace / version output; "expected vs actual" sections that describe plausible-sounding behavior with no logs; hallucinated-looking command output (commands or flags that do not match the project's actual CLI); long structured templates with every section filled by generic descriptions instead of specifics; obvious LLM tells like "Of course!", "I'd be happy to", "Certainly!" before listing steps. Real reports — even those drafted with AI assistance — are NOT is_ai_generated when they include real logs, real error messages, real version output, or specific reproducible steps. Default to false when uncertain.

- summary: one short English sentence summarizing the issue (<= 140 chars).

GENERAL PRINCIPLE
A bug counts as functionality="core" + severity="critical"|"high" ONLY when BOTH hold:
  (a) Trigger is universal — the failure reproduces for a typical user with default settings, with NO specific provider / channel / plugin / MCP server / terminal backend / OS subfeature / model SKU / skill / non-default config / saved-state combination required to manifest it.
  (b) Effect is fundamental — the documented core flow (install, CLI start, gateway daemon stability, default agent loop, update path; see PROJECT CONTEXT) is unusable.

CLASSIFY BY TRIGGER, NOT BY CONSEQUENCE
- Failure requires a specific model / model SKU / OAuth profile / provider-fallback chain → functionality="provider".
- Failure requires a specific channel adapter / messenger / browser plugin / MCP server / terminal backend / skill or sub-feature (e.g. kanban) / OS subfeature / non-default mode / non-default saved config combination → functionality="integration".
- A vivid consequence — "the gateway dies", "agent hangs forever", "all my sessions broke", "destroyed my system", "completely unusable" — does NOT promote the trigger to core. Inspect whether a specific named subsystem or non-default state is required to reproduce; if yes, it is not core.

SEVERITY LANGUAGE INFLATION
Vocal framing — "CRITICAL", "always", "completely broken", "every user", "[Bug]", "destroyed my system", "totally" — does NOT override the principle. Reporters routinely mark their corner case as critical. Trust the structural facts (what subsystem is named, what config is described, whether a stack trace points at the trigger), not the adjectives. If the body has no concrete reproduction (no logs, no steps, no version output) treat as low signal — at most severity="medium" — even when the title is dramatic.

DUPLICATION vs BREADTH
A cluster of duplicate niche reports does NOT become core. Use duplicate_cluster_size for duplication; never inflate to core+broad to express report volume.

POSITIVE REBUTTAL
Positive comments in the same thread ("works for me on macOS", "no issue here on default config") pull confidence in "broad failure" claims downward.

SENTIMENT vs FEATURE REQUEST
Posts framed as "make X configurable", "narrow scope of Y", "expose option for Z", "improve heuristic for W" are feature requests → sentiment="neutral", even when filed under a [Bug] template. A bug describes a failure with current behavior; a feature request describes desired new behavior.

WHEN IN DOUBT
- core / integration / provider / unknown — pick the more specific (non-core) option.
- broad / moderate / niche — pick niche.

ILLUSTRATIVE EXAMPLES (apply the principle; not exhaustive)
- Provider-switching ("switching A→B leaves the previous runtime active") → provider + niche.
- External-CLI bridge (claude-cli / claude-agent-acp / codex-cli / codex-agent / gemini-cli / qwen-coder / acpx, "ACP_TURN_FAILED", "handshake error") → provider + niche.
- Single-provider/SKU regression ("Anthropic Claude returns incomplete response", "claude-haiku-4-5 rejected by allowlist") → provider + moderate.
- LLM-timeout / fallback-not-delivering glue → integration + moderate.
- MCP-server-specific bug ("Chrome MCP times out", "filesystem MCP returns wrong path") → integration + niche.
- Browser/Chrome subfeature (specific profile mode / OS / SingletonLock; even when consequence is gateway OOM) → integration + niche.
- Skill-or-feature-specific agent-loop misbehavior ("agent loops on kanban tasks", "agent freezes when using skill X") → integration + niche.
- Saved-state config combination ("toolset list mixing composite + configurable drops native toolset") → integration + moderate.
- OAuth invalidation on a specific provider profile → provider + niche.
- UI-feature-specific bugs ("Control UI session switching slow", "dashboard panel hangs", "Canvas pane fails to render") → integration + niche. The CLI-level core flow (gateway, agent, install/update) is unaffected.
- Deployment-path bugs ("default in container without OPENCLAW_SYSTEMD_UNIT", "Docker without launchd", "in-process restart drops config") → integration + moderate. The README's documented install path (npm install -g + systemd/launchd daemon) is the universal trigger; alternative deployment paths are not. A bug in the in-process / container / SIGUSR1 restart path is integration, not core, even if the consequence is config corruption.

SELF-CHECK before emitting core + critical|high
Ask: "Could a user on the default install path (npm install -g, systemd/launchd daemon, default config, default tools, default CLI flow, no UI-only features) reproduce this?" If the answer is "no, they'd need to ___", the answer in the blank is the trigger — classify by it (provider / integration / niche), not by consequence.

Return ONLY the JSON object. No markdown fences, no commentary.`;

function buildSystemPrompt(slug) {
  const ctx = (slug && PROJECT_CONTEXTS[slug]) || FALLBACK_PROJECT_CONTEXT;
  return `${SYSTEM_PROMPT_BASE}\n\n${ctx}`;
}

const FALLBACK = {
  sentiment: 'neutral',
  target_version: null,
  confidence: 0,
  severity: 'medium',
  impact_scope: 'moderate',
  functionality: 'unknown',
  affected_user_share: 'unknown',
  duplicate_cluster_size: 1,
  workaround_status: 'unknown',
  is_ai_generated: 0,
  summary: '',
  raw_response: '',
};

function parseArgs(argv) {
  const args = {
    db: join(root, 'backups/local.sqlite'),
    limit: 300,
    comments: 10,
    concurrency: 4,
    dryRun: false,
    projects: undefined,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--db') args.db = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--comments') args.comments = Number(argv[++i]);
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (arg === '--projects') args.projects = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  args.limit = clampInt(args.limit, 1, 1000, 300);
  args.comments = clampInt(args.comments, 0, 30, 10);
  args.concurrency = clampInt(args.concurrency, 1, 12, 4);
  return args;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function loadEnvFile(file) {
  const path = join(root, file);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function projectList(raw) {
  return (raw || DEFAULT_PROJECTS)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [slug, repo] = entry.split('=').map((part) => part.trim());
      if (!slug || !repo || !repo.includes('/')) throw new Error(`Invalid project entry: ${entry}`);
      return { slug, repo, name: slug.charAt(0).toUpperCase() + slug.slice(1) };
    });
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agent-watch-reanalyze',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function githubJson(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${url} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchIssues(repo, limit) {
  const out = [];
  const maxPages = Math.max(3, Math.ceil(limit / 30) + 5);
  for (let page = 1; page <= maxPages && out.length < limit; page++) {
    const url = `${API_ROOT}/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`;
    const batch = await githubJson(url);
    out.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100 || out.length >= limit) break;
  }
  return out.slice(0, limit);
}

async function fetchComments(repo, issueNumber, limit) {
  if (limit <= 0) return [];
  const comments = await githubJson(`${API_ROOT}/repos/${repo}/issues/${issueNumber}/comments?per_page=100`);
  return comments.slice(-limit);
}

function truncate(value, limit) {
  if (!value) return '';
  return value.length > limit ? `${value.slice(0, limit)}...[truncated]` : value;
}

function userPrompt(issue, comments, versions) {
  const commentBlock = comments
    .map((comment, index) => {
      const login = comment.user?.login || 'unknown';
      return `[Comment ${index + 1} by ${login} @ ${comment.created_at}]\n${truncate(comment.body, 800)}`;
    })
    .join('\n\n');
  return [
    `Recent versions (most recent first): ${versions.length ? versions.join(', ') : '(no version list provided)'}`,
    '',
    `Issue #${issue.number} - state: ${issue.state}`,
    `Title: ${issue.title}`,
    `Author: ${issue.user?.login || 'unknown'}`,
    `Created: ${issue.created_at}`,
    `Body:\n${truncate(issue.body, 3000)}`,
    '',
    `Comments (${comments.length}):\n${commentBlock || '(none)'}`,
  ].join('\n');
}

async function analyze(issue, comments, versions, projectSlug) {
  if (!process.env.LLM_API_KEY) throw new Error('LLM_API_KEY is required');
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL_NAME || 'gpt-5.4-mini';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt(projectSlug) },
        { role: 'user', content: userPrompt(issue, comments, versions) },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${raw.slice(0, 500)}`);
  const json = JSON.parse(raw);
  const content = json.choices?.[0]?.message?.content || '';
  return normalize(content, versions);
}

function normalize(raw, versions) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
  }
  if (!parsed || typeof parsed !== 'object') return { ...FALLBACK, raw_response: raw };
  const sentiment = enumValue(parsed.sentiment, ['positive', 'negative', 'neutral'], 'neutral');
  const targetVersion =
    typeof parsed.target_version === 'string' && versions.includes(parsed.target_version)
      ? parsed.target_version
      : null;
  const confidenceRaw = Number(parsed.confidence);
  const confidence = targetVersion && Number.isFinite(confidenceRaw) ? clamp(confidenceRaw, 0, 1) : 0;
  return {
    sentiment,
    target_version: confidence > 0 ? targetVersion : null,
    confidence,
    severity: enumValue(parsed.severity, ['critical', 'high', 'medium', 'low'], 'medium'),
    impact_scope: enumValue(parsed.impact_scope, ['broad', 'moderate', 'niche'], 'moderate'),
    functionality: enumValue(parsed.functionality, ['core', 'integration', 'provider', 'docs', 'unknown'], 'unknown'),
    affected_user_share: enumValue(parsed.affected_user_share, ['many', 'some', 'few', 'unknown'], 'unknown'),
    duplicate_cluster_size: clampInt(Number(parsed.duplicate_cluster_size), 1, 100, 1),
    workaround_status: enumValue(parsed.workaround_status, ['none', 'partial', 'confirmed', 'unknown'], 'unknown'),
    is_ai_generated:
      parsed.is_ai_generated === true ||
      parsed.is_ai_generated === 1 ||
      (typeof parsed.is_ai_generated === 'string' && /^(true|1|yes)$/i.test(parsed.is_ai_generated.trim()))
        ? 1
        : 0,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 280) : '',
    raw_response: raw,
  };
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function ensureProject(db, project) {
  const existing = db.prepare('SELECT * FROM projects WHERE slug = ?').get(project.slug);
  if (existing) return existing;
  db.prepare('INSERT INTO projects (slug, name, github_repo, github_url) VALUES (?, ?, ?, ?)').run(
    project.slug,
    project.name,
    project.repo,
    `https://github.com/${project.repo}`,
  );
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(project.slug);
}

function ensureImpactColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(issue_analyses)').all().map((row) => row.name));
  const columns = [
    ['severity', "TEXT NOT NULL DEFAULT 'medium'"],
    ['impact_scope', "TEXT NOT NULL DEFAULT 'moderate'"],
    ['functionality', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['affected_user_share', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['duplicate_cluster_size', 'INTEGER NOT NULL DEFAULT 1'],
    ['workaround_status', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['is_ai_generated', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.prepare(`ALTER TABLE issue_analyses ADD COLUMN ${name} ${definition}`).run();
  }
}

function recentVersions(db, projectId) {
  return db
    .prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY published_at DESC LIMIT 15')
    .all(projectId);
}

function upsertIssue(db, projectId, issue) {
  db.prepare(
    `INSERT INTO issues (project_id, github_id, number, title, body, state, html_url, user_login, comment_count, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, github_id) DO UPDATE SET
       title=excluded.title, body=excluded.body, state=excluded.state, html_url=excluded.html_url,
       user_login=excluded.user_login, comment_count=excluded.comment_count,
       updated_at=excluded.updated_at, closed_at=excluded.closed_at`,
  ).run(
    projectId,
    issue.id,
    issue.number,
    issue.title,
    issue.body,
    issue.state,
    issue.html_url,
    issue.user?.login || null,
    issue.comments,
    issue.created_at,
    issue.updated_at,
    issue.closed_at,
  );
  return db.prepare('SELECT id FROM issues WHERE project_id = ? AND github_id = ?').get(projectId, issue.id).id;
}

function upsertComment(db, issueId, comment) {
  db.prepare(
    `INSERT INTO issue_comments (issue_id, github_id, body, user_login, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(issue_id, github_id) DO UPDATE SET body=excluded.body`,
  ).run(issueId, comment.id, comment.body, comment.user?.login || null, comment.created_at);
}

function upsertAnalysis(db, issueId, result) {
  db.prepare(
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
  ).run(
    issueId,
    result.sentiment,
    result.target_version,
    result.confidence,
    result.severity,
    result.impact_scope,
    result.functionality,
    result.affected_user_share,
    result.duplicate_cluster_size,
    result.workaround_status,
    result.is_ai_generated ?? 0,
    result.summary,
    result.raw_response.slice(0, 4000),
    new Date().toISOString(),
  );
}

async function mapLimit(items, concurrency, fn) {
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await fn(current, index, items.length);
    }
  });
  await Promise.all(workers);
}

async function loadScoreModule() {
  await mkdir(tmpDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'src/lib/score.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile: join(tmpDir, 'score.mjs'),
    logLevel: 'silent',
  });
  return import(pathToFileURL(join(tmpDir, 'score.mjs')).href);
}

function printScores(db, calculateStability, project) {
  const projectRow = db.prepare('SELECT * FROM projects WHERE slug = ?').get(project.slug);
  const versions = recentVersions(db, projectRow.id);
  console.log(`\n${project.slug} recalculated scores`);
  for (const version of versions) {
    const issues = db
      .prepare(
        `SELECT i.created_at, i.comment_count, a.sentiment, a.confidence, a.severity, a.impact_scope,
                a.functionality, a.affected_user_share, a.duplicate_cluster_size, a.workaround_status
         FROM issues i JOIN issue_analyses a ON a.issue_id = i.id
         WHERE i.project_id = ? AND a.target_version = ?
           AND COALESCE(a.is_ai_generated, 0) = 0`,
      )
      .all(projectRow.id, version.tag_name);
    const ratings = db.prepare('SELECT score FROM user_ratings WHERE version_id = ?').all(version.id);
    const stability = calculateStability({ publishedAt: version.published_at }, issues, ratings);
    console.log(
      `${version.tag_name.padEnd(14)} ${stability.score.toFixed(1).padStart(4)} ${stability.grade.padEnd(20)} ` +
        `${String(stability.breakdown.issueCount).padStart(3)} issues · ` +
        `${stability.breakdown.coreIssueCount} core · ${stability.breakdown.nicheIssueCount} niche · ` +
        `${stability.breakdown.workaroundCount} workarounds · ${stability.breakdown.topRiskFactor}`,
    );
  }
}

async function main() {
  loadEnvFile('.env');
  loadEnvFile('.dev.vars');
  const args = parseArgs(process.argv);
  const db = new Database(args.db);
  ensureImpactColumns(db);
  const { calculateStability } = await loadScoreModule();
  const projects = projectList(args.projects || process.env.PROJECTS);

  for (const project of projects) {
    const projectRow = ensureProject(db, project);
    const versions = recentVersions(db, projectRow.id);
    const tagNames = versions.map((version) => version.tag_name);
    if (tagNames.length === 0) throw new Error(`No versions in DB for ${project.slug}; run cron first`);

    console.log(`\nFetching ${args.limit} recent issues for ${project.slug} (${project.repo})`);
    const issues = await fetchIssues(project.repo, args.limit);
    console.log(`Analyzing ${issues.length} issues for ${project.slug}`);

    await mapLimit(issues, args.concurrency, async (issue, index, total) => {
      const comments = await fetchComments(project.repo, issue.number, args.comments);
      const result = await analyze(issue, comments, tagNames, project.slug);
      if (!args.dryRun) {
        const issueId = upsertIssue(db, projectRow.id, issue);
        for (const comment of comments) upsertComment(db, issueId, comment);
        upsertAnalysis(db, issueId, result);
      }
      console.log(
        `[${project.slug}] ${String(index).padStart(3)}/${total} #${issue.number} ` +
          `${result.sentiment}/${result.severity}/${result.functionality}/${result.impact_scope} -> ${result.target_version || 'none'}`,
      );
    });

    printScores(db, calculateStability, project);
  }

  await rm(tmpDir, { recursive: true, force: true });
}

main().catch(async (err) => {
  await rm(tmpDir, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
