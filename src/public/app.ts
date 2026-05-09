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
  issues_total: number;
  ratings: Array<{ score: number; comment: string | null; created_at: string }>;
  project?: { slug: string; name: string; github_url: string };
}

interface MeResponse {
  user: { id: number; provider: string; name: string | null; login: string | null; avatar_url: string | null } | null;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

const ISSUES_PER_CARD = 20;
const ISSUES_PAGE_CAP = 200;

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
  | { kind: 'issues'; slug: string; tag: string };

function parseRoute(pathname: string, search: string, hash: string): Route {
  const path = normalizePath(pathname);
  const issuesMatch = path.match(/^\/projects\/([^/]+)\/v\/(.+?)\/issues$/);
  if (issuesMatch) {
    return {
      kind: 'issues',
      slug: decodeURIComponent(issuesMatch[1]!),
      tag: decodeURIComponent(issuesMatch[2]!),
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
  const stable = versions.filter((version) => version.stability.score >= 6).length;
  const issues = versions.reduce((sum, version) => sum + version.stability.breakdown.issueCount, 0);
  const ratings = versions.reduce((sum, version) => sum + version.stability.breakdown.ratingCount, 0);

  const statItems: Array<[string, string]> = [
    ['Average score', tracked ? avgScore.toFixed(1) : '--'],
    ['Stable releases', `${stable}/${tracked}`],
    ['Issue signals', String(issues)],
    ['Community ratings', String(ratings)],
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

function pushUrl(path: string, mode: 'push' | 'replace' = 'push'): void {
  const url = new URL(location.href);
  url.pathname = path;
  url.search = '';
  url.hash = '';
  history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
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

  $('.vc-tag', node)!.textContent = v.tag_name;
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
      `/api/versions/${v.id}/issues?limit=${ISSUES_PER_CARD}`,
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

  const total = data.issues_total ?? data.issues.length;
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

function renderIssueLi(i: IssueItem, mode: 'compact' | 'full'): HTMLElement {
  const li = document.createElement('li');
  li.classList.add(`sentiment-${i.sentiment ?? 'unknown'}`);
  const sentimentIcon = i.sentiment === 'negative' ? '⚠' : i.sentiment === 'positive' ? '✓' : '·';
  if (mode === 'full') {
    const summary = i.summary ? `<div class="issue-summary muted">${escapeHtml(i.summary)}</div>` : '';
    const meta = [
      `${i.comment_count} comment${i.comment_count === 1 ? '' : 's'}`,
      i.user_login ? `by ${escapeHtml(i.user_login)}` : null,
      `${timeAgo(i.created_at)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    li.innerHTML = `
      <div class="issue-row-top">
        <span class="issue-num">#${i.number}</span>
        <span class="issue-title"><a href="${i.html_url}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a></span>
        <span class="issue-state">${sentimentIcon} ${escapeHtml(i.state)}</span>
      </div>
      <div class="issue-row-meta muted">${meta}</div>
      ${summary}`;
  } else {
    li.innerHTML = `
      <span class="issue-num">#${i.number}</span>
      <span class="issue-title"><a href="${i.html_url}" target="_blank" rel="noreferrer">${escapeHtml(i.title)}</a></span>
      <span class="issue-state" title="${escapeHtml(i.summary ?? '')}">${sentimentIcon} ${escapeHtml(i.state)}</span>`;
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

async function navigateToIssues(slug: string, tag: string, urlMode: 'push' | 'replace' = 'push') {
  pushUrl(issuesPath(slug, tag), urlMode);
  await renderIssuesPage(slug, tag);
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
      `/api/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(tag)}/issues?limit=${ISSUES_PAGE_CAP}`,
    );
  } catch (err) {
    titleEl.textContent = 'Could not load issues';
    list.innerHTML = `<li class="empty">Failed: ${escapeHtml((err as Error).message)}</li>`;
    return;
  }

  const projectName = data.project?.name ?? slug;
  eyebrowEl.textContent = `// ${projectName} · ${data.version.tag_name}`;
  titleEl.textContent = `${data.version.tag_name} — related issues`;
  const subParts: string[] = [];
  if (data.version.name && data.version.name !== data.version.tag_name) subParts.push(data.version.name);
  subParts.push(`Released ${formatDate(data.version.published_at)} · ${timeAgo(data.version.published_at)}`);
  metaEl.textContent = subParts.join(' · ');

  const total = data.issues_total ?? data.issues.length;
  countLabel.textContent = `${data.issues.length} issue${data.issues.length === 1 ? '' : 's'}`;
  if (total > data.issues.length) {
    capNote.textContent = `Showing the first ${data.issues.length} of ${total} matched issues (capped at ${ISSUES_PAGE_CAP}).`;
  } else if (total === 0) {
    capNote.textContent = 'No issues are linked to this release yet.';
  } else {
    capNote.textContent = `All ${total} matched issue${total === 1 ? '' : 's'}.`;
  }

  if (data.issues.length === 0) {
    list.innerHTML = '<li class="empty">No issues linked to this release yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const i of data.issues) list.appendChild(renderIssueLi(i, 'full'));
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
  void handleRoute('replace');
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
      pushUrl(projectPath(slug), 'replace');
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
    pushUrl(projectPath(desiredSlug), 'replace');
  }
  setView('home');
  highlightTab(desiredSlug);
  await renderProject();
}

async function bootstrap(): Promise<void> {
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
      pushUrl(projectPath(slug), 'replace');
      setView('home');
      highlightTab(slug);
      await renderProject();
    } else {
      pushUrl(issuesPath(slug, initialRoute.tag), 'replace');
      highlightTab(slug);
      await renderIssuesPage(slug, initialRoute.tag);
    }
    await authPromise;
    return;
  }

  const slug = known.has(initialSlug) ? initialSlug : projectsData.default;
  state.currentSlug = slug;
  rememberSlug(slug);
  pushUrl(projectPath(slug), 'replace');
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
}

void bootstrap();
