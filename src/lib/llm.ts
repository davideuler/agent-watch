import type { Env } from './types';
import type { GhComment, GhIssue } from './github';

export interface AnalysisResult {
  sentiment: 'positive' | 'negative' | 'neutral';
  targetVersion: string | null;
  confidence: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  impactScope: 'broad' | 'moderate' | 'niche';
  functionality: 'core' | 'integration' | 'provider' | 'docs' | 'unknown';
  affectedUserShare: 'many' | 'some' | 'few' | 'unknown';
  duplicateClusterSize: number;
  workaroundStatus: 'none' | 'partial' | 'confirmed' | 'unknown';
  isAiGenerated: boolean;
  summary: string;
  raw: string;
}

const FALLBACK: AnalysisResult = {
  sentiment: 'neutral',
  targetVersion: null,
  confidence: 0,
  severity: 'medium',
  impactScope: 'moderate',
  functionality: 'unknown',
  affectedUserShare: 'unknown',
  duplicateClusterSize: 1,
  workaroundStatus: 'unknown',
  isAiGenerated: false,
  summary: '',
  raw: '',
};

const PROJECT_CONTEXTS: Record<string, string> = {
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

function buildSystemPrompt(projectSlug?: string): string {
  const ctx = (projectSlug && PROJECT_CONTEXTS[projectSlug]) ?? FALLBACK_PROJECT_CONTEXT;
  return `${SYSTEM_PROMPT_BASE}\n\n${ctx}`;
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…[truncated]' : s;
}

function buildUserPrompt(issue: GhIssue, comments: GhComment[], versions: string[]): string {
  const versionList = versions.length > 0 ? versions.join(', ') : '(no version list provided)';
  const commentBlock = comments
    .slice(-10)
    .map((c, i) => `[Comment ${i + 1} by ${c.user?.login ?? 'unknown'} @ ${c.created_at}]\n${truncate(c.body, 800)}`)
    .join('\n\n');
  return [
    `Recent versions (most recent first): ${versionList}`,
    '',
    `Issue #${issue.number} — state: ${issue.state}`,
    `Title: ${issue.title}`,
    `Author: ${issue.user?.login ?? 'unknown'}`,
    `Created: ${issue.created_at}`,
    `Body:\n${truncate(issue.body, 3000)}`,
    '',
    `Comments (${comments.length}):\n${commentBlock || '(none)'}`,
  ].join('\n');
}

function parseJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalize(parsed: unknown, versions: string[], raw: string): AnalysisResult {
  if (!parsed || typeof parsed !== 'object') return { ...FALLBACK, raw };
  const obj = parsed as Record<string, unknown>;
  const sentRaw = String(obj['sentiment'] ?? '').toLowerCase();
  const sentiment: AnalysisResult['sentiment'] =
    sentRaw === 'positive' || sentRaw === 'negative' || sentRaw === 'neutral' ? sentRaw : 'neutral';
  const tv = obj['target_version'];
  let targetVersion: string | null = null;
  if (typeof tv === 'string' && tv.length > 0 && versions.includes(tv)) targetVersion = tv;
  const confRaw = Number(obj['confidence']);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;
  const severity = enumValue(obj['severity'], ['critical', 'high', 'medium', 'low'], 'medium');
  const impactScope = enumValue(obj['impact_scope'], ['broad', 'moderate', 'niche'], 'moderate');
  const functionality = enumValue(obj['functionality'], ['core', 'integration', 'provider', 'docs', 'unknown'], 'unknown');
  const affectedUserShare = enumValue(obj['affected_user_share'], ['many', 'some', 'few', 'unknown'], 'unknown');
  const duplicateRaw = Number(obj['duplicate_cluster_size']);
  const duplicateClusterSize = Number.isFinite(duplicateRaw) ? Math.max(1, Math.min(100, Math.round(duplicateRaw))) : 1;
  const workaroundStatus = enumValue(obj['workaround_status'], ['none', 'partial', 'confirmed', 'unknown'], 'unknown');
  const aiRaw = obj['is_ai_generated'];
  const isAiGenerated =
    aiRaw === true ||
    aiRaw === 1 ||
    (typeof aiRaw === 'string' && /^(true|1|yes)$/i.test(aiRaw.trim()));
  const summary = typeof obj['summary'] === 'string' ? obj['summary'].slice(0, 280) : '';
  return {
    sentiment,
    targetVersion: targetVersion && confidence > 0 ? targetVersion : null,
    confidence: targetVersion ? confidence : 0,
    severity,
    impactScope,
    functionality,
    affectedUserShare,
    duplicateClusterSize,
    workaroundStatus,
    isAiGenerated,
    summary,
    raw,
  };
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export async function analyzeIssue(
  env: Env,
  issue: GhIssue,
  comments: GhComment[],
  versions: string[],
  projectSlug?: string,
): Promise<AnalysisResult> {
  if (!env.LLM_API_KEY) return FALLBACK;
  const baseUrl = (env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = env.LLM_MODEL_NAME ?? 'gpt-4o-mini';

  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(projectSlug) },
      { role: 'user', content: buildUserPrompt(issue, comments, versions) },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`LLM ${res.status}: ${errBody.slice(0, 300)}`);
      return FALLBACK;
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? '';
    return normalize(parseJson(content), versions, content);
  } catch (err) {
    console.error('LLM request failed', err);
    return FALLBACK;
  }
}
