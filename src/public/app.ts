interface ProjectListItem {
  slug: string;
  name: string;
  github_url: string;
  is_default: boolean;
  has_data: boolean;
}

interface Stability {
  score: number;
  color: string;
  state: 'analyzing' | 'rated';
  breakdown: {
    issueCount: number;
    negativeCount: number;
    positiveCount: number;
    ratingAvg: number | null;
    ratingCount: number;
  };
}

interface VersionItem {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string | null;
  download_url: string | null;
  published_at: string;
  is_prerelease: boolean;
  stability: Stability;
  issue_count: number;
  rating_count: number;
}

interface ProjectDetail {
  project: { slug: string; name: string; github_repo: string; github_url: string };
  versions: VersionItem[];
}

interface IssueItem {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  user_login: string | null;
  comment_count: number;
  created_at: string;
  sentiment: string | null;
  confidence: number | null;
  summary: string | null;
}

interface VersionIssuesResponse {
  version: { id: number; tag_name: string; name: string | null; published_at: string };
  issues: IssueItem[];
  ratings: Array<{ score: number; comment: string | null; created_at: string }>;
}

interface MeResponse {
  user: { id: number; provider: string; name: string | null; login: string | null; avatar_url: string | null } | null;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

const state = {
  user: null as MeResponse['user'],
  currentSlug: '' as string,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function capabilityRank(score: number): string {
  if (score >= 8.6) return 'Omega';
  if (score >= 7) return 'Apex';
  if (score >= 5.5) return 'Field-ready';
  if (score >= 4) return 'Volatile';
  return 'Power drain';
}

function renderProjectStats(data: ProjectDetail) {
  const stats = $('#project-stats');
  if (!stats) return;

  const versions = data.versions;
  const tracked = versions.length;
  const avgScore = tracked
    ? versions.reduce((sum, version) => sum + version.stability.score, 0) / tracked
    : 0;
  const stable = versions.filter((version) => version.stability.score >= 6).length;
  const issues = versions.reduce((sum, version) => sum + version.stability.breakdown.issueCount, 0);
  const ratings = versions.reduce((sum, version) => sum + version.stability.breakdown.ratingCount, 0);

  const statItems: Array<[string, string]> = [
    ['Average power', tracked ? avgScore.toFixed(1) : '--'],
    ['Prime releases', `${stable}/${tracked}`],
    ['Issue signals', String(issues)],
    ['Field ratings', String(ratings)],
  ];

  stats.innerHTML = statItems
    .map(
      ([label, value]) => `
        <div class="stat-cell">
          <span class="stat-value">${escapeHtml(value)}</span>
          <span class="stat-label">${escapeHtml(label)}</span>
        </div>`,
    )
    .join('');
}

async function loadAuth() {
  try {
    const me = await api<MeResponse>('/api/auth/me');
    state.user = me.user;
  } catch {
    state.user = null;
  }
  renderAuth();
}

function renderAuth() {
  const el = $('#auth-area')!;
  if (state.user) {
    const avatar = state.user.avatar_url ?? '';
    const name = state.user.name ?? state.user.login ?? 'You';
    el.innerHTML = `
      <span class="user-chip">
        ${avatar ? `<img src="${avatar}" alt="" />` : ''}
        <span>${escapeHtml(name)}</span>
      </span>
      <button class="auth-btn" id="logout-btn">Log out</button>`;
    $('#logout-btn')!.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      state.user = null;
      renderAuth();
      renderProject();
    });
  } else {
    el.innerHTML = `
      <a class="auth-btn" href="/auth/github">Sign in with GitHub</a>
      <a class="auth-btn" href="/auth/google">Sign in with Google</a>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function loadProjectsList() {
  const data = await api<{ projects: ProjectListItem[]; default: string }>('/api/projects');
  const tabsEl = $('#project-tabs')!;
  tabsEl.innerHTML = '';
  for (const p of data.projects) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.textContent = p.name;
    btn.dataset.slug = p.slug;
    btn.addEventListener('click', () => switchProject(p.slug));
    tabsEl.appendChild(btn);
  }
  const known = new Set(data.projects.map((p) => p.slug));
  const initial = location.hash.replace('#', '') || data.default;
  switchProject(known.has(initial) ? initial : data.default);
}

async function switchProject(slug: string) {
  state.currentSlug = slug;
  location.hash = slug;
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.slug === slug));
  await renderProject();
}

async function renderProject() {
  const slug = state.currentSlug;
  if (!slug) return;
  const versionsEl = $('#versions')!;
  versionsEl.innerHTML = '<div class="loading">Loading…</div>';
  let data: ProjectDetail;
  try {
    data = await api<ProjectDetail>(`/api/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    versionsEl.innerHTML = `<div class="empty">Failed to load project: ${(err as Error).message}</div>`;
    return;
  }
  $('#project-title')!.textContent = `${data.project.name} release powers`;
  const meta = $('#project-meta')!;
  meta.innerHTML = `<a href="${data.project.github_url}" target="_blank" rel="noreferrer">${escapeHtml(data.project.github_repo)}</a> · ${data.versions.length} versions mapped`;
  renderProjectStats(data);

  if (data.versions.length === 0) {
    versionsEl.innerHTML = '<div class="empty">No versions yet. The hourly cron will populate them, or trigger <code>POST /cron/run</code>.</div>';
    return;
  }

  versionsEl.innerHTML = '';
  for (const v of data.versions) versionsEl.appendChild(renderVersionCard(v));
}

function renderVersionCard(v: VersionItem): HTMLElement {
  const tpl = $<HTMLTemplateElement>('#version-card-template')!;
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;

  const tagEl = $('.vc-tag', node)!;
  tagEl.textContent = v.tag_name;
  $('.vc-name', node)!.textContent = v.name && v.name !== v.tag_name ? v.name : '';

  const scoreEl = $<HTMLElement>('.vc-score', node)!;
  scoreEl.textContent = v.stability.score.toFixed(1);
  scoreEl.style.setProperty('--score-color', v.stability.color);
  scoreEl.style.color = v.stability.color;
  $('.vc-rank', node)!.textContent = capabilityRank(v.stability.score);

  const stateEl = $('.vc-state', node)!;
  stateEl.textContent =
    v.stability.state === 'analyzing'
      ? 'Scanning signal'
      : `${v.stability.breakdown.issueCount} issues · ${v.stability.breakdown.ratingCount} ratings`;

  const fill = $<HTMLElement>('.vc-bar-fill', node)!;
  fill.style.width = `${(v.stability.score / 10) * 100}%`;
  fill.style.background = v.stability.color;

  const metaParts = [
    `Released ${formatDate(v.published_at)} · ${timeAgo(v.published_at)}`,
    v.is_prerelease ? 'pre-release' : null,
    v.stability.breakdown.negativeCount > 0 ? `${v.stability.breakdown.negativeCount} negative` : null,
    v.stability.breakdown.positiveCount > 0 ? `${v.stability.breakdown.positiveCount} positive` : null,
  ].filter(Boolean);
  $('.vc-meta', node)!.textContent = metaParts.join(' · ');

  const dl = $<HTMLAnchorElement>('.vc-download', node)!;
  if (v.download_url) {
    dl.href = v.download_url;
    dl.textContent = 'Deploy power';
  } else {
    dl.href = v.html_url ?? '#';
    dl.textContent = 'View release';
  }
  const rl = $<HTMLAnchorElement>('.vc-release-link', node)!;
  rl.href = v.html_url ?? '#';

  const detail = $<HTMLElement>('.vc-detail', node)!;
  const toggle = $<HTMLButtonElement>('.vc-toggle', node)!;
  detail.hidden = false;
  toggle.textContent = 'Hide intel';
  let loaded = true;
  void loadDetail(v, node);
  toggle.addEventListener('click', async () => {
    detail.hidden = !detail.hidden;
    toggle.textContent = detail.hidden ? 'Open intel' : 'Hide intel';
    if (!loaded && !detail.hidden) {
      loaded = true;
      await loadDetail(v, node);
    }
  });

  return node;
}

async function loadDetail(v: VersionItem, root: HTMLElement) {
  const issuesEl = $('.vc-issues-list', root)!;
  issuesEl.innerHTML = '<li>Loading…</li>';
  let data: VersionIssuesResponse;
  try {
    data = await api<VersionIssuesResponse>(`/api/versions/${v.id}/issues`);
  } catch (err) {
    issuesEl.innerHTML = `<li>Failed: ${(err as Error).message}</li>`;
    return;
  }
  if (data.issues.length === 0) {
    issuesEl.innerHTML = '<li class="muted">No issues linked to this version yet.</li>';
  } else {
    issuesEl.innerHTML = '';
    for (const i of data.issues.slice(0, 50)) {
      const li = document.createElement('li');
      li.classList.add(`sentiment-${i.sentiment ?? 'unknown'}`);
      const sentimentIcon = i.sentiment === 'negative' ? '⚠' : i.sentiment === 'positive' ? '✓' : '·';
      li.innerHTML = `
        <span class="issue-num">#${i.number}</span>
        <span class="issue-title"><a href="${i.html_url}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a></span>
        <span class="issue-state" title="${escapeHtml(i.summary ?? '')}">${sentimentIcon} ${i.state}</span>`;
      issuesEl.appendChild(li);
    }
  }

  const summary = $('.rating-summary', root)!;
  if (data.ratings.length > 0) {
    const avg = data.ratings.reduce((a, r) => a + r.score, 0) / data.ratings.length;
    summary.textContent = `${data.ratings.length} community rating${data.ratings.length === 1 ? '' : 's'} · avg ${avg.toFixed(1)}/10`;
  } else {
    summary.textContent = 'No community ratings yet.';
  }

  const form = $<HTMLElement>('.rating-form', root)!;
  const loginNote = $<HTMLElement>('.rating-login', root)!;
  if (state.user) {
    form.hidden = false;
    loginNote.hidden = true;
    setupRatingForm(v.id, root);
  } else {
    form.hidden = true;
    loginNote.hidden = false;
  }
}

function setupRatingForm(versionId: number, root: HTMLElement) {
  const stars = $<HTMLElement>('[data-stars]', root)!;
  const submit = $<HTMLButtonElement>('.rating-submit', root)!;
  const comment = $<HTMLTextAreaElement>('.rating-comment', root)!;
  const status = $<HTMLElement>('.rating-status', root)!;
  let selected = 0;

  stars.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const s = document.createElement('span');
    s.className = 'star';
    s.textContent = '★';
    s.dataset.value = String(i);
    s.addEventListener('mouseenter', () => paintStars(stars, i, 'hover'));
    s.addEventListener('mouseleave', () => paintStars(stars, selected, 'active'));
    s.addEventListener('click', () => {
      selected = i;
      paintStars(stars, selected, 'active');
    });
    stars.appendChild(s);
  }

  submit.onclick = async () => {
    if (selected < 1) {
      status.textContent = 'Pick a score 1–10';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Saving…';
    try {
      await api('/api/ratings', {
        method: 'POST',
        body: JSON.stringify({ version_id: versionId, score: selected, comment: comment.value || null }),
      });
      status.textContent = 'Saved! ✓';
    } catch (err) {
      status.textContent = `Failed: ${(err as Error).message}`;
    } finally {
      submit.disabled = false;
    }
  };
}

function paintStars(root: HTMLElement, count: number, cls: 'hover' | 'active') {
  const stars = $$('.star', root);
  stars.forEach((s) => s.classList.remove('hover', 'active'));
  for (let i = 0; i < count && i < stars.length; i++) stars[i]!.classList.add(cls);
}

window.addEventListener('hashchange', () => {
  const slug = location.hash.replace('#', '');
  if (slug && slug !== state.currentSlug) switchProject(slug);
});

loadAuth().then(loadProjectsList).catch((err) => {
  $('#versions')!.innerHTML = `<div class="empty">Bootstrap failed: ${(err as Error).message}</div>`;
});
