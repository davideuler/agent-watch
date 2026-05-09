import type { Env } from './types';
import type { GhComment, GhIssue } from './github';

export interface AnalysisResult {
  sentiment: 'positive' | 'negative' | 'neutral';
  targetVersion: string | null;
  confidence: number;
  summary: string;
  raw: string;
}

const FALLBACK: AnalysisResult = {
  sentiment: 'neutral',
  targetVersion: null,
  confidence: 0,
  summary: '',
  raw: '',
};

const SYSTEM_PROMPT = `You analyze GitHub issues for an open-source project release-stability tracker.

Given an issue (title + body + recent comments) and a list of recently published version tags, return STRICT JSON with these keys:
- sentiment: "positive" | "negative" | "neutral" (negative = bug report / regression / complaint; positive = praise / confirmation things work; neutral = question / feature request / unclear).
- target_version: the version tag this issue most likely affects, copied EXACTLY from the provided list, or null if not derivable.
- confidence: number in [0, 1] representing your confidence in target_version (0 if null).
- summary: one short English sentence summarizing the issue (<= 140 chars).

Return ONLY the JSON object. No markdown fences, no commentary.`;

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
  const summary = typeof obj['summary'] === 'string' ? obj['summary'].slice(0, 280) : '';
  return {
    sentiment,
    targetVersion: targetVersion && confidence > 0 ? targetVersion : null,
    confidence: targetVersion ? confidence : 0,
    summary,
    raw,
  };
}

export async function analyzeIssue(
  env: Env,
  issue: GhIssue,
  comments: GhComment[],
  versions: string[],
): Promise<AnalysisResult> {
  if (!env.LLM_API_KEY) return FALLBACK;
  const baseUrl = (env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = env.LLM_MODEL_NAME ?? 'gpt-4o-mini';

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
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
