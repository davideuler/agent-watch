import { formatReleaseDate, getReleaseDisplay, googleAnalyticsScriptSrc } from './release-display';

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
  grade: string;
  breakdown: {
    issueCount: number;
    negativeCount: number;
    positiveCount: number;
    coreIssueCount: number;
    nicheIssueCount: number;
    workaroundCount: number;
    topRiskFactor: string;
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
  severity: string | null;
  impact_scope: string | null;
  functionality: string | null;
  affected_user_share: string | null;
  duplicate_cluster_size: number | null;
  workaround_status: string | null;
  summary: string | null;
}

interface AllStats {
  total: number;
  negative: number;
  positive: number;
  core: number;
  niche: number;
  workarounds: number;
  facets?: Record<string, Record<string, number>>;
}

interface VersionIssuesResponse {
  version: { id: number; tag_name: string; name: string | null; published_at: string };
  issues: IssueItem[];
  issues_total: number;
  page?: number;
  per_page?: number;
  total?: number;
  total_considered?: number;
  total_pages?: number;
  max_pages?: number;
  max_per_page?: number;
  all_stats?: AllStats;
  ratings: Array<{ score: number; comment: string | null; created_at: string }>;
  project?: { slug: string; name: string; github_url: string };
}

interface MeResponse {
  user: { id: number; provider: string; name: string | null; login: string | null; avatar_url: string | null } | null;
}

declare global {
  interface Window {
    AGENT_WATCH_CONFIG?: { googleAnalyticsMeasurementId?: string };
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

const ISSUES_PER_CARD = 20;
const ISSUES_PER_PAGE = 40;
const ISSUES_MAX_PAGES = 30;
const ISSUES_PAGE_CAP = ISSUES_PER_PAGE * ISSUES_MAX_PAGES;

const state = {
  user: null as MeResponse['user'],
  currentSlug: '' as string,
  projectsCache: null as { projects: ProjectListItem[]; default: string } | null,
};

const PROJECT_STORAGE_KEY = 'agent-watch-project';
const AUTH_START_PATHS = new Set(['/auth/github', '/auth/google']);

function normalizePath(pathname: string): string {
  return pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

const currentPath = normalizePath(location.pathname);
if (AUTH_START_PATHS.has(currentPath) && (location.search || location.hash)) {
  window.location.replace(`${location.origin}${currentPath}`);
}

type Route =
  | { kind: 'home' }
  | { kind: 'project'; slug: string }
  | { kind: 'issues'; slug: string; tag: string; page: number };

function parseIssuesPageQuery(search: string): number {
  const params = new URLSearchParams(search);
  const raw = Number(params.get('page'));
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(ISSUES_MAX_PAGES, Math.max(1, Math.floor(raw)));
}

function parseRoute(pathname: string, search: string, hash: string): Route {
  const path = normalizePath(pathname);
  const issuesMatch = path.match(/^\/projects\/([^/]+)\/v\/(.+?)\/issues$/);
  if (issuesMatch) {
    return {
      kind: 'issues',
      slug: decodeURIComponent(issuesMatch[1]!),
      tag: decodeURIComponent(issuesMatch[2]!),
      page: parseIssuesPageQuery(search),
    };
  }
  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) return { kind: 'project', slug: decodeURIComponent(projectMatch[1]!) };

  // Legacy fallbacks: ?project=foo or #foo or sessionStorage
  const params = new URLSearchParams(search);
  const legacy = params.get('project')?.trim() || hash.replace('#', '').trim();
  if (legacy) return { kind: 'project', slug: legacy };
  try {
    const stored = sessionStorage.getItem(PROJECT_STORAGE_KEY)?.trim();
    if (stored) return { kind: 'project', slug: stored };
  } catch {
    // ignore
  }
  return { kind: 'home' };
}

function projectPath(slug: string): string {
  return `/projects/${encodeURIComponent(slug)}`;
}

function issuesPath(slug: string, tag: string): string {
  return `/projects/${encodeURIComponent(slug)}/v/${encodeURIComponent(tag)}/issues`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function initGoogleAnalytics(): void {
  const measurementId = window.AGENT_WATCH_CONFIG?.googleAnalyticsMeasurementId;
  const src = googleAnalyticsScriptSrc(measurementId);
  if (!src || !measurementId || document.querySelector('[data-agent-watch-ga]')) return;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag = (...args: unknown[]) => {
    window.dataLayer!.push(args);
  };
  window.gtag('js', new Date());
  window.gtag('config', measurementId, { send_page_view: false });

  const script = document.createElement('script');
  script.async = true;
  script.src = src;
  script.dataset.agentWatchGa = 'true';
  document.head.appendChild(script);
}

function trackPageView(): void {
  const measurementId = window.AGENT_WATCH_CONFIG?.googleAnalyticsMeasurementId;
  if (!measurementId || !window.gtag) return;
  window.gtag('event', 'page_view', {
    page_location: location.href,
    page_path: `${location.pathname}${location.search}${location.hash}`,
    page_title: document.title,
  });
}

function formatDate(iso: string): string {
  return formatReleaseDate(iso);
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
  if (score >= 8.2) return 'Stable';
  if (score >= 6.8) return 'Mostly stable';
  if (score >= 5.2) return 'Mixed';
  if (score >= 3.5) return 'Risky';
  return 'Unstable';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function renderProjectStats(data: ProjectDetail) {
  const stats = $('#project-stats');
  if (!stats) return;

  const versions = data.versions;
  const tracked = versions.length;
  const avgScore = tracked
    ? versions.reduce((sum, version) => sum + version.stability.score, 0) / tracked
    : 0;
  const stable = versions.filter((version) => version.stability.score >= 6.8).length;
  const issues = versions.reduce((sum, version) => sum + version.stability.breakdown.issueCount, 0);
  const negative = versions.reduce((sum, version) => sum + version.stability.breakdown.negativeCount, 0);
  const ratings = versions.reduce((sum, version) => sum + version.stability.breakdown.ratingCount, 0);

  const statItems: Array<[string, string, string?]> = [
    ['Average grade', tracked ? avgScore.toFixed(1) : '--', 'score'],
    ['Mostly stable+', `${stable}/${tracked}`],
    ['Issue signals', String(issues), 'issues'],
    ['Negative signals', String(negative), 'negative'],
    ['Community ratings', String(ratings)],
  ];

  stats.innerHTML = statItems
    .map(
      ([label, value, tone]) => `
        <div class="stat-cell${tone ? ` stat-cell-${tone}` : ''}">
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
      void rerenderActiveRoute();
    });
  } else {
    el.innerHTML = `
      <a class="auth-btn" href="/auth/github" data-auth-provider="github">Sign in with GitHub</a>
      <a class="auth-btn" href="/auth/google" data-auth-provider="google">Sign in with Google</a>`;
    $$<HTMLAnchorElement>('[data-auth-provider]', el).forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        window.location.assign(link.pathname);
      });
    });
  }
}

function rememberSlug(slug: string): void {
  try {
    sessionStorage.setItem(PROJECT_STORAGE_KEY, slug);
  } catch {
    // ignore storage failures
  }
}

function pushUrl(path: string, mode: 'push' | 'replace' = 'push', shouldTrackPageView = true): void {
  const url = new URL(location.href);
  const qIdx = path.indexOf('?');
  if (qIdx >= 0) {
    url.pathname = path.slice(0, qIdx);
    url.search = path.slice(qIdx);
  } else {
    url.pathname = path;
    url.search = '';
  }
  url.hash = '';
  history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
  if (shouldTrackPageView) trackPageView();
}

function setView(name: 'home' | 'issues'): void {
  const home = $('#home-view')!;
  const issues = $('#issues-view')!;
  home.hidden = name !== 'home';
  issues.hidden = name !== 'issues';
}

function renderProjectsList(projects: ProjectListItem[]): void {
  const tabsEl = $('#project-tabs')!;
  tabsEl.innerHTML = '';
  for (const p of projects) {
    const a = document.createElement('a');
    a.className = 'tab-btn';
    a.textContent = p.name;
    a.dataset.slug = p.slug;
    a.href = projectPath(p.slug);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      void switchProject(p.slug);
    });
    tabsEl.appendChild(a);
  }
}

function highlightTab(slug: string | null): void {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', !!slug && b.dataset.slug === slug));
}

async function switchProject(slug: string, urlMode: 'push' | 'replace' = 'push') {
  state.currentSlug = slug;
  rememberSlug(slug);
  pushUrl(projectPath(slug), urlMode);
  highlightTab(slug);
  setView('home');
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
  applyProjectDetail(data);
}

function applyProjectDetail(data: ProjectDetail): void {
  const versionsEl = $('#versions')!;
  $('#project-title')!.textContent = `${data.project.name} releases`;
  const meta = $('#project-meta')!;
  meta.innerHTML = `Tracking <a href="${data.project.github_url}" target="_blank" rel="noreferrer">${escapeHtml(data.project.github_repo)}</a> · ${data.versions.length} version${data.versions.length === 1 ? '' : 's'} mapped`;
  renderProjectStats(data);

  if (data.versions.length === 0) {
    versionsEl.innerHTML = '<div class="empty">No versions yet. The cron will populate them shortly.</div>';
    return;
  }

  versionsEl.innerHTML = '';
  for (const v of data.versions) versionsEl.appendChild(renderVersionCard(v, data.project.slug));
}

function renderVersionCard(v: VersionItem, slug: string): HTMLElement {
  const tpl = $<HTMLTemplateElement>('#version-card-template')!;
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const releaseDisplay = getReleaseDisplay(v);

  $('.vc-tag', node)!.textContent = releaseDisplay.version;
  $('.vc-date', node)!.textContent = `Released ${formatDate(v.published_at)}`;
  $('.vc-name', node)!.textContent = releaseDisplay.subtitle;

  const scoreEl = $<HTMLElement>('.vc-score', node)!;
  scoreEl.textContent = v.stability.score.toFixed(1);
  node.style.setProperty('--score-color', v.stability.color);
  scoreEl.style.setProperty('--score-color', v.stability.color);
  scoreEl.style.color = v.stability.color;
  $('.vc-rank', node)!.textContent = v.stability.grade ?? capabilityRank(v.stability.score);

  const stateEl = $('.vc-state', node)!;
  stateEl.textContent =
    v.stability.state === 'analyzing'
      ? 'Collecting signal'
      : '10 most stable · 0 least stable';

  $('[data-signal-issues]', node)!.textContent = String(v.stability.breakdown.issueCount);
  $('[data-signal-core]', node)!.textContent = String(v.stability.breakdown.coreIssueCount ?? 0);
  $('[data-signal-niche]', node)!.textContent = String(v.stability.breakdown.nicheIssueCount ?? 0);
  $('[data-signal-workarounds]', node)!.textContent = String(v.stability.breakdown.workaroundCount ?? 0);
  $('[data-signal-ratings]', node)!.textContent = String(v.stability.breakdown.ratingCount);

  const makeSignalClickable = (
    el: HTMLElement | null,
    preset: IssuesPreset | null,
    title: string,
  ) => {
    if (!el) return;
    el.classList.add('vc-signal-clickable');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.title = title;
    const go = () => {
      pendingIssuesPreset = preset;
      void navigateToIssues(slug, v.tag_name);
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  };

  makeSignalClickable($('.vc-signal-issues', node), null, 'View all issues');
  makeSignalClickable($('.vc-signal-core', node), [{ facetId: 'area', value: 'core' }], 'View core issues');
  makeSignalClickable($('.vc-signal-niche', node), [{ facetId: 'scope', value: 'niche' }], 'View niche issues');
  makeSignalClickable(
    $('.vc-signal-workarounds', node),
    [{ facetId: 'workaround', value: 'confirmed' }],
    'View issues with confirmed workarounds',
  );

  const fill = $<HTMLElement>('.vc-bar-fill', node)!;
  fill.style.width = `${(v.stability.score / 10) * 100}%`;
  fill.style.background = v.stability.color;

  const metaParts = [
    `Released ${formatDate(v.published_at)} · ${timeAgo(v.published_at)}`,
    v.is_prerelease ? 'pre-release' : null,
    v.stability.breakdown.topRiskFactor,
    v.stability.breakdown.positiveCount > 0 ? `${v.stability.breakdown.positiveCount} positive` : null,
  ].filter(Boolean);
  $('.vc-meta', node)!.textContent = metaParts.join(' · ');

  const dl = $<HTMLAnchorElement>('.vc-download', node)!;
  if (v.download_url) {
    dl.href = v.download_url;
    dl.textContent = 'Download';
  } else {
    dl.href = v.html_url ?? '#';
    dl.textContent = 'View release';
  }
  const rl = $<HTMLAnchorElement>('.vc-release-link', node)!;
  rl.href = v.html_url ?? '#';

  void loadDetail(v, slug, node);

  return node;
}

async function loadDetail(v: VersionItem, slug: string, root: HTMLElement) {
  const issuesEl = $('.vc-issues-list', root)!;
  const allLink = $<HTMLAnchorElement>('.vc-issues-all', root)!;
  issuesEl.innerHTML = '<li>Loading…</li>';
  allLink.hidden = true;

  let data: VersionIssuesResponse;
  try {
    data = await api<VersionIssuesResponse>(
      `/api/versions/${v.id}/issues?page=1&per_page=${ISSUES_PER_CARD}`,
    );
  } catch (err) {
    issuesEl.innerHTML = `<li>Failed: ${(err as Error).message}</li>`;
    return;
  }
  if (data.issues.length === 0) {
    issuesEl.innerHTML = '<li class="muted">No issues linked to this version yet.</li>';
  } else {
    issuesEl.innerHTML = '';
    for (const i of data.issues) {
      issuesEl.appendChild(renderIssueLi(i, 'compact'));
    }
  }

  const total = data.total ?? data.issues_total ?? data.issues.length;
  if (total > 0) {
    const targetTotal = Math.min(total, ISSUES_PAGE_CAP);
    allLink.hidden = false;
    allLink.href = issuesPath(slug, v.tag_name);
    allLink.textContent =
      total > ISSUES_PER_CARD ? `View all ${targetTotal} →` : `View page →`;
    allLink.onclick = (e) => {
      e.preventDefault();
      void navigateToIssues(slug, v.tag_name);
    };
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

// ---------------------------------------------------------------------------
// Issue list filters

type FacetField =
  | 'sentiment'
  | 'severity'
  | 'functionality'
  | 'impact_scope'
  | 'affected_user_share'
  | 'workaround_status';

interface FacetDef {
  id: string;
  label: string;
  field: FacetField;
  values: string[];
}

const FACET_DEFS: FacetDef[] = [
  { id: 'sentiment', label: 'Sentiment', field: 'sentiment', values: ['negative', 'positive', 'neutral'] },
  { id: 'severity', label: 'Severity', field: 'severity', values: ['critical', 'high', 'medium', 'low'] },
  { id: 'area', label: 'Area', field: 'functionality', values: ['core', 'integration', 'provider', 'docs', 'unknown'] },
  { id: 'scope', label: 'Scope', field: 'impact_scope', values: ['broad', 'moderate', 'niche'] },
  { id: 'users', label: 'Users', field: 'affected_user_share', values: ['many', 'some', 'few', 'unknown'] },
  { id: 'workaround', label: 'Workaround', field: 'workaround_status', values: ['none', 'partial', 'confirmed', 'unknown'] },
];

const CONFIDENCE_BUCKETS: Array<{ id: string; label: string; min: number }> = [
  { id: 'all', label: 'Any', min: 0 },
  { id: 'q30', label: '≥30%', min: 0.3 },
  { id: 'q50', label: '≥50%', min: 0.5 },
  { id: 'q70', label: '≥70%', min: 0.7 },
  { id: 'q90', label: '≥90%', min: 0.9 },
];

interface IssueFilterState {
  facets: Record<string, Set<string>>;
  confidenceMin: number;
}

function makeEmptyFilters(): IssueFilterState {
  const facets: Record<string, Set<string>> = {};
  for (const f of FACET_DEFS) facets[f.id] = new Set();
  return { facets, confidenceMin: 0 };
}

let currentIssueFilters: IssueFilterState = makeEmptyFilters();
let currentIssueData: IssueItem[] = [];

interface IssuesPageContext {
  slug: string;
  tag: string;
  total: number;
}

let currentIssuesPageContext: IssuesPageContext | null = null;
let currentAllStats: AllStats | null = null;
let currentClientPage = 1;

type IssuesPreset = Array<{ facetId: string; value: string }>;
let pendingIssuesPreset: IssuesPreset | null = null;

function getFacetFieldValue(item: IssueItem, field: FacetField): string {
  const v = item[field];
  return v == null ? 'unknown' : String(v);
}

function applyFilters(items: IssueItem[], filters: IssueFilterState): IssueItem[] {
  return items.filter((item) => {
    for (const f of FACET_DEFS) {
      const selected = filters.facets[f.id];
      if (!selected || selected.size === 0) continue;
      const v = getFacetFieldValue(item, f.field);
      if (!selected.has(v)) return false;
    }
    if (filters.confidenceMin > 0 && (item.confidence ?? 0) < filters.confidenceMin) return false;
    return true;
  });
}

function activeFilterCount(filters: IssueFilterState): number {
  let n = 0;
  for (const f of FACET_DEFS) n += filters.facets[f.id]?.size ?? 0;
  if (filters.confidenceMin > 0) n += 1;
  return n;
}

function renderIssueFilters(items: IssueItem[]): void {
  const bar = document.getElementById('issues-filter-bar');
  const row = document.getElementById('filter-row');
  const summary = document.getElementById('filter-summary');
  const clearBtn = document.getElementById('filter-clear') as HTMLButtonElement | null;
  if (!bar || !row || !summary || !clearBtn) return;

  if (items.length === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const allFacets = currentAllStats?.facets;
  const counts: Record<string, Record<string, number>> = {};
  for (const f of FACET_DEFS) {
    if (allFacets?.[f.field]) {
      counts[f.id] = { ...allFacets[f.field]! };
    } else {
      counts[f.id] = Object.fromEntries(f.values.map((v) => [v, 0]));
      for (const item of items) {
        const v = getFacetFieldValue(item, f.field);
        const map = counts[f.id]!;
        if (v in map) map[v] = (map[v] ?? 0) + 1;
      }
    }
  }

  row.innerHTML = '';
  for (const f of FACET_DEFS) {
    const group = document.createElement('div');
    group.className = 'filter-group';
    group.innerHTML = `<span class="filter-group-label">${f.label}</span>`;
    const chips = document.createElement('div');
    chips.className = 'filter-chips';
    for (const v of f.values) {
      const count = counts[f.id]?.[v] ?? 0;
      const active = currentIssueFilters.facets[f.id]?.has(v) ?? false;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `filter-chip${active ? ' active' : ''}${count === 0 ? ' empty' : ''}`;
      btn.dataset.facet = f.id;
      btn.dataset.value = v;
      btn.disabled = count === 0 && !active;
      btn.innerHTML = `<span class="filter-chip-value">${escapeHtml(v)}</span><span class="filter-chip-count">${count}</span>`;
      btn.addEventListener('click', () => toggleFacet(f.id, v));
      chips.appendChild(btn);
    }
    group.appendChild(chips);
    row.appendChild(group);
  }

  const confGroup = document.createElement('div');
  confGroup.className = 'filter-group';
  confGroup.innerHTML = `<span class="filter-group-label">Confidence</span>`;
  const confChips = document.createElement('div');
  confChips.className = 'filter-chips';
  const allConfCounts = allFacets?.['confidence'];
  for (const bucket of CONFIDENCE_BUCKETS) {
    const active = Math.abs(currentIssueFilters.confidenceMin - bucket.min) < 1e-9;
    const matching = allConfCounts?.[bucket.id] ?? items.filter((it) => (it.confidence ?? 0) >= bucket.min).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-chip${active ? ' active' : ''}`;
    btn.disabled = matching === 0 && bucket.min > 0;
    btn.innerHTML = `<span class="filter-chip-value">${bucket.label}</span><span class="filter-chip-count">${matching}</span>`;
    btn.addEventListener('click', () => setConfidenceMin(bucket.min));
    confChips.appendChild(btn);
  }
  confGroup.appendChild(confChips);
  row.appendChild(confGroup);

  const filtered = applyFilters(items, currentIssueFilters);
  const active = activeFilterCount(currentIssueFilters);
  summary.textContent = active === 0
    ? `Showing all ${items.length} issue${items.length === 1 ? '' : 's'}`
    : `Showing ${filtered.length} of ${items.length} issues · ${active} filter${active === 1 ? '' : 's'} active`;
  clearBtn.hidden = active === 0;
  clearBtn.onclick = () => {
    currentIssueFilters = makeEmptyFilters();
    currentClientPage = 1;
    rerenderFilteredIssues();
  };
}

function toggleFacet(facetId: string, value: string): void {
  const set = currentIssueFilters.facets[facetId];
  if (!set) return;
  if (set.has(value)) set.delete(value);
  else set.add(value);
  currentClientPage = 1;
  rerenderFilteredIssues();
}

function setConfidenceMin(min: number): void {
  currentIssueFilters.confidenceMin = min;
  currentClientPage = 1;
  rerenderFilteredIssues();
}

function rerenderFilteredIssues(): void {
  const list = document.getElementById('issues-page-list');
  const capNote = document.getElementById('issues-cap-note');
  if (!list) return;

  renderIssueFilters(currentIssueData);
  const filtered = applyFilters(currentIssueData, currentIssueFilters);
  const totalClientPages = Math.max(1, Math.ceil(filtered.length / ISSUES_PER_PAGE));
  if (currentClientPage > totalClientPages) currentClientPage = 1;

  renderClientPagination(currentClientPage, totalClientPages);

  const activeFilters = activeFilterCount(currentIssueFilters);
  if (capNote) {
    if (filtered.length === 0) {
      capNote.textContent = activeFilters > 0 ? 'No issues match the current filters.' : 'No issues linked to this release yet.';
    } else if (totalClientPages > 1) {
      const start = (currentClientPage - 1) * ISSUES_PER_PAGE + 1;
      const end = Math.min(currentClientPage * ISSUES_PER_PAGE, filtered.length);
      capNote.textContent = activeFilters > 0
        ? `Filtered: ${filtered.length} of ${currentIssueData.length} · page ${currentClientPage}/${totalClientPages} · showing ${start}–${end}`
        : `Page ${currentClientPage} of ${totalClientPages} · showing ${start}–${end} of ${filtered.length}`;
    } else {
      capNote.textContent = activeFilters > 0
        ? `Filtered: ${filtered.length} of ${currentIssueData.length} issue${currentIssueData.length === 1 ? '' : 's'}`
        : `All ${filtered.length} issue${filtered.length === 1 ? '' : 's'}`;
    }
  }

  if (filtered.length === 0) {
    list.innerHTML = '<li class="empty">No issues match the current filters.</li>';
    return;
  }
  const pageStart = (currentClientPage - 1) * ISSUES_PER_PAGE;
  const pageItems = filtered.slice(pageStart, pageStart + ISSUES_PER_PAGE);
  list.innerHTML = '';
  for (const i of pageItems) list.appendChild(renderIssueLi(i, 'full'));
}

// ---------------------------------------------------------------------------

function chip(label: string, value: string | null | undefined, kind: string): string {
  if (!value) return '';
  return `<span class="chip chip-${kind} chip-${kind}-${value}"><span class="chip-label">${escapeHtml(label)}</span><span class="chip-value">${escapeHtml(value)}</span></span>`;
}

function buildAnalysisChips(i: IssueItem): string {
  const parts: string[] = [];
  if (i.sentiment) parts.push(chip('sentiment', i.sentiment, 'sent'));
  if (i.severity) parts.push(chip('severity', i.severity, 'sev'));
  if (i.functionality && i.functionality !== 'unknown') parts.push(chip('area', i.functionality, 'fn'));
  if (i.impact_scope) parts.push(chip('scope', i.impact_scope, 'scope'));
  if (i.affected_user_share && i.affected_user_share !== 'unknown') {
    parts.push(chip('users', i.affected_user_share, 'share'));
  }
  if (i.workaround_status && i.workaround_status !== 'unknown' && i.workaround_status !== 'none') {
    parts.push(chip('workaround', i.workaround_status, 'wa'));
  }
  if (i.duplicate_cluster_size && i.duplicate_cluster_size > 1) {
    parts.push(`<span class="chip chip-dupe"><span class="chip-label">duplicates</span><span class="chip-value">×${i.duplicate_cluster_size}</span></span>`);
  }
  if (typeof i.confidence === 'number' && i.confidence > 0) {
    parts.push(`<span class="chip chip-conf"><span class="chip-label">confidence</span><span class="chip-value">${Math.round(i.confidence * 100)}%</span></span>`);
  }
  return parts.join('');
}

function renderIssueLi(i: IssueItem, mode: 'compact' | 'full'): HTMLElement {
  const li = document.createElement('li');
  li.classList.add(`sentiment-${i.sentiment ?? 'unknown'}`);
  const sentimentIcon = i.sentiment === 'negative' ? '!' : i.sentiment === 'positive' ? '+' : '·';
  if (mode === 'full') {
    const summary = i.summary ? `<div class="issue-summary muted">${escapeHtml(i.summary)}</div>` : '';
    const chips = buildAnalysisChips(i);
    const meta = [
      `${i.comment_count} comment${i.comment_count === 1 ? '' : 's'}`,
      i.user_login ? `by ${escapeHtml(i.user_login)}` : null,
      `${timeAgo(i.created_at)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const chipsHtml = chips ? `<div class="issue-chips">${chips}</div>` : '';
    li.innerHTML = `
      <div class="issue-row-top">
        <span class="issue-num">#${i.number}</span>
        <span class="issue-title"><a href="${i.html_url}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a></span>
        <span class="issue-state">${sentimentIcon} ${escapeHtml(i.state)}</span>
      </div>
      <div class="issue-row-meta muted">${meta}</div>
      ${chipsHtml}
      ${summary}`;
  } else {
    const compactHints = [
      i.severity,
      i.functionality && i.functionality !== 'unknown' ? i.functionality : null,
      i.impact_scope,
    ].filter(Boolean);
    const compactTitle = [i.summary, ...compactHints].filter(Boolean).join(' · ');
    li.innerHTML = `
      <span class="issue-num">#${i.number}</span>
      <span class="issue-title"><a href="${i.html_url}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a></span>
      <span class="issue-state" title="${escapeHtml(compactTitle)}">${sentimentIcon} ${escapeHtml(i.state)}</span>`;
  }
  return li;
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

async function navigateToIssues(
  slug: string,
  tag: string,
  urlMode: 'push' | 'replace' = 'push',
) {
  pushUrl(issuesPath(slug, tag), urlMode);
  await renderIssuesPage(slug, tag);
}

function goToClientPage(page: number): void {
  const filtered = applyFilters(currentIssueData, currentIssueFilters);
  const totalPages = Math.max(1, Math.ceil(filtered.length / ISSUES_PER_PAGE));
  const target = Math.min(Math.max(1, page), totalPages);
  if (target === currentClientPage) return;
  currentClientPage = target;
  rerenderFilteredIssues();
}

async function renderIssuesPage(slug: string, tag: string): Promise<void> {
  setView('issues');
  highlightTab(slug);
  const list = $('#issues-page-list')!;
  const titleEl = $('#issues-title')!;
  const metaEl = $('#issues-meta')!;
  const eyebrowEl = $('#issues-eyebrow')!;
  const countLabel = $('#issues-count-label')!;
  const capNote = $('#issues-cap-note')!;
  const back = $<HTMLAnchorElement>('#issues-back')!;

  currentAllStats = null;
  currentClientPage = 1;
  titleEl.textContent = `Loading ${tag}…`;
  metaEl.textContent = '';
  list.innerHTML = '<li class="muted">Loading issues…</li>';
  countLabel.textContent = 'Related issues';
  capNote.textContent = '';
  back.href = projectPath(slug);
  back.onclick = (e) => {
    e.preventDefault();
    void switchProject(slug);
  };

  let data: VersionIssuesResponse;
  try {
    data = await api<VersionIssuesResponse>(
      `/api/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(tag)}/issues?per_page=${ISSUES_PAGE_CAP}`,
    );
  } catch (err) {
    titleEl.textContent = 'Could not load issues';
    list.innerHTML = `<li class="empty">Failed: ${escapeHtml((err as Error).message)}</li>`;
    renderClientPagination(1, 1);
    return;
  }

  const projectName = data.project?.name ?? slug;
  const releaseDisplay = getReleaseDisplay(data.version);
  eyebrowEl.textContent = `// ${projectName} · ${data.version.tag_name}`;
  titleEl.textContent = `${releaseDisplay.version} — related issues`;
  const subParts: string[] = [];
  if (releaseDisplay.subtitle) subParts.push(releaseDisplay.subtitle);
  subParts.push(`Released ${formatDate(data.version.published_at)} · ${timeAgo(data.version.published_at)}`);
  metaEl.textContent = subParts.join(' · ');

  const total = data.total ?? data.issues_total ?? data.issues.length;
  currentIssuesPageContext = { slug, tag, total };

  const s = data.all_stats;
  if (s && s.total > 0) {
    const parts: string[] = [`<span class="issues-stat-total">${s.total} total</span>`];
    if (s.negative > 0) parts.push(`<span class="issues-negative-count">${s.negative} negative</span>`);
    if (s.positive > 0) parts.push(`<span class="issues-stat-positive">${s.positive} positive</span>`);
    if (s.core > 0) parts.push(`<span class="issues-stat-core">${s.core} core</span>`);
    if (s.niche > 0) parts.push(`<span class="issues-stat-niche">${s.niche} niche</span>`);
    if (s.workarounds > 0) parts.push(`<span class="issues-stat-workarounds">${s.workarounds} workarounds</span>`);
    countLabel.innerHTML = parts.join('');
  } else {
    countLabel.textContent = `${total} issue${total === 1 ? '' : 's'}`;
  }

  currentIssueData = data.issues;
  currentAllStats = data.all_stats ?? null;
  currentIssueFilters = makeEmptyFilters();
  if (pendingIssuesPreset) {
    for (const { facetId, value } of pendingIssuesPreset) {
      currentIssueFilters.facets[facetId]?.add(value);
    }
    pendingIssuesPreset = null;
  }
  rerenderFilteredIssues();
}
function renderClientPagination(page: number, totalPages: number): void {
  const root = document.getElementById('issues-pagination');
  if (!root) return;
  if (totalPages <= 1) { root.hidden = true; root.innerHTML = ''; return; }
  root.hidden = false;
  root.innerHTML = '';

  const make = (label: string, targetPage: number, opts?: { active?: boolean; disabled?: boolean; ariaLabel?: string }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pager-btn${opts?.active ? ' active' : ''}`;
    btn.textContent = label;
    if (opts?.ariaLabel) btn.setAttribute('aria-label', opts.ariaLabel);
    if (opts?.disabled) { btn.disabled = true; }
    else { btn.addEventListener('click', () => goToClientPage(targetPage)); }
    return btn;
  };

  root.appendChild(make('‹ Prev', page - 1, { disabled: page <= 1, ariaLabel: 'Previous page' }));

  const windowSize = 2;
  const lo = Math.max(1, page - windowSize);
  const hi = Math.min(totalPages, page + windowSize);

  if (lo > 1) {
    root.appendChild(make('1', 1));
    if (lo > 2) { const sep = document.createElement('span'); sep.className = 'pager-ellipsis'; sep.textContent = '…'; root.appendChild(sep); }
  }
  for (let p = lo; p <= hi; p++) root.appendChild(make(String(p), p, { active: p === page }));
  if (hi < totalPages) {
    if (hi < totalPages - 1) { const sep = document.createElement('span'); sep.className = 'pager-ellipsis'; sep.textContent = '…'; root.appendChild(sep); }
    root.appendChild(make(String(totalPages), totalPages));
  }

  root.appendChild(make('Next ›', page + 1, { disabled: page >= totalPages, ariaLabel: 'Next page' }));
}

async function rerenderActiveRoute(): Promise<void> {
  const route = parseRoute(location.pathname, location.search, location.hash);
  if (route.kind === 'issues') {
    await renderIssuesPage(route.slug, route.tag);
  } else if (route.kind === 'project') {
    state.currentSlug = route.slug;
    setView('home');
    highlightTab(route.slug);
    await renderProject();
  }
}

window.addEventListener('popstate', () => {
  void handleRoute('replace').then(trackPageView);
});

async function handleRoute(_urlMode: 'push' | 'replace'): Promise<void> {
  const route = parseRoute(location.pathname, location.search, location.hash);
  const projects = state.projectsCache;
  if (!projects) return;
  const known = new Set(projects.projects.map((p) => p.slug));

  if (route.kind === 'issues') {
    const slug = known.has(route.slug) ? route.slug : projects.default;
    state.currentSlug = slug;
    rememberSlug(slug);
    if (slug !== route.slug) {
      pushUrl(projectPath(slug), 'replace', false);
      setView('home');
      highlightTab(slug);
      await renderProject();
      return;
    }
    await renderIssuesPage(slug, route.tag);
    return;
  }

  const desiredSlug =
    route.kind === 'project' && known.has(route.slug)
      ? route.slug
      : route.kind === 'project'
        ? projects.default
        : projects.default;

  state.currentSlug = desiredSlug;
  rememberSlug(desiredSlug);
  if (route.kind !== 'project' || route.slug !== desiredSlug) {
    pushUrl(projectPath(desiredSlug), 'replace', false);
  }
  setView('home');
  highlightTab(desiredSlug);
  await renderProject();
}

async function bootstrap(): Promise<void> {
  initGoogleAnalytics();
  const initialRoute = parseRoute(location.pathname, location.search, location.hash);
  const initialSlug =
    initialRoute.kind === 'project' || initialRoute.kind === 'issues' ? initialRoute.slug : '';

  // Auth + projects list run independently — fire in parallel.
  const authPromise = loadAuth();
  const projectsPromise = api<{ projects: ProjectListItem[]; default: string }>('/api/projects');
  // For project landing, fire detail speculatively; cheap to discard if slug invalid.
  const speculativeDetail =
    initialRoute.kind === 'project' && initialSlug
      ? api<ProjectDetail>(`/api/projects/${encodeURIComponent(initialSlug)}`).catch(() => null)
      : null;

  let projectsData: { projects: ProjectListItem[]; default: string };
  try {
    projectsData = await projectsPromise;
  } catch (err) {
    $('#versions')!.innerHTML = `<div class="empty">Bootstrap failed: ${(err as Error).message}</div>`;
    await authPromise;
    return;
  }
  state.projectsCache = projectsData;

  renderProjectsList(projectsData.projects);

  const known = new Set(projectsData.projects.map((p) => p.slug));

  if (initialRoute.kind === 'issues') {
    const slug = known.has(initialRoute.slug) ? initialRoute.slug : projectsData.default;
    state.currentSlug = slug;
    rememberSlug(slug);
    if (slug !== initialRoute.slug) {
      pushUrl(projectPath(slug), 'replace', false);
      setView('home');
      highlightTab(slug);
      await renderProject();
    } else {
      pushUrl(issuesPath(slug, initialRoute.tag), 'replace', false);
      highlightTab(slug);
      await renderIssuesPage(slug, initialRoute.tag);
    }
    await authPromise;
    trackPageView();
    return;
  }

  const slug = known.has(initialSlug) ? initialSlug : projectsData.default;
  state.currentSlug = slug;
  rememberSlug(slug);
  pushUrl(projectPath(slug), 'replace', false);
  setView('home');
  highlightTab(slug);

  let detail: ProjectDetail | null = null;
  if (speculativeDetail && slug === initialSlug) {
    detail = await speculativeDetail;
  }

  if (detail) {
    applyProjectDetail(detail);
  } else {
    await renderProject();
  }

  await authPromise;
  trackPageView();
}

void bootstrap();
