/* global io */
const socket = io();

// Re-join the active crawl's room after any (re)connect. A large crawl's
// post-Stop report build can take longer than a transient socket drop, and
// without rejoining we'd miss the `complete` event and the report would never
// render. currentCrawlId is read lazily so this stays correct across crawls.
socket.on('connect', () => {
  if (currentCrawlId) socket.emit('join', currentCrawlId);
});

// ── Theme ──
(function initTheme() {
  const saved = localStorage.getItem('seo-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', () => {
    const sel = document.getElementById('themeSelect');
    if (sel) {
      sel.value = saved;
      sel.addEventListener('change', () => {
        const t = sel.value;
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('seo-theme', t);
      });
    }
  });
})();

// Each tab gets its own crawl ID via sessionStorage so parallel tabs work
let currentCrawlId = sessionStorage.getItem('currentCrawlId') || null;
let analysisData = null;
let pagesData = [];

// Share URL: /share/<crawl-id> just auto-loads the crawl. The viewer is
// already authenticated (the auth middleware redirected them to /login?
// next=/share/<id> first), so they get the same tabs and access as the
// owner — no read-only mode.
const SHARE_MATCH = window.location.pathname.match(/^\/share\/([0-9a-f-]{8,})/i);
const SHARE_ID = SHARE_MATCH ? SHARE_MATCH[1] : null;

function setCurrentCrawlId(id) {
  currentCrawlId = id;
  if (id) sessionStorage.setItem('currentCrawlId', id);
  else sessionStorage.removeItem('currentCrawlId');
}

// ── DOM refs ──
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── Navigation ──
$$('.nav-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const view = link.dataset.view;
    $$('.nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${view}`).classList.add('active');
    // Load saved projects when navigating to that view
    if (view === 'saved-projects') loadSavedProjects();
    if (view === 'gsc') loadGscView();
    if (view === 'strategy') loadStrategyView();
    if (view === 'externallinks') loadExternalLinks();
    if (view === 'notfound') loadNotFoundView();
  });
});

$('#menuToggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
});

// ── Settings dropdown ──
$('#settingsToggle').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#settingsDropdown').classList.toggle('open');
});

// ── "Crawl as" bot preset ──
// Populate from the server so the preset list (and UA strings) live in one
// place; remember the last choice per browser.
(async function initBotPresets() {
  try {
    const presets = await fetch('/api/bot-presets').then(r => r.json());
    const sel = $('#optBotPreset');
    sel.innerHTML = presets.map(p => `<option value="${p.id}">${p.label}</option>`).join('');
    const saved = localStorage.getItem('seo-bot-preset');
    if (saved && presets.some(p => p.id === saved)) sel.value = saved;
    $('#customUaRow').style.display = sel.value === 'custom' ? '' : 'none';
  } catch { /* keep default option */ }
})();
$('#optBotPreset').addEventListener('change', () => {
  const v = $('#optBotPreset').value;
  $('#customUaRow').style.display = v === 'custom' ? '' : 'none';
  localStorage.setItem('seo-bot-preset', v);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.topbar-settings')) {
    $('#settingsDropdown').classList.remove('open');
  }
});

// ── Save Project toggle ──
// Restore per-domain preference when URL input changes
$('#optSaveProject').checked = false; // default unchecked
$('#urlInput').addEventListener('change', () => {
  try {
    const u = new URL($('#urlInput').value.startsWith('http') ? $('#urlInput').value : 'https://' + $('#urlInput').value);
    const saved = localStorage.getItem('seo-save-' + u.hostname);
    $('#optSaveProject').checked = saved === '1';
  } catch { /* ignore */ }
  // If the GSC tab is currently visible, re-evaluate which property matches.
  const gscView = document.getElementById('view-gsc');
  if (gscView && gscView.classList.contains('active') && typeof loadGscView === 'function') {
    loadGscView();
  }
});

// ── Start Crawl ──
let _crawlBotLabel = '';
$('#startCrawl').addEventListener('click', startCrawl);
$('#urlInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') startCrawl(); });

// ── Mode toggle: Spider vs List ──
// Spider (default) = type one URL, crawler discovers from it.
// List = paste/upload a URL list, crawl exactly those URLs (no discovery),
// mirroring Screaming Frog's List mode.
let _crawlMode = 'spider';
let _listUrls = [];

function updateListCount() {
  const el = $('#urlListCount');
  if (el) el.textContent = _listUrls.length === 1 ? '1 URL' : (_listUrls.length.toLocaleString() + ' URLs');
}

// Decode %xx so a URL with diacritics is kept/shown with its real letters
// (…/qualité), not the wire form (…/qualit%C3%A9) the browser puts on the
// clipboard. decodeURI leaves structural reserved chars alone.
function decodeUrlInput(s) { try { return decodeURI(s); } catch { return s; } }

function parseTextareaUrls() {
  const raw = ($('#urlListTextarea').value || '').split(/\r?\n/);
  _listUrls = raw.map(l => decodeUrlInput(l.trim())).filter(l => l && !l.startsWith('#'));
  updateListCount();
}

$$('#modeToggle .mode-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const mode = pill.dataset.mode;
    if (mode === _crawlMode) return;
    _crawlMode = mode;
    $$('#modeToggle .mode-pill').forEach(p => {
      const active = p.dataset.mode === mode;
      p.classList.toggle('active', active);
      p.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (mode === 'list') {
      $('#urlInput').classList.add('hidden');
      $('#urlListInput').classList.remove('hidden');
      parseTextareaUrls();
    } else {
      $('#urlInput').classList.remove('hidden');
      $('#urlListInput').classList.add('hidden');
    }
  });
});

const _urlListTa = $('#urlListTextarea');
if (_urlListTa) {
  _urlListTa.addEventListener('input', parseTextareaUrls);
  // Decode on paste so a copied URL shows its accents (…/qualité) immediately
  // in the box — the same way the browser address bar renders %C3%A9 as é —
  // instead of the raw clipboard form (…/qualit%C3%A9).
  _urlListTa.addEventListener('paste', (e) => {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const text = cd.getData('text');
    if (!text) return;
    e.preventDefault();
    const decoded = text.split(/\r?\n/).map(l => decodeUrlInput(l)).join('\n');
    // Insert at the caret, preserving any text already typed around it.
    const ta = _urlListTa;
    const start = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + decoded + ta.value.slice(end);
    const caret = start + decoded.length;
    ta.setSelectionRange(caret, caret);
    parseTextareaUrls();
  });
}

const _urlListFile = $('#urlListFile');
if (_urlListFile) _urlListFile.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  const type = name.endsWith('.xlsx') || name.endsWith('.xls') ? 'xlsx'
             : name.endsWith('.csv') ? 'csv' : 'txt';
  const countEl = $('#urlListCount');
  if (countEl) countEl.textContent = 'Parsing…';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/parse-url-list?type=' + type, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    // Decode so diacritic URLs from the file show their real letters too.
    _listUrls = (data.urls || []).map(decodeUrlInput);
    // Show parsed URLs in the textarea so the user can review/edit before
    // starting the crawl.
    $('#urlListTextarea').value = _listUrls.join('\n');
    updateListCount();
  } catch (err) {
    alert('Could not parse file: ' + err.message);
    if (countEl) countEl.textContent = '0 URLs';
  }
  // Reset the input so re-selecting the same file fires `change` again.
  e.target.value = '';
});

function renderAll(analysis) {
  renderDashboard(analysis);
  renderAllPages(pagesData);
  // Issues tab removed
  renderHreflang(analysis);
  renderCanonicals(analysis);
  renderConflicts(analysis);
  renderRedirects(analysis);
  renderContent(analysis);
  renderImages(analysis);
  renderStructuredData(analysis);
  renderSecurity(analysis);
  renderInternalLinks(analysis);
  renderAiBots(analysis);
  renderSearchEngines(analysis);
  renderSitemaps(analysis);
  renderStatusCodes(analysis);
  renderAnchors(analysis);
  renderMetaTitles(analysis);
  renderMetaDescriptions(analysis);
  renderHeadings(analysis);
  renderDirectives(analysis);
  renderSummary(analysis);
}

async function startCrawl() {
  // List mode: use the parsed URL list; Spider mode: single URL from the input.
  if (_crawlMode === 'list') parseTextareaUrls();
  const url = $('#urlInput').value.trim();
  if (_crawlMode === 'list') {
    if (_listUrls.length === 0) return alert('Paste or upload at least one URL.');
  } else {
    if (!url) return;
  }

  const saveProject = $('#optSaveProject').checked;
  const botPreset = $('#optBotPreset').value || 'default';
  const body = {
    maxPages: parseInt($('#optMaxPages').value) || 500,
    maxDepth: parseInt($('#optMaxDepth').value) || 10,
    concurrency: parseInt($('#optConcurrency').value) || 5,
    respectRobots: $('#optRobots').checked,
    botPreset,
    userAgent: botPreset === 'custom' ? ($('#optUserAgent').value || undefined) : undefined,
    saveProject
  };
  if (_crawlMode === 'list') body.urls = _listUrls;
  else body.url = url;

  // Persist save preference per domain (use first URL for list mode).
  try {
    const seed = _crawlMode === 'list' ? _listUrls[0] : url;
    const u = new URL(seed.startsWith('http') ? seed : 'https://' + seed);
    localStorage.setItem('seo-save-' + u.hostname, saveProject ? '1' : '0');
  } catch { /* ignore */ }

  try {
    const res = await fetch('/api/crawls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) return alert(data.error);

    _crawlBotLabel = data.botLabel || '';
    setCurrentCrawlId(data.id);
    pagesData = [];
    analysisData = null;
    // Reset per-crawl cached datasets so tabs don't show the previous crawl
    _nfData = null;
    _imgAssetsData = null;
    _extLinksData = null;

    socket.emit('join', currentCrawlId);

    // UI state
    $('#startCrawl').classList.add('hidden');
    $('#stopCrawl').classList.remove('hidden');
    $('#pauseCrawl').classList.remove('hidden');
    $('#resumeCrawl').classList.add('hidden');
    $('#progressContainer').classList.remove('hidden');
    $('#liveFeed').classList.remove('hidden');
    $('#liveFeedItems').innerHTML = '';
    $('#emptyState').classList.add('hidden');
    $('#dashboardContent').classList.remove('hidden');
    $('#dashboardContent').innerHTML = '<p style="color:var(--text-muted)">Crawling in progress...</p>';
    $('#progressFill').style.width = '0%';

    // Navigate to dashboard
    $$('.nav-link').forEach(l => l.classList.remove('active'));
    $('[data-view="dashboard"]').classList.add('active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $('#view-dashboard').classList.add('active');
  } catch (e) {
    alert('Failed to start crawl: ' + e.message);
  }
}

// Stop / Pause / Resume
$('#stopCrawl').addEventListener('click', async () => {
  if (!currentCrawlId) return;
  // Don't tear the UI down — the server finishes the in-flight pages, builds
  // the report from everything crawled so far, and emits `complete` (handled
  // below) which renders the full dashboard. Show a building state meanwhile
  // so large crawls don't look frozen.
  $('#stopCrawl').disabled = true;
  $('#pauseCrawl').classList.add('hidden');
  $('#progressText').textContent = 'Building report from crawled pages…';
  const fill = $('#progressFill');
  if (fill) fill.classList.add('indeterminate');
  try {
    await fetch(`/api/crawls/${currentCrawlId}/abort`, { method: 'POST' });
  } catch {
    $('#stopCrawl').disabled = false;
  }
});

$('#pauseCrawl').addEventListener('click', async () => {
  if (!currentCrawlId) return;
  await fetch(`/api/crawls/${currentCrawlId}/pause`, { method: 'POST' });
  $('#pauseCrawl').classList.add('hidden');
  $('#resumeCrawl').classList.remove('hidden');
  $('#progressText').textContent = 'Paused';
});

$('#resumeCrawl').addEventListener('click', async () => {
  if (!currentCrawlId) return;
  await fetch(`/api/crawls/${currentCrawlId}/resume`, { method: 'POST' });
  $('#resumeCrawl').classList.add('hidden');
  $('#pauseCrawl').classList.remove('hidden');
  $('#progressText').textContent = 'Crawling...';
});

function resetCrawlUI() {
  $('#startCrawl').classList.remove('hidden');
  $('#stopCrawl').classList.add('hidden');
  $('#stopCrawl').disabled = false;
  $('#pauseCrawl').classList.add('hidden');
  $('#resumeCrawl').classList.add('hidden');
  $('#progressContainer').classList.add('hidden');
  $('#liveFeed').classList.add('hidden');
  const fill = $('#progressFill');
  if (fill) fill.classList.remove('indeterminate');
}

// ── Socket events ──
socket.on('progress', (data) => {
  const pct = data.total > 0 ? ((data.crawled / Math.min(data.total, parseInt($('#optMaxPages').value) || 500)) * 100).toFixed(1) : 0;
  $('#progressFill').style.width = `${Math.min(pct, 100)}%`;
  $('#progressText').textContent = `Crawling${_crawlBotLabel && _crawlBotLabel !== 'SEO Tool (default browser UA)' ? ' as ' + _crawlBotLabel : ''}... ${data.crawled} pages`;
  $('#progressStats').textContent = `${data.pagesPerSecond.toFixed(1)} pages/s | Queue: ${data.queued} | Errors: ${data.errors} | Elapsed: ${(data.elapsed / 1000).toFixed(0)}s`;
});

socket.on('page', (page) => {
  pagesData.push(page);
  // Live feed
  const feed = $('#liveFeedItems');
  if (feed) {
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = `
      <span class="feed-status">${statusBadge(page.statusCode)}</span>
      <span class="feed-url" title="${esc(prettyUrl(page.url))}">${esc(prettyUrl(page.url))}</span>
      <span class="feed-time">${page.responseTime || 0}ms</span>
    `;
    feed.prepend(item);
    // Keep max 200 items visible
    while (feed.children.length > 200) feed.removeChild(feed.lastChild);
    // Update count
    const countEl = $('#liveFeedCount');
    if (countEl) countEl.textContent = `${pagesData.length} pages scanned`;
  }
});

// Crawl phase finished (Stop, or naturally hitting maxPages) — server is now
// building the report. Switch the UI out of "Crawling…" so it doesn't look
// frozen while the analyzer runs; `complete` follows when it's ready.
socket.on('building', () => {
  $('#stopCrawl').disabled = true;
  $('#pauseCrawl').classList.add('hidden');
  $('#resumeCrawl').classList.add('hidden');
  $('#progressText').textContent = 'Building report from crawled pages…';
  const fill = $('#progressFill');
  if (fill) fill.classList.add('indeterminate');
  const body = $('#dashboardContent');
  if (body && /Crawling in progress/i.test(body.innerHTML)) {
    body.innerHTML = '<p style="color:var(--text-muted)">Building report from crawled pages… this can take a moment for large crawls.</p>';
  }
});

socket.on('complete', async (data) => {
  resetCrawlUI();
  // WAF wall: the crawler stopped itself because ~every request was being
  // challenged — tell the user immediately, before they dig into the report
  if (data && data.stats && data.stats.challengeAborted) {
    alert(`Crawl stopped early after ${data.stats.challengeAbortAfter} pages: ${data.stats.challengeAbortVendor} bot protection is challenging every request from the crawler's IP.\n\nWait for the WAF flag to decay (usually minutes to a few hours) or allowlist the "SEOAuditCrawler" user agent in the site's WAF, then re-crawl.`);
  }
  // The analysis is no longer sent over the socket (it can be tens of MB and
  // socket.io drops messages >1 MB). Fetch the persisted report over HTTP —
  // it's served instantly from the server-side cache and gzipped. Reuse
  // loadCrawl() so the render sequence stays in one place.
  const id = currentCrawlId;
  if (!id) return;
  try {
    await window.loadCrawl(id);
  } catch (e) {
    const body = $('#dashboardContent');
    if (body) body.innerHTML = '<p style="color:var(--danger)">Report built but failed to load: ' + esc(e.message) + '. Try reloading the page.</p>';
    return;
  }
  // Load project history if save is enabled
  if ($('#optSaveProject') && $('#optSaveProject').checked) {
    loadProjectHistory();
  }
});

socket.on('error', (data) => {
  resetCrawlUI();
  alert('Crawl error: ' + data.message);
});

// ── Export ──
$$('.export-menu a').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    if (!currentCrawlId) return alert('No crawl data to export');
    if (a.dataset.format === 'pdf') {
      window.open(`/api/crawls/${currentCrawlId}/export-pdf`, '_blank');
    } else if (a.dataset.format === 'xlsx-filtered') {
      exportFilteredPages();
    } else {
      window.location.href = `/api/crawls/${currentCrawlId}/export/${a.dataset.format}`;
    }
  });
});

// ── Render Dashboard ──
function renderDashboard(stats, analysis) {
  const o = analysis.overview;
  // Share strip — shown on every dashboard. Anyone viewing the audit
  // can copy the link and forward it; recipients log in once and land
  // back on this exact URL.
  const shareStrip = `
    <div class="share-strip" style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;margin-bottom:16px;font-size:13px">
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--primary);flex-shrink:0"><circle cx="13" cy="5" r="2"/><circle cx="5" cy="9" r="2"/><circle cx="13" cy="13" r="2"/><path d="M6.5 8L11 6M6.5 10L11 12"/></svg>
      <span style="color:var(--text-muted)">Share this audit with a unique read-only link.</span>
      <code id="shareUrl" style="background:var(--bg-input);padding:4px 8px;border-radius:4px;font-size:12px;color:var(--text);user-select:all;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${window.location.origin}/share/${currentCrawlId}</code>
      <button id="shareCopyBtn" class="btn btn-secondary" style="padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0">Copy link</button>
    </div>`;
  const html = `${shareStrip}
    <div class="stats-grid">
      ${statCard('Pages Crawled', o.totalUrlsCrawled, '')}
      ${statCard('HTML Pages', o.htmlPages, 'info')}
      ${statCard('2xx Success', o.status2xx, 'success')}
      ${statCard('3xx Redirects', o.status3xx, 'warning')}
      ${statCard('4xx Errors', o.status4xx, 'danger')}
      ${statCard('5xx Server Errors', o.status5xx, 'danger')}
      ${statCard('Avg Response', o.avgResponseTime + 'ms', o.avgResponseTime > 2000 ? 'danger' : o.avgResponseTime > 1000 ? 'warning' : 'success')}
      ${statCard('Avg Word Count', o.avgWordCount, o.avgWordCount < 300 ? 'warning' : '')}
      ${statCard('With Hreflangs', o.pagesWithHreflangs, 'info')}
      ${statCard('With Canonical', o.pagesWithCanonical, 'info')}
      ${statCard('In Sitemap', o.pagesInSitemap, 'success')}
      ${statCard('Not In Sitemap', o.pagesNotInSitemap, o.pagesNotInSitemap > 0 ? 'warning' : 'success')}
      ${statCard('Structured Data', o.pagesWithStructuredData, 'info')}
      ${(() => { const ia = analysis.imageAnalysis || {}; const total = (ia.missingAlt || 0) + (ia.emptyAlt || 0); return statCard('Images Alt Issues', total, total > 0 ? 'warning' : 'success'); })()}
      ${statCard('Blocked by Robots', o.blockedByRobots, o.blockedByRobots > 0 ? 'warning' : '')}
      ${statCard('Connection Errors', o.errors, o.errors > 0 ? 'danger' : 'success')}
    </div>

    <div class="section-card">
      <h3>Issues Overview</h3>
      <div class="issues-summary">
        ${issueCountCard(analysis.issues.filter(i => i.severity === 'critical').length, 'Critical', 'danger')}
        ${issueCountCard(analysis.issues.filter(i => i.severity === 'warning').length, 'Warnings', 'warning')}
        ${issueCountCard(analysis.issues.filter(i => i.severity === 'error').length, 'Errors', 'danger')}
        ${issueCountCard(analysis.issues.filter(i => i.severity === 'info').length, 'Info', 'info')}
      </div>
      ${renderIssueCategories(analysis.issues)}
    </div>

    ${analysis.hreflangCanonicalConflicts.totalConflicts > 0 ? `
    <div class="section-card" style="border-left:4px solid var(--danger)">
      <h3>Hreflang vs Canonical Conflicts: ${analysis.hreflangCanonicalConflicts.totalConflicts}</h3>
      <p style="color:var(--text-muted);margin-bottom:12px">${analysis.hreflangCanonicalConflicts.totalPagesWithConflicts} page(s) have conflicts between hreflang and canonical tags. See "Hreflang vs Canonical" tab for details.</p>
    </div>
    ` : ''}

    <div class="section-card">
      <h3>Status Code Distribution</h3>
      ${renderStatusBars(analysis.statusCodeBreakdown)}
    </div>
  `;
  $('#dashboardContent').innerHTML = html;

  const copyBtn = document.getElementById('shareCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const url = `${window.location.origin}/share/${currentCrawlId}`;
      try {
        await navigator.clipboard.writeText(url);
        const orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied ✓';
        copyBtn.style.background = 'rgba(22,163,74,0.12)';
        copyBtn.style.color = 'var(--success)';
        setTimeout(() => {
          copyBtn.textContent = orig;
          copyBtn.style.background = 'var(--bg-input)';
          copyBtn.style.color = 'var(--text)';
        }, 1800);
      } catch {
        prompt('Copy this URL:', url);
      }
    });
  }
}

async function loadProjectHistory() {
  try {
    const urlVal = $('#urlInput').value.trim();
    const u = new URL(urlVal.startsWith('http') ? urlVal : 'https://' + urlVal);
    const domain = u.hostname;
    const res = await fetch(`/api/projects/${encodeURIComponent(domain)}/history`);
    if (!res.ok) return;
    const crawls = await res.json();

    if (crawls.length === 0) return;

    const current = crawls[0];
    if (!current.stats) return;
    const previous = crawls.length >= 2 ? crawls[1] : null;

    const cs = current.stats;
    const ps = previous ? previous.stats : null;

    const el = document.getElementById('projectHistory');
    if (el) el.remove();

    const div = document.createElement('div');
    div.id = 'projectHistory';
    div.className = 'section-card';
    div.style.borderLeft = '4px solid var(--info)';

    const curDate = new Date(current.completed_at || current.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    if (!previous || !ps) {
      // Only 1 crawl saved — show info, no comparison
      div.innerHTML = `
        <h3>Saved Project</h3>
        <p style="color:var(--text-muted);margin-bottom:8px;font-size:13px">1 crawl saved (${curDate}). Run another crawl with <strong>Save Project</strong> enabled to see evolution.</p>
      `;
    } else {
      const delta = (cur, prev, label, inverse = false) => {
        const diff = (cur || 0) - (prev || 0);
        if (diff === 0) return `<td>${cur || 0}</td><td style="color:var(--text-muted)">—</td>`;
        const good = inverse ? diff < 0 : diff > 0;
        const color = good ? 'var(--success)' : 'var(--danger)';
        const arrow = diff > 0 ? '&#9650;' : '&#9660;';
        return `<td>${cur || 0}</td><td style="color:${color};font-weight:600">${arrow} ${Math.abs(diff)}</td>`;
      };

      const prevDate = new Date(previous.completed_at || previous.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

      div.innerHTML = `
        <h3>Evolution vs Previous Crawl</h3>
        <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">Comparing <strong>${curDate}</strong> with <strong>${prevDate}</strong> &middot; ${crawls.length} total crawl(s) saved</p>
        <table>
          <thead><tr><th>Metric</th><th>Current</th><th>Change</th><th>Previous</th></tr></thead>
          <tbody>
            <tr><td>Pages Crawled</td>${delta(cs.pagesDiscovered || cs.crawled, ps.pagesDiscovered || ps.crawled)}<td>${ps.pagesDiscovered || ps.crawled || 0}</td></tr>
            <tr><td>Pages Crawled (fetched)</td>${delta(cs.crawled, ps.crawled)}<td>${ps.crawled || 0}</td></tr>
            <tr><td>2xx Responses</td>${delta(cs.status2xx, ps.status2xx)}<td>${ps.status2xx || 0}</td></tr>
            <tr><td>3xx Redirects</td>${delta(cs.status3xx, ps.status3xx, null, true)}<td>${ps.status3xx || 0}</td></tr>
            <tr><td>4xx Errors</td>${delta(cs.status4xx, ps.status4xx, null, true)}<td>${ps.status4xx || 0}</td></tr>
            <tr><td>5xx Errors</td>${delta(cs.status5xx, ps.status5xx, null, true)}<td>${ps.status5xx || 0}</td></tr>
            <tr><td>Blocked by Robots</td>${delta(cs.blockedByRobots, ps.blockedByRobots, null, true)}<td>${ps.blockedByRobots || 0}</td></tr>
            <tr><td>Connection Errors</td>${delta(cs.errors, ps.errors, null, true)}<td>${ps.errors || 0}</td></tr>
          </tbody>
        </table>
      `;
    }

    // Always show all crawls list if there are any
    if (crawls.length > 1) {
      div.innerHTML += `
        <details style="margin-top:12px"${crawls.length <= 3 ? ' open' : ''}><summary style="cursor:pointer;color:var(--primary);font-size:13px;font-weight:600">View all ${crawls.length} crawls</summary>
        <table style="margin-top:8px">
          <thead><tr><th>Date</th><th>Pages</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th><th>Actions</th></tr></thead>
          <tbody>${crawls.map(c => {
            const s = c.stats || {};
            const d = new Date(c.completed_at || c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `<tr>
              <td>${d}</td>
              <td>${s.crawled || 0}</td>
              <td>${s.status2xx || 0}</td>
              <td>${s.status3xx || 0}</td>
              <td>${s.status4xx || 0}</td>
              <td>${s.status5xx || 0}</td>
              <td><a href="#" onclick="loadCrawl('${c.id}');return false" style="color:var(--primary);font-size:12px">Load</a></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        </details>`;
    }

    $('#dashboardContent').appendChild(div);
  } catch (e) { /* ignore history errors */ }
}

async function loadSavedProjects() {
  const container = $('#savedProjectsContent');
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) { container.innerHTML = '<p style="color:var(--text-muted);padding:20px">Could not load saved projects.</p>'; return; }
    const projects = await res.json();

    if (projects.length === 0) {
      container.innerHTML = `
        <div class="section-card" style="text-align:center;padding:40px">
          <svg width="48" height="48" fill="none" stroke="var(--text-muted)" stroke-width="1.5" style="margin-bottom:12px"><path d="M6 10a4 4 0 014-4h6l4 4h8a4 4 0 014 4v14a4 4 0 01-4 4H10a4 4 0 01-4-4V10z"/></svg>
          <h3 style="color:var(--text-muted);margin-bottom:8px">No Saved Projects Yet</h3>
          <p style="color:var(--text-muted);max-width:400px;margin:0 auto;line-height:1.6">
            To save a project, enable the <strong>"Save Project"</strong> toggle in the settings panel before starting a crawl.
            Saved projects let you track SEO evolution over time by comparing crawls.
          </p>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="stats-grid" style="margin-bottom:20px">
        ${statCard('SAVED DOMAINS', projects.length, '')}
        ${statCard('TOTAL CRAWLS', projects.reduce((s, p) => s + p.crawl_count, 0), '')}
      </div>
      <div id="savedProjectsList"></div>`;

    const list = $('#savedProjectsList');

    for (const project of projects) {
      const card = document.createElement('div');
      card.className = 'section-card';
      card.style.marginBottom = '16px';

      const lastDate = new Date(project.last_crawl).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const firstDate = new Date(project.first_crawl).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div>
            <h3 style="margin:0;font-size:16px">${project.domain}</h3>
            <p style="color:var(--text-muted);font-size:12px;margin:4px 0 0">${project.crawl_count} crawl(s) &middot; First: ${firstDate} &middot; Last: ${lastDate}</p>
          </div>
          <button class="btn btn-primary" style="font-size:12px;padding:6px 14px" onclick="expandProject('${project.domain}', this.closest('.section-card'))">View History</button>
        </div>
        <div class="project-history-detail"></div>`;

      list.appendChild(card);
    }
  } catch (e) {
    container.innerHTML = '<p style="color:var(--danger);padding:20px">Error loading saved projects: ' + e.message + '</p>';
  }
}

window.expandProject = async function(domain, card) {
  const detail = card.querySelector('.project-history-detail');
  if (detail.dataset.loaded) {
    detail.style.display = detail.style.display === 'none' ? '' : 'none';
    return;
  }

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(domain)}/history`);
    if (!res.ok) return;
    const crawls = await res.json();

    if (crawls.length === 0) {
      detail.innerHTML = '<p style="color:var(--text-muted)">No completed crawls found.</p>';
      detail.dataset.loaded = '1';
      return;
    }

    let html = `<table>
      <thead><tr><th>Date</th><th>URL</th><th>Pages</th><th>2xx</th><th>3xx</th><th>4xx</th><th>5xx</th><th>Errors</th><th>Actions</th></tr></thead>
      <tbody>`;

    for (const c of crawls) {
      const s = c.stats ? (typeof c.stats === 'string' ? JSON.parse(c.stats) : c.stats) : {};
      const d = new Date(c.completed_at || c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      html += `<tr>
        <td>${d}</td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${c.url}">${c.url}</td>
        <td>${s.crawled || s.pagesDiscovered || 0}</td>
        <td style="color:var(--success)">${s.status2xx || 0}</td>
        <td style="color:var(--warning)">${s.status3xx || 0}</td>
        <td style="color:var(--danger)">${s.status4xx || 0}</td>
        <td style="color:var(--danger)">${s.status5xx || 0}</td>
        <td>${s.errors || 0}</td>
        <td><a href="#" onclick="loadCrawl('${c.id}');return false" style="color:var(--primary);font-weight:600;font-size:12px">Load</a></td>
      </tr>`;
    }

    html += '</tbody></table>';

    // Evolution comparison if 2+ crawls
    if (crawls.length >= 2) {
      const cur = crawls[0].stats ? (typeof crawls[0].stats === 'string' ? JSON.parse(crawls[0].stats) : crawls[0].stats) : {};
      const prev = crawls[1].stats ? (typeof crawls[1].stats === 'string' ? JSON.parse(crawls[1].stats) : crawls[1].stats) : {};
      const diffCell = (c, p, inv = false) => {
        const cv = c || 0, pv = p || 0, diff = cv - pv;
        const badge = diff === 0
          ? `<span style="color:var(--text-muted);font-size:11px">—</span>`
          : (() => { const good = inv ? diff < 0 : diff > 0; return `<span style="color:var(--${good?'success':'danger'});font-size:11px;font-weight:700">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}</span>`; })();
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px"><span style="font-size:13px;font-weight:600">${cv}</span>${badge}</div>`;
      };
      const noData = (label) => `<div style="display:flex;flex-direction:column;align-items:center;gap:2px"><span style="font-size:12px;color:var(--text-muted)">—</span><span style="font-size:10px;color:var(--text-muted)">no data</span></div>`;
      const hasIssueData = cur.missingTitles !== undefined || cur.missingDescriptions !== undefined;
      html += `<div style="margin-top:16px;background:var(--bg-tertiary);border-radius:10px;padding:16px">
        <div style="font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Latest vs Previous Crawl</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px">
          ${[
            ['Pages', cur.crawled, prev.crawled, false],
            ['2xx', cur.status2xx, prev.status2xx, false],
            ['3xx', cur.status3xx, prev.status3xx, true],
            ['4xx', cur.status4xx, prev.status4xx, true],
            ['5xx', cur.status5xx, prev.status5xx, true],
            ['Errors', cur.errors, prev.errors, true],
          ].map(([label, c, p, inv]) => `<div style="background:var(--bg-card);border-radius:8px;padding:10px 8px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${label}</div>
            ${diffCell(c, p, inv)}
          </div>`).join('')}
        </div>
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 10px">SEO Issues</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px">
          ${[
            ['Missing Titles', cur.missingTitles, prev.missingTitles, true],
            ['Duplicate Titles', cur.duplicateTitles, prev.duplicateTitles, true],
            ['Missing Desc.', cur.missingDescriptions, prev.missingDescriptions, true],
            ['Duplicate Desc.', cur.duplicateDescriptions, prev.duplicateDescriptions, true],
            ['Hreflang Issues', cur.hreflangIssues, prev.hreflangIssues, true],
            ['Missing Canonicals', cur.missingCanonicals, prev.missingCanonicals, true],
            ['Image Alt Issues', cur.imagesWithAltIssues, prev.imagesWithAltIssues, true],
            ['Critical Issues', cur.criticalIssues, prev.criticalIssues, true],
            ['Warnings', cur.warnings, prev.warnings, true],
          ].map(([label, c, p, inv]) => `<div style="background:var(--bg-card);border-radius:8px;padding:10px 8px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${label}</div>
            ${c === undefined && p === undefined ? noData(label) : diffCell(c, p, inv)}
          </div>`).join('')}
        </div>
        ${!hasIssueData ? '<p style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:center">SEO issue metrics will appear after the next crawl completes.</p>' : ''}
      </div>`;
    }

    detail.innerHTML = html;
    detail.dataset.loaded = '1';
  } catch (e) {
    detail.innerHTML = '<p style="color:var(--danger)">Error loading history.</p>';
  }
};

function statCard(label, value, colorClass) {
  return `<div class="stat-card"><div class="label">${label}</div><div class="value ${colorClass}">${value}</div></div>`;
}

function issueCountCard(count, label, color) {
  return `<div class="issue-count-card"><div class="count" style="color:var(--${color})">${count}</div><div class="label">${label}</div></div>`;
}

function renderIssueCategories(issues) {
  const cats = {};
  issues.forEach(i => { cats[i.category] = (cats[i.category] || 0) + 1; });
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] || 1;
  return '<div class="bar-chart">' + sorted.map(([cat, count]) =>
    `<div class="bar-item"><span class="bar-label">${cat}</span><div class="bar-track"><div class="bar-fill warning" style="width:${(count/max*100).toFixed(0)}%">${count}</div></div></div>`
  ).join('') + '</div>';
}

function renderStatusBars(breakdown) {
  const entries = Object.entries(breakdown).sort((a, b) => a[0] - b[0]);
  const max = Math.max(...entries.map(e => e[1].length));
  return '<div class="bar-chart">' + entries.map(([code, urls]) => {
    const color = code >= 500 ? 'danger' : code >= 400 ? 'danger' : code >= 300 ? 'warning' : code >= 200 ? 'success' : 'info';
    return `<div class="bar-item"><span class="bar-label">${code} (${urls.length})</span><div class="bar-track"><div class="bar-fill ${color}" style="width:${(urls.length/max*100).toFixed(0)}%">${urls.length}</div></div></div>`;
  }).join('') + '</div>';
}

// ── Pages table ──
async function loadPages() {
  if (!currentCrawlId) return;
  // Lite projection = every crawled page (no 5k cap) without the heavy
  // link/image blobs, so the list reflects the true total. Detail is fetched
  // on row click.
  const res = await fetch(`/api/crawls/${currentCrawlId}/pages?fields=lite`);
  const allPages = await res.json();
  // Filter out non-HTML resources (images, CSS, JS, fonts, etc.)
  pagesData = allPages.filter(p => {
    const ct = (p.content_type || '').toLowerCase();
    const url = (p.url || '').toLowerCase();
    if (ct && !ct.includes('html') && !ct.includes('xml')) return false;
    if (/\.(jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?|css|js|woff2?|ttf|eot|mp4|mp3|pdf|zip|gz)(\?|#|$)/i.test(url)) return false;
    return true;
  });
  renderPagesTable(pagesData);
}

// Sort state for All Pages table
let _sortCol = null, _sortDir = 'asc';
function sortPages(col) {
  if (_sortCol === col) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
  else { _sortCol = col; _sortDir = 'asc'; }
  if (pagesData.length) renderPagesTable(pagesData);
}

// Build duplicate lookup maps for filtering
let _titleDups = new Set(), _descDups = new Set();
function isNoindexPage(p) {
  return (p.meta_robots || '').toLowerCase().includes('noindex');
}
function buildDupMaps(pages) {
  const tc = {}, dc = {};
  for (const p of pages) {
    if (p.status_code >= 300) continue;
    if (isNoindexPage(p)) continue;
    if (p.title) { const k = p.title.trim().toLowerCase(); tc[k] = (tc[k]||0)+1; }
    if (p.meta_description) { const k = p.meta_description.trim().toLowerCase(); dc[k] = (dc[k]||0)+1; }
  }
  _titleDups = new Set(Object.keys(tc).filter(k => tc[k] > 1));
  _descDups = new Set(Object.keys(dc).filter(k => dc[k] > 1));
}

function renderPagesTable(pages) {
  buildDupMaps(pages);
  const filter = ($('#pagesFilter')?.value || '').toLowerCase();
  const sf = $('#pagesStatusFilter')?.value || '';
  const tf = $('#pagesTitleFilter')?.value || '';
  const df = $('#pagesDescFilter')?.value || '';
  const dirf = $('#pagesDirectiveFilter')?.value || '';
  const cf = $('#pagesCanonicalFilter')?.value || '';
  const h1f = $('#pagesH1Filter')?.value || '';
  const wf = $('#pagesWordFilter')?.value || '';
  const hlf = $('#pagesHreflangFilter')?.value || '';

  let filtered = pages;
  if (filter) filtered = filtered.filter(p => (p.url||'').toLowerCase().includes(filter));

  // Status filter
  if (sf === '2xx') filtered = filtered.filter(p => p.status_code >= 200 && p.status_code < 300);
  else if (sf === '3xx') filtered = filtered.filter(p => p.status_code >= 300 && p.status_code < 400);
  else if (sf === '4xx') filtered = filtered.filter(p => p.status_code >= 400 && p.status_code < 500);
  else if (sf === '5xx') filtered = filtered.filter(p => p.status_code >= 500);
  else if (sf) filtered = filtered.filter(p => String(p.status_code) === sf);

  // Title filter (exclude noindex pages from all title issue filters)
  if (tf === 'missing') filtered = filtered.filter(p => !p.title && p.status_code < 300 && !isNoindexPage(p));
  else if (tf === 'short') filtered = filtered.filter(p => p.title && (p.title_length||0) < 30 && !isNoindexPage(p));
  else if (tf === 'long') filtered = filtered.filter(p => p.title && (p.title_length||0) > 60 && !isNoindexPage(p));
  else if (tf === 'optimal') filtered = filtered.filter(p => p.title && (p.title_length||0) >= 30 && (p.title_length||0) <= 60 && !isNoindexPage(p));
  else if (tf === 'duplicate') filtered = filtered.filter(p => p.title && _titleDups.has(p.title.trim().toLowerCase()) && !isNoindexPage(p));

  // Desc filter (exclude noindex pages from all description issue filters)
  if (df === 'missing') filtered = filtered.filter(p => !p.meta_description && p.status_code < 300 && !isNoindexPage(p));
  else if (df === 'short') filtered = filtered.filter(p => p.meta_description && (p.meta_description_length||0) < 70 && !isNoindexPage(p));
  else if (df === 'long') filtered = filtered.filter(p => p.meta_description && (p.meta_description_length||0) > 160 && !isNoindexPage(p));
  else if (df === 'optimal') filtered = filtered.filter(p => p.meta_description && (p.meta_description_length||0) >= 70 && (p.meta_description_length||0) <= 160 && !isNoindexPage(p));
  else if (df === 'duplicate') filtered = filtered.filter(p => p.meta_description && _descDups.has(p.meta_description.trim().toLowerCase()) && !isNoindexPage(p));

  // Directives filter
  if (dirf === 'noindex') filtered = filtered.filter(p => (p.meta_robots||'').toLowerCase().includes('noindex'));
  else if (dirf === 'nofollow') filtered = filtered.filter(p => (p.meta_robots||'').toLowerCase().includes('nofollow'));
  else if (dirf === 'index') filtered = filtered.filter(p => !(p.meta_robots||'').toLowerCase().includes('noindex'));

  // Canonical filter
  if (cf === 'self') filtered = filtered.filter(p => p.canonical_is_self);
  else if (cf === 'other') filtered = filtered.filter(p => p.canonical && !p.canonical_is_self);
  else if (cf === 'missing') filtered = filtered.filter(p => !p.canonical && p.status_code < 300);

  // H1 filter
  if (h1f === 'missing') filtered = filtered.filter(p => (p.h1_count || 0) === 0 && p.status_code < 300);
  else if (h1f === 'multiple') filtered = filtered.filter(p => (p.h1_count || 0) > 1);
  else if (h1f === 'single') filtered = filtered.filter(p => (p.h1_count || 0) === 1);

  // Word count filter
  if (wf === 'thin') filtered = filtered.filter(p => (p.word_count || 0) < 300 && p.status_code < 300);
  else if (wf === 'short') filtered = filtered.filter(p => (p.word_count || 0) >= 300 && (p.word_count || 0) < 600);
  else if (wf === 'medium') filtered = filtered.filter(p => (p.word_count || 0) >= 600 && (p.word_count || 0) < 1500);
  else if (wf === 'long') filtered = filtered.filter(p => (p.word_count || 0) >= 1500);

  // Hreflang filter
  if (hlf === 'has') filtered = filtered.filter(p => { try { return JSON.parse(p.hreflangs || '[]').length > 0; } catch { return false; } });
  else if (hlf === 'none') filtered = filtered.filter(p => { try { return JSON.parse(p.hreflangs || '[]').length === 0; } catch { return true; } });

  // Sort
  if (_sortCol) {
    const colMap = { url:'url', status:'status_code', title:'title', titlelen:'title_length', desc:'meta_description', desclen:'meta_description_length', h1:'h1', h1c:'h1_count', h2c:'h2_count', words:'word_count', resp:'response_time', depth:'depth', dir:'meta_robots' };
    const key = colMap[_sortCol];
    if (key) {
      filtered.sort((a, b) => {
        let va = a[key], vb = b[key];
        if (typeof va === 'number' || typeof vb === 'number') { va = va || 0; vb = vb || 0; return _sortDir === 'asc' ? va - vb : vb - va; }
        va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase();
        return _sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
  }

  const count = filtered.length;
  // Render cap — high enough to show entire large crawls, bounded so a runaway
  // DOM doesn't lock the tab. The "Showing X of Y" line always reports the true
  // numbers even when we render fewer rows than matched.
  const RENDER_CAP = 50000;
  const shown = Math.min(count, RENDER_CAP);
  const sortIcon = (col) => _sortCol === col ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const showingLine = count > RENDER_CAP
    ? `Showing first ${shown.toLocaleString()} of ${count.toLocaleString()} matching (${pages.length.toLocaleString()} crawled) — refine filters to narrow`
    : `Showing ${count.toLocaleString()} of ${pages.length.toLocaleString()} pages`;
  const html = `<p style="color:var(--text-muted);font-size:13px;margin-bottom:8px">${showingLine}</p>
  <table>
    <thead><tr>
      <th style="width:48px;text-align:right">#</th>
      <th style="min-width:280px;cursor:pointer" onclick="sortPages('url')">URL${sortIcon('url')}</th>
      <th style="cursor:pointer" onclick="sortPages('status')">Status${sortIcon('status')}</th>
      <th style="min-width:200px;cursor:pointer" onclick="sortPages('title')">Meta Title${sortIcon('title')}</th>
      <th style="cursor:pointer" onclick="sortPages('titlelen')">Title Len${sortIcon('titlelen')}</th>
      <th style="min-width:250px;cursor:pointer" onclick="sortPages('desc')">Meta Desc${sortIcon('desc')}</th>
      <th style="cursor:pointer" onclick="sortPages('desclen')">Desc Len${sortIcon('desclen')}</th>
      <th style="min-width:180px;cursor:pointer" onclick="sortPages('h1')">H1${sortIcon('h1')}</th>
      <th style="cursor:pointer" onclick="sortPages('h1c')">H1#${sortIcon('h1c')}</th>
      <th style="cursor:pointer" onclick="sortPages('h2c')">H2#${sortIcon('h2c')}</th>
      <th style="cursor:pointer" onclick="sortPages('words')">Words${sortIcon('words')}</th>
      <th style="min-width:120px">Canonical</th><th>Hreflangs</th><th>Schema</th>
      <th style="cursor:pointer" onclick="sortPages('dir')">Directives${sortIcon('dir')}</th>
      <th style="cursor:pointer" onclick="sortPages('resp')">Resp ms${sortIcon('resp')}</th>
      <th style="cursor:pointer" onclick="sortPages('depth')">Depth${sortIcon('depth')}</th>
    </tr></thead>
    <tbody>${filtered.slice(0, RENDER_CAP).map((p, i) => {
      const h1s = JSON.parse(p.h1 || '[]');
      const hls = JSON.parse(p.hreflangs || '[]');
      const sdt = JSON.parse(p.structured_data_types || '[]');
      const dir = p.meta_robots || 'index, follow';
      return `<tr class="page-row" data-url="${esc(p.url)}">
      <td style="text-align:right;color:var(--text-muted)">${i + 1}</td>
      <td>${urlLink(p.url)}</td>
      <td>${statusBadge(p.status_code)}</td>
      <td style="white-space:normal;max-width:250px">${esc(p.title || '-')}</td>
      <td>${p.title_length || 0}</td>
      <td style="white-space:normal;max-width:300px">${esc(p.meta_description || '-')}</td>
      <td>${p.meta_description_length || 0}</td>
      <td style="white-space:normal;max-width:200px">${h1s.length > 0 ? esc(h1s[0]) : '-'}</td>
      <td>${p.h1_count || 0}</td>
      <td>${p.h2_count || 0}</td>
      <td>${p.word_count || 0}</td>
      <td>${p.canonical ? (p.canonical_is_self ? '<span class="badge badge-success">Self</span>' : '<span class="badge badge-warning">Other</span>') : '<span class="badge badge-muted">None</span>'}</td>
      <td>${hls.length > 0 ? hls.map(h => `<span class="badge badge-info">${esc(h.lang)}</span>`).join(' ') : '-'}</td>
      <td>${sdt.length > 0 ? sdt.map(t => `<span class="badge badge-info">${esc(t)}</span>`).join(' ') : '-'}</td>
      <td>${dir.includes('noindex') ? '<span class="badge badge-danger">noindex</span>' : ''}${dir.includes('nofollow') ? '<span class="badge badge-warning">nofollow</span>' : ''}${!dir.includes('noindex') && !dir.includes('nofollow') ? '<span class="badge badge-success">index,follow</span>' : ''}</td>
      <td>${p.response_time || 0}</td>
      <td>${p.depth || 0}</td>
    </tr>`}).join('')}</tbody>
  </table>`;
  const tableWrap = $('#pagesTable');
  tableWrap.innerHTML = html;

  // One delegated listener instead of one-per-row — essential for large crawls
  // (20k rows × a listener each froze the tab).
  tableWrap.onclick = (e) => {
    if (e.target.closest('a.url-cell')) return; // let URL links handle their own click
    const row = e.target.closest('.page-row');
    if (row && row.dataset.url) showPageDetail(row.dataset.url);
  };
}

['pagesFilter'].forEach(id => { $('#'+id)?.addEventListener('input', () => { if (pagesData.length) renderPagesTable(pagesData); }); });
['pagesStatusFilter','pagesTitleFilter','pagesDescFilter','pagesDirectiveFilter','pagesCanonicalFilter','pagesH1Filter','pagesWordFilter','pagesHreflangFilter'].forEach(id => {
  $('#'+id)?.addEventListener('change', () => { if (pagesData.length) renderPagesTable(pagesData); });
});

async function showPageDetail(url) {
  // The All Pages list is now a lightweight projection (no link/image/heading
  // blobs), so fetch the full row on demand for the detail modal.
  let p;
  try {
    const res = await fetch(`/api/crawls/${currentCrawlId}/page?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error('not found');
    p = await res.json();
  } catch {
    p = (pagesData || []).find(pg => pg.url === url);
  }
  if (!p) return;
  const hreflangs = JSON.parse(p.hreflangs || '[]');
  const conflicts = JSON.parse(p.hreflang_canonical_conflicts || '[]');
  const headings = JSON.parse(p.heading_structure || '[]');
  const secHeaders = JSON.parse(p.security_headers || '{}');

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal">
    <button class="modal-close">&times;</button>
    <h3>${esc(prettyUrl(p.url))}</h3>
    <div class="detail-grid">
      ${detailItem('Status', statusBadge(p.status_code))}
      ${detailItem('Title', esc(p.title || 'None') + ` (${p.title_length || 0} chars)`)}
      ${detailItem('Meta Description', esc(p.meta_description || 'None') + ` (${p.meta_description_length || 0} chars)`)}
      ${detailItem('Canonical', p.canonical ? esc(p.canonical) + (p.canonical_is_self ? ' (Self)' : ' (Different)') : 'None')}
      ${detailItem('H1', JSON.parse(p.h1 || '[]').join(', ') || 'None')}
      ${detailItem('H1 Count', p.h1_count || 0)}
      ${detailItem('H2 Count', p.h2_count || 0)}
      ${detailItem('Word Count', p.word_count || 0)}
      ${detailItem('Response Time', (p.response_time || 0) + 'ms')}
      ${detailItem('Content Length', formatBytes(p.content_length || 0))}
      ${detailItem('Internal Links', p.internal_links || 0)}
      ${detailItem('External Links', p.external_links || 0)}
      ${detailItem('Images', `${p.images_total || 0} total, ${p.images_without_alt || 0} missing alt`)}
      ${detailItem('Meta Robots', p.meta_robots || 'None')}
      ${detailItem('HTML Lang', p.html_lang || 'None')}
      ${detailItem('In Sitemap', sitemapDetailValue(p.in_sitemap, p.url))}
      ${detailItem('Structured Data', JSON.parse(p.structured_data_types || '[]').join(', ') || 'None')}
      ${detailItem('OG Title', p.og_title || 'None')}
      ${detailItem('OG Image', p.og_image || 'None')}
      ${detailItem('Depth', p.depth || 0)}
    </div>
    ${hreflangs.length > 0 ? `<div class="section-card" style="margin-top:20px"><h3>Hreflangs (${hreflangs.length})</h3>
      <table><thead><tr><th>Lang</th><th>URL</th></tr></thead><tbody>
      ${hreflangs.map(h => `<tr><td>${esc(h.lang)}</td><td>${esc(h.href)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    ${conflicts.length > 0 ? `<div class="section-card" style="margin-top:20px;border-left:4px solid var(--danger)"><h3>Hreflang/Canonical Conflicts (${conflicts.length})</h3>
      ${conflicts.map(c => `<div class="conflict-item"><div class="conflict-type" style="color:var(--${c.severity === 'critical' ? 'danger' : c.severity})">${esc(c.type)}</div>${esc(c.message)}</div>`).join('')}
    </div>` : ''}
    ${headings.length > 0 ? `<div class="section-card" style="margin-top:20px"><h3>Heading Structure</h3>
      ${headings.map(h => `<div style="padding-left:${(h.level-1)*20}px;margin:4px 0;font-size:13px"><strong>${h.tag}:</strong> ${esc(h.text)}</div>`).join('')}
    </div>` : ''}
    <div class="section-card" style="margin-top:20px"><h3>Security Headers</h3>
      <div class="detail-grid">
        ${Object.entries(secHeaders).map(([k,v]) => detailItem(k, v ? `<span class="badge badge-success">${esc(String(v).substring(0,60))}</span>` : '<span class="badge badge-danger">Missing</span>')).join('')}
      </div>
    </div>
  </div>`;

  document.body.appendChild(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function detailItem(label, value) {
  return `<div class="detail-item"><div class="dlabel">${label}</div><div class="dvalue">${value}</div></div>`;
}

// ── URL Context Menu (hover dropdown on all url-cell links) ──
let _urlMenu = null;
function showUrlMenu(e, url) {
  e.preventDefault();
  e.stopPropagation();
  hideUrlMenu();
  _urlMenu = document.createElement('div');
  _urlMenu.className = 'url-context-menu';
  const safeUrl = url.replace(/'/g, "\\'");
  _urlMenu.innerHTML = `
    <div class="url-menu-item" data-action="open">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 2h4v4M14 2L7 9M12 8v5a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h5"/></svg>
      Open Link
    </div>
    <div class="url-menu-item" data-action="inspect">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7" cy="7" r="5"/><path d="M7 4v3h2M11 11l2 2"/></svg>
      Inspect URL
    </div>
  `;
  _urlMenu.querySelector('[data-action="open"]').addEventListener('click', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    hideUrlMenu();
    window.open(url, '_blank', 'noopener');
  });
  _urlMenu.querySelector('[data-action="inspect"]').addEventListener('click', (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    hideUrlMenu();
    inspectUrl(url);
  });
  // Position near cursor
  _urlMenu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  _urlMenu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  document.body.appendChild(_urlMenu);
}

function hideUrlMenu() {
  if (_urlMenu) { _urlMenu.remove(); _urlMenu = null; }
}
document.addEventListener('click', hideUrlMenu);
document.addEventListener('scroll', hideUrlMenu, true);

// Attach context menu to all url-cell links via delegation
document.addEventListener('contextmenu', (e) => {
  const link = e.target.closest('a.url-cell');
  if (link) showUrlMenu(e, link.href || link.textContent);
});

// ── Inspect URL (full page detail with inbound links) ──
function findSitemapsForUrl(url) {
  const statuses = analysisData?.sitemapReport?.sitemapUrlStatuses || [];
  const variants = new Set([url, url.endsWith('/') ? url.slice(0, -1) : url + '/']);
  const matches = statuses.filter(s => variants.has(s.url) && s.sitemap);
  const unique = [...new Set(matches.map(m => m.sitemap))];
  return unique;
}
function sitemapDetailValue(inSitemap, url) {
  if (!inSitemap) return 'No';
  const sitemaps = findSitemapsForUrl(url);
  if (sitemaps.length === 0) return 'Yes';
  return 'Yes<div style="margin-top:6px;font-size:11px;color:var(--text-muted)">Found in:</div>' +
    sitemaps.map(s => `<div style="font-size:11px;word-break:break-all"><a href="${esc(s)}" target="_blank" rel="noopener" style="color:var(--primary)">${esc(s)}</a></div>`).join('');
}
function inspectUrl(url) {
  hideUrlMenu();
  if (!pagesData.length) return alert('No crawl data available');
  const p = pagesData.find(pg => pg.url === url);

  // Find pages linking TO this URL (deduplicated by source URL).
  // Scan both <a href> and <img src> so image-asset URLs surface their
  // host pages — otherwise the modal claims "no internal pages link
  // here" even when the image is embedded on dozens of pages.
  const inboundMap = new Map();
  for (const page of pagesData) {
    try {
      const links = JSON.parse(page.links || '[]');
      for (const link of links) {
        if (link.href === url && link.isInternal && !inboundMap.has(page.url)) {
          inboundMap.set(page.url, { from: page.url, anchor: link.anchor || '(no text)', nofollow: link.isNofollow, via: 'link' });
        }
      }
    } catch {}
    try {
      const images = JSON.parse(page.images || '[]');
      for (const img of images) {
        if (img.src === url && !inboundMap.has(page.url)) {
          inboundMap.set(page.url, { from: page.url, anchor: img.alt || '(no alt)', nofollow: false, via: 'image' });
        }
      }
    } catch {}
  }
  const inboundLinks = [...inboundMap.values()];

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  if (!p) {
    // URL not crawled directly — just show inbound links
    modal.innerHTML = `<div class="modal">
      <button class="modal-close">&times;</button>
      <h3 style="word-break:break-all">${esc(url)}</h3>
      <p style="color:var(--text-muted);font-size:13px">This URL was not directly crawled.</p>
      ${inboundLinks.length > 0 ? `<div class="section-card" style="margin-top:16px"><h3>Pages Referencing This URL (${inboundLinks.length})</h3>
        <table><thead><tr><th>Source Page</th><th>Via</th><th>Anchor / Alt text</th><th>Nofollow</th></tr></thead><tbody>
        ${inboundLinks.slice(0, 200).map(l => `<tr><td>${urlLink(l.from)}</td><td><span class="badge ${l.via === 'image' ? 'badge-info' : ''}" style="font-size:11px">${l.via === 'image' ? '&lt;img src&gt;' : '&lt;a href&gt;'}</span></td><td>${esc(l.anchor)}</td><td>${l.nofollow ? '<span class="badge badge-warning">Yes</span>' : 'No'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p style="color:var(--text-muted)">No internal pages reference this URL.</p>'}
    </div>`;
  } else {
    const hreflangs = JSON.parse(p.hreflangs || '[]');
    const conflicts = JSON.parse(p.hreflang_canonical_conflicts || '[]');
    const headings = JSON.parse(p.heading_structure || '[]');
    const secHeaders = JSON.parse(p.security_headers || '{}');
    const sdt = JSON.parse(p.structured_data_types || '[]');

    modal.innerHTML = `<div class="modal">
      <button class="modal-close">&times;</button>
      <h3 style="word-break:break-all">${esc(prettyUrl(p.url))}</h3>
      <div class="detail-grid">
        ${detailItem('Status', statusBadge(p.status_code))}
        ${detailItem('Title', esc(p.title || 'None') + ` (${p.title_length || 0} chars)`)}
        ${detailItem('Meta Description', esc(p.meta_description || 'None') + ` (${p.meta_description_length || 0} chars)`)}
        ${detailItem('Canonical', p.canonical ? esc(p.canonical) + (p.canonical_is_self ? ' (Self)' : ' (Different)') : 'None')}
        ${detailItem('H1', JSON.parse(p.h1 || '[]').join(', ') || 'None')}
        ${detailItem('H1 Count', p.h1_count || 0)}
        ${detailItem('H2 Count', p.h2_count || 0)}
        ${detailItem('Word Count', p.word_count || 0)}
        ${detailItem('Response Time', (p.response_time || 0) + 'ms')}
        ${detailItem('Content Length', formatBytes(p.content_length || 0))}
        ${detailItem('Internal Links', p.internal_links || 0)}
        ${detailItem('External Links', p.external_links || 0)}
        ${detailItem('Images', `${p.images_total || 0} total, ${p.images_without_alt || 0} missing alt`)}
        ${detailItem('Meta Robots', p.meta_robots || 'index, follow')}
        ${detailItem('HTML Lang', p.html_lang || 'None')}
        ${detailItem('In Sitemap', sitemapDetailValue(p.in_sitemap, p.url))}
        ${detailItem('Structured Data', sdt.join(', ') || 'None')}
        ${detailItem('OG Title', p.og_title || 'None')}
        ${detailItem('OG Image', p.og_image || 'None')}
        ${detailItem('Depth', p.depth || 0)}
      </div>

      <div class="section-card" style="margin-top:20px;border-left:4px solid var(--info)">
        <h3>Pages Referencing This URL (${inboundLinks.length})</h3>
        ${inboundLinks.length > 0 ? `<table><thead><tr><th>Source Page</th><th>Via</th><th>Anchor / Alt text</th><th>Nofollow</th></tr></thead><tbody>
        ${inboundLinks.slice(0, 200).map(l => `<tr><td>${urlLink(l.from)}</td><td><span class="badge ${l.via === 'image' ? 'badge-info' : ''}" style="font-size:11px">${l.via === 'image' ? '&lt;img src&gt;' : '&lt;a href&gt;'}</span></td><td>${esc(l.anchor)}</td><td>${l.nofollow ? '<span class="badge badge-warning">Yes</span>' : 'No'}</td></tr>`).join('')}
        </tbody></table>` : '<p style="color:var(--text-muted)">No internal pages reference this URL.</p>'}
      </div>

      ${hreflangs.length > 0 ? `<div class="section-card" style="margin-top:16px"><h3>Hreflangs (${hreflangs.length})</h3>
        <table><thead><tr><th>Lang</th><th>URL</th></tr></thead><tbody>
        ${hreflangs.map(h => `<tr><td>${esc(h.lang)}</td><td>${urlLink(h.href)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}

      ${conflicts.length > 0 ? `<div class="section-card" style="margin-top:16px;border-left:4px solid var(--danger)"><h3>Hreflang/Canonical Conflicts</h3>
        ${conflicts.map(c => `<div style="margin:8px 0;padding:8px;background:rgba(255,0,0,0.05);border-radius:4px"><span class="badge badge-${c.severity === 'critical' ? 'danger' : c.severity}">${esc(c.type)}</span> ${esc(c.message)}</div>`).join('')}
      </div>` : ''}

      ${headings.length > 0 ? `<div class="section-card" style="margin-top:16px"><h3>Heading Structure</h3>
        ${headings.map(h => `<div style="padding-left:${(h.level-1)*20}px;margin:4px 0;font-size:13px"><strong>${h.tag}:</strong> ${esc(h.text)}</div>`).join('')}
      </div>` : ''}

      <div class="section-card" style="margin-top:16px"><h3>Security Headers</h3>
        <div class="detail-grid">
        ${Object.entries(secHeaders).map(([k,v]) => detailItem(k, v ? `<span class="badge badge-success">${esc(String(v).substring(0,80))}</span>` : '<span class="badge badge-danger">Missing</span>')).join('')}
        </div>
      </div>
    </div>`;
  }

  document.body.appendChild(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ── Issues ──
function renderIssues(analysis) {
  const issues = analysis.issues;

  // Populate categories
  const cats = [...new Set(issues.map(i => i.category))].sort();
  const catSelect = $('#issuesCategory');
  catSelect.innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');

  function render() {
    const sev = $('#issuesSeverity').value;
    const cat = $('#issuesCategory').value;
    let filtered = issues;
    if (sev) filtered = filtered.filter(i => i.severity === sev);
    if (cat) filtered = filtered.filter(i => i.category === cat);

    $('#issuesSummary').innerHTML = `
      ${issueCountCard(filtered.filter(i => i.severity === 'critical').length, 'Critical', 'danger')}
      ${issueCountCard(filtered.filter(i => i.severity === 'warning').length, 'Warnings', 'warning')}
      ${issueCountCard(filtered.filter(i => i.severity === 'info').length, 'Info', 'info')}
    `;

    $('#issuesTable').innerHTML = `
      ${exportBtn('issues')}
      <table>
      <thead><tr><th>Severity</th><th>Category</th><th>URL</th><th>Issue</th></tr></thead>
      <tbody>${filtered.map(i => `<tr>
        <td>${severityBadge(i.severity)}</td>
        <td>${esc(i.category)}</td>
        <td>${urlLink(i.url)}</td>
        <td>${esc(i.message)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  $('#issuesSeverity').addEventListener('change', render);
  $('#issuesCategory').addEventListener('change', render);
  render();
}

function exportIssuesToCSV() {
  if (!analysisData || !analysisData.issues) return;
  const rows = [['Severity','Category','URL','Issue']];
  for (const i of analysisData.issues) {
    rows.push([i.severity, i.category, i.url, i.message]);
  }
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'seo-issues.csv';
  a.click();
}

// ── Hreflang ──
function renderHreflang(analysis) {
  const r = analysis.hreflangReport;
  let html = `<div class="stats-grid">
    ${statCard('Pages with Hreflangs', r.pagesWithHreflangs, 'info')}
    ${statCard('Languages Found', r.languages.length, '')}
    ${statCard('Return Link Issues', r.totalReturnLinkIssues, r.totalReturnLinkIssues > 0 ? 'danger' : 'success')}
  </div>`;

  if (r.languages.length > 0) {
    html += `<div class="section-card"><h3>Languages</h3><div style="display:flex;gap:8px;flex-wrap:wrap">
      ${r.languages.map(l => `<span class="badge badge-info">${esc(l)}</span>`).join('')}
    </div></div>`;
  }

  if (r.returnLinkIssues.length > 0) {
    html += `<div class="section-card"><h3>Missing Return Links (${r.returnLinkIssues.length})</h3>
      <table><thead><tr><th>From</th><th>To</th><th>Lang</th><th>Issue</th></tr></thead>
      <tbody>${r.returnLinkIssues.map(i => `<tr>
        <td>${urlLink(i.from)}</td>
        <td>${urlLink(i.to)}</td>
        <td>${esc(i.lang)}</td>
        <td style="font-size:12px">${esc(prettyUrl(i.message))}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  const list = r.pagesList || [];
  if (list.length > 0) {
    const cap = 1000;
    const shown = list.slice(0, cap);
    const selfChip = (ok) => ok
      ? '<span class="badge badge-success" title="Page references itself in hreflang">self ✓</span>'
      : '<span class="badge badge-danger" title="No self-referencing hreflang on this page">no self</span>';
    const hrefStatus = (s) => s == null
      ? '<span class="badge" style="background:var(--bg-hover);color:var(--text-muted)" title="Target not crawled (external or out of scope)">—</span>'
      : statusBadge(s);
    html += `<div class="section-card"><h3>Pages with Hreflangs (${list.length}${list.length > cap ? ` — showing first ${cap}` : ''})</h3>
      <table><thead><tr><th>Page URL</th><th>Self</th><th>Languages</th><th>Hreflang Targets</th></tr></thead>
      <tbody>${shown.map(p => `<tr>
        <td>${urlLink(p.url)}</td>
        <td>${selfChip(p.hasSelf)}</td>
        <td style="white-space:nowrap">${p.hreflangs.map(h => `<span class="badge badge-info" style="margin:1px">${esc(h.lang)}</span>`).join('')}</td>
        <td style="font-size:12px">${p.hreflangs.map(h => `<div style="margin:2px 0">${hrefStatus(h.status)} <span style="color:var(--text-muted)">${esc(h.lang)}${h.isSelf ? ' · self' : ''}</span> → ${urlLink(h.href)}</div>`).join('')}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#hreflangContent').innerHTML = exportBtn('hreflang') + html;
}

// ── Canonicals ──
let _canData = null, _canFilter = 'all';
function renderCanonicals(analysis) {
  _canData = analysis.canonicalReport;
  _canFilter = 'all';
  _renderCan();
}
function filterCan(f) { _canFilter = (_canFilter === f) ? 'all' : f; _renderCan(); }
function _renderCan() {
  const r = _canData, f = _canFilter;
  if (!r) { $('#canonicalsContent').innerHTML = '<p style="color:var(--text-muted)">No data.</p>'; return; }
  const cb = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterCan('${key}')">${statCardInner(label, count)}</div>`;
  };
  let html = `<div class="stats-grid">
    ${cb('all', 'Total Pages', r.total, '')}
    ${cb('with', 'With Canonical', r.withCanonical, 'info')}
    ${cb('self', 'Self-Referencing', r.selfReferencing, 'success')}
    ${cb('other', 'Canonicalized (Other)', r.canonicalized, 'warning')}
    ${cb('missing', 'Missing Canonical', r.missing, r.missing > 0 ? 'danger' : 'success')}
  </div>`;
  if (f === 'with') {
    const wcp = r.withCanonicalPages || [];
    if (wcp.length > 0) html += `<div class="section-card"><h3>Pages With Canonical (${wcp.length})</h3><table><thead><tr><th>Page URL</th><th>Canonical URL</th><th>Type</th></tr></thead><tbody>${wcp.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${urlLink(p.canonical)}</td><td>${p.isSelf ? '<span class="badge badge-success">Self</span>' : '<span class="badge badge-warning">Other</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'other') {
    if (r.canonicalizedPages.length > 0) html += `<div class="section-card"><h3>Canonicalized to Other URLs (${r.canonicalizedPages.length})</h3><table><thead><tr><th>Page URL</th><th>Canonical Points To</th></tr></thead><tbody>${r.canonicalizedPages.map(p=>`<tr><td>${urlLink(p.url)}</td><td>${urlLink(p.canonical)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'missing') {
    if (r.missingPages.length > 0) html += `<div class="section-card"><h3>Pages Missing Canonical (${r.missingPages.length})</h3><table><thead><tr><th>URL</th></tr></thead><tbody>${r.missingPages.map(u=>`<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'self') {
    const srp = r.selfReferencingPages || [];
    html += `<div class="section-card"><h3>Self-Referencing Canonical (${srp.length})</h3><table><thead><tr><th>URL</th></tr></thead><tbody>${srp.slice(0,500).map(u=>`<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('#canonicalsContent').innerHTML = exportBtn('canonicals') + html;
}

// ── Hreflang vs Canonical Conflicts ──
let _conflictsData = null, _conflictsFilter = 'all';
function renderConflicts(analysis) {
  _conflictsData = analysis.hreflangCanonicalConflicts;
  _conflictsFilter = 'all';
  _renderConflicts();
}
function filterConflicts(f) { _conflictsFilter = (_conflictsFilter === f) ? 'all' : f; _renderConflicts(); }
function _renderConflicts() {
  const r = _conflictsData, f = _conflictsFilter;
  if (!r || r.totalConflicts === 0) {
    $('#conflictsContent').innerHTML = `<div class="section-card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h3>No Hreflang/Canonical Conflicts Found</h3>
      <p style="color:var(--text-muted)">All pages with hreflang tags have consistent canonical tags.</p>
    </div>`;
    return;
  }

  // Count conflicts by type
  const typeCounts = {};
  for (const page of r.pages) {
    for (const c of page.conflicts) {
      typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
    }
  }

  const cb = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterConflicts('${key}')">${statCardInner(label, count)}</div>`;
  };

  const typeLabels = {
    'missing_self_referencing_hreflang': 'Missing Self-Ref Hreflang',
    'hreflang_self_points_to_different_url': 'Self Points to Different URL',
    'hreflang_all_same_params': 'All Same Params',
    'canonical_differs_from_page': 'Canonical Differs from Page',
    'hreflang_page_canonical_all_differ': 'Three-Way Mismatch',
    'hreflang_self_vs_canonical_mismatch': 'Self vs Canonical Mismatch',
    'canonical_not_in_hreflangs': 'Canonical Not in Hreflangs',
    'hreflang_inconsistent_params': 'Inconsistent Params',
    'hreflang_shared_params': 'Shared Params'
  };

  let html = `<div class="stats-grid">
    ${cb('all', 'All Conflicts', r.totalConflicts, 'danger')}
    ${Object.entries(typeCounts).sort((a,b) => b[1] - a[1]).map(([type, count]) => {
      const isWarning = type === 'missing_self_referencing_hreflang' || type === 'hreflang_inconsistent_params' || type === 'hreflang_shared_params';
      return cb(type, typeLabels[type] || type, count, isWarning ? 'warning' : 'danger');
    }).join('')}
  </div>
  <div class="section-card" style="border-left:4px solid var(--danger)">
    <h3>Why This Matters</h3>
    <p style="color:var(--text-muted);font-size:13px">When canonical tags and hreflang tags conflict, Google typically follows the canonical signal and may ignore hreflang annotations. This can cause the wrong language version to appear in search results for different regions.</p>
  </div>`;

  // Filter pages based on selected conflict type
  const filteredPages = f === 'all' ? r.pages : r.pages.filter(p => p.conflicts.some(c => c.type === f));

  for (const page of filteredPages) {
    const visibleConflicts = f === 'all' ? page.conflicts : page.conflicts.filter(c => c.type === f);
    const hasCritical = visibleConflicts.some(c => c.severity === 'critical');
    html += `<div class="conflict-card ${hasCritical ? '' : 'warning'}">
      <div class="conflict-url">${esc(prettyUrl(page.url))}</div>
      <div style="margin-bottom:12px;font-size:13px;color:var(--text-muted)">
        Canonical: <strong>${esc(page.canonical || 'None')}</strong> |
        Hreflangs: ${(page.hreflangs || []).map(h => `<span class="badge badge-info">${esc(h.lang)}</span>`).join(' ')}
      </div>
      ${visibleConflicts.map(c => `<div class="conflict-item">
        <div class="conflict-type" style="color:var(--${c.severity === 'critical' ? 'danger' : c.severity === 'warning' ? 'warning' : 'info'})">${severityBadge(c.severity)} ${esc(c.type)}</div>
        <div style="margin-top:4px">${esc(c.message)}</div>
      </div>`).join('')}
    </div>`;
  }

  $('#conflictsContent').innerHTML = exportBtn('hreflang-canonical') + html;
}

// ── Redirects ──
function renderRedirects(analysis) {
  const r = analysis.redirectChains;
  const rp = analysis.redirectParamsReport || { tested: false, testedCount: 0, testedParams: [], activeResults: [], activeDrops: [], passiveDrops: [], totalDropping: 0 };
  let html = `<div class="stats-grid">
    ${statCard('Total Redirects', r.total, r.total > 0 ? 'warning' : 'success')}
    ${statCard('Long Chains (3+)', r.longChains, r.longChains > 0 ? 'danger' : 'success')}
    ${statCard('Param-Loss Tests', rp.testedCount, '')}
    ${statCard('Dropping Marketing Params', rp.totalDropping, rp.totalDropping > 0 ? 'danger' : 'success')}
  </div>`;

  // Marketing parameter preservation (UTM / gclid / fbclid …)
  html += `<div class="section-card" ${rp.totalDropping > 0 ? 'style="border-left:4px solid var(--danger)"' : ''}>
    <h3>Marketing Parameter Preservation (UTM, gclid, fbclid…)</h3>
    <p style="margin-bottom:12px;color:var(--text-muted);font-size:13px">
      After the crawl, each redirecting URL (plus the homepage) is re-requested with test marketing parameters appended
      (${rp.testedParams.map(p => `<code>${esc(p)}</code>`).join(', ') || 'utm_*, gclid, fbclid…'}).
      If a redirect drops these parameters, campaign traffic that passes through it loses attribution —
      GA4 reports the session as <em>direct/none</em> and Google Ads / Meta / Microsoft click IDs never reach the landing page.
    </p>`;

  if (!rp.tested && rp.passiveDrops.length === 0) {
    html += `<p style="color:var(--text-muted);font-size:13px">No parameter-preservation data for this crawl. Re-run the crawl to test redirects with marketing parameters.</p>`;
  } else if (rp.totalDropping === 0) {
    html += `<p style="font-size:13px"><span class="badge badge-success">All good</span> Marketing parameters survived redirects on all ${rp.testedCount} tested URL(s).</p>`;
  }

  if (rp.activeResults.length > 0) {
    html += `<table><thead><tr><th>URL Tested</th><th>Final URL</th><th>Result</th><th>Dropped Params</th></tr></thead>
      <tbody>${rp.activeResults.map(t => {
        let result;
        if (t.error) result = `<span class="badge badge-warning">Error: ${esc(t.error)}</span>`;
        else if (t.dropsParams) result = `<span class="badge badge-danger">Drops params</span>`;
        else if (t.redirected) result = `<span class="badge badge-success">Preserved (${t.hops} hop${t.hops > 1 ? 's' : ''})</span>`;
        else result = `<span class="badge badge-success">No redirect</span>`;
        return `<tr>
          <td>${urlLink(t.url)}</td>
          <td>${t.finalUrl ? urlLink(t.finalUrl) : '—'}</td>
          <td>${result}</td>
          <td>${(t.dropped || []).map(p => `<span class="badge badge-danger" style="margin:1px">${esc(p)}</span>`).join(' ') || '—'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }
  html += '</div>';

  if (rp.passiveDrops.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--danger)">
      <h3>Crawled Redirects That Dropped Marketing Params (${rp.passiveDrops.length})</h3>
      <p style="margin-bottom:12px;color:var(--text-muted);font-size:13px">These URLs were discovered during the crawl already carrying marketing parameters, and their redirect target lost them.</p>
      <table><thead><tr><th>Original URL</th><th>Final URL</th><th>Dropped Params</th><th>Hops</th></tr></thead>
      <tbody>${rp.passiveDrops.map(d => `<tr>
        <td>${urlLink(d.url)}</td>
        <td>${urlLink(d.finalUrl)}</td>
        <td>${d.dropped.map(p => `<span class="badge badge-danger" style="margin:1px">${esc(p)}</span>`).join(' ')}</td>
        <td>${d.hops}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  if (r.chains.length > 0) {
    html += `<div class="section-card"><h3>Redirect Chains</h3>
      <table><thead><tr><th>Original URL</th><th>Final URL</th><th>Hops</th><th>Chain</th></tr></thead>
      <tbody>${r.chains.map(c => `<tr>
        <td>${urlLink(c.originalUrl)}</td>
        <td>${urlLink(c.finalUrl)}</td>
        <td>${c.hops} ${c.isLong ? '<span class="badge badge-danger">Long</span>' : ''}</td>
        <td style="font-size:11px">${c.chain.map(s => `${s.statusCode}`).join(' → ')}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  const exportRow = `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px">
    ${exportBtnInner('redirect-params', 'Export Param Check')}
    ${exportBtnInner('redirects', 'Export Redirects')}
  </div>`;
  $('#redirectsContent').innerHTML = exportRow + html;
}

// ── Content ──
function renderContent(analysis) {
  const r = analysis.contentAnalysis;
  const d = analysis.duplicates;
  const lm = analysis.languageMismatchReport || { totalPages: 0, pages: [] };

  let html = `<div class="stats-grid">
    ${statCard('Avg Word Count', r.avgWordCount, r.avgWordCount < 300 ? 'warning' : '')}
    ${statCard('Avg Text Ratio', r.avgTextRatio + '%', '')}
    ${statCard('Thin Pages (<300w)', r.thinPages.length, r.thinPages.length > 0 ? 'warning' : 'success')}
    ${statCard('Duplicate Titles', d.duplicateTitles.length, d.duplicateTitles.length > 0 ? 'warning' : 'success')}
    ${statCard('Duplicate Descriptions', d.duplicateDescriptions.length, d.duplicateDescriptions.length > 0 ? 'warning' : 'success')}
    ${statCard('Duplicate Content', d.duplicateContent.length, d.duplicateContent.length > 0 ? 'warning' : 'success')}
    ${statCard('Language Mismatches', lm.totalPages, lm.totalPages > 0 ? 'critical' : 'success')}
  </div>`;

  // Language mismatches — show first since it's a critical issue
  if (lm.totalPages > 0) {
    html += `<div class="section-card"><h3>Language Mismatches (${lm.totalPages} pages)</h3>
      <p style="margin-bottom:12px;color:var(--text-muted);font-size:13px">Pages where the URL path language doesn't match the <code>html lang</code> attribute or the detected content language. For example, a <code>/en/</code> URL serving French content. <code>og:locale</code> is ignored — it's a social-sharing hint and often doesn't reflect the content language.</p>
      <table><thead><tr><th>URL</th><th>URL Lang</th><th>html lang</th><th>Content Lang</th><th>Issues</th></tr></thead>
      <tbody>${lm.pages.slice(0, 100).map(p => {
        const urlLangMatch = p.url.match(/^https?:\/\/[^/]+\/([a-z]{2}(?:-[a-z]{2})?)\//i);
        const urlLang = urlLangMatch ? urlLangMatch[1] : '—';
        const issueList = p.issues.map(i => `<span class="badge badge-critical" style="margin:2px">${esc(i.message)}</span>`).join('');
        return `<tr>
          <td>${urlLink(p.url)}</td>
          <td><strong>${esc(urlLang)}</strong></td>
          <td>${esc(p.htmlLang || '—')}</td>
          <td>${esc(p.detectedContentLang ? p.detectedContentLang.toUpperCase() : '—')}</td>
          <td>${issueList}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  if (r.thinPages.length > 0) {
    html += `<div class="section-card"><h3>Thin Content Pages</h3>
      <table><thead><tr><th>URL</th><th>Word Count</th></tr></thead>
      <tbody>${r.thinPages.slice(0, 50).map(p => `<tr><td>${urlLink(p.url)}</td><td>${p.wordCount}</td></tr>`).join('')}</tbody></table></div>`;
  }

  if (d.duplicateTitles.length > 0) {
    html += `<div class="section-card"><h3>Duplicate Titles (${d.duplicateTitles.length} groups)</h3>`;
    for (const group of d.duplicateTitles.slice(0, 20)) {
      html += `<div style="margin-bottom:12px"><strong>${esc(group[0].title)}</strong><ul style="margin-top:4px;padding-left:20px">
        ${group.map(p => `<li style="font-size:13px;color:var(--text-muted)">${esc(prettyUrl(p.url))}</li>`).join('')}
      </ul></div>`;
    }
    html += '</div>';
  }

  $('#contentContent').innerHTML = exportBtn('content') + html;
}

// ── Images ──
let _imgData = null, _imgFilter = 'all';
function renderImages(analysis) {
  _imgData = analysis.imageAnalysis;
  _imgFilter = 'all';
  _renderImagesUI();
}
function filterImg(f) { _imgFilter = (_imgFilter === f) ? 'all' : f; _renderImagesUI(); }
function _renderImagesUI() {
  const r = _imgData || { totalImages: 0, missingAlt: 0, emptyAlt: 0, uniqueIssueImages: 0, issueImages: [] };
  const f = _imgFilter;

  // Once the image-assets dataset has been fetched (with cached statuses),
  // recompute the alt counts restricted to images that returned 2xx — this
  // is the user's requirement: don't surface alt issues on broken images,
  // since the real fix is to remove/fix the URL, not the alt text. We also
  // surface a dedicated "Broken (4xx)" scorecard from the same dataset.
  //
  // Before the asset probe finishes, we fall back to the analyzer's totals
  // (which DO already drop "no src" images) so the tab isn't empty.
  let totalImages = r.totalImages || 0;
  let missingAltCount = r.missingAlt || 0;
  let emptyAltCount = r.emptyAlt || 0;
  let uniqueWithIssues = r.uniqueIssueImages || 0;
  let broken4xxCount = 0;
  let issueRows = (r.issueImages || []).map(i => ({
    src: i.src, pageUrl: i.pageUrl, issue: i.issue, occurrences: i.occurrences
  }));

  if (_imgAssetsData && Array.isArray(_imgAssetsData.items)) {
    const fromImg = _imgAssetsData.items.filter(i => i.fromImg);
    const ok = (i) => i.status >= 200 && i.status < 300;
    const broken4xx = fromImg.filter(i => i.status >= 400 && i.status < 500);
    const okImgs = fromImg.filter(ok);

    totalImages = okImgs.length;
    broken4xxCount = broken4xx.length;
    const okMissing = okImgs.filter(i => i.missingAlt);
    const okEmpty = okImgs.filter(i => i.emptyAlt);
    missingAltCount = okMissing.length;
    emptyAltCount = okEmpty.length;
    uniqueWithIssues = okMissing.length + okEmpty.length;

    // Build per-row issue list from the 2xx subset, ordered by frequency.
    issueRows = okImgs
      .filter(i => i.missingAlt || i.emptyAlt)
      .map(i => ({
        src: i.href,
        pageUrl: i.samplePageUrl,
        issue: i.missingAlt ? 'Missing alt attribute' : 'Empty alt text',
        occurrences: i.sourceCount
      }))
      .sort((a, b) => b.occurrences - a.occurrences);
  }

  const cb = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterImg('${key}')">${statCardInner(label, count)}</div>`;
  };
  let html = `<div class="stats-grid">
    ${cb('all', 'Total Images (2xx)', totalImages, '')}
    ${cb('missingalt', 'Missing Alt Attr', missingAltCount, missingAltCount > 0 ? 'danger' : 'success')}
    ${cb('emptyalt', 'Empty Alt Text', emptyAltCount, emptyAltCount > 0 ? 'warning' : 'success')}
    ${cb('broken', 'Broken (4xx)', broken4xxCount, broken4xxCount > 0 ? 'danger' : 'success')}
  </div>`;

  // Apply filter pill to the row list.
  let issues = issueRows;
  if (f === 'missingalt') issues = issues.filter(i => i.issue === 'Missing alt attribute');
  else if (f === 'emptyalt') issues = issues.filter(i => i.issue !== 'Missing alt attribute');
  else if (f === 'broken') issues = []; // broken images shown in the dedicated section below

  if (f !== 'broken') {
    if (issues.length > 0) {
      html += `<div class="section-card"><h3>Images with Alt Issues (${issues.length.toLocaleString()} unique images)</h3>
        <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">Only images returning 200 are counted. Each image URL is shown once with one example origin page. "Occurrences" shows how many times this image appears across the site.</p>
        <table><thead><tr><th>Image URL</th><th>Found On</th><th>Issue</th><th>Occurrences</th></tr></thead>
        <tbody>${issues.slice(0, 500).map(i => `<tr>
          <td>${urlLink(i.src)}</td>
          <td>${i.pageUrl ? urlLink(i.pageUrl) : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td>${i.issue === 'Missing alt attribute' ? '<span class="badge badge-danger">Missing alt attr</span>' : '<span class="badge badge-warning">Empty alt text</span>'}</td>
          <td>${i.occurrences}</td>
        </tr>`).join('')}</tbody></table></div>`;
    } else {
      html += `<div class="section-card" style="text-align:center;padding:40px">
        <div style="font-size:48px;margin-bottom:16px">✅</div>
        <h3>${f === 'all' ? (_imgAssetsData ? 'All 2xx Images Have Alt Text' : 'All Images Have Alt Text') : 'No images match this filter'}</h3>
      </div>`;
    }
  }

  $('#imagesContent').innerHTML = exportBtn('images') + html
    + '<div id="brokenImagesSection" style="margin-top:18px"></div>';
  loadBrokenImages();
}

// ── Broken image references ──
// Probes every internal image URL (from <img src> + <a href="...jpg">)
// for its status code and surfaces the 404/410/5xx ones. Auto-scans on
// open; results cached server-side under asset-status:<url>.
let _imgAssetsData = null;
let _imgAssetsChecking = false;

async function loadBrokenImages() {
  const wrap = document.getElementById('brokenImagesSection');
  if (!wrap || !currentCrawlId) return;
  // Already have the dataset (from an earlier visit to this tab): just paint
  // the broken-images section. Avoids a redundant fetch when _renderImagesUI
  // is called a second time with status-filtered scorecards.
  if (_imgAssetsData) { renderBrokenImages(); return; }
  wrap.innerHTML = '<div class="section-card"><p style="color:var(--text-muted)">Loading image references…</p></div>';
  try {
    const res = await fetch(`/api/crawls/${currentCrawlId}/image-assets`);
    if (!res.ok) throw new Error((await res.json()).error || 'failed');
    _imgAssetsData = await res.json();
    // First time the assets dataset arrives, re-render the whole Images tab
    // so the top scorecards switch from analyzer-fallback counts to the
    // status-filtered (2xx only) counts + Broken (4xx) tile.
    _renderImagesUI();
    const unchecked = (_imgAssetsData.items || []).filter(i => i.status == null && !i.error).length;
    if (unchecked > 0 && !_imgAssetsChecking) startImageAssetCheck();
  } catch (e) {
    wrap.innerHTML = `<div class="section-card"><p style="color:var(--danger)">Failed to load image references: ${esc(e.message)}</p></div>`;
  }
}

function renderBrokenImages() {
  const wrap = document.getElementById('brokenImagesSection');
  if (!wrap || !_imgAssetsData) return;
  const items = _imgAssetsData.items || [];
  const broken = items.filter(i => i.error || (i.status != null && i.status >= 400));
  const statusCell = (i) => {
    if (i.error && i.status == null) return `<span class="badge badge-danger" title="${esc(i.error)}">${esc(i.error)}</span>`;
    if (i.status == null) return '<span class="badge" style="background:var(--bg-hover);color:var(--text-muted)">—</span>';
    return statusBadge(i.status);
  };
  const rows = broken.slice(0, 1000).map(i => {
    const top = (i.sources || []).slice(0, 3).map(s => urlLink(s.url)).join('<br>');
    const more = (i.sourceCount || 0) > 3 ? `<div style="color:var(--text-muted);font-size:11px">+${i.sourceCount - 3} more</div>` : '';
    return `<tr>
      <td style="font-size:12px"><a href="${esc(i.href)}" target="_blank" rel="noopener" style="color:var(--primary);word-break:break-all">${esc(i.href)}</a></td>
      <td style="text-align:center">${statusCell(i)}</td>
      <td style="text-align:center;color:var(--text-muted)">${i.sourceCount || (i.sources||[]).length}</td>
      <td style="font-size:11px">${top}${more}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="section-card">
      <h3>Broken image references (${broken.length.toLocaleString()} of ${items.length.toLocaleString()} checked${_imgAssetsChecking ? ' — scanning…' : ''})</h3>
      <div id="imgAssetsProgress" style="display:${_imgAssetsChecking ? 'block' : 'none'};margin-bottom:10px"></div>
      ${broken.length === 0
        ? `<p style="color:var(--text-muted);padding:6px 0">${_imgAssetsChecking ? 'Checking image URLs…' : 'No broken image references found. 🎉'}</p>`
        : `<table>
            <thead><tr><th>Image URL</th><th style="text-align:center">Status</th><th style="text-align:center">Used on</th><th>Top source pages</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
      ${!_imgAssetsChecking ? `<button id="imgRecheckBtn" class="btn btn-secondary" style="margin-top:10px;padding:7px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Re-check images</button>` : ''}
    </div>`;
  document.getElementById('imgRecheckBtn')?.addEventListener('click', () => startImageAssetCheck(true));
}

async function startImageAssetCheck(force) {
  if (_imgAssetsChecking || !currentCrawlId) return;
  _imgAssetsChecking = true;
  renderBrokenImages();
  const drawBar = (done, total, finished) => {
    const p = document.getElementById('imgAssetsProgress');
    if (!p) return;
    p.style.display = 'block';
    const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    p.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${finished ? 'Done.' : 'Checking image URLs…'} ${done.toLocaleString()} / ${total.toLocaleString()}</div>
      <div style="height:8px;background:var(--bg-input);border-radius:999px;overflow:hidden;border:1px solid var(--border)"><div style="height:100%;width:${pct}%;background:${finished ? 'linear-gradient(135deg,#16A34A,#22C55E)' : 'linear-gradient(135deg,#6366F1,#8B5CF6)'};transition:width .3s"></div></div>`;
  };
  let pending = false;
  // Re-render the WHOLE Images tab (not just the broken-images section), so
  // the top scorecards — Missing Alt / Empty Alt / Broken (4xx) — update live
  // as the background checker reports new statuses.
  const refresh = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (_imgAssetsChecking) _renderImagesUI(); }, 1500); };
  try {
    const res = await fetch(`/api/crawls/${currentCrawlId}/image-assets/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force })
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'start' || evt.type === 'progress') drawBar(evt.done || 0, evt.total, false);
          else if (evt.type === 'result') {
            const it = _imgAssetsData.items.find(x => x.href === evt.url);
            if (it) { it.status = evt.status; it.error = evt.error; it.checkedAt = evt.checkedAt; }
            drawBar(evt.done, evt.total, false);
            refresh();
          } else if (evt.type === 'done') drawBar(evt.done, evt.total, true);
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    const p = document.getElementById('imgAssetsProgress');
    if (p) p.innerHTML = `<div style="color:var(--danger);font-size:12px">Check failed: ${esc(e.message)}</div>`;
  } finally {
    _imgAssetsChecking = false;
    renderBrokenImages();
  }
}

// ── Structured Data ──
function renderStructuredData(analysis) {
  const r = analysis.structuredDataReport;
  const types = Object.entries(r.typeCounts).sort((a, b) => b[1] - a[1]);
  const max = types[0]?.[1] || 1;

  let html = `<div class="stats-grid">
    ${statCard('Pages With SD', r.pagesWithSD, 'success')}
    ${statCard('Pages Without SD', r.pagesWithoutSD, r.pagesWithoutSD > 0 ? 'warning' : 'success')}
    ${statCard('Schema Types', types.length, 'info')}
  </div>`;

  if (types.length > 0) {
    html += `<div class="section-card"><h3>Schema Types Distribution</h3>
      <div class="bar-chart">${types.map(([type, count]) =>
        `<div class="bar-item"><span class="bar-label">${esc(type)}</span><div class="bar-track"><div class="bar-fill primary" style="width:${(count/max*100).toFixed(0)}%">${count}</div></div></div>`
      ).join('')}</div></div>`;
  }

  $('#structuredContent').innerHTML = exportBtn('structured') + html;
}

// ── Security ──
function renderSecurity(analysis) {
  const r = analysis.securityReport;
  if (!r.headers) {
    $('#securityContent').innerHTML = '<p style="color:var(--text-muted)">No security data available.</p>';
    return;
  }

  let html = `<div class="stats-grid">
    ${statCard('HTTPS', r.isHttps ? 'Yes' : 'No', r.isHttps ? 'success' : 'danger')}
    ${statCard('Pages Checked', r.checked, '')}
  </div>
  <div class="section-card"><h3>Security Headers Coverage</h3>`;

  const headers = Object.entries(r.headers);
  const max = r.checked;
  html += '<div class="bar-chart">' + headers.map(([name, data]) =>
    `<div class="bar-item"><span class="bar-label">${esc(name)}</span><div class="bar-track"><div class="bar-fill ${data.present > data.missing ? 'success' : 'danger'}" style="width:${(data.present/max*100).toFixed(0)}%">${data.present}/${max}</div></div></div>`
  ).join('') + '</div></div>';

  $('#securityContent').innerHTML = exportBtn('security') + html;
}

// ── External Links ──
// Lazy-loaded when the user navigates to the tab. Server returns the
// deduped list with cached statuses; the "Check status codes" button
// streams live HEAD/GET probes via SSE.
let _extLinksData = null;
let _extLinksChecking = false;
let _extLinksFilter = '';
let _extLinksStatusFilter = '';

async function loadExternalLinks() {
  const wrap = document.getElementById('externalLinksContent');
  if (!wrap) return;
  if (!currentCrawlId) {
    wrap.innerHTML = '<p style="color:var(--text-muted);padding:20px">Load a crawl first.</p>';
    return;
  }
  // A check already running for this tab — just re-render what we have.
  if (_extLinksChecking && _extLinksData) {
    renderExternalLinks();
    return;
  }
  wrap.innerHTML = '<p style="color:var(--text-muted);padding:20px">Loading external links…</p>';
  try {
    const res = await fetch(`/api/crawls/${currentCrawlId}/external-links`);
    if (!res.ok) throw new Error((await res.json()).error || 'failed');
    _extLinksData = await res.json();
    renderExternalLinks();
    // Auto-probe any links we don't yet have a status for. Cached
    // statuses persist server-side, so this only fires real work the
    // first time (or after new pages are crawled).
    const items = _extLinksData.items || [];
    const unchecked = items.filter(i => i.status == null).length;
    if (unchecked > 0 && !_extLinksChecking) startExternalCheck(false);
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--danger);padding:20px">Failed to load: ${esc(e.message)}</p>`;
  }
}

function renderExternalLinks() {
  const wrap = document.getElementById('externalLinksContent');
  if (!wrap || !_extLinksData) return;
  const items = _extLinksData.items || [];
  const total = items.length;
  const checked = items.filter(i => i.status != null).length;
  const c4 = items.filter(i => i.status != null && i.status >= 400 && i.status < 500).length;
  const s5 = items.filter(i => i.status != null && i.status >= 500).length;
  const errs = items.filter(i => i.error && i.status == null).length;
  const redirects = items.filter(i => i.status != null && i.status >= 300 && i.status < 400).length;
  const ok = items.filter(i => i.status != null && i.status >= 200 && i.status < 300).length;

  const tone = (s, err) => err ? 'danger' : (s == null ? 'muted' : s >= 200 && s < 300 ? 'success' : s >= 300 && s < 400 ? 'warning' : 'danger');
  const statusCell = (i) => {
    if (i.error && i.status == null) return `<span class="badge badge-danger" title="${esc(i.error)}">err</span>`;
    if (i.status == null) return '<span class="badge" style="background:var(--bg-hover);color:var(--text-muted)">—</span>';
    return statusBadge(i.status);
  };

  const filterText = (_extLinksFilter || '').toLowerCase();
  const statusFilter = _extLinksStatusFilter;
  const filtered = items.filter(i => {
    if (filterText && !(i.href.toLowerCase().includes(filterText)
        || (i.sources || []).some(s => (s.url || '').toLowerCase().includes(filterText)
                                    || (s.anchor || '').toLowerCase().includes(filterText)))) return false;
    if (statusFilter === 'checked' && i.status == null && !i.error) return false;
    if (statusFilter === 'ok' && !(i.status >= 200 && i.status < 300)) return false;
    if (statusFilter === '3xx' && !(i.status >= 300 && i.status < 400)) return false;
    if (statusFilter === '4xx' && !(i.status >= 400 && i.status < 500)) return false;
    if (statusFilter === '5xx' && !(i.status >= 500)) return false;
    if (statusFilter === 'err' && !(i.error && i.status == null)) return false;
    if (statusFilter === 'unchecked' && (i.status != null || i.error)) return false;
    return true;
  });

  const rowsHtml = filtered.slice(0, 2000).map(i => {
    const srcCount = i.sourceCount || (i.sources || []).length;
    const topSources = (i.sources || []).slice(0, 3).map(s => urlLink(s.url)).join('<br>');
    const moreSrc = srcCount > 3
      ? `<a href="#" class="ext-show-sources" data-url="${esc(i.href)}" style="color:var(--primary);font-size:11px;margin-top:2px;display:inline-block">Show all ${srcCount}…</a>`
      : '';
    return `<tr data-ext-row="${esc(i.href)}">
      <td style="font-size:12px"><a href="${esc(i.href)}" target="_blank" rel="noopener nofollow" style="color:var(--primary);word-break:break-all" title="Right-click to see all source pages">${esc(i.href)}</a></td>
      <td style="text-align:center">${statusCell(i)}</td>
      <td style="text-align:center"><a href="#" class="ext-show-sources" data-url="${esc(i.href)}" style="color:var(--text-muted);text-decoration:none" title="Show all source pages">${srcCount}</a></td>
      <td style="font-size:11px">${topSources}${moreSrc}</td>
    </tr>`;
  }).join('');

  // Clickable scorecard → sets the status filter. Clicking the active
  // one again clears it. `key` matches the values used in the filter
  // predicate above.
  const card = (key, label, value, colorClass) => {
    const active = statusFilter === key;
    return `<div class="stat-card" data-ext-filter="${key}" title="Click to filter"
      style="cursor:pointer;${active ? 'outline:2px solid var(--primary);outline-offset:-2px;' : ''}">
      <div class="label">${label}</div><div class="value ${colorClass}">${value}</div></div>`;
  };

  wrap.innerHTML = `
    <div style="padding:20px">
      <div class="stats-grid">
        ${card('', 'External Links', total.toLocaleString(), 'info')}
        ${card('ok', 'OK (2xx)', ok.toLocaleString(), 'success')}
        ${card('3xx', 'Redirects (3xx)', redirects.toLocaleString(), redirects > 0 ? 'warning' : 'success')}
        ${card('4xx', '4xx Client Error', c4.toLocaleString(), c4 > 0 ? 'danger' : 'success')}
        ${card('5xx', '5xx Server Error', s5.toLocaleString(), s5 > 0 ? 'danger' : 'success')}
        ${card('err', 'Conn Errors', errs.toLocaleString(), errs > 0 ? 'danger' : 'success')}
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0">
        <input type="text" id="extFilterInput" placeholder="Filter by URL, source, or anchor…" value="${esc(_extLinksFilter)}" style="flex:1;min-width:240px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
        <select id="extStatusFilter" style="padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          <option value=""${statusFilter === '' ? ' selected' : ''}>All statuses</option>
          <option value="checked"${statusFilter === 'checked' ? ' selected' : ''}>Checked</option>
          <option value="ok"${statusFilter === 'ok' ? ' selected' : ''}>2xx OK</option>
          <option value="3xx"${statusFilter === '3xx' ? ' selected' : ''}>3xx Redirect</option>
          <option value="4xx"${statusFilter === '4xx' ? ' selected' : ''}>4xx Client error</option>
          <option value="5xx"${statusFilter === '5xx' ? ' selected' : ''}>5xx Server error</option>
          <option value="err"${statusFilter === 'err' ? ' selected' : ''}>Connection errors</option>
          <option value="unchecked"${statusFilter === 'unchecked' ? ' selected' : ''}>Unchecked</option>
        </select>
        ${checked > 0 && !_extLinksChecking ? `<button id="extRecheckBtn" class="btn btn-secondary" style="padding:8px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Re-check all</button>` : ''}
        <button id="extExportXlsxBtn" class="btn btn-secondary" title="Export the current filtered view to Excel" style="padding:8px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Export Excel</button>
        <button id="extExportPdfBtn" class="btn btn-secondary" title="Export the current filtered view to PDF" style="padding:8px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Export PDF</button>
      </div>

      <div id="extLinksProgress" style="display:${_extLinksChecking ? 'block' : 'none'};margin-bottom:12px"></div>

      <div class="section-card">
        <h3>External Links (${filtered.length.toLocaleString()}${filtered.length > 2000 ? ' — showing first 2000' : ''})</h3>
        ${filtered.length === 0 ? '<p style="color:var(--text-muted);padding:14px">No external links match the current filter.</p>' : `
        <table>
          <thead><tr><th>External URL</th><th style="text-align:center">Status</th><th style="text-align:center">Sources</th><th>Top source pages</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>`}
      </div>
    </div>`;

  wrap.querySelectorAll('[data-ext-filter]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.extFilter;
      _extLinksStatusFilter = (_extLinksStatusFilter === key) ? '' : key;
      renderExternalLinks();
    });
  });
  document.getElementById('extRecheckBtn')?.addEventListener('click', () => startExternalCheck(true));
  document.getElementById('extFilterInput')?.addEventListener('input', (e) => {
    _extLinksFilter = e.target.value;
    renderExternalLinks();
    document.getElementById('extFilterInput')?.focus();
  });
  document.getElementById('extStatusFilter')?.addEventListener('change', (e) => {
    _extLinksStatusFilter = e.target.value;
    renderExternalLinks();
  });
  document.getElementById('extExportXlsxBtn')?.addEventListener('click', () => exportExternalLinks('xlsx'));
  document.getElementById('extExportPdfBtn')?.addEventListener('click', () => exportExternalLinks('pdf'));

  // "Sources" cell + "Show all N…" link → open the modal listing every
  // page that links to this external URL. Right-clicking the URL itself
  // opens the same modal (suppressing the browser context menu) so the
  // user can drill in without having to scroll to the sources column.
  wrap.querySelectorAll('.ext-show-sources').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showExternalSources(el.dataset.url);
    });
  });
  wrap.querySelectorAll('tr[data-ext-row]').forEach(tr => {
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showExternalSources(tr.dataset.extRow);
    });
  });
}

function exportExternalLinks(format) {
  if (!currentCrawlId) return;
  const params = new URLSearchParams();
  if (_extLinksStatusFilter) params.set('status', _extLinksStatusFilter);
  if (_extLinksFilter) params.set('q', _extLinksFilter);
  const qs = params.toString();
  const url = `/api/crawls/${currentCrawlId}/external-links/export/${format}${qs ? '?' + qs : ''}`;
  window.open(url, '_blank');
}

async function showExternalSources(targetUrl) {
  // Reuse the existing .modal-overlay pattern from the page-detail modal.
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal" style="max-width:880px">
    <button class="modal-close">&times;</button>
    <h2 style="margin-top:0;word-break:break-all;font-size:16px">${esc(targetUrl)}</h2>
    <p style="color:var(--text-muted);font-size:13px;margin:4px 0 14px">Pages on your site that link to this URL</p>
    <div id="extSourcesBody"><p style="color:var(--text-muted)">Loading…</p></div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  const onEsc = (e) => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
  try {
    const res = await fetch(`/api/crawls/${currentCrawlId}/external-links/sources?url=${encodeURIComponent(targetUrl)}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const sources = data.sources || [];
    const body = modal.querySelector('#extSourcesBody');
    if (!sources.length) { body.innerHTML = '<p style="color:var(--text-muted)">No source pages found.</p>'; return; }
    body.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${sources.length.toLocaleString()} source page${sources.length === 1 ? '' : 's'}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="text-align:left;background:var(--bg-hover)">
          <th style="padding:6px 8px;border-bottom:1px solid var(--border)">Source page</th>
          <th style="padding:6px 8px;border-bottom:1px solid var(--border)">Anchor</th>
          <th style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">Nofollow</th>
        </tr></thead>
        <tbody>${sources.map(s => `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid var(--border)"><a href="${esc(s.url)}" target="_blank" rel="noopener" style="color:var(--primary);word-break:break-all">${esc(s.url)}</a></td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text-muted)">${esc(s.anchor || '')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:center">${s.isNofollow ? '✓' : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`;
  } catch (e) {
    modal.querySelector('#extSourcesBody').innerHTML = `<p style="color:var(--danger)">Failed to load: ${esc(e.message)}</p>`;
  }
}

async function startExternalCheck(force) {
  if (_extLinksChecking || !currentCrawlId) return;
  _extLinksChecking = true;
  renderExternalLinks();

  const drawBar = (done, total, finished) => {
    const progress = document.getElementById('extLinksProgress');
    if (!progress) return;
    progress.style.display = 'block';
    const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    progress.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;margin-bottom:6px">
        <span style="font-weight:600">${finished ? 'Done.' : 'Probing external URLs…'}</span>
        <span style="color:var(--text-muted)"><b style="color:var(--text)">${done.toLocaleString()}</b> / ${total.toLocaleString()}</span>
      </div>
      <div style="height:10px;background:var(--bg-input);border-radius:999px;overflow:hidden;border:1px solid var(--border)">
        <div style="height:100%;width:${pct}%;background:${finished ? 'linear-gradient(135deg,#16A34A,#22C55E)' : 'linear-gradient(135deg,#6366F1,#8B5CF6,#6366F1)'};transition:width .3s ease"></div>
      </div>`;
  };

  // Live count updates on the scorecards without re-rendering the whole
  // tab (which would steal focus from the filter input).
  const updateCards = () => {
    const items = _extLinksData?.items || [];
    const counts = { total: items.length, checked: 0, ok: 0, redirects: 0, broken: 0 };
    for (const i of items) {
      if (i.status == null && !i.error) continue;
      counts.checked++;
      if (i.error) counts.broken++;
      else if (i.status >= 200 && i.status < 300) counts.ok++;
      else if (i.status >= 300 && i.status < 400) counts.redirects++;
      else if (i.status >= 400) counts.broken++;
    }
    const set = (selector, val) => { const el = document.querySelector(selector); if (el) el.textContent = val.toLocaleString(); };
    set('[data-ext-filter=""] .value', counts.total);
    set('[data-ext-filter="checked"] .value', counts.checked);
    set('[data-ext-filter="ok"] .value', counts.ok);
    set('[data-ext-filter="3xx"] .value', counts.redirects);
    set('[data-ext-filter="broken"] .value', counts.broken);
  };

  // Throttled full re-render so the table picks up new statuses without
  // re-rendering on every single SSE event (2000+ rows).
  let pending = false;
  const scheduleTableRefresh = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (!_extLinksChecking) return;
      // Re-render but restore focus + caret position on the filter input.
      const inp = document.getElementById('extFilterInput');
      const sel = inp ? { start: inp.selectionStart, end: inp.selectionEnd } : null;
      renderExternalLinks();
      if (sel) {
        const after = document.getElementById('extFilterInput');
        if (after) { after.focus(); after.setSelectionRange(sel.start, sel.end); }
      }
    }, 1500);
  };

  try {
    const res = await fetch(`/api/crawls/${currentCrawlId}/external-links/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!force })
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'start') {
            drawBar(evt.done || 0, evt.total, false);
          } else if (evt.type === 'progress') {
            drawBar(evt.done, evt.total, false);
          } else if (evt.type === 'result') {
            const it = _extLinksData.items.find(x => x.href === evt.url);
            if (it) {
              it.status = evt.status;
              it.error = evt.error;
              it.checkedAt = evt.checkedAt;
            }
            drawBar(evt.done, evt.total, false);
            updateCards();
            scheduleTableRefresh();
          } else if (evt.type === 'done') {
            drawBar(evt.done, evt.total, true);
          } else if (evt.type === 'error') {
            drawBar(0, 0, false);
            const p = document.getElementById('extLinksProgress');
            if (p) p.innerHTML = `<div style="color:var(--danger);font-size:12px">${esc(evt.message || 'Check error')}</div>`;
          }
        } catch { /* ignore malformed sse frame */ }
      }
    }
  } catch (e) {
    const p = document.getElementById('extLinksProgress');
    if (p) p.innerHTML = `<div style="color:var(--danger);font-size:12px">Check failed: ${esc(e.message)}</div>`;
  } finally {
    _extLinksChecking = false;
    renderExternalLinks();
    setTimeout(() => {
      const p = document.getElementById('extLinksProgress');
      if (p && !_extLinksChecking) p.style.display = 'none';
    }, 3000);
  }
}

// ── Internal Links ──
function renderLinks(analysis) {
  const r = analysis.internalLinkAnalysis;
  const cd = r.crawlDepth || { total: 0, buckets: [], within3ClicksPct: 0 };

  let html = `<div class="stats-grid">
    ${statCard('Orphan Pages', r.orphanCount, r.orphanCount > 0 ? 'warning' : 'success')}
    ${statCard('Avg Internal Links', r.avgInternalLinks, '')}
    ${statCard('Within 3 Clicks', cd.within3ClicksPct + '%', cd.within3ClicksPct >= 80 ? 'success' : cd.within3ClicksPct >= 50 ? 'warning' : 'danger')}
  </div>`;

  // Pages Crawl Depth — distribution of pages by click-distance from homepage
  if (cd.total > 0) {
    const deep = cd.buckets.find(b => b.key === '4+');
    const deepPct = deep ? deep.percentage : 0;
    html += `<div class="section-card"><h3>Pages Crawl Depth</h3>
      <p style="color:var(--text-muted);margin-bottom:16px;font-size:13px">
        How many clicks from the homepage each page sits at. As a rule of thumb, important pages should be reachable within 3 clicks — deeper pages get less crawl budget and less link equity.
        ${deepPct > 30 ? `<strong style="color:var(--warning)"> ${deepPct}% of pages are 4+ clicks deep — consider flattening the site structure.</strong>` : ''}
      </p>
      <div class="pie-chart-container">
        ${renderPieChart(cd.buckets, 200)}
        <div class="pie-legend">
          ${cd.buckets.map(b => `<div class="pie-legend-item">
            <div class="pie-legend-dot" style="background:${b.color}"></div>
            <span class="pie-legend-label">${esc(b.label)}</span>
            <span class="pie-legend-count">${b.count.toLocaleString()} (${b.percentage}%)</span>
          </div>`).join('')}
          <div class="pie-legend-item" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px;font-weight:600">
            <div class="pie-legend-dot" style="background:transparent"></div>
            <span class="pie-legend-label">Total</span>
            <span class="pie-legend-count">${cd.total.toLocaleString()} pages</span>
          </div>
        </div>
      </div>
    </div>`;

    // List the deepest pages so the user can act on them
    const deepUrls = deep && deep.urls ? deep.urls : [];
    if (deepUrls.length > 0) {
      html += `<div class="section-card"><h3>Pages 4+ Clicks Deep (${deep.count.toLocaleString()})</h3>
        <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">Consider adding internal links from higher-level pages to make these easier to discover.</p>
        <table><thead><tr><th>URL</th></tr></thead>
        <tbody>${deepUrls.slice(0, 100).map(u => `<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table>
        ${deepUrls.length > 100 ? `<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Showing 100 of ${deep.count.toLocaleString()}</p>` : ''}
      </div>`;
    }
  }

  if (r.orphanPages.length > 0) {
    html += `<div class="section-card"><h3>Orphan Pages (${r.orphanCount})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">Pages with no internal links pointing to them.</p>
      <table><thead><tr><th>URL</th></tr></thead>
      <tbody>${r.orphanPages.slice(0, 50).map(u => `<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  if (r.topLinkedPages.length > 0) {
    html += `<div class="section-card"><h3>Most Linked Pages (Top 50)</h3>
      <table><thead><tr><th>URL</th><th>Inbound Links</th></tr></thead>
      <tbody>${r.topLinkedPages.map(p =>
        `<tr><td>${urlLink(p.url)}</td><td><strong>${p.inboundLinks}</strong></td></tr>`
      ).join('')}</tbody></table></div>`;
  }

  $('#linksContent').innerHTML = exportBtn('links') + html
    + '<div id="malformedLinksSection" style="margin-top:18px"></div>';
  loadMalformedLinks();
}

// ── Malformed links ──
// Links the author wrote without a scheme (e.g. href="www.foo.ch") that
// the browser resolves as a broken internal path. Flagged at crawl time.
async function loadMalformedLinks() {
  const wrap = document.getElementById('malformedLinksSection');
  if (!wrap || !currentCrawlId) return;
  try {
    const res = await fetch(`/api/crawls/${currentCrawlId}/malformed-links`);
    if (!res.ok) return;
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) { wrap.innerHTML = ''; return; }
    const rows = items.slice(0, 1000).map(i => {
      const top = (i.sources || []).slice(0, 3).map(s => urlLink(s.url)).join('<br>');
      const more = i.sourceCount > 3 ? `<div style="color:var(--text-muted);font-size:11px">+${i.sourceCount - 3} more</div>` : '';
      return `<tr>
        <td style="font-size:12px;color:var(--danger);word-break:break-all">${esc(i.rawHref || i.resolved)}</td>
        <td style="font-size:12px;color:var(--text-muted);word-break:break-all">${esc(i.resolved)}</td>
        <td style="text-align:center;color:var(--text-muted)">${i.sourceCount}</td>
        <td style="font-size:11px">${top}${more}</td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `
      <div class="section-card" style="border-left:4px solid var(--warning)">
        <h3>Malformed links (${items.length.toLocaleString()})</h3>
        <p style="color:var(--text-muted);font-size:12px;margin:0 0 10px">
          These links were written without <code>https://</code> (e.g. <code>www.example.ch</code>), so the browser treats them as a path under the current page — producing a broken internal URL. Fix by adding the scheme.
        </p>
        <table>
          <thead><tr><th>Written as</th><th>Resolves to (broken)</th><th style="text-align:center">Count</th><th>Top source pages</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch { /* non-fatal */ }
}

window.loadCrawl = async function(id) {
  setCurrentCrawlId(id);
  // Reset per-crawl cached datasets so tabs reload for the newly opened crawl
  _nfData = null;
  _imgAssetsData = null;
  _extLinksData = null;
  // Cache-bust + force a fresh network round-trip so deployed analyzer fixes
  // (versioned via Analyzer.VERSION in the cached blob) are picked up
  // immediately instead of any HTTP/proxy cache serving the old report.
  const res = await fetch(`/api/crawls/${id}/analysis?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return alert('Could not load analysis');
  const analysis = await res.json();
  analysisData = analysis;

  const crawlRes = await fetch(`/api/crawls/${id}`);
  const crawl = await crawlRes.json();

  renderDashboard(crawl.stats, analysis);
  loadPages();
  // Issues tab removed
  renderHreflang(analysis);
  renderCanonicals(analysis);
  renderConflicts(analysis);
  renderRedirects(analysis);
  renderContent(analysis);
  renderImages(analysis);
  renderStructuredData(analysis);
  renderSecurity(analysis);
  renderLinks(analysis);
  renderAiBots(analysis);
  renderSearchEngines(analysis);
  renderSitemaps(analysis);
  renderStatusCodes(analysis);
  renderAnchors(analysis);
  renderMetaTitles(analysis);
  renderMetaDescriptions(analysis);
  renderHeadings(analysis);
  renderDirectives(analysis);
  renderSummary(analysis);

  $('#emptyState').classList.add('hidden');
  $('#dashboardContent').classList.remove('hidden');

  $$('.nav-link').forEach(l => l.classList.remove('active'));
  $('[data-view="dashboard"]').classList.add('active');
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-dashboard').classList.add('active');

  // Load history if this is a saved project
  if (crawl.saved || $('#optSaveProject').checked) {
    try {
      const domain = new URL(crawl.url).hostname;
      $('#urlInput').value = crawl.url;
      loadProjectHistory();
    } catch { /* ignore */ }
  }
};

window.deleteCrawl = async function(id) {
  if (!confirm('Delete this crawl?')) return;
  await fetch(`/api/crawls/${id}`, { method: 'DELETE' });
};

// ── 404 Pages (source attribution) ──────────────────────────────────────
// Shows every 4xx URL together with WHERE it is referenced from — anchors,
// canonicals, hreflangs, images, pagination tags, sitemap, redirects — with
// per-type filter tiles, a text filter, and filtered Excel export.
let _nfData = null;        // { items, typeCounts, total }
let _nfTypeFilter = 'all';
let _nfLoading = false;

// Plain-text labels only — an earlier version put literal "<a href>" in a
// label, which the browser parsed as a real (unclosed) anchor tag and turned
// half the view into underlined links. Colors are a CVD-validated categorical
// palette (identity, not status), assigned per type in this fixed order and
// shared by the tiles, the pie chart and the table badges.
const NF_TYPE_META = {
  anchor:     { label: 'Anchor links',    hex: '#6366F1' },
  canonical:  { label: 'Canonical tags',  hex: '#F59E0B' },
  hreflang:   { label: 'Hreflang tags',   hex: '#0EA5E9' },
  image:      { label: 'Image tags',      hex: '#EC4899' },
  pagination: { label: 'Pagination tags', hex: '#A16207' },
  sitemap:    { label: 'XML Sitemap',     hex: '#14B8A6' },
  redirect:   { label: 'Redirects',       hex: '#8B5CF6' }
};
const nfTypeLabel = (t) => (NF_TYPE_META[t] && NF_TYPE_META[t].label) || t;

async function loadNotFoundView(force) {
  const wrap = $('#notfoundContent');
  if (!wrap) return;
  if (!currentCrawlId) { wrap.innerHTML = '<p style="color:var(--text-muted)">Run a crawl first.</p>'; return; }
  if (_nfData && !force) { renderNotFound(); return; }
  if (_nfLoading) return;
  _nfLoading = true;
  wrap.innerHTML = '<p style="color:var(--text-muted)">Cross-referencing 4xx URLs against every anchor, canonical, hreflang, image and pagination tag…</p>';
  try {
    const res = await fetch(`/api/crawls/${currentCrawlId}/broken-sources`, { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json()).error || 'HTTP ' + res.status);
    _nfData = await res.json();
    _nfTypeFilter = 'all';
    renderNotFound();
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--danger)">Failed to load: ${esc(e.message)}</p>`;
  } finally {
    _nfLoading = false;
  }
}

function filterNotFound(type) {
  _nfTypeFilter = (_nfTypeFilter === type) ? 'all' : type;
  renderNotFound();
}

function _nfFilteredItems() {
  const items = (_nfData && _nfData.items) || [];
  const q = ($('#nfTextFilter')?.value || '').trim().toLowerCase();
  return items.filter(it => {
    if (_nfTypeFilter !== 'all' && !it.types.includes(_nfTypeFilter)) return false;
    if (q && !it.url.toLowerCase().includes(q) && !prettyUrl(it.url).toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderNotFound() {
  const wrap = $('#notfoundContent');
  if (!wrap || !_nfData) return;
  const counts = _nfData.typeCounts || {};
  const f = _nfTypeFilter;

  // Plain clickable cards — no link styling. The active filter gets a primary
  // border; inactive ones dim slightly. A colored identity dot ties each tile
  // to its pie slice and table badge.
  const tile = (key, label, count, hex) => {
    const active = f === key
      ? 'border:2px solid var(--primary);cursor:pointer;'
      : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.55') + ';';
    const dot = hex ? `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${hex};margin-right:6px"></span>` : '';
    return `<div class="stat-card" style="${active}user-select:none" onclick="filterNotFound('${key}')">
      <div class="stat-value">${count.toLocaleString()}</div>
      <div class="stat-label">${dot}${esc(label)}</div>
    </div>`;
  };

  let html = `<div class="stats-grid">
    ${tile('all', 'All 4xx pages', _nfData.total, null)}
    ${Object.keys(NF_TYPE_META).map(t => tile(t, NF_TYPE_META[t].label, counts[t] || 0, NF_TYPE_META[t].hex)).join('')}
  </div>`;

  // Camembert: share of broken pages per referencing source type. Slices keep
  // the fixed type order (palette adjacency was validated in that order).
  const pieData = Object.keys(NF_TYPE_META)
    .map(t => ({ label: NF_TYPE_META[t].label, color: NF_TYPE_META[t].hex, count: counts[t] || 0 }))
    .filter(d => d.count > 0);
  const pieTotal = pieData.reduce((s, d) => s + d.count, 0) || 1;
  pieData.forEach(d => { d.percentage = ((d.count / pieTotal) * 100).toFixed(1); });
  if (pieData.length > 0) {
    html += `<div class="section-card"><h3>Where the 404s come from</h3>
      <p style="color:var(--text-muted);font-size:12px;margin:4px 0 10px">Broken pages per referencing source — a page referenced from several places counts once per source type.</p>
      <div class="pie-chart-container">
        ${renderPieChart(pieData, 200)}
        <div class="pie-legend">
          ${pieData.map(s => `<div class="pie-legend-item">
            <div class="pie-legend-dot" style="background:${s.color}"></div>
            <span class="pie-legend-label">${esc(s.label)}</span>
            <span class="pie-legend-count">${s.count.toLocaleString()} (${s.percentage}%)</span>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  const items = _nfFilteredItems();
  const CAP = 1000;
  const shown = items.slice(0, CAP);
  const typeBadge = (t) => {
    const m = NF_TYPE_META[t] || {};
    return `<span class="badge badge-muted" style="margin:1px" title="${esc(m.label || t)}"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${m.hex || 'var(--text-muted)'};margin-right:4px"></span>${esc(t)}</span>`;
  };

  html += `<div class="section-card">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <h3 style="margin:0">Broken pages ${f !== 'all' ? `referenced via ${esc(nfTypeLabel(f))}` : ''} (${items.length.toLocaleString()})</h3>
      <input id="nfTextFilter" placeholder="Filter URLs…" value="${esc($('#nfTextFilter')?.value || '')}"
        style="margin-left:auto;padding:8px 12px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;min-width:220px">
      <button id="nfExportBtn" class="btn btn-secondary" style="padding:8px 14px">Export to Excel</button>
    </div>
    ${items.length === 0
      ? '<p style="color:var(--text-muted);padding:12px 0">No 4xx pages match this filter. 🎉</p>'
      : `<table><thead><tr>
          <th style="width:48px;text-align:right">#</th>
          <th>404 URL</th>
          <th style="text-align:center">Status</th>
          <th>Found in</th>
          <th style="text-align:center">Refs</th>
          <th>Source pages (where it's referenced)</th>
        </tr></thead>
        <tbody>${shown.map((it, i) => {
          const srcs = f === 'all' ? it.sources : it.sources.filter(s => s.type === f);
          const srcRows = srcs.slice(0, 5).map(s =>
            `<div style="margin:2px 0">${typeBadge(s.type)} ${s.from && /^https?:/i.test(s.from) ? urlLink(s.from) : esc(s.from || '')}${s.detail ? ` <span style="color:var(--text-muted);font-size:11px">· ${esc(s.detail)}</span>` : ''}</div>`
          ).join('');
          const more = srcs.length > 5 ? `<div style="color:var(--text-muted);font-size:11px">+${srcs.length - 5} more</div>` : '';
          return `<tr>
            <td style="text-align:right;color:var(--text-muted)">${i + 1}</td>
            <td>${urlLink(it.url)}</td>
            <td style="text-align:center">${statusBadge(it.status)}</td>
            <td style="white-space:nowrap">${it.types.map(typeBadge).join('')}</td>
            <td style="text-align:center;color:var(--text-muted)">${it.sourceCount}</td>
            <td style="font-size:12px">${srcRows}${more}</td>
          </tr>`;
        }).join('')}</tbody></table>
        ${items.length > CAP ? `<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Showing first ${CAP.toLocaleString()} of ${items.length.toLocaleString()} — refine filters to narrow, or export for the full list.</p>` : ''}`}
  </div>`;

  wrap.innerHTML = html;
  // Re-render on typing, then restore focus + caret — innerHTML replacement
  // destroys the input element, which would otherwise eat the focus after
  // every keystroke.
  $('#nfTextFilter')?.addEventListener('input', () => {
    renderNotFound();
    const el = $('#nfTextFilter');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  });
  $('#nfExportBtn')?.addEventListener('click', exportNotFound);
}

function exportNotFound() {
  const items = _nfFilteredItems();
  if (!items.length) return alert('Nothing to export with the current filter.');
  const f = _nfTypeFilter;
  const rows = items.map((it, i) => {
    const srcs = f === 'all' ? it.sources : it.sources.filter(s => s.type === f);
    return {
      '#': i + 1,
      'URL': it.url,
      'Status': it.status,
      'Found In': it.types.map(nfTypeLabel).join(', '),
      'Reference Count': it.sourceCount,
      'Sources': srcs.slice(0, 50).map(s => `[${s.type}] ${s.from}${s.detail ? ' (' + s.detail + ')' : ''}`).join('\n')
        + (srcs.length > 50 ? `\n…and ${srcs.length - 50} more` : '')
    };
  });
  const suffix = f === 'all' ? 'all-sources' : f;
  fetch(`/api/crawls/${currentCrawlId}/export-filtered-xlsx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, sheetName: '404 Pages (' + suffix + ')', fileName: `404-pages_${suffix}.xlsx` })
  }).then(async res => {
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `404-pages_${suffix}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  }).catch(e => alert(e.message));
}

// ── Status Codes ──
let _statusCodesData = null;
let _statusCodesActiveFilter = 'all';

function renderStatusCodes(analysis) {
  const r = analysis.statusCodesReport;
  if (!r) { $('#statuscodesContent').innerHTML = '<p style="color:var(--text-muted)">No data.</p>'; return; }
  _statusCodesData = r;
  _statusCodesActiveFilter = 'all';
  _statusContentTypeFilter = 'all';
  _renderStatusCodesUI();
  ensureImageAssetsForStatus();
}

let _statusContentTypeFilter = 'all';

// Classify a URL by its file extension so the Status Codes view can
// segregate HTML pages from broken PDFs / images / Office docs. SF
// keeps those in their own buckets; we previously mixed them all.
function classifyUrlContentType(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/\.(pdf)$/.test(path)) return 'pdf';
    if (/\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?)$/.test(path)) return 'image';
    if (/\.(docx?|xlsx?|pptx?|odt|ods|odp|csv|rtf)$/.test(path)) return 'office';
    if (/\.(zip|rar|7z|tar|gz|bz2)$/.test(path)) return 'archive';
    if (/\.(mp4|mp3|avi|mov|wmv|mkv|webm|ogg|wav|flac)$/.test(path)) return 'media';
    if (/\.(js|css|woff2?|ttf|eot|map|json|xml|txt)$/.test(path)) return 'asset';
    // No extension, or .html/.htm/.php/.aspx/.jsp — treat as HTML page.
    if (/\.(html?|php|aspx?|jsp|cfm|cgi)$/.test(path) || !/\.[a-z0-9]{1,5}$/.test(path)) return 'html';
    return 'other';
  } catch { return 'other'; }
}

window.filterStatusContentType = function(key) {
  _statusContentTypeFilter = (_statusContentTypeFilter === key && key !== 'all') ? 'all' : key;
  _renderStatusCodesUI();
};

function statusTierOf(statusCode, error) {
  if (statusCode == null) return 'error';
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  if (statusCode >= 500) return '5xx';
  return 'error';
}

function _renderStatusCodesUI() {
  const r = _statusCodesData;
  const f = _statusCodesActiveFilter;
  const ct = _statusContentTypeFilter;
  // Images are referenced via <img src> and aren't crawled as pages, so
  // their statuses live in the separate image-assets dataset. When the
  // user selects "Images" we render the FULL image set (probed statuses),
  // not the handful of image URLs that happened to be crawled as pages.
  const imageView = ct === 'image';
  const GROUP_META = {
    '2xx':   { label: '2xx (Success)',      color: '#16A34A' },
    '3xx':   { label: '3xx (Redirect)',     color: '#D97706' },
    '4xx':   { label: '4xx (Client Error)', color: '#DC2626' },
    '5xx':   { label: '5xx (Server Error)', color: '#7F1D1D' },
    'error': { label: 'Conn Errors',        color: '#6B7085' }
  };

  // Build the status groups for whichever dataset is active.
  let groups;
  if (imageView) {
    groups = {};
    for (const k of Object.keys(GROUP_META)) groups[k] = { ...GROUP_META[k], urls: [] };
    for (const it of (_imgStatusData?.items || [])) {
      const tier = statusTierOf(it.status, it.error);
      groups[tier].urls.push({ url: it.href, statusCode: it.status, error: it.error, sources: it.sources, sourceCount: it.sourceCount });
    }
  } else {
    const passes = (u) => ct === 'all' || classifyUrlContentType(u.url) === ct;
    groups = {};
    for (const key of Object.keys(r.groups)) groups[key] = { ...r.groups[key], urls: r.groups[key].urls.filter(passes) };
  }
  const total = Object.values(groups).reduce((s, g) => s + g.urls.length, 0);

  // Content-type pills. Image count comes from the full image-assets set;
  // every other type from the crawled-pages classification.
  const ctCounts = { all: r.total, html: 0, image: 0, pdf: 0, office: 0, archive: 0, media: 0, asset: 0, other: 0 };
  for (const key of Object.keys(r.groups)) {
    for (const u of r.groups[key].urls) {
      const c = classifyUrlContentType(u.url);
      if (c !== 'image') ctCounts[c]++;   // images counted from the asset set below
    }
  }
  ctCounts.image = _imgStatusData ? (_imgStatusData.items || []).length : null;
  const ctPill = (key, label) => {
    const count = ctCounts[key];
    const shown = count == null ? '…' : count.toLocaleString();
    const active = ct === key;
    return `<button onclick="filterStatusContentType('${key}')" style="padding:6px 12px;border-radius:999px;border:1px solid ${active ? 'var(--primary)' : 'var(--border)'};background:${active ? 'var(--primary)' : 'var(--bg-input)'};color:${active ? '#fff' : 'var(--text)'};cursor:pointer;font-size:12px;font-weight:${active ? 600 : 500}">${esc(label)} <span style="opacity:.8;margin-left:4px">${shown}</span></button>`;
  };
  let html = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
    ${ctPill('all', 'All')}
    ${ctPill('html', 'HTML pages')}
    ${ctPill('image', 'Images')}
    ${ctPill('pdf', 'PDF')}
    ${ctPill('office', 'Office docs')}
    ${ctPill('media', 'Media')}
    ${ctPill('asset', 'JS/CSS/fonts')}
    ${ctPill('archive', 'Archives')}
    ${ctPill('other', 'Other')}
  </div>`;

  // In image view, show an export button + live-scan progress.
  if (imageView) {
    html += `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:6px">
      <div style="font-size:13px;color:var(--text-muted)">${(_imgStatusData ? (_imgStatusData.items || []).length : 0).toLocaleString()} image URLs${_imgStatusChecking ? ' — scanning…' : ''}</div>
      <button id="imgStatusExportBtn" class="btn btn-secondary" style="padding:6px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer;font-size:13px">Export Excel</button>
    </div>
    <div id="imgStatusProgress" style="display:${_imgStatusChecking ? 'block' : 'none'};margin-bottom:10px"></div>`;
  }

  const cardBtn = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterStatusCodes('${key}')">${statCardInner(label, count)}</div>`;
  };

  html += `<div class="stats-grid">
    ${cardBtn('all', imageView ? 'Total Images' : 'Total URLs', total, '')}
    ${cardBtn('2xx', '2xx Success', groups['2xx'].urls.length, 'success')}
    ${cardBtn('3xx', '3xx Redirect', groups['3xx'].urls.length, groups['3xx'].urls.length > 0 ? 'warning' : '')}
    ${cardBtn('4xx', '4xx Client Error', groups['4xx'].urls.length, groups['4xx'].urls.length > 0 ? 'danger' : 'success')}
    ${cardBtn('5xx', '5xx Server Error', groups['5xx'].urls.length, groups['5xx'].urls.length > 0 ? 'danger' : 'success')}
    ${cardBtn('error', 'Conn Errors', groups['error'].urls.length, groups['error'].urls.length > 0 ? 'danger' : '')}
  </div>`;

  // Pie chart from the active groups.
  const pieEntries = Object.keys(GROUP_META)
    .map(k => ({ key: k, label: GROUP_META[k].label, color: GROUP_META[k].color, count: groups[k].urls.length }))
    .filter(e => e.count > 0);
  const pieTotal = pieEntries.reduce((s, e) => s + e.count, 0) || 1;
  const pieData = pieEntries.map(e => ({ label: e.label, color: e.color, count: e.count, percentage: ((e.count / pieTotal) * 100).toFixed(1) }));
  if (pieData.length > 0) {
    html += `<div class="section-card"><h3>Status Code Distribution</h3>
      <div class="pie-chart-container">
        ${renderPieChart(pieData, 200)}
        <div class="pie-legend">
          ${pieData.map(s => `<div class="pie-legend-item">
            <div class="pie-legend-dot" style="background:${s.color}"></div>
            <span class="pie-legend-label">${esc(s.label)}</span>
            <span class="pie-legend-count">${s.count} (${s.percentage}%)</span>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  const groupOrder = f === 'all' ? ['2xx', '3xx', '4xx', '5xx', 'error'] : [f];
  for (const key of groupOrder) {
    const g = groups[key];
    if (!g || g.urls.length === 0) continue;
    const showSources = imageView;
    html += `<div class="section-card" style="border-left:4px solid ${g.color}">
      <h3>${esc(g.label)} (${g.urls.length})</h3>
      <table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th><th>Status</th>${key === '3xx' && !imageView ? '<th>Redirects To</th>' : ''}${key === 'error' ? '<th>Error</th>' : ''}${showSources ? '<th>Used on</th>' : ''}</tr></thead>
      <tbody>${g.urls.slice(0, 500).map((u, i) => `<tr>
        <td style="text-align:right;color:var(--text-muted)">${i+1}</td>
        <td>${urlLink(u.url)}</td>
        <td>${u.statusCode ? statusBadge(u.statusCode) : '<span class="badge badge-danger">Error</span>'}</td>
        ${key === '3xx' && !imageView ? `<td>${u.finalUrl ? urlLink(u.finalUrl) : '-'}</td>` : ''}
        ${key === 'error' ? `<td style="font-size:12px;color:var(--text-muted)">${esc(u.error || '')}</td>` : ''}
        ${showSources ? `<td style="font-size:11px">${(u.sources || []).slice(0, 2).map(s => urlLink(s.url)).join('<br>')}${(u.sourceCount || 0) > 2 ? `<div style="color:var(--text-muted);font-size:11px">+${u.sourceCount - 2} more</div>` : ''}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#statuscodesContent').innerHTML = exportBtn('statuscodes') + html;
  document.getElementById('imgStatusExportBtn')?.addEventListener('click', () => {
    window.open(`/api/crawls/${currentCrawlId}/image-assets/export/xlsx`, '_blank');
  });
}

// ── Image-asset status (feeds the "Images" content-type filter on the
// Status Codes tab) ──────────────────────────────────────────────────
// Images come from <img src> + asset <a href>, which aren't crawled as
// pages, so their statuses are probed on demand by the shared background
// checker and cached server-side.
let _imgStatusData = null;
let _imgStatusChecking = false;

async function ensureImageAssetsForStatus() {
  if (!currentCrawlId) return;
  if (_imgStatusData) { _renderStatusCodesUI(); return; }
  try {
    const res = await fetch('/api/crawls/' + currentCrawlId + '/image-assets');
    if (!res.ok) return;
    _imgStatusData = await res.json();
    _renderStatusCodesUI();
    const unchecked = (_imgStatusData.items || []).filter(i => i.status == null && !i.error).length;
    if (unchecked > 0 && !_imgStatusChecking) startImageStatusCheck();
  } catch { /* non-fatal */ }
}

async function startImageStatusCheck(force) {
  if (_imgStatusChecking || !currentCrawlId) return;
  _imgStatusChecking = true;
  _renderStatusCodesUI();
  const drawBar = (done, total, finished) => {
    const p = document.getElementById('imgStatusProgress');
    if (!p) return;
    p.style.display = 'block';
    const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    p.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">' + (finished ? 'Done.' : 'Checking image URLs…') + ' ' + done.toLocaleString() + ' / ' + total.toLocaleString() + '</div>' +
      '<div style="height:8px;background:var(--bg-input);border-radius:999px;overflow:hidden;border:1px solid var(--border)"><div style="height:100%;width:' + pct + '%;background:' + (finished ? 'linear-gradient(135deg,#16A34A,#22C55E)' : 'linear-gradient(135deg,#6366F1,#8B5CF6)') + ';transition:width .3s"></div></div>';
  };
  let pending = false;
  const refresh = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (_imgStatusChecking) _renderStatusCodesUI(); }, 1500); };
  try {
    const res = await fetch('/api/crawls/' + currentCrawlId + '/image-assets/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: !!force })
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const linesArr = buf.split('\n');
      buf = linesArr.pop() || '';
      for (const line of linesArr) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'start' || evt.type === 'progress') drawBar(evt.done || 0, evt.total, false);
          else if (evt.type === 'result') {
            const it = _imgStatusData.items.find(x => x.href === evt.url);
            if (it) { it.status = evt.status; it.error = evt.error; it.checkedAt = evt.checkedAt; }
            if (_imgAssetsData) { const a = _imgAssetsData.items.find(x => x.href === evt.url); if (a) { a.status = evt.status; a.error = evt.error; } }
            drawBar(evt.done, evt.total, false);
            refresh();
          } else if (evt.type === 'done') drawBar(evt.done, evt.total, true);
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    const p = document.getElementById('imgStatusProgress');
    if (p) p.innerHTML = '<div style="color:var(--danger);font-size:12px">Check failed: ' + esc(e.message) + '</div>';
  } finally {
    _imgStatusChecking = false;
    _renderStatusCodesUI();
  }
}


function filterStatusCodes(key) {
  _statusCodesActiveFilter = (_statusCodesActiveFilter === key) ? 'all' : key;
  _renderStatusCodesUI();
}

function statCardInner(label, value) {
  return `<div class="stat-value">${value}</div><div class="stat-label">${label}</div>`;
}

// ── Anchors ──
function renderAnchors(analysis) {
  const r = analysis.anchorsReport;
  if (!r) { $('#anchorsContent').innerHTML = '<p style="color:var(--text-muted)">No data.</p>'; return; }

  let html = `<div class="stats-grid">
    ${statCard('Links Without Anchor Text', r.totalEmptyAnchors, r.totalEmptyAnchors > 0 ? 'warning' : 'success')}
  </div>`;

  if (r.totalEmptyAnchors === 0) {
    html += `<div class="section-card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h3>All Internal Links Have Anchor Text</h3>
    </div>`;
  } else {
    html += `<div class="section-card">
      <h3>Internal Links Missing Anchor Text (${r.totalEmptyAnchors})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">These internal links have no visible anchor text, which reduces their SEO value and accessibility.</p>
      <table><thead><tr><th>Origin Page</th><th>Destination URL</th><th>Nofollow</th></tr></thead>
      <tbody>${r.emptyAnchors.slice(0, 500).map(a => `<tr>
        <td>${urlLink(a.from)}</td>
        <td>${urlLink(a.to)}</td>
        <td>${a.isNofollow ? '<span class="badge badge-warning">Yes</span>' : 'No'}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#anchorsContent').innerHTML = exportBtn('anchors') + html;
}

// ── Meta Titles ──
let _mtData = null, _mtFilter = 'all';
function renderMetaTitles(analysis) {
  _mtData = analysis.metaTitlesReport;
  if (!_mtData) { $('#metatitlesContent').innerHTML = '<p style="color:var(--text-muted)">No data.</p>'; return; }
  _mtFilter = 'all';
  _renderMT();
}
function filterMT(f) { _mtFilter = (_mtFilter === f) ? 'all' : f; _renderMT(); }
function _renderMT() {
  const r = _mtData, f = _mtFilter;
  const cb = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterMT('${key}')">${statCardInner(label, count)}</div>`;
  };
  let html = `<div class="stats-grid">
    ${cb('all', 'Total Pages', r.total, '')}
    ${cb('missing', 'Missing Title', r.missing.length, r.missing.length > 0 ? 'danger' : 'success')}
    ${cb('short', 'Too Short (<30)', r.tooShort.length, r.tooShort.length > 0 ? 'warning' : 'success')}
    ${cb('long', 'Too Long (>60)', r.tooLong.length, r.tooLong.length > 0 ? 'warning' : 'success')}
    ${cb('dup', 'Duplicates', r.duplicates.length, r.duplicates.length > 0 ? 'danger' : 'success')}
  </div>`;
  if (f === 'all' || f === 'missing') {
    if (r.missing.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Missing Title (${r.missing.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th></tr></thead><tbody>${r.missing.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'dup') {
    if (r.duplicates.length > 0) { html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Duplicate Titles (${r.duplicates.length} groups)</h3>`;
      for (const d of r.duplicates.slice(0,50)) html += `<div style="margin-bottom:16px;padding:12px;background:var(--bg-hover);border-radius:8px"><strong style="color:var(--text-muted)">"${esc(truncate(d.title,80))}"</strong> <span class="badge badge-danger">${d.count}x</span><table style="margin-top:8px"><tbody>${d.urls.map(u=>`<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
      html += `</div>`; }
  }
  if (f === 'all' || f === 'short') {
    if (r.tooShort.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Short (${r.tooShort.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th><th>Title</th><th>Len</th></tr></thead><tbody>${r.tooShort.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td><td>${esc(p.title)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'long') {
    if (r.tooLong.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Long (${r.tooLong.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th><th>Title</th><th>Len</th></tr></thead><tbody>${r.tooLong.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td><td>${esc(p.title)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('#metatitlesContent').innerHTML = exportBtn('metatitles') + html;
}

// ── Meta Descriptions ──
let _mdData = null, _mdFilter = 'all';
function renderMetaDescriptions(analysis) {
  _mdData = analysis.metaDescriptionsReport;
  if (!_mdData) { $('#metadescriptionsContent').innerHTML = '<p style="color:var(--text-muted)">No data.</p>'; return; }
  _mdFilter = 'all';
  _renderMD();
}
function filterMD(f) { _mdFilter = (_mdFilter === f) ? 'all' : f; _renderMD(); }
function _renderMD() {
  const r = _mdData, f = _mdFilter;
  const cb = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterMD('${key}')">${statCardInner(label, count)}</div>`;
  };
  let html = `<div class="stats-grid">
    ${cb('all', 'Total Pages', r.total, '')}
    ${cb('missing', 'Missing Desc', r.missing.length, r.missing.length > 0 ? 'danger' : 'success')}
    ${cb('short', 'Too Short (<70)', r.tooShort.length, r.tooShort.length > 0 ? 'warning' : 'success')}
    ${cb('long', 'Too Long (>160)', r.tooLong.length, r.tooLong.length > 0 ? 'warning' : 'success')}
    ${cb('dup', 'Duplicates', r.duplicates.length, r.duplicates.length > 0 ? 'danger' : 'success')}
  </div>`;
  if (f === 'all' || f === 'missing') {
    if (r.missing.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Missing Description (${r.missing.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th></tr></thead><tbody>${r.missing.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'dup') {
    if (r.duplicates.length > 0) { html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Duplicate Descriptions (${r.duplicates.length} groups)</h3>`;
      for (const d of r.duplicates.slice(0,50)) html += `<div style="margin-bottom:16px;padding:12px;background:var(--bg-hover);border-radius:8px"><strong style="color:var(--text-muted)">"${esc(truncate(d.description,80))}"</strong> <span class="badge badge-danger">${d.count}x</span><table style="margin-top:8px"><tbody>${d.urls.map(u=>`<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
      html += `</div>`; }
  }
  if (f === 'all' || f === 'short') {
    if (r.tooShort.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Short (${r.tooShort.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th><th>Description</th><th>Len</th></tr></thead><tbody>${r.tooShort.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td><td>${esc(p.metaDescription)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'long') {
    if (r.tooLong.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Long (${r.tooLong.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th><th>Description</th><th>Len</th></tr></thead><tbody>${r.tooLong.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td><td>${esc(p.metaDescription)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('#metadescriptionsContent').innerHTML = exportBtn('metadescriptions') + html;
}

// ── Sitemaps ──
function renderSitemaps(analysis) {
  const r = analysis.sitemapReport;
  if (!r) {
    $('#sitemapsContent').innerHTML = '<p style="color:var(--text-muted)">No sitemap data available.</p>';
    return;
  }

  if (!r.found) {
    let html = `<div class="section-card" style="text-align:center;padding:40px;border-left:4px solid var(--danger)">
      <div style="font-size:48px;margin-bottom:16px">🚫</div>
      <h3>No Sitemap.xml Found</h3>
      <p style="color:var(--text-muted);max-width:600px;margin:0 auto 20px">${esc(r.message)}</p>
    </div>`;

    if (r.crawledNotInSitemapCount > 0) {
      html += `<div class="section-card">
        <h3>Indexable Pages Without Sitemap (${r.crawledNotInSitemapCount})</h3>
        <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">These pages returned 200 and are indexable but have no sitemap coverage.</p>
        <table><thead><tr><th>URL</th></tr></thead>
        <tbody>${r.crawledNotInSitemap.slice(0, 200).map(u => `<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table>
      </div>`;
    }

    $('#sitemapsContent').innerHTML = exportBtn('sitemaps') + html;
    return;
  }

  // Sitemaps found
  const non200Count = (r.non200InSitemapCount || (r.sitemapUrlStatuses || []).filter(u => u.statusCode !== 200 && u.statusCode !== 'not_crawled').length);
  const noindexInSmCount = (r.sitemapUrlStatuses || []).filter(u => u.isNoindex).length;
  let html = `<div class="stats-grid">
    ${statCard('Sitemap Files', r.files.length, 'info')}
    ${statCard('URLs in Sitemaps', r.totalSitemapUrls, '')}
    ${statCard('Non-200 in Sitemap', non200Count, non200Count > 0 ? 'danger' : 'success')}
    ${statCard('Noindex in Sitemap', noindexInSmCount, noindexInSmCount > 0 ? 'danger' : 'success')}
    ${statCard('Crawled Not in Sitemap', r.crawledNotInSitemapCount, r.crawledNotInSitemapCount > 0 ? 'warning' : 'success')}
    ${statCard('In Sitemap Not Crawled', r.inSitemapNotCrawledCount, r.inSitemapNotCrawledCount > 0 ? 'info' : '')}
  </div>`;

  if (!r.fromRobots) {
    html += `<div class="section-card" style="border-left:4px solid var(--warning)">
      <h3 style="color:var(--warning)">Sitemap Not Declared in robots.txt</h3>
      <p style="color:var(--text-muted);font-size:13px">The sitemap was found via auto-discovery but is not referenced in robots.txt. Add a <code>Sitemap:</code> directive to robots.txt for better discoverability by search engines.</p>
    </div>`;
  }

  // Sitemap files list
  html += `<div class="section-card"><h3>Sitemap Files (${r.files.length})</h3>
    <table><thead><tr><th>URL</th><th>Source</th><th>Type</th><th>URLs</th></tr></thead>
    <tbody>${r.files.map(f => `<tr>
      <td>${urlLink(f.url)}</td>
      <td><span class="badge ${f.source === 'robots.txt' ? 'badge-success' : 'badge-info'}">${esc(f.source)}</span></td>
      <td>${esc(f.type)}</td>
      <td>${f.urlCount}</td>
    </tr>`).join('')}</tbody></table></div>`;

  // Status code pie chart
  if (r.statusPieChart && r.statusPieChart.length > 0) {
    html += `<div class="section-card"><h3>Sitemap URLs by Status Code</h3>
      <div class="pie-chart-container">
        ${renderPieChart(r.statusPieChart, 180)}
        <div class="pie-legend">
          ${r.statusPieChart.map(s => `<div class="pie-legend-item">
            <div class="pie-legend-dot" style="background:${s.color}"></div>
            <span class="pie-legend-label">${esc(s.label)}</span>
            <span class="pie-legend-count">${s.count} (${s.percentage}%)</span>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  // Non-200 URLs in sitemap
  const problemUrls = (r.sitemapUrlStatuses || []).filter(u => u.statusCode !== 200 && u.statusCode !== 'not_crawled');
  if (problemUrls.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--danger)">
      <h3>Non-200 URLs in Sitemap (${problemUrls.length})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">These URLs are in the sitemap but don't return a 200 status code. They should be removed or fixed.</p>
      <table><thead><tr><th>URL</th><th>Status</th><th>Sitemap</th></tr></thead>
      <tbody>${problemUrls.slice(0, 200).map(u => `<tr>
        <td>${urlLink(u.url)}</td>
        <td>${statusBadge(u.statusCode)}</td>
        <td>${urlLink(u.sitemap)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Noindex URLs in sitemap
  const noindexUrls = (r.sitemapUrlStatuses || []).filter(u => u.isNoindex);
  if (noindexUrls.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--danger)">
      <h3>Noindex URLs in Sitemap (${noindexUrls.length})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">These URLs are in the sitemap but have a noindex meta robots directive. They should be removed from the sitemap.</p>
      <table><thead><tr><th>URL</th><th>Status</th><th>Sitemap</th></tr></thead>
      <tbody>${noindexUrls.slice(0, 200).map(u => `<tr>
        <td>${urlLink(u.url)}</td>
        <td>${statusBadge(u.statusCode)} <span class="badge badge-danger">noindex</span></td>
        <td>${urlLink(u.sitemap)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Crawled pages not in sitemap
  if (r.crawledNotInSitemapCount > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--warning)">
      <h3>Crawled Pages Not in Sitemap (${r.crawledNotInSitemapCount})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">Indexable pages (200, no noindex) that were discovered during crawling but are not included in any sitemap.</p>
      <table><thead><tr><th>URL</th></tr></thead>
      <tbody>${r.crawledNotInSitemap.slice(0, 200).map(u => `<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // Sitemap URLs not reached by crawl
  if (r.inSitemapNotCrawledCount > 0) {
    html += `<div class="section-card">
      <h3>Sitemap URLs Not Reached by Crawl (${r.inSitemapNotCrawledCount})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">These URLs are in the sitemap but were not discovered during the crawl (possibly orphan pages or the crawl limit was reached).</p>
      <table><thead><tr><th>URL</th></tr></thead>
      <tbody>${r.inSitemapNotCrawled.slice(0, 200).map(u => `<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  $('#sitemapsContent').innerHTML = exportBtn('sitemaps') + html;
}

function renderPieChart(data, size) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return '';
  // Radius pulled in 1px so the slice-gap stroke isn't clipped by the viewBox
  const r = size / 2 - 1;
  const cx = size / 2, cy = size / 2;
  let currentAngle = -Math.PI / 2;

  // 2px surface-colored stroke = visible gap between adjacent slices (reads
  // better and keeps slices distinguishable for colorblind users); <title>
  // gives every slice a native hover tooltip.
  const gap = 'stroke="var(--bg-card)" stroke-width="2" stroke-linejoin="round"';
  const tip = (slice, pct) => `<title>${esc(slice.label ? slice.label + ': ' : '')}${slice.count.toLocaleString()} (${slice.percentage != null ? slice.percentage : (pct * 100).toFixed(1)}%)</title>`;

  let paths = '';
  for (const slice of data) {
    const pct = slice.count / total;
    if (pct === 0) continue;
    const angle = pct * 2 * Math.PI;
    const x1 = cx + r * Math.cos(currentAngle);
    const y1 = cy + r * Math.sin(currentAngle);
    const x2 = cx + r * Math.cos(currentAngle + angle);
    const y2 = cy + r * Math.sin(currentAngle + angle);
    const largeArc = angle > Math.PI ? 1 : 0;

    if (pct >= 0.999) {
      // Full circle
      paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${slice.color}" ${gap}>${tip(slice, pct)}</circle>`;
    } else {
      paths += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z" fill="${slice.color}" ${gap}>${tip(slice, pct)}</path>`;
    }
    currentAngle += angle;
  }

  return `<svg class="pie-chart-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}</svg>`;
}

// ── AI Bots ──
function renderAiBots(analysis) {
  const r = analysis.aiBotsReport;
  if (!r || !r.hasRobotsTxt) {
    $('#aibotsContent').innerHTML = `<div class="section-card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:16px">🤖</div>
      <h3>No robots.txt Found</h3>
      <p style="color:var(--text-muted)">This site does not have a robots.txt file. All AI bots are allowed by default.</p>
    </div>`;
    return;
  }

  const blocked = r.bots.filter(b => b.status === 'blocked');
  const partial = r.bots.filter(b => b.status === 'partial');
  const allowed = r.bots.filter(b => b.status === 'allowed');
  const notMentioned = r.bots.filter(b => b.status === 'not_mentioned');

  let html = `<div class="stats-grid">
    ${statCard('AI Bots Checked', r.totalBots, '')}
    ${statCard('Blocked', blocked.length, blocked.length > 0 ? 'danger' : '')}
    ${statCard('Partially Blocked', partial.length, partial.length > 0 ? 'warning' : '')}
    ${statCard('Allowed / Not Mentioned', allowed.length + notMentioned.length, 'success')}
  </div>`;

  // Blocked bots
  if (blocked.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--danger)">
      <h3 style="color:var(--danger)">Blocked AI Bots (${blocked.length})</h3>
      <table><thead><tr><th>Bot</th><th>Owner</th><th>Description</th><th>Status</th><th>Rules</th></tr></thead>
      <tbody>${blocked.map(b => `<tr>
        <td><strong>${esc(b.name)}</strong></td>
        <td>${esc(b.owner)}</td>
        <td style="white-space:normal;max-width:300px">${esc(b.description)}</td>
        <td><span class="badge badge-danger">${esc(b.statusLabel)}</span></td>
        <td style="font-size:11px">${b.rules.map(r => `${r.type}: ${esc(r.path)}`).join('<br>')}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Partially blocked
  if (partial.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--warning)">
      <h3 style="color:var(--warning)">Partially Blocked AI Bots (${partial.length})</h3>
      <table><thead><tr><th>Bot</th><th>Owner</th><th>Description</th><th>Status</th><th>Rules</th></tr></thead>
      <tbody>${partial.map(b => `<tr>
        <td><strong>${esc(b.name)}</strong></td>
        <td>${esc(b.owner)}</td>
        <td style="white-space:normal;max-width:300px">${esc(b.description)}</td>
        <td><span class="badge badge-warning">${esc(b.statusLabel)}</span></td>
        <td style="font-size:11px">${b.rules.map(r => `${r.type}: ${esc(r.path)}`).join('<br>')}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Allowed / explicitly mentioned
  if (allowed.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--success)">
      <h3 style="color:var(--success)">Explicitly Allowed AI Bots (${allowed.length})</h3>
      <table><thead><tr><th>Bot</th><th>Owner</th><th>Description</th><th>Status</th></tr></thead>
      <tbody>${allowed.map(b => `<tr>
        <td><strong>${esc(b.name)}</strong></td>
        <td>${esc(b.owner)}</td>
        <td style="white-space:normal;max-width:300px">${esc(b.description)}</td>
        <td><span class="badge badge-success">${esc(b.statusLabel)}</span></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Not mentioned
  if (notMentioned.length > 0) {
    html += `<div class="section-card">
      <h3>Not Mentioned in robots.txt (${notMentioned.length})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">These bots are not specifically referenced in robots.txt and are allowed by default.</p>
      <table><thead><tr><th>Bot</th><th>Owner</th><th>Description</th><th>Status</th></tr></thead>
      <tbody>${notMentioned.map(b => `<tr>
        <td><strong>${esc(b.name)}</strong></td>
        <td>${esc(b.owner)}</td>
        <td style="white-space:normal;max-width:300px">${esc(b.description)}</td>
        <td><span class="badge badge-success">Allowed</span></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Raw robots.txt
  html += `<div class="section-card">
    <h3>Raw robots.txt</h3>
    <pre style="background:var(--bg);padding:16px;border-radius:8px;overflow-x:auto;font-size:12px;max-height:400px;overflow-y:auto;white-space:pre-wrap">${esc(r.rawRobotsTxt)}</pre>
  </div>`;

  $('#aibotsContent').innerHTML = html;
}

// ── Search Engines (Google / Bing bots in robots.txt) ──
// WAF-challenge + cloaking-check sections shown at the top of the Search
// Engines tab (live crawl access, complementing the robots.txt view below)
function renderBotAccessSections(analysis) {
  const ba = analysis.botAccessReport || { challengedCount: 0, byVendor: {}, pages: [], botLabel: '' };
  const bp = analysis.botParityReport || { tested: false, testedCount: 0, differingCount: 0, challengedCount: 0, results: [] };
  let html = '';

  // WAF / bot-protection challenges during the crawl
  if (ba.challengedCount > 0) {
    const vendors = Object.entries(ba.byVendor).map(([v, n]) => `<strong>${esc(v)}</strong> (${n})`).join(', ');
    html += `<div class="section-card" style="border-left:4px solid var(--danger);background:color-mix(in srgb, var(--danger) 8%, transparent)">
      <h3 style="color:var(--danger);margin-bottom:8px">🛡️ Bot protection challenged ${ba.challengedCount} request(s)</h3>
      ${ba.challengeAborted ? `<p style="margin-bottom:8px"><strong>The crawl was stopped early after ${ba.challengeAbortAfter} pages</strong> because the WAF was challenging essentially every request — continuing would only collect more challenge pages and further hurt this server's IP reputation. Wait for the flag to decay (usually minutes–hours) or allowlist the crawler, then re-crawl.</p>` : ''}
      <p style="margin-bottom:8px">Crawling as <strong>${esc(ba.botLabel)}</strong>, the site's WAF intercepted requests: ${vendors}.
      The status codes and content of these URLs reflect the WAF's challenge page, <em>not</em> the real site — treat their crawl data as unreliable.</p>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">Real search-engine bots verify by IP (reverse DNS), so a spoofed bot UA from this crawler can be challenged even where the genuine bot is allowed.
      If this is your own site, allowlist the <code>SEOAuditCrawler</code> user agent in the WAF and re-crawl.</p>
      <table><thead><tr><th>URL</th><th>Status</th><th>WAF</th></tr></thead>
      <tbody>${ba.pages.slice(0, 50).map(p => `<tr>
        <td>${urlLink(p.url)}</td>
        <td>${statusBadge(p.statusCode)}</td>
        <td><span class="badge badge-danger">${esc(p.vendor)}</span></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Cloaking / UA-parity check
  if (bp.tested && bp.testedCount > 0) {
    const problems = bp.results.filter(x => x.differs);
    html += `<div class="section-card" ${problems.length > 0 ? 'style="border-left:4px solid var(--warning)"' : ''}>
      <h3>Cloaking Check — ${esc(bp.crawledAs || '')} vs ${esc(bp.comparedWith || '')}</h3>
      <p style="margin-bottom:12px;color:var(--text-muted);font-size:13px">After the crawl, ${bp.testedCount} page(s) were re-fetched with a different user agent
      (<strong>${esc(bp.comparedWith || '')}</strong>) and compared against what the crawl saw. Differences in status, title, canonical or noindex indicate cloaking,
      bot-specific serving, or a WAF treating the two user agents differently.</p>`;
    if (problems.length === 0) {
      html += `<p style="font-size:13px"><span class="badge badge-success">All good</span> Both user agents were served the same status, title, canonical and robots directives on all ${bp.testedCount} tested page(s).</p>`;
    } else {
      html += `<table><thead><tr><th>URL</th><th>What differs</th><th>Crawled as ${esc(bp.crawledAs || '')}</th><th>As ${esc(bp.comparedWith || '')}</th></tr></thead>
        <tbody>${problems.map(p => p.diffs.map((d, i) => `<tr>
          ${i === 0 ? `<td rowspan="${p.diffs.length}">${urlLink(p.url)}</td>` : ''}
          <td><span class="badge ${d.field === 'access' ? 'badge-danger' : 'badge-warning'}">${esc(d.field)}</span></td>
          <td style="white-space:normal;max-width:260px;font-size:12px">${esc(truncate(d.crawled, 120))}</td>
          <td style="white-space:normal;max-width:260px;font-size:12px">${esc(truncate(d.compared, 120))}</td>
        </tr>`).join('')).join('')}</tbody></table>`;
    }
    html += '</div>';
  }

  return html;
}

function renderSearchEngines(analysis) {
  const r = analysis.searchEnginesReport;
  const botSections = renderBotAccessSections(analysis);
  if (!r || !r.hasRobotsTxt) {
    $('#searchenginesContent').innerHTML = botSections + `<div class="section-card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:16px">🔍</div>
      <h3>No robots.txt Found</h3>
      <p style="color:var(--text-muted)">This site does not have a robots.txt file. All search engine crawlers are allowed by default.</p>
    </div>`;
    return;
  }

  const blocked = r.bots.filter(b => b.status === 'blocked');
  const partial = r.bots.filter(b => b.status === 'partial');
  const allowed = r.bots.filter(b => b.status === 'allowed');
  const notMentioned = r.bots.filter(b => b.status === 'not_mentioned');
  const critical = r.criticalBlocked || [];

  let html = botSections;

  // Critical warning banner — Googlebot or Bingbot blocked
  if (critical.length > 0) {
    const names = critical.map(b => `<strong>${esc(b.name)}</strong> (${esc(b.statusLabel)})`).join(', ');
    html += `<div class="section-card" style="border-left:4px solid var(--danger);background:color-mix(in srgb, var(--danger) 8%, transparent)">
      <h3 style="color:var(--danger);margin-bottom:8px">⚠️ Critical: Search engine crawler blocked</h3>
      <p style="margin-bottom:8px">${names} ${critical.length === 1 ? 'is' : 'are'} disallowed by this site's <code>robots.txt</code>.</p>
      <p style="color:var(--text-muted);font-size:13px;margin:0">Blocking the main Google or Bing crawler prevents organic indexing — pages will not appear in search results. Review the <code>User-agent</code> and <code>Disallow</code> rules below.</p>
    </div>`;
  }

  html += `<div class="stats-grid">
    ${statCard('Search Bots Checked', r.totalBots, '')}
    ${statCard('Blocked', blocked.length, blocked.length > 0 ? 'danger' : '')}
    ${statCard('Partially Blocked', partial.length, partial.length > 0 ? 'warning' : '')}
    ${statCard('Allowed / Not Mentioned', allowed.length + notMentioned.length, 'success')}
  </div>`;

  const botRow = (b, badgeClass) => `<tr>
    <td><strong>${esc(b.name)}</strong>${b.critical ? ' <span class="badge badge-warning" style="font-size:10px">main crawler</span>' : ''}</td>
    <td>${esc(b.engine)}</td>
    <td style="white-space:normal;max-width:320px">${esc(b.description)}</td>
    <td><span class="badge ${badgeClass}">${esc(b.statusLabel)}</span></td>
    <td style="font-size:11px">${(b.rules || []).map(rr => `${rr.type}: ${esc(rr.path)}`).join('<br>') || '—'}</td>
  </tr>`;

  if (blocked.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--danger)">
      <h3 style="color:var(--danger)">Blocked Search Bots (${blocked.length})</h3>
      <table><thead><tr><th>Bot</th><th>Engine</th><th>Description</th><th>Status</th><th>Rules</th></tr></thead>
      <tbody>${blocked.map(b => botRow(b, 'badge-danger')).join('')}</tbody></table></div>`;
  }

  if (partial.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--warning)">
      <h3 style="color:var(--warning)">Partially Blocked Search Bots (${partial.length})</h3>
      <table><thead><tr><th>Bot</th><th>Engine</th><th>Description</th><th>Status</th><th>Rules</th></tr></thead>
      <tbody>${partial.map(b => botRow(b, 'badge-warning')).join('')}</tbody></table></div>`;
  }

  if (allowed.length > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--success)">
      <h3 style="color:var(--success)">Explicitly Allowed Search Bots (${allowed.length})</h3>
      <table><thead><tr><th>Bot</th><th>Engine</th><th>Description</th><th>Status</th><th>Rules</th></tr></thead>
      <tbody>${allowed.map(b => botRow(b, 'badge-success')).join('')}</tbody></table></div>`;
  }

  if (notMentioned.length > 0) {
    html += `<div class="section-card">
      <h3>Not Mentioned in robots.txt (${notMentioned.length})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">These bots aren't specifically referenced and fall back to the <code>User-agent: *</code> rules (or allowed by default if no wildcard).</p>
      <table><thead><tr><th>Bot</th><th>Engine</th><th>Description</th><th>Status</th></tr></thead>
      <tbody>${notMentioned.map(b => `<tr>
        <td><strong>${esc(b.name)}</strong>${b.critical ? ' <span class="badge badge-warning" style="font-size:10px">main crawler</span>' : ''}</td>
        <td>${esc(b.engine)}</td>
        <td style="white-space:normal;max-width:320px">${esc(b.description)}</td>
        <td><span class="badge badge-success">Allowed</span></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  html += `<div class="section-card">
    <h3>Raw robots.txt</h3>
    <pre style="background:var(--bg);padding:16px;border-radius:8px;overflow-x:auto;font-size:12px;max-height:400px;overflow-y:auto;white-space:pre-wrap">${esc(r.rawRobotsTxt)}</pre>
  </div>`;

  $('#searchenginesContent').innerHTML = exportBtn('searchengines', 'Export Bot Access') + html;
}

// ── Headings ──
let _hdData = null, _hdFilter = 'all';
function renderHeadings(analysis) {
  _hdData = analysis.headingsReport;
  if (!_hdData) { $('#headingsContent').innerHTML = '<p style="color:var(--text-muted)">No data.</p>'; return; }
  _hdFilter = 'all';
  _renderHD();
}
function filterHD(f) { _hdFilter = (_hdFilter === f) ? 'all' : f; _renderHD(); }
function _renderHD() {
  const r = _hdData, f = _hdFilter;
  const cb = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterHD('${key}')">${statCardInner(label, count)}</div>`;
  };
  let html = `<div class="stats-grid">
    ${cb('all', 'Total Pages', r.total, '')}
    ${cb('missingH1', 'Missing H1', r.missingH1.length, r.missingH1.length > 0 ? 'danger' : 'success')}
    ${cb('multipleH1', 'Multiple H1s', r.multipleH1.length, r.multipleH1.length > 0 ? 'warning' : 'success')}
    ${cb('missingH2', 'Missing H2', r.missingH2.length, r.missingH2.length > 0 ? 'warning' : 'success')}
  </div>`;
  if (f === 'all' || f === 'missingH1') {
    if (r.missingH1.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Missing H1 (${r.missingH1.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th><th>H2 Count</th></tr></thead><tbody>${r.missingH1.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td><td>${p.h2Count}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'multipleH1') {
    if (r.multipleH1.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Multiple H1s (${r.multipleH1.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th><th>H1 Count</th><th>H1 Tags</th></tr></thead><tbody>${r.multipleH1.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td><td>${p.h1Count}</td><td style="font-size:12px">${(p.h1||[]).map(h=>esc(h)).join(', ')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'missingH2') {
    if (r.missingH2.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Missing H2 (${r.missingH2.length})</h3><table><thead><tr><th style="width:48px;text-align:right">#</th><th>URL</th><th>H1 Count</th></tr></thead><tbody>${r.missingH2.slice(0,500).map((p,i)=>`<tr><td style="text-align:right;color:var(--text-muted)">${i+1}</td><td>${urlLink(p.url)}</td><td>${p.h1Count}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('#headingsContent').innerHTML = exportBtn('headings') + html;
}

// ── Directives ──
let _dirData = null, _dirFilter = 'all';
function renderDirectives(analysis) {
  _dirData = analysis.directivesReport;
  if (!_dirData) { $('#directivesContent').innerHTML = '<p style="color:var(--text-muted)">No data.</p>'; return; }
  _dirFilter = 'all';
  _renderDir();
}
function filterDir(f) { _dirFilter = (_dirFilter === f) ? 'all' : f; _renderDir(); }
function _renderDir() {
  const r = _dirData, f = _dirFilter;
  const cb = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterDir('${key}')">${statCardInner(label, count)}</div>`;
  };
  let html = `<div class="stats-grid">
    ${cb('all', 'Total Pages', r.total, '')}
    ${cb('noindex', 'Noindex', r.noindex.length, r.noindex.length > 0 ? 'danger' : '')}
    ${cb('nofollow', 'Nofollow', r.nofollow.length, r.nofollow.length > 0 ? 'warning' : '')}
    ${cb('indexFollow', 'Index / Follow', r.indexFollow.length, 'success')}
    ${cb('noRobotsTag', 'No Robots Tag', r.noRobotsTag.length, r.noRobotsTag.length > 0 ? 'warning' : '')}
  </div>`;
  const showGroup = (key, label, items, color) => {
    if (items.length === 0) return '';
    return `<div class="section-card" style="border-left:4px solid var(--${color})"><h3>${label} (${items.length})</h3><table><thead><tr><th>URL</th><th>Meta Robots</th></tr></thead><tbody>${items.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.metaRobots || 'None')}</td></tr>`).join('')}</tbody></table></div>`;
  };
  if (f === 'all' || f === 'noindex') html += showGroup('noindex', 'Noindex Pages', r.noindex, 'danger');
  if (f === 'all' || f === 'nofollow') html += showGroup('nofollow', 'Nofollow Pages', r.nofollow, 'warning');
  if (f === 'all' || f === 'indexFollow') html += showGroup('indexFollow', 'Index / Follow Pages', r.indexFollow, 'success');
  if (f === 'all' || f === 'noRobotsTag') html += showGroup('noRobotsTag', 'No Robots Tag', r.noRobotsTag, 'warning');
  $('#directivesContent').innerHTML = exportBtn('directives') + html;
}

// ── Helpers ──
// ── Summary ──
function renderSummary(analysis) {
  if (!analysis) { $('#summaryContent').innerHTML = '<p style="color:var(--text-muted)">Run a crawl first.</p>'; return; }

  // Gather all metrics
  const sc = analysis.statusCodesReport || {};
  const mt = analysis.metaTitlesReport || {};
  const md = analysis.metaDescriptionsReport || {};
  const img = analysis.imageAnalysis || {};
  const anch = analysis.anchorsReport || {};
  const sm = analysis.sitemapReport || {};
  const hvc = analysis.hreflangCanonicalConflicts || {};
  const hrf = analysis.hreflangReport || {};
  const sec = analysis.securityReport || {};
  const sd = analysis.structuredDataReport || {};
  const cnt = analysis.contentAnalysis || {};
  const lnk = analysis.internalLinkAnalysis || {};
  const iss = analysis.issues || [];
  const hdg = analysis.headingsReport || {};

  const criticals = iss.filter(i => i.severity === 'critical').length;
  const warnings = iss.filter(i => i.severity === 'warning').length;
  const infos = iss.filter(i => i.severity === 'info').length;
  const totalIssues = criticals + warnings;

  // Calculate score (0-100)
  const totalPages = sc.total || 1;
  let deductions = 0;
  deductions += Math.min(30, criticals * 2);
  deductions += Math.min(20, warnings * 0.5);
  if ((mt.missing?.length || 0) > 0) deductions += 10;
  if ((md.missing?.length || 0) > 0) deductions += 5;
  if ((sc.groups?.['4xx']?.urls?.length || 0) > 0) deductions += 10;
  if ((sc.groups?.['5xx']?.urls?.length || 0) > 0) deductions += 15;
  if (!sm.found) deductions += 5;
  if ((hvc.conflicts?.length || 0) > 0) deductions += 10;
  if ((hrf.totalReturnLinkIssues || 0) > 0) deductions += 5;
  const score = Math.max(0, Math.min(100, Math.round(100 - deductions)));
  const scoreColor = score >= 80 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444';
  const scoreLabel = score >= 80 ? 'Good' : score >= 50 ? 'Needs Work' : 'Critical Issues';

  const row = (label, value, threshold) => {
    let cls = 'neutral';
    if (typeof threshold === 'function') cls = threshold(value);
    else if (value === 0) cls = 'ok';
    else if (value > 0) cls = 'bad';
    return `<div class="summary-row"><span class="label">${label}</span><span class="value ${cls}">${value}</span></div>`;
  };

  // Crawl-reliability banner: pages behind a WAF challenge carry the WAF's
  // response, not the site's, so the whole report needs that context up top
  const _ba = analysis.botAccessReport || { challengedCount: 0 };
  const challengeBanner = _ba.challengedCount > 0 ? `
    <div class="section-card" style="border-left:4px solid var(--danger);background:color-mix(in srgb, var(--danger) 8%, transparent);margin-bottom:20px">
      <h3 style="color:var(--danger);margin-bottom:6px">🛡️ ${_ba.challengedCount} request(s) challenged by bot protection${_ba.challengeAborted ? ' — crawl stopped early' : ''}</h3>
      <p style="font-size:13px;margin:0">Crawling as <strong>${esc(_ba.botLabel || '')}</strong> triggered ${esc(Object.keys(_ba.byVendor || {}).join(', '))} challenges —
      data for those URLs reflects the WAF, not the site.${_ba.challengeAborted ? ` The crawl was <strong>stopped after ${_ba.challengeAbortAfter} pages</strong> to avoid burning more challenged requests — wait for the WAF flag to decay or allowlist the crawler, then re-crawl.` : ''} See the <strong>Search Engines</strong> tab for details.</p>
    </div>` : '';

  let html = `
    ${challengeBanner}
    <div class="summary-score">
      <div class="score-num" style="color:${scoreColor}">${score}</div>
      <div class="score-label">${scoreLabel} — SEO Health Score</div>
      <div class="score-bar"><div class="score-fill" style="width:${score}%;background:${scoreColor}"></div></div>
    </div>

    <div class="stats-grid" style="margin-bottom:24px">
      ${statCard('Total Pages Crawled', totalPages, '')}
      ${statCard('Critical Issues', criticals, criticals > 0 ? 'danger' : 'success')}
      ${statCard('Warnings', warnings, warnings > 0 ? 'warning' : 'success')}
      ${statCard('Info', infos, 'info')}
    </div>

    <div class="summary-grid">

      <div class="summary-category" style="border-left-color:#ef4444">
        <h3><span class="cat-icon">🔗</span> Status Codes</h3>
        ${row('2xx (Success)', sc.groups?.['2xx']?.urls?.length || 0, v => 'ok')}
        ${row('3xx (Redirects)', sc.groups?.['3xx']?.urls?.length || 0, v => v > 0 ? 'warn' : 'ok')}
        ${row('4xx (Not Found)', sc.groups?.['4xx']?.urls?.length || 0)}
        ${row('5xx (Server Error)', sc.groups?.['5xx']?.urls?.length || 0)}
      </div>

      <div class="summary-category" style="border-left-color:#8b5cf6">
        <h3><span class="cat-icon">📝</span> Meta Titles</h3>
        ${row('Missing', mt.missing?.length || 0)}
        ${row('Duplicates', mt.duplicates?.length || 0)}
        ${row('Too Short (<30 chars)', mt.tooShort?.length || 0)}
        ${row('Too Long (>60 chars)', mt.tooLong?.length || 0)}
        ${row('Optimal', mt.optimal || 0, v => 'ok')}
      </div>

      <div class="summary-category" style="border-left-color:#3b82f6">
        <h3><span class="cat-icon">📄</span> Meta Descriptions</h3>
        ${row('Missing', md.missing?.length || 0)}
        ${row('Duplicates', md.duplicates?.length || 0)}
        ${row('Too Short (<70 chars)', md.tooShort?.length || 0)}
        ${row('Too Long (>160 chars)', md.tooLong?.length || 0)}
        ${row('Optimal', md.optimal || 0, v => 'ok')}
      </div>

      <div class="summary-category" style="border-left-color:#f59e0b">
        <h3><span class="cat-icon">🖼️</span> Images</h3>
        ${row('Total Images', img.totalImages || 0, v => 'neutral')}
        ${row('Missing Alt Attribute', img.missingAlt || 0)}
        ${row('Empty Alt Text', img.emptyAlt || 0)}
        ${row('Unique Images with Issues', img.uniqueIssueImages || 0)}
      </div>

      <div class="summary-category" style="border-left-color:#22c55e">
        <h3><span class="cat-icon">🔗</span> Internal Links</h3>
        ${row('Orphan Pages', lnk.orphanPages?.length || 0)}
        ${row('Links Without Anchor Text', anch.totalEmptyAnchors || 0)}
      </div>

      <div class="summary-category" style="border-left-color:#ec4899">
        <h3><span class="cat-icon">🌍</span> Hreflang & Canonical</h3>
        ${row('Pages with Hreflangs', hrf.pagesWithHreflangs || 0, v => 'neutral')}
        ${row('Languages Found', hrf.languages?.length || 0, v => 'neutral')}
        ${row('Missing Return Links', hrf.totalReturnLinkIssues || 0)}
        ${row('Hreflang vs Canonical Conflicts', hvc.conflicts?.length || 0)}
      </div>

      <div class="summary-category" style="border-left-color:#06b6d4">
        <h3><span class="cat-icon">🗺️</span> Sitemaps</h3>
        ${row('Sitemap Found', sm.found ? 'Yes' : 'No', v => v === 'Yes' ? 'ok' : 'bad')}
        ${row('URLs in Sitemap', sm.totalSitemapUrls || 0, v => 'neutral')}
        ${row('Crawled but NOT in Sitemap', sm.crawledNotInSitemapCount || 0, v => v > 0 ? 'warn' : 'ok')}
        ${row('In Sitemap but NOT Crawled', sm.inSitemapNotCrawledCount || 0, v => v > 0 ? 'warn' : 'ok')}
      </div>

      <div class="summary-category" style="border-left-color:#14b8a6">
        <h3><span class="cat-icon">📊</span> Structured Data</h3>
        ${row('Pages with Schema', sd.pagesWithSchema || 0, v => 'neutral')}
        ${row('Pages without Schema', sd.pagesWithoutSchema || 0, v => v > 0 ? 'warn' : 'ok')}
        ${row('Schema Types Found', Object.keys(sd.typeCounts || {}).length, v => 'neutral')}
      </div>

      <div class="summary-category" style="border-left-color:#f97316">
        <h3><span class="cat-icon">🔒</span> Security</h3>
        ${row('HTTPS', sec.isHttps ? 'Yes' : 'No', v => v === 'Yes' ? 'ok' : 'bad')}
        ${row('Missing HSTS', sec.headers?.strictTransportSecurity?.missing || 0, v => v > 0 ? 'warn' : 'ok')}
        ${row('Missing X-Frame-Options', sec.headers?.xFrameOptions?.missing || 0, v => v > 0 ? 'warn' : 'ok')}
        ${row('Missing CSP', sec.headers?.contentSecurityPolicy?.missing || 0, v => v > 0 ? 'warn' : 'ok')}
      </div>

      <div class="summary-category" style="border-left-color:#a855f7">
        <h3><span class="cat-icon">📏</span> Content Quality</h3>
        ${row('Thin Content (<300 words)', cnt.thinPages?.length || 0)}
        ${row('Avg Word Count', cnt.avgWordCount || 0, v => 'neutral')}
        ${row('Missing H1', hdg?.missingH1?.length || 0)}
        ${row('Multiple H1s', hdg?.multipleH1?.length || 0)}
        ${row('Text/HTML Ratio', cnt.avgTextRatio ? cnt.avgTextRatio + '%' : '0%', v => 'neutral')}
      </div>

    </div>
  `;

  $('#summaryContent').innerHTML = exportBtn('summary') + html;
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function truncate(s, len) { s = s || ''; return s.length > len ? s.substring(0, len) + '...' : s; }
function exportBtn(section, label = 'Export to Excel') {
  return `<div style="display:flex;justify-content:flex-end;margin-bottom:12px">
    ${exportBtnInner(section, label)}
  </div>`;
}
function exportBtnInner(section, label = 'Export to Excel') {
  return `<button onclick="exportSection('${section}')" style="display:inline-flex;align-items:center;gap:6px;background:#1d6f42;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:background .15s" onmouseover="this.style.background='#238d53'" onmouseout="this.style.background='#1d6f42'">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 17 15 14"/></svg>
      ${label}
    </button>`;
}
function exportSection(section) {
  if (!currentCrawlId) return;
  // Pass active scorecard filter for tabs that have them
  let filterParam = '';
  if (section === 'statuscodes' && _statusCodesActiveFilter !== 'all') filterParam = '?filter=' + _statusCodesActiveFilter;
  else if (section === 'metatitles' && _mtFilter !== 'all') filterParam = '?filter=' + _mtFilter;
  else if (section === 'metadescriptions' && _mdFilter !== 'all') filterParam = '?filter=' + _mdFilter;
  else if (section === 'images' && _imgFilter !== 'all') filterParam = '?filter=' + _imgFilter;
  window.open(`/api/crawls/${currentCrawlId}/export-section/${section}${filterParam}`, '_blank');
}
function exportFilteredPages() {
  if (!currentCrawlId || !pagesData) return alert('No crawl data to export');
  // Re-apply current filters to get the filtered set (same logic as renderPagesTable)
  buildDupMaps(pagesData);
  const filter = ($('#pagesFilter')?.value || '').toLowerCase();
  const sf = $('#pagesStatusFilter')?.value || '';
  const tf = $('#pagesTitleFilter')?.value || '';
  const df = $('#pagesDescFilter')?.value || '';
  const dirf = $('#pagesDirectiveFilter')?.value || '';
  const cf = $('#pagesCanonicalFilter')?.value || '';
  const h1f = $('#pagesH1Filter')?.value || '';
  const wf = $('#pagesWordFilter')?.value || '';
  const hlf = $('#pagesHreflangFilter')?.value || '';
  let filtered = pagesData;
  if (filter) filtered = filtered.filter(p => (p.url||'').toLowerCase().includes(filter));
  if (sf === '2xx') filtered = filtered.filter(p => p.status_code >= 200 && p.status_code < 300);
  else if (sf === '3xx') filtered = filtered.filter(p => p.status_code >= 300 && p.status_code < 400);
  else if (sf === '4xx') filtered = filtered.filter(p => p.status_code >= 400 && p.status_code < 500);
  else if (sf === '5xx') filtered = filtered.filter(p => p.status_code >= 500);
  else if (sf) filtered = filtered.filter(p => String(p.status_code) === sf);
  if (tf === 'missing') filtered = filtered.filter(p => !p.title && p.status_code < 300 && !isNoindexPage(p));
  else if (tf === 'short') filtered = filtered.filter(p => p.title && (p.title_length||0) < 30 && !isNoindexPage(p));
  else if (tf === 'long') filtered = filtered.filter(p => p.title && (p.title_length||0) > 60 && !isNoindexPage(p));
  else if (tf === 'optimal') filtered = filtered.filter(p => p.title && (p.title_length||0) >= 30 && (p.title_length||0) <= 60 && !isNoindexPage(p));
  else if (tf === 'duplicate') filtered = filtered.filter(p => p.title && _titleDups.has(p.title.trim().toLowerCase()) && !isNoindexPage(p));
  if (df === 'missing') filtered = filtered.filter(p => !p.meta_description && p.status_code < 300 && !isNoindexPage(p));
  else if (df === 'short') filtered = filtered.filter(p => p.meta_description && (p.meta_description_length||0) < 70 && !isNoindexPage(p));
  else if (df === 'long') filtered = filtered.filter(p => p.meta_description && (p.meta_description_length||0) > 160 && !isNoindexPage(p));
  else if (df === 'optimal') filtered = filtered.filter(p => p.meta_description && (p.meta_description_length||0) >= 70 && (p.meta_description_length||0) <= 160 && !isNoindexPage(p));
  else if (df === 'duplicate') filtered = filtered.filter(p => p.meta_description && _descDups.has(p.meta_description.trim().toLowerCase()) && !isNoindexPage(p));
  if (dirf === 'noindex') filtered = filtered.filter(p => (p.meta_robots||'').toLowerCase().includes('noindex'));
  else if (dirf === 'nofollow') filtered = filtered.filter(p => (p.meta_robots||'').toLowerCase().includes('nofollow'));
  else if (dirf === 'index') filtered = filtered.filter(p => !(p.meta_robots||'').toLowerCase().includes('noindex'));
  if (cf === 'self') filtered = filtered.filter(p => p.canonical_is_self);
  else if (cf === 'other') filtered = filtered.filter(p => p.canonical && !p.canonical_is_self);
  else if (cf === 'missing') filtered = filtered.filter(p => !p.canonical && p.status_code < 300);
  if (h1f === 'missing') filtered = filtered.filter(p => (p.h1_count || 0) === 0 && p.status_code < 300);
  else if (h1f === 'multiple') filtered = filtered.filter(p => (p.h1_count || 0) > 1);
  else if (h1f === 'single') filtered = filtered.filter(p => (p.h1_count || 0) === 1);
  if (wf === 'thin') filtered = filtered.filter(p => (p.word_count || 0) < 300 && p.status_code < 300);
  else if (wf === 'short') filtered = filtered.filter(p => (p.word_count || 0) >= 300 && (p.word_count || 0) < 600);
  else if (wf === 'medium') filtered = filtered.filter(p => (p.word_count || 0) >= 600 && (p.word_count || 0) < 1500);
  else if (wf === 'long') filtered = filtered.filter(p => (p.word_count || 0) >= 1500);
  if (hlf === 'has') filtered = filtered.filter(p => { try { return JSON.parse(p.hreflangs || '[]').length > 0; } catch { return false; } });
  else if (hlf === 'none') filtered = filtered.filter(p => { try { return JSON.parse(p.hreflangs || '[]').length === 0; } catch { return true; } });

  if (filtered.length === 0) return alert('No pages match the current filters');
  // Build active filter label for sheet name
  const labels = [];
  if (sf) labels.push('Status:' + sf);
  if (tf) labels.push('Title:' + tf);
  if (df) labels.push('Desc:' + df);
  if (dirf) labels.push('Dir:' + dirf);
  if (cf) labels.push('Can:' + cf);
  if (h1f) labels.push('H1:' + h1f);
  if (wf) labels.push('Words:' + wf);
  if (hlf) labels.push('HL:' + hlf);
  if (filter) labels.push('URL:' + filter.substring(0, 20));
  const filterLabel = labels.length ? labels.join(', ') : 'All';

  // Map to export rows
  const rows = filtered.map(p => ({
    URL: p.url,
    Status: p.status_code,
    'Meta Title': p.title || '',
    'Title Length': p.title_length || 0,
    'Meta Description': p.meta_description || '',
    'Desc Length': p.meta_description_length || 0,
    H1: JSON.parse(p.h1 || '[]').join(' | '),
    'H1 Count': p.h1_count || 0,
    'H2 Count': p.h2_count || 0,
    'Word Count': p.word_count || 0,
    Canonical: p.canonical || '',
    Directives: p.meta_robots || '',
    'Response Time': p.response_time || 0,
    Depth: p.depth || 0
  }));
  // POST to server for XLSX generation
  fetch(`/api/crawls/${currentCrawlId}/export-filtered-xlsx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, sheetName: 'Filtered (' + filterLabel + ')', fileName: 'filtered-pages' })
  }).then(r => r.blob()).then(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'filtered-pages.xlsx'; a.click();
    URL.revokeObjectURL(url);
  }).catch(err => alert('Export failed: ' + err.message));
}
// Decode percent-encoded characters for DISPLAY so URLs with diacritics show
// the real letters (…/test-et-assurance-qualité) instead of the wire form
// (…/qualit%C3%A9). decodeURI (not decodeURIComponent) leaves structural
// reserved chars — / ? & = # — untouched, so only things like %C3%A9 → é are
// turned back. The actual href stays in its original (encoded) form, which is
// always valid to click. Falls back to the raw string if decoding fails
// (malformed %-sequence).
function prettyUrl(url) {
  if (!url) return '';
  try { return decodeURI(url); } catch { return String(url); }
}
function urlLink(url) {
  if (!url) return '-';
  const shown = prettyUrl(url);
  return `<a href="${esc(url)}" target="_blank" rel="noopener" class="url-cell" title="${esc(shown)}">${esc(shown)}</a>`;
}
function formatBytes(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b/1024).toFixed(1) + ' KB'; return (b/1048576).toFixed(1) + ' MB'; }
function statusBadge(code) {
  if (!code || code === 0) return '<span class="badge badge-danger">Error</span>';
  if (code < 300) return `<span class="badge badge-success">${code}</span>`;
  if (code < 400) return `<span class="badge badge-warning">${code}</span>`;
  return `<span class="badge badge-danger">${code}</span>`;
}
function severityBadge(s) {
  const map = { critical: 'danger', warning: 'warning', error: 'danger', info: 'info' };
  return `<span class="badge badge-${map[s] || 'muted'}">${s}</span>`;
}

// ── Resizable table columns ──
function initAllResizableColumns() {
  document.querySelectorAll('table').forEach(table => {
    if (table.dataset.resizable) return;
    table.dataset.resizable = 'true';
    // Keep table-layout: auto so columns size naturally
    table.style.tableLayout = 'auto';
    const ths = table.querySelectorAll('th');
    ths.forEach(th => {
      if (th.querySelector('.col-resizer')) return;
      const handle = document.createElement('div');
      handle.className = 'col-resizer';
      th.style.position = 'relative';
      th.appendChild(handle);
      initResizeHandle(th, handle, table);
    });
  });
}

function initResizeHandle(th, handle, table) {
  let startX, startW;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Switch to fixed layout on first resize so widths are respected
    if (table.style.tableLayout !== 'fixed') {
      const ths = table.querySelectorAll('th');
      ths.forEach(t => { t.style.width = t.offsetWidth + 'px'; });
      table.style.tableLayout = 'fixed';
    }
    startX = e.pageX;
    startW = th.offsetWidth;
    handle.classList.add('active');

    function onMove(e2) {
      const diff = e2.pageX - startX;
      const newW = Math.max(60, startW + diff);
      th.style.width = newW + 'px';
      th.style.minWidth = newW + 'px';
    }
    function onUp() {
      handle.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Auto-init resizable columns whenever DOM changes
const tableObserver = new MutationObserver(() => {
  clearTimeout(tableObserver._t);
  tableObserver._t = setTimeout(initAllResizableColumns, 200);
});
const vc = document.getElementById('viewsContainer');
if (vc) tableObserver.observe(vc, { childList: true, subtree: true });

// ── Google Search Console tab ─────────────────────────────────────────────
const gscState = {
  status: null,
  sites: [],
  selectedSite: localStorage.getItem('gsc-selected-site') || '',
  lastResult: null
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function gscDateNDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Date presets matching the Search Console UI. Values are days back from
// today (less the GSC 2-day delay).
const GSC_DATE_PRESETS = [
  { value: '7',    label: 'Last 7 days' },
  { value: '28',   label: 'Last 28 days' },
  { value: '90',   label: 'Last 3 months' },
  { value: '180',  label: 'Last 6 months' },
  { value: '365',  label: 'Last 12 months' },
  { value: '480',  label: 'Last 16 months' },
  { value: 'custom', label: 'Custom range' }
];

function applyGscDatePreset(preset, startInputId, endInputId) {
  if (preset === 'custom') return;
  const days = parseInt(preset);
  if (!days) return;
  document.getElementById(startInputId).value = gscDateNDaysAgo(days);
  document.getElementById(endInputId).value = gscDateNDaysAgo(2);
}

// GSC uses ISO 3166-1 alpha-3 country codes (lowercase in the API).
// Curated list ordered by likely relevance for our user base, then
// alphabetical. The label is what the user sees.
const GSC_COUNTRIES = [
  { code: '', label: 'All countries' },
  { code: 'che', label: 'Switzerland' },
  { code: 'fra', label: 'France' },
  { code: 'deu', label: 'Germany' },
  { code: 'ita', label: 'Italy' },
  { code: 'gbr', label: 'United Kingdom' },
  { code: 'usa', label: 'United States' },
  { code: 'rou', label: 'Romania' },
  { code: 'aut', label: 'Austria' },
  { code: 'bel', label: 'Belgium' },
  { code: 'nld', label: 'Netherlands' },
  { code: 'lux', label: 'Luxembourg' },
  { code: 'esp', label: 'Spain' },
  { code: 'prt', label: 'Portugal' },
  { code: 'pol', label: 'Poland' },
  { code: 'cze', label: 'Czechia' },
  { code: 'svk', label: 'Slovakia' },
  { code: 'hun', label: 'Hungary' },
  { code: 'bgr', label: 'Bulgaria' },
  { code: 'grc', label: 'Greece' },
  { code: 'svn', label: 'Slovenia' },
  { code: 'hrv', label: 'Croatia' },
  { code: 'srb', label: 'Serbia' },
  { code: 'irl', label: 'Ireland' },
  { code: 'dnk', label: 'Denmark' },
  { code: 'swe', label: 'Sweden' },
  { code: 'nor', label: 'Norway' },
  { code: 'fin', label: 'Finland' },
  { code: 'est', label: 'Estonia' },
  { code: 'lva', label: 'Latvia' },
  { code: 'ltu', label: 'Lithuania' },
  { code: 'isl', label: 'Iceland' },
  { code: 'mlt', label: 'Malta' },
  { code: 'cyp', label: 'Cyprus' },
  { code: 'tur', label: 'Türkiye' },
  { code: 'ukr', label: 'Ukraine' },
  { code: 'rus', label: 'Russia' },
  { code: 'can', label: 'Canada' },
  { code: 'mex', label: 'Mexico' },
  { code: 'bra', label: 'Brazil' },
  { code: 'arg', label: 'Argentina' },
  { code: 'col', label: 'Colombia' },
  { code: 'chl', label: 'Chile' },
  { code: 'per', label: 'Peru' },
  { code: 'aus', label: 'Australia' },
  { code: 'nzl', label: 'New Zealand' },
  { code: 'jpn', label: 'Japan' },
  { code: 'kor', label: 'South Korea' },
  { code: 'chn', label: 'China' },
  { code: 'hkg', label: 'Hong Kong' },
  { code: 'twn', label: 'Taiwan' },
  { code: 'sgp', label: 'Singapore' },
  { code: 'mys', label: 'Malaysia' },
  { code: 'tha', label: 'Thailand' },
  { code: 'idn', label: 'Indonesia' },
  { code: 'phl', label: 'Philippines' },
  { code: 'vnm', label: 'Vietnam' },
  { code: 'ind', label: 'India' },
  { code: 'pak', label: 'Pakistan' },
  { code: 'bgd', label: 'Bangladesh' },
  { code: 'are', label: 'United Arab Emirates' },
  { code: 'sau', label: 'Saudi Arabia' },
  { code: 'isr', label: 'Israel' },
  { code: 'qat', label: 'Qatar' },
  { code: 'kwt', label: 'Kuwait' },
  { code: 'zaf', label: 'South Africa' },
  { code: 'egy', label: 'Egypt' },
  { code: 'mar', label: 'Morocco' },
  { code: 'tun', label: 'Tunisia' },
  { code: 'dza', label: 'Algeria' },
  { code: 'nga', label: 'Nigeria' },
  { code: 'ken', label: 'Kenya' }
];

function buildCountryOptions(selected) {
  return GSC_COUNTRIES.map(c =>
    `<option value="${c.code}"${c.code === selected ? ' selected' : ''}>${escapeHtml(c.label)}</option>`
  ).join('');
}

function gscCountryFilterGroup(code) {
  if (!code) return null;
  return [{ filters: [{ dimension: 'country', operator: 'equals', expression: code }] }];
}

// When the server says the GSC refresh token is dead (revoked, expired,
// or the OAuth app was flipped back to Testing mode and the 7-day grace
// ran out), show a friendly inline reconnect prompt instead of just
// dumping the error text. Falls back to a plain error message for any
// other failure so the user still sees something useful.
function renderGscErrorOrReconnect(err) {
  if (err && err.reconnect) {
    const url = err.reconnectUrl || '/api/gsc/auth/start';
    return `<div style="padding:18px;border:1px solid var(--warning);background:rgba(217,119,6,.08);border-radius:8px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
      <div style="flex:1;min-width:240px">
        <div style="font-weight:600;color:var(--text)">Google Search Console session expired</div>
        <div style="color:var(--text-muted);font-size:13px;margin-top:2px">${escapeHtml(err.message || '')}</div>
      </div>
      <a href="${url}" style="padding:9px 18px;border-radius:6px;background:var(--primary);color:#fff;text-decoration:none;font-weight:600">Reconnect to Google</a>
    </div>`;
  }
  return `<div style="padding:20px;color:var(--danger)">${escapeHtml((err && err.message) || 'Request failed')}</div>`;
}

async function loadGscView() {
  const container = document.getElementById('gscContent');
  container.innerHTML = '<p style="color:var(--text-muted);padding:20px">Loading…</p>';

  // Surface OAuth redirect notices
  const params = new URLSearchParams(location.search);
  if (params.get('gsc') === 'error') {
    const reason = params.get('reason') || 'unknown error';
    const friendly = reason === 'missing_scope_webmasters'
      ? `You signed in but didn't grant Search Console access. Click <b>Sign in with Google</b> again and make sure the <b>"View Search Console data for your verified sites"</b> checkbox is ticked on Google's consent screen.`
      : `Could not connect to Google: ${escapeHtml(reason)}`;
    container.insertAdjacentHTML('afterbegin',
      `<div style="background:rgba(220,38,38,.08);border:1px solid var(--danger);color:var(--danger);padding:12px 16px;border-radius:8px;margin-bottom:16px">
         ${friendly}
       </div>`);
    history.replaceState({}, '', location.pathname);
  } else if (params.get('gsc') === 'connected') {
    history.replaceState({}, '', location.pathname);
  }

  try {
    const r = await fetch('/api/gsc/status');
    if (!r.ok) throw new Error('status ' + r.status);
    gscState.status = await r.json();
  } catch (e) {
    container.innerHTML = `<div style="padding:20px;color:var(--danger)">Failed to load GSC status: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (!gscState.status.configured) {
    container.innerHTML = `
      <div style="padding:20px;max-width:780px">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:20px">
          <h3 style="margin-bottom:12px">Google OAuth is not configured</h3>
          <p style="color:var(--text-muted);margin-bottom:12px">
            To enable Search Console login, set the following environment variables on the server and restart:
          </p>
          <pre style="background:var(--bg-input);border:1px solid var(--border);padding:12px;border-radius:6px;font-size:12px;overflow:auto">GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
GOOGLE_REDIRECT_URI=${location.origin}/api/gsc/oauth/callback</pre>
          <p style="color:var(--text-muted);font-size:13px;margin-top:12px">
            Create an OAuth 2.0 Client (type: Web application) in Google Cloud Console,
            enable the <b>Search Console API</b>, then add the redirect URI above to the client.
          </p>
        </div>
      </div>`;
    return;
  }

  if (!gscState.status.connected) {
    container.innerHTML = `
      <div style="padding:40px;text-align:center;max-width:520px;margin:0 auto">
        <div style="font-size:48px;margin-bottom:12px">🔐</div>
        <h3 style="margin-bottom:8px">Connect Google Search Console</h3>
        <p style="color:var(--text-muted);margin-bottom:24px">
          Sign in with the Google account that has access to your Search Console properties.
          We request read-only access (<code>webmasters.readonly</code>).
        </p>
        <a href="/api/gsc/auth/start" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:10px;padding:10px 22px;border-radius:8px;background:var(--primary);color:#fff;text-decoration:none;font-weight:600">
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.7 4.7-6.2 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.5 34.7 26.9 36 24 36c-5.1 0-9.5-3.3-11.2-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.5 5.5C42 35 44 30 44 24c0-1.3-.1-2.6-.4-3.5z"/></svg>
          Sign in with Google
        </a>
      </div>`;
    return;
  }

  renderGscConnectedShell();
  await loadGscSites();
}

function renderGscConnectedShell() {
  const today = gscDateNDaysAgo(2);          // GSC data is ~2 days delayed
  const start = gscDateNDaysAgo(30);
  document.getElementById('gscContent').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr;gap:16px;padding:20px">
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:12px;color:var(--text-muted)">Signed in as</div>
          <div style="font-weight:600">${escapeHtml(gscState.status.email || 'Google account')}</div>
        </div>
        <button id="gscLogout" class="btn btn-secondary" style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Disconnect</button>
      </div>

      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end">
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Property</label>
            <input type="text" id="gscSiteFilter" placeholder="Filter properties…" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);margin-bottom:6px;font-size:13px">
            <select id="gscSite" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)"><option value="">Loading sites…</option></select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Date range</label>
            <select id="gscDatePreset" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
              ${GSC_DATE_PRESETS.map(p => `<option value="${p.value}"${p.value === '28' ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Start date</label>
            <input type="date" id="gscStart" value="${start}" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">End date</label>
            <input type="date" id="gscEnd" value="${today}" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Country</label>
            <select id="gscCountry" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
              ${buildCountryOptions(localStorage.getItem('gsc-country') || '')}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Dimension</label>
            <select id="gscDimension" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
              <option value="query">Query</option>
              <option value="page">Page</option>
              <option value="country">Country</option>
              <option value="device">Device</option>
              <option value="date">Date</option>
              <option value="searchAppearance">Search appearance</option>
              <option value="query,page">Query + Page</option>
              <option value="page,query">Page + Query</option>
              <option value="date,query">Date + Query</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Search type</label>
            <select id="gscType" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
              <option value="web">Web</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="news">News</option>
              <option value="discover">Discover</option>
              <option value="googleNews">Google News</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Rows</label>
            <input type="number" id="gscRowLimit" value="1000" min="1" max="25000" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <button id="gscRun" class="btn btn-primary" style="width:100%;padding:9px;border-radius:6px;background:var(--primary);color:#fff;border:none;cursor:pointer;font-weight:600">Fetch data</button>
          </div>
        </div>
        <div style="display:flex;gap:16px;margin-top:12px;flex-wrap:wrap;align-items:center">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)">
            <input type="checkbox" id="gscFresh"> Include fresh (recent) data
          </label>
          <input type="text" id="gscFilter" placeholder="Filter rows in table…" style="flex:1;min-width:200px;padding:7px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          <button id="gscExport" class="btn btn-secondary" style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Export CSV</button>
        </div>
      </div>

      <div id="gscTotals" style="display:none;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px"></div>

      <div id="gscResults"></div>
    </div>
  `;

  document.getElementById('gscLogout').addEventListener('click', gscLogout);
  document.getElementById('gscRun').addEventListener('click', runGscQuery);
  document.getElementById('gscExport').addEventListener('click', exportGscCsv);
  document.getElementById('gscFilter').addEventListener('input', renderGscResults);
  document.getElementById('gscSite').addEventListener('change', (e) => {
    gscState.selectedSite = e.target.value;
    localStorage.setItem('gsc-selected-site', gscState.selectedSite);
  });
  document.getElementById('gscDatePreset').addEventListener('change', (e) => {
    applyGscDatePreset(e.target.value, 'gscStart', 'gscEnd');
  });
  document.getElementById('gscCountry').addEventListener('change', (e) => {
    localStorage.setItem('gsc-country', e.target.value);
  });
  // Mark preset as "custom" when the user edits dates manually.
  for (const id of ['gscStart', 'gscEnd']) {
    document.getElementById(id).addEventListener('change', () => {
      document.getElementById('gscDatePreset').value = 'custom';
    });
  }
  wireSelectFilter('gscSiteFilter', 'gscSite');
}

// Generic helper: filter the visible <option>s of a <select> from a text input.
function wireSelectFilter(filterInputId, selectId) {
  const input = document.getElementById(filterInputId);
  const sel = document.getElementById(selectId);
  if (!input || !sel) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let firstVisible = null;
    for (const opt of sel.options) {
      const match = !q || opt.textContent.toLowerCase().includes(q);
      opt.hidden = !match;
      if (match && !firstVisible) firstVisible = opt;
    }
    // If the current selection is hidden by the filter, move to first match.
    if (sel.selectedOptions[0] && sel.selectedOptions[0].hidden && firstVisible) {
      sel.value = firstVisible.value;
      sel.dispatchEvent(new Event('change'));
    }
  });
}

// Returns the hostname of the site currently being crawled / queued in the
// top URL bar — or null. Used to auto-pick the matching GSC property.
function getCurrentSiteHost() {
  let raw = (document.getElementById('urlInput') || {}).value || '';
  raw = raw.trim();
  if (!raw && analysisData && analysisData.startUrl) raw = analysisData.startUrl;
  if (!raw) return null;
  try {
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

// Score how well a GSC property matches a host. Higher = better.
// Handles `sc-domain:example.com` and URL-prefix properties like
// `https://example.com/` / `https://www.example.com/` / subpaths.
function scoreGscMatch(siteUrl, host) {
  if (!host) return 0;
  const s = String(siteUrl);
  if (s.startsWith('sc-domain:')) {
    const d = s.slice('sc-domain:'.length).toLowerCase();
    if (d === host) return 100;
    if (host.endsWith('.' + d)) return 80;
    if (d.endsWith('.' + host)) return 60;
    return 0;
  }
  try {
    const u = new URL(s);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (h === host) return 90;
    if (host.endsWith('.' + h)) return 70;
    if (h.endsWith('.' + host)) return 50;
  } catch { /* ignore */ }
  return 0;
}

// Permissions returned by GSC's /sites endpoint, ranked usable → unusable.
// siteUnverifiedUser means the auth token holder isn't verified for the
// property, so any /searchAnalytics/query against it will 403 — we'd
// rather auto-select a sibling property they actually own.
function permissionRank(level) {
  switch (level) {
    case 'siteOwner':           return 4;
    case 'siteFullUser':        return 3;
    case 'siteRestrictedUser':  return 2;
    case 'siteUnverifiedUser':  return 0;
    case 'siteUnverified':      return 0;
    default:                    return 1;
  }
}

// Depth of the URL path on a URL-prefix property (0 = root, 1 = /de/, ...).
// sc-domain properties cover everything, so we treat them as depth 0.
function gscPathDepth(siteUrl) {
  const s = String(siteUrl);
  if (s.startsWith('sc-domain:')) return 0;
  try {
    const u = new URL(s);
    const path = (u.pathname || '/').replace(/^\/+|\/+$/g, '');
    return path ? path.split('/').length : 0;
  } catch { return 99; }
}

function findMatchingGscSite(sites, host) {
  if (!sites || !sites.length || !host) return null;

  // Find all host-matching properties, then rank them by:
  //   1. usable permission (siteUnverifiedUser can't query, drop unless
  //      it's the only thing matching the host),
  //   2. higher permission level (Owner > FullUser > RestrictedUser),
  //   3. shorter path — pick "experis.ch/" over "experis.ch/de/" so a
  //      multilingual site never auto-selects the wrong language,
  //   4. sc-domain over URL-prefix (covers every subpath at once),
  //   5. raw host-match score as the final tie-breaker.
  const all = sites
    .map(s => ({ s, hostScore: scoreGscMatch(s.siteUrl, host) }))
    .filter(x => x.hostScore > 0);
  if (!all.length) return null;

  const usable = all.filter(x => permissionRank(x.s.permissionLevel) > 0);
  const pool = usable.length ? usable : all;

  pool.sort((a, b) => {
    const pr = permissionRank(b.s.permissionLevel) - permissionRank(a.s.permissionLevel);
    if (pr) return pr;
    const pd = gscPathDepth(a.s.siteUrl) - gscPathDepth(b.s.siteUrl);
    if (pd) return pd;
    const sa = String(a.s.siteUrl).startsWith('sc-domain:') ? 1 : 0;
    const sb = String(b.s.siteUrl).startsWith('sc-domain:') ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return b.hostScore - a.hostScore;
  });
  return pool[0].s;
}

async function loadGscSites() {
  const sel = document.getElementById('gscSite');
  try {
    const r = await fetch('/api/gsc/sites');
    if (!r.ok) throw new Error((await r.json()).error || 'failed');
    const { sites } = await r.json();
    gscState.sites = sites || [];
    if (!gscState.sites.length) {
      sel.innerHTML = '<option value="">No properties found for this account</option>';
      renderGscMatchBanner(null, null);
      return;
    }

    const host = getCurrentSiteHost();
    const matched = findMatchingGscSite(gscState.sites, host);
    // Prefer the auto-matched property; otherwise fall back to the
    // previously-selected one; otherwise the first site.
    let target = gscState.selectedSite;
    if (matched) target = matched.siteUrl;
    if (!target || !gscState.sites.some(s => s.siteUrl === target)) {
      target = gscState.sites[0].siteUrl;
    }
    gscState.selectedSite = target;
    localStorage.setItem('gsc-selected-site', target);

    sel.innerHTML = gscState.sites.map(s => {
      const isSel = s.siteUrl === target ? ' selected' : '';
      return `<option value="${escapeHtml(s.siteUrl)}"${isSel}>${escapeHtml(s.siteUrl)} (${escapeHtml(s.permissionLevel || '')})</option>`;
    }).join('');

    renderGscMatchBanner(host, matched);

    // If we auto-matched the crawled site, fetch data straight away.
    if (matched) runGscQuery();
  } catch (e) {
    sel.innerHTML = `<option value="">Error</option>`;
    showGscApiError(e.message);
  }
}

function showGscApiError(message) {
  const lower = String(message || '').toLowerCase();
  const insufficient = lower.includes('insufficient') && lower.includes('scope');
  const html = insufficient
    ? `<div style="background:rgba(217,119,6,.08);border:1px solid var(--warning);color:var(--text);padding:14px 16px;border-radius:8px;margin-top:12px">
         <div style="font-weight:600;margin-bottom:6px">Search Console access wasn't granted</div>
         <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px">
           Your Google sign-in succeeded but the token doesn't include the <code>webmasters.readonly</code> scope.
           Disconnect, sign in again, and tick the <b>"View Search Console data for your verified sites"</b> checkbox on Google's consent screen.
         </div>
         <button id="gscReconnect" class="btn btn-primary" style="padding:8px 16px;border-radius:6px;background:var(--primary);color:#fff;border:none;cursor:pointer;font-weight:600">Disconnect &amp; reconnect</button>
       </div>`
    : `<div style="background:rgba(220,38,38,.08);border:1px solid var(--danger);color:var(--danger);padding:12px 16px;border-radius:8px;margin-top:12px">${escapeHtml(message)}</div>`;
  const totals = document.getElementById('gscTotals');
  if (totals) totals.insertAdjacentHTML('beforebegin', html);
  const btn = document.getElementById('gscReconnect');
  if (btn) btn.addEventListener('click', async () => {
    await fetch('/api/gsc/logout', { method: 'POST' });
    location.href = '/api/gsc/auth/start';
  });
}

function renderGscMatchBanner(host, matched) {
  const id = 'gscMatchBanner';
  let el = document.getElementById(id);
  if (!host) { if (el) el.remove(); return; }
  const msg = matched
    ? `Showing data for <b>${escapeHtml(matched.siteUrl)}</b> — auto-matched from <b>${escapeHtml(host)}</b> in the URL bar.`
    : `<b>${escapeHtml(host)}</b> is in the URL bar but no matching Search Console property was found in your account. You can pick one manually above.`;
  const html = `<div id="${id}" style="background:${matched ? 'rgba(99,102,241,.08)' : 'rgba(217,119,6,.08)'};border:1px solid ${matched ? 'var(--primary)' : 'var(--warning)'};color:var(--text);padding:10px 14px;border-radius:8px;font-size:13px">${msg}</div>`;
  if (el) { el.outerHTML = html; }
  else {
    const totals = document.getElementById('gscTotals');
    if (totals) totals.insertAdjacentHTML('beforebegin', html);
  }
}

async function gscLogout() {
  if (!confirm('Disconnect this Google account from the SEO tool?')) return;
  await fetch('/api/gsc/logout', { method: 'POST' });
  loadGscView();
}

async function runGscQuery() {
  const siteUrl = document.getElementById('gscSite').value;
  const startDate = document.getElementById('gscStart').value;
  const endDate = document.getElementById('gscEnd').value;
  const dimensionsRaw = document.getElementById('gscDimension').value;
  const dimensions = dimensionsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const searchType = document.getElementById('gscType').value;
  const rowLimit = parseInt(document.getElementById('gscRowLimit').value) || 1000;
  const dataState = document.getElementById('gscFresh').checked ? 'all' : 'final';
  const country = (document.getElementById('gscCountry') || {}).value || '';

  if (!siteUrl) { alert('Select a property first.'); return; }

  const btn = document.getElementById('gscRun');
  btn.disabled = true; btn.textContent = 'Loading…';
  const results = document.getElementById('gscResults');
  results.innerHTML = '<p style="color:var(--text-muted);padding:20px">Querying Google Search Console…</p>';

  try {
    const body = { siteUrl, startDate, endDate, dimensions, rowLimit, searchType, dataState };
    const countryFilter = gscCountryFilterGroup(country);
    if (countryFilter) body.dimensionFilterGroups = countryFilter;
    const r = await fetch('/api/gsc/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) {
      const err = new Error(data.error || 'Query failed');
      err.reconnect = !!data.reconnect;
      err.reconnectUrl = data.reconnectUrl || '/api/gsc/auth/start';
      throw err;
    }
    gscState.lastResult = { rows: data.rows || [], dimensions, siteUrl, startDate, endDate };
    renderGscTotals();
    renderGscResults();
  } catch (e) {
    results.innerHTML = renderGscErrorOrReconnect(e);
    gscState.lastResult = null;
    document.getElementById('gscTotals').style.display = 'none';
  } finally {
    btn.disabled = false; btn.textContent = 'Fetch data';
  }
}

function renderGscTotals() {
  const totalsEl = document.getElementById('gscTotals');
  if (!gscState.lastResult || !gscState.lastResult.rows.length) {
    totalsEl.style.display = 'none';
    return;
  }
  let clicks = 0, impressions = 0;
  for (const row of gscState.lastResult.rows) {
    clicks += row.clicks || 0;
    impressions += row.impressions || 0;
  }
  const ctr = impressions ? (clicks / impressions) : 0;
  const avgPos = gscState.lastResult.rows.reduce((a, r) => a + (r.position || 0), 0) / gscState.lastResult.rows.length;
  const card = (label, value) => `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px">
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em">${label}</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${value}</div>
    </div>`;
  totalsEl.style.display = 'grid';
  totalsEl.innerHTML =
    card('Clicks', clicks.toLocaleString()) +
    card('Impressions', impressions.toLocaleString()) +
    card('CTR', (ctr * 100).toFixed(2) + '%') +
    card('Avg. position', avgPos.toFixed(1));
}

function renderGscResults() {
  const wrap = document.getElementById('gscResults');
  if (!gscState.lastResult) { wrap.innerHTML = ''; return; }
  const { rows, dimensions } = gscState.lastResult;
  if (!rows.length) {
    wrap.innerHTML = '<div style="padding:20px;color:var(--text-muted)">No rows returned for this query.</div>';
    return;
  }
  const filter = (document.getElementById('gscFilter').value || '').toLowerCase();
  const filtered = filter
    ? rows.filter(r => (r.keys || []).some(k => String(k).toLowerCase().includes(filter)))
    : rows;

  const headers = [...dimensions, 'Clicks', 'Impressions', 'CTR', 'Position'];
  const body = filtered.map(r => {
    const keys = (r.keys || []).map(k => `<td>${escapeHtml(k)}</td>`).join('');
    const ctr = ((r.ctr || 0) * 100).toFixed(2) + '%';
    return `<tr>${keys}<td style="text-align:right">${(r.clicks || 0).toLocaleString()}</td><td style="text-align:right">${(r.impressions || 0).toLocaleString()}</td><td style="text-align:right">${ctr}</td><td style="text-align:right">${(r.position || 0).toFixed(1)}</td></tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="table-container" style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;overflow:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:var(--bg-hover)">
            ${headers.map((h, i) => `<th style="padding:10px 12px;text-align:${i >= dimensions.length ? 'right' : 'left'};border-bottom:1px solid var(--border);font-weight:600">${escapeHtml(h)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div style="padding:10px 4px;color:var(--text-muted);font-size:12px">Showing ${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} rows.</div>
  `;
}

function exportGscCsv() {
  if (!gscState.lastResult || !gscState.lastResult.rows.length) {
    alert('Run a query first.');
    return;
  }
  const { rows, dimensions, siteUrl, startDate, endDate } = gscState.lastResult;
  const headers = [...dimensions, 'clicks', 'impressions', 'ctr', 'position'];
  const escape = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    const keys = r.keys || [];
    lines.push([...keys, r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0].map(escape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const safeHost = (siteUrl || 'gsc').replace(/[^a-z0-9]/gi, '_');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gsc_${safeHost}_${startDate}_${endDate}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// If page loaded via OAuth redirect (#gsc), auto-open the tab.
if (location.hash === '#gsc' || new URLSearchParams(location.search).get('gsc')) {
  document.addEventListener('DOMContentLoaded', () => {
    const link = document.querySelector('.nav-link[data-view="gsc"]');
    if (link) link.click();
  });
}

// /share/<id>: auto-load that crawl on boot. The viewer has already
// authenticated via the /login?next=/share/<id> round-trip, so we just
// open the same dashboard the owner sees — no read-only banner, full
// access to GSC / Content Strategy / Saved Projects.
if (SHARE_ID) {
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await window.loadCrawl(SHARE_ID);
    } catch (e) {
      const c = document.getElementById('dashboardContent') || document.body;
      c.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger)">This audit could not be loaded.<br><small style="color:var(--text-muted)">${e && e.message ? e.message : ''}</small></div>`;
      c.classList.remove('hidden');
      document.getElementById('emptyState')?.classList.add('hidden');
    }
  });
}

// Auto-restore the previously-loaded crawl only when we're returning
// from Google's OAuth round-trip (`?gsc=connected` is set by the
// callback handler). A plain refresh should start with a clean state —
// the user can reopen any past crawl from the Saved Projects tab.
(async function restoreCrawlOnBoot() {
  const params = new URLSearchParams(location.search);
  const returningFromOAuth = params.get('gsc') === 'connected';
  if (!returningFromOAuth) return;
  const id = sessionStorage.getItem('currentCrawlId');
  if (!id) return;
  try {
    const r = await fetch(`/api/crawls/${id}`);
    if (!r.ok) { sessionStorage.removeItem('currentCrawlId'); return; }
    const crawl = await r.json();
    if (!crawl || crawl.status !== 'completed') return;
    if (typeof window.loadCrawl === 'function') {
      await window.loadCrawl(id);
      const link = document.querySelector('.nav-link[data-view="gsc"]');
      if (link) link.click();
    }
  } catch { /* ignore — user can re-crawl */ }
})();

// ── Content Strategy tab ─────────────────────────────────────────────────
// Opportunity bands: pages outside position 1 grouped by current ranking.
// targetPos is the rank we estimate the page could realistically reach with
// content/internal-linking work — used to compute potential-clicks uplift.
const STRATEGY_BANDS = [
  { id: 'push',     label: 'Push to #1',         min: 1.5,  max: 3.5,  target: 1,  color: '#16a34a' },
  { id: 'striking', label: 'Striking distance',  min: 3.5,  max: 10.5, target: 3,  color: '#2563eb' },
  { id: 'page2',    label: 'Page 2',             min: 10.5, max: 20.5, target: 5,  color: '#6366f1' },
  { id: 'deep',     label: 'Hidden volume',      min: 20.5, max: 30.5, target: 10, color: '#d97706' },
  { id: 'deeper',   label: 'Deep but searched',  min: 30.5, max: 40.5, target: 10, color: '#dc2626' }
];

// Rough CTR-by-position curve (averaged from public studies — Advanced Web
// Ranking / Sistrix / Backlinko 2023). Good enough for uplift estimation.
const CTR_BY_POS = {
  1: 0.30, 2: 0.16, 3: 0.10, 4: 0.07, 5: 0.05,
  6: 0.04, 7: 0.03, 8: 0.025, 9: 0.022, 10: 0.020,
  11: 0.012, 12: 0.011, 13: 0.010, 14: 0.009, 15: 0.009,
  16: 0.008, 17: 0.008, 18: 0.007, 19: 0.007, 20: 0.007,
  21: 0.006, 22: 0.005, 23: 0.005, 24: 0.005, 25: 0.005,
  26: 0.004, 27: 0.004, 28: 0.004, 29: 0.004, 30: 0.004,
  31: 0.003, 32: 0.003, 33: 0.003, 34: 0.003, 35: 0.003,
  36: 0.002, 37: 0.002, 38: 0.002, 39: 0.002, 40: 0.002
};

function ctrAtPosition(p) {
  if (p == null) return 0;
  const rounded = Math.max(1, Math.min(40, Math.round(p)));
  return CTR_BY_POS[rounded] ?? 0.001;
}

function bandForPosition(p) {
  return STRATEGY_BANDS.find(b => p >= b.min && p < b.max) || null;
}

// ── Strategy recommendation helpers ──────────────────────────────────────

// "loyer impayé genève" → "loyer-impaye-geneve"
function slugifyKeyword(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

// Tokens of a normalised string with stop-words filtered out, so we can
// measure how much of a keyword's substance appears in a URL slug. Stop
// words exist for FR/EN/DE — the most common languages on Converta's sites.
const STOPWORDS = new Set([
  'de','du','le','la','les','un','une','des','et','en','au','aux','à','a','d','l',
  'the','of','and','or','for','to','in','on','with','at',
  'der','die','das','und','von','zu','bei','mit','im','am'
]);

function meaningfulTokens(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length >= 2 && !STOPWORDS.has(w));
}

// Returns 0…1 indicating how much of a keyword's meaningful tokens appear
// in the URL's slug. Substring match so "geneve" matches "geneve-centre".
function keywordInUrlScore(url, keyword) {
  const tokens = meaningfulTokens(keyword);
  if (!tokens.length) return 0;
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch { return 0; }
  const slug = path.replace(/[^a-z0-9]+/g, ' ');
  const matched = tokens.filter(t => slug.includes(t)).length;
  return matched / tokens.length;
}

// Build a suggested new URL for a keyword based on the current page's
// parent directory — preserves the site's existing URL pattern (eg
// /adresses/<x>/, /services/<x>/) rather than dumping a slug at the root.
function suggestNewLandingUrl(currentUrl, keyword) {
  try {
    const u = new URL(currentUrl);
    const slug = slugifyKeyword(keyword);
    if (!slug) return null;
    // Drop the leaf segment, keep the rest.
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length > 1) parts.pop();
    const parent = parts.length ? '/' + parts.join('/') + '/' : '/';
    return u.origin + parent + slug + '/';
  } catch { return null; }
}

// Brand-name detection. The hostname's domain root (e.g. "groupemutuel"
// from "www.groupemutuel.ch" or "sc-domain:groupemutuel.ch") is treated as
// the brand stem. A "brand-only" query is one that, when stripped of
// non-alphanumeric chars, equals the brand stem — meaning the user is
// looking for the brand directly with no intent qualifier. These should
// only target the homepage; inner pages ranking for the bare brand are
// navigational noise (Google shows them because the site's name is in
// the title, not because they target the brand).
function getBrandStem(siteUrl) {
  if (!siteUrl) return '';
  try {
    let raw = String(siteUrl).replace(/^sc-domain:/, '');
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    const u = new URL(raw);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    const parts = h.split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : h;
  } catch { return ''; }
}
function flattenForBrandCompare(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
// Bounded Levenshtein — catches typo variants of the brand (e.g.
// "group mutuel" vs the stem "groupemutuel", "groupe mutuelle" with the
// extra trailing -e). Bound the work at length-difference: if the
// strings can't be within `max` edits even by free insert/delete on the
// shorter one, return early.
function lev(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = dp[0];
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      if (dp[j] < rowMin) rowMin = dp[j];
      prev = tmp;
    }
    if (rowMin > max) return max + 1;
  }
  return dp[n];
}
function isBrandOnlyQuery(query, brandStem) {
  if (!brandStem) return false;
  const q = flattenForBrandCompare(query);
  if (!q) return false;
  const stem = brandStem.toLowerCase();
  if (q === stem) return true;
  // Fuzzy: catches typo variants like "group mutuel" (missing letter),
  // "groupe mutuelle" (extra trailing letter), "groupmutuel" etc.
  const maxDist = stem.length >= 8 ? 2 : 1;
  if (lev(q, stem, maxDist) <= maxDist) return true;
  // Partial: a single word from the brand counted as brand-only. The
  // user search "groupe" or "mutuel" on a multi-word brand like
  // "groupemutuel" is still brand-intent; don't suggest it for inner
  // pages. Min length 4 keeps "ge" / "mut" from false-matching.
  if (q.length >= 4 && stem.includes(q)) return true;
  // Brand with a short trailing/leading bit, e.g. "groupemutuel.ch"
  // (flatten → "groupemutuelch") or "lesgroupemutuel". The query
  // contains the brand and adds <=3 extra chars.
  if (q.includes(stem) && q.length - stem.length <= 3) return true;
  return false;
}
function isHomepagePage(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const path = (u.pathname || '/').replace(/\/+$/, '');
    return path === '' || /^\/(index|home|default)(\.html?|\.php|\.aspx?)?$/i.test(path);
  } catch { return false; }
}
// URL path depth — used to identify which page is closest to the
// homepage. "/" → 0, "/fr/" → 1, "/fr/clients-prives.html" → 2, etc.
function urlPathDepth(pageUrl) {
  try {
    const u = new URL(pageUrl);
    return u.pathname.split('/').filter(Boolean).length;
  } catch { return 99; }
}

// Decide what to do with a page-query opportunity. Returns one of:
//   optimize           — page is on-topic; small edits (title, body, links)
//   rewrite-expand     — page is partial; needs a meaningful rework
//   create-landing     — page is tangentially related; a dedicated landing
//                        page would rank substantially better
function recommendStrategy(row) {
  const bestQ = row.bestQuery || '';
  const cov = row.coverage && Array.isArray(row.coverage.queries) ? row.coverage : null;
  const covQ = cov ? cov.queries.find(q => q.query === bestQ) : null;

  const urlScore = keywordInUrlScore(row.page, bestQ);

  // Heuristics. Without coverage we lean on URL relevance + crawl signals
  // (title length tells us a real <title> exists). With coverage we have
  // strong per-section signal.
  let titleScore = 0, h1Score = 0, bodyScore = 0;
  let pageWordCount = 0;
  if (cov && covQ) {
    titleScore = covQ.phrase.inTitle ? 1 : 0;
    h1Score = covQ.phrase.inH1 ? 1 : (covQ.phrase.inHeadings ? 0.5 : 0);
    bodyScore = covQ.phrase.bodyOccurrences >= 3 ? 1 : (covQ.phrase.bodyOccurrences > 0 ? 0.5 : 0);
    pageWordCount = cov.wordCount || 0;
  } else if (row.crawl) {
    pageWordCount = row.crawl.wordCount || 0;
  }

  // Combine: URL relevance is heavily weighted because it's the strongest
  // signal of "this page is meant to be about this keyword".
  const relevance = urlScore * 0.5 + titleScore * 0.2 + h1Score * 0.15 + bodyScore * 0.15;

  if (relevance >= 0.55) {
    return {
      type: 'optimize',
      label: 'Optimize this page',
      color: '16A34A',
      reason: cov
        ? 'Page is the right topic match — refine the title, deepen the body and strengthen internal links to push it higher.'
        : 'URL slug looks topically aligned — refine on-page SEO to push it higher.',
      pageWordCount
    };
  } else if (relevance >= 0.25 || urlScore >= 0.25) {
    return {
      type: 'rewrite-expand',
      label: 'Rewrite & expand',
      color: 'D97706',
      reason: 'Only partially relevant to the keyword. Rewrite the title/H1, add a dedicated section, and expand the content.',
      pageWordCount
    };
  } else {
    return {
      type: 'create-landing',
      label: 'Create new landing page',
      color: 'DC2626',
      reason: 'The current URL is only tangentially related to this keyword — Google ranks it because it\'s the closest match, but a dedicated landing page would convert demand into clicks.',
      suggestedUrl: suggestNewLandingUrl(row.page, bestQ),
      pageWordCount
    };
  }
}

const csState = {
  sites: [],
  selectedSite: localStorage.getItem('gsc-selected-site') || '',
  rows: [],         // enriched rows for the table
  expanded: new Set(),
  crawlPages: null, // URL → { title, h1Count, wordCount } from active crawl
  querySort: { key: 'impressions', dir: 'desc' }   // sort for the per-page queries table
};

async function loadStrategyView() {
  const container = document.getElementById('strategyContent');
  container.innerHTML = '<p style="color:var(--text-muted);padding:20px">Loading…</p>';

  let status;
  try {
    const r = await fetch('/api/gsc/status');
    status = await r.json();
  } catch (e) {
    container.innerHTML = `<div style="padding:20px;color:var(--danger)">Failed to load GSC status: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (!status.configured || !status.connected) {
    container.innerHTML = `
      <div style="padding:40px;text-align:center;max-width:520px;margin:0 auto">
        <div style="font-size:48px;margin-bottom:12px">📈</div>
        <h3 style="margin-bottom:8px">Content Strategy needs Search Console</h3>
        <p style="color:var(--text-muted);margin-bottom:20px">
          This tab finds pages that already get search impressions but rank below position 1.
          Connect Google Search Console first.
        </p>
        <a href="#" class="btn btn-primary" id="strategyGoToGsc" style="display:inline-block;padding:10px 22px;border-radius:8px;background:var(--primary);color:#fff;text-decoration:none;font-weight:600">Open Search Console tab</a>
      </div>`;
    document.getElementById('strategyGoToGsc').addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelector('.nav-link[data-view="gsc"]').click();
    });
    return;
  }

  renderStrategyShell();
  await Promise.all([loadStrategySites(), loadStrategyCrawlPages()]);
}

// Build a URL → crawl-metadata lookup if there's a completed crawl loaded.
async function loadStrategyCrawlPages() {
  csState.crawlPages = null;
  if (!currentCrawlId) return;
  try {
    const r = await fetch(`/api/crawls/${currentCrawlId}/pages?limit=10000`);
    if (!r.ok) return;
    const pages = await r.json();
    const map = new Map();
    for (const p of pages || []) {
      const norm = normaliseUrlForJoin(p.url);
      if (norm) map.set(norm, {
        title: p.title || '',
        titleLength: p.title_length || 0,
        h1Count: p.h1_count || 0,
        wordCount: p.word_count || 0,
        statusCode: p.status_code || 0
      });
      const finalNorm = normaliseUrlForJoin(p.final_url);
      if (finalNorm && finalNorm !== norm) map.set(finalNorm, map.get(norm));
    }
    csState.crawlPages = map;
  } catch { /* ignore */ }
}

function normaliseUrlForJoin(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    let path = url.pathname.replace(/\/+$/, '') || '/';
    return (url.protocol + '//' + url.host.replace(/^www\./, '') + path).toLowerCase();
  } catch { return null; }
}

function renderStrategyShell() {
  const today = gscDateNDaysAgo(2);
  const start = gscDateNDaysAgo(28);
  const bandCheckboxes = STRATEGY_BANDS.map(b => `
    <label style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--border);border-radius:999px;background:var(--bg-input);font-size:12px;cursor:pointer">
      <input type="checkbox" class="strategy-band" data-band="${b.id}" checked> <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${b.color}"></span> ${escapeHtml(b.label)} <span style="color:var(--text-muted)">(${b.min === 1.5 ? 2 : Math.ceil(b.min)}–${Math.floor(b.max)})</span>
    </label>`).join('');

  document.getElementById('strategyContent').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr;gap:16px;padding:20px">
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end">
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Property</label>
            <input type="text" id="csSiteFilter" placeholder="Filter properties…" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);margin-bottom:6px;font-size:13px">
            <select id="csSite" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)"><option value="">Loading sites…</option></select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Date range</label>
            <select id="csDatePreset" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
              ${GSC_DATE_PRESETS.map(p => `<option value="${p.value}"${p.value === '28' ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Start date</label>
            <input type="date" id="csStart" value="${start}" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">End date</label>
            <input type="date" id="csEnd" value="${today}" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Country</label>
            <select id="csCountry" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
              ${buildCountryOptions(localStorage.getItem('gsc-country') || '')}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Search type</label>
            <select id="csType" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
              <option value="web">Web</option><option value="image">Image</option>
              <option value="video">Video</option><option value="news">News</option>
              <option value="discover">Discover</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Min impressions (per query)</label>
            <input type="number" id="csMinImpressions" value="10" min="0" title="Per-query impression threshold. Lower this to include lower-volume queries that often dominate Push-to-#1 and Page-2 bands." style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <button id="csRun" class="btn btn-primary" style="width:100%;padding:9px;border-radius:6px;background:var(--primary);color:#fff;border:none;cursor:pointer;font-weight:600">Find opportunities</button>
          </div>
        </div>
        <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span style="font-size:12px;color:var(--text-muted);margin-right:4px">Bands:</span>
          ${bandCheckboxes}
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
          A page is counted in every band where it has at least one ranking query above the min-impressions threshold, so the same page can appear in multiple bands (Push-to-#1 for one query, Page 2 for another).
        </div>
        <div style="display:flex;gap:12px;margin-top:12px;flex-wrap:wrap;align-items:center">
          <input type="text" id="csTextFilter" placeholder="Filter rows (URL or query)…" style="flex:1;min-width:200px;padding:7px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          <button id="csAnalyse" class="btn btn-secondary" title="Fetch each page and analyse whether the queries it ranks for actually appear on the page" style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Analyse keyword coverage</button>
          <label id="csQuickWinsLabel" title="Show only opportunities where at least one query is completely missing from the page" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);opacity:.6">
            <input type="checkbox" id="csQuickWins" disabled> Quick wins only
          </label>
          <button id="csExport" class="btn btn-secondary" style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Export CSV</button>
          <select id="csExportLang" title="Deck language" style="padding:7px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer;font-size:13px">
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
          <button id="csExportPpt" class="btn btn-secondary" title="One slide per opportunity, with action items based on the coverage gaps" style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Export PPT</button>
          <button id="csExportPdf" class="btn btn-secondary" title="Open a printable HTML report; use your browser's Print → Save as PDF" style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Export PDF</button>
        </div>
        <div id="csAnalyseProgress" style="display:none;margin-top:10px"></div>
        <style>
          @keyframes csBarStripe { 0% { background-position: 0 0; } 100% { background-position: 40px 0; } }
          @keyframes csBarPulse  { 0%, 100% { opacity: 1; } 50% { opacity: .85; } }
          .cs-progress-bar { position: relative; height: 10px; border-radius: 999px; overflow: hidden; background: var(--bg-input); border: 1px solid var(--border); }
          .cs-progress-fill { height: 100%; background: linear-gradient(135deg, #6366F1 0%, #8B5CF6 35%, #6366F1 70%, #4F46E5 100%); background-size: 40px 40px; animation: csBarStripe 1.4s linear infinite, csBarPulse 1.6s ease-in-out infinite; transition: width .35s ease-out; border-radius: 999px; }
          .cs-progress-fill.done { animation: none; background: linear-gradient(135deg, #16A34A, #22C55E); }
          .cs-progress-fill.stopped { animation: none; background: var(--warning); }
        </style>
      </div>

      <div id="csSummary" style="display:none;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px"></div>
      <div id="csStrategicOverview"></div>
      <div id="csExcludedHint"></div>
      <div id="csCoverageHint"></div>
      <div id="csTable"></div>
    </div>
  `;

  document.getElementById('csRun').addEventListener('click', runStrategyQuery);
  document.getElementById('csExport').addEventListener('click', exportStrategyCsv);
  document.getElementById('csExportPpt').addEventListener('click', async () => {
    const btn = document.getElementById('csExportPpt');
    const origLabel = btn.textContent;
    try {
      await exportStrategyPpt();
    } catch (e) {
      console.error('Export failed:', e);
      alert('PPT export failed: ' + (e && e.message ? e.message : e) + '\n\nOpen the browser console for the full stack trace.');
    } finally {
      // Belt-and-braces: always restore the button so the user can retry.
      btn.disabled = false;
      if (btn.textContent !== origLabel) btn.textContent = origLabel;
    }
  });
  document.getElementById('csExportPdf').addEventListener('click', () => {
    try {
      exportStrategyPdf();
    } catch (e) {
      console.error('PDF export failed:', e);
      alert('PDF export failed: ' + (e && e.message ? e.message : e));
    }
  });
  const langSel = document.getElementById('csExportLang');
  if (langSel) {
    langSel.value = localStorage.getItem('cs-export-lang') || 'en';
    langSel.addEventListener('change', () => localStorage.setItem('cs-export-lang', langSel.value));
  }
  document.getElementById('csTextFilter').addEventListener('input', renderStrategyTable);
  document.getElementById('csAnalyse').addEventListener('click', analyseAllCoverage);
  document.getElementById('csQuickWins').addEventListener('change', renderStrategyTable);
  document.getElementById('csSite').addEventListener('change', (e) => {
    csState.selectedSite = e.target.value;
    localStorage.setItem('gsc-selected-site', csState.selectedSite);
  });
  document.getElementById('csDatePreset').addEventListener('change', (e) => {
    applyGscDatePreset(e.target.value, 'csStart', 'csEnd');
  });
  document.getElementById('csCountry').addEventListener('change', (e) => {
    localStorage.setItem('gsc-country', e.target.value);
  });
  for (const id of ['csStart', 'csEnd']) {
    document.getElementById(id).addEventListener('change', () => {
      document.getElementById('csDatePreset').value = 'custom';
    });
  }
  for (const cb of document.querySelectorAll('.strategy-band')) {
    cb.addEventListener('change', renderStrategyTable);
  }
  wireSelectFilter('csSiteFilter', 'csSite');
}

async function loadStrategySites() {
  const sel = document.getElementById('csSite');
  try {
    const r = await fetch('/api/gsc/sites');
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'failed');
    }
    const { sites } = await r.json();
    csState.sites = sites || [];
    if (!csState.sites.length) {
      sel.innerHTML = '<option value="">No properties found</option>';
      return;
    }

    const host = getCurrentSiteHost();
    const matched = findMatchingGscSite(csState.sites, host);
    let target = csState.selectedSite;
    if (matched) target = matched.siteUrl;
    if (!target || !csState.sites.some(s => s.siteUrl === target)) target = csState.sites[0].siteUrl;
    csState.selectedSite = target;
    localStorage.setItem('gsc-selected-site', target);

    sel.innerHTML = csState.sites.map(s => {
      const isSel = s.siteUrl === target ? ' selected' : '';
      return `<option value="${escapeHtml(s.siteUrl)}"${isSel}>${escapeHtml(s.siteUrl)} (${escapeHtml(s.permissionLevel || '')})</option>`;
    }).join('');

    if (matched) runStrategyQuery();
  } catch (e) {
    sel.innerHTML = `<option value="">Error: ${escapeHtml(e.message)}</option>`;
  }
}

async function runStrategyQuery() {
  const siteUrl = document.getElementById('csSite').value;
  const startDate = document.getElementById('csStart').value;
  const endDate = document.getElementById('csEnd').value;
  const searchType = document.getElementById('csType').value;
  const minImpressions = parseInt(document.getElementById('csMinImpressions').value) || 0;
  const country = (document.getElementById('csCountry') || {}).value || '';
  if (!siteUrl) { alert('Select a property first.'); return; }

  const btn = document.getElementById('csRun');
  btn.disabled = true; btn.textContent = 'Loading…';
  document.getElementById('csTable').innerHTML = '<p style="color:var(--text-muted);padding:20px">Querying Search Console for opportunities…</p>';
  document.getElementById('csSummary').style.display = 'none';

  try {
    // Page + query dimension so we can classify each page by its best
    // opportunity query rather than by the page's average rank — that
    // avoids hiding pages where one query ranks #2 while another ranks #15.
    const body = {
      siteUrl, startDate, endDate,
      dimensions: ['page', 'query'],
      rowLimit: 25000,
      searchType
    };
    const countryFilter = gscCountryFilterGroup(country);
    if (countryFilter) body.dimensionFilterGroups = countryFilter;
    const r = await fetch('/api/gsc/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) {
      const err = new Error(data.error || 'Query failed');
      err.reconnect = !!data.reconnect;
      err.reconnectUrl = data.reconnectUrl || '/api/gsc/auth/start';
      throw err;
    }

    // Group page+query pairs by page.
    const pageMap = new Map();
    for (const row of data.rows || []) {
      const keys = row.keys || [];
      const page = keys[0];
      const query = keys[1];
      if (!page) continue;
      let p = pageMap.get(page);
      if (!p) {
        p = { page, queries: [], totalImpr: 0, totalClicks: 0, weightedPosSum: 0 };
        pageMap.set(page, p);
      }
      const q = {
        query: query || '',
        impressions: row.impressions || 0,
        clicks: row.clicks || 0,
        ctr: row.ctr || 0,
        position: row.position || 0
      };
      p.queries.push(q);
      p.totalImpr += q.impressions;
      p.totalClicks += q.clicks;
      p.weightedPosSum += q.position * q.impressions;
    }

    // Track queries skipped by the threshold so we can show the user
    // "X queries excluded — lower the threshold to include them".
    const excluded = {};
    for (const b of STRATEGY_BANDS) excluded[b.id] = { queries: 0, impressions: 0 };

    const rows = [];
    const brandStem = getBrandStem(csState.selectedSite);
    for (const p of pageMap.values()) {
      // For each query, compute the band + potential uplift. The page's
      // initial bestQuery is just the highest-potential qualifying one;
      // the real assignment happens after construction, where each query
      // is awarded to a single "winner" page (brand → shortest URL,
      // non-brand → highest per-query potential).
      let bestQuery = null;
      let totalPotential = 0;
      const qualifying = [];
      for (const q of p.queries) {
        if (q.position < 1.5 || q.position > 40.5) continue;
        const band = bandForPosition(q.position);
        if (!band) continue;
        if (q.impressions < minImpressions) {
          excluded[band.id].queries++;
          excluded[band.id].impressions += q.impressions;
          continue;
        }
        const targetCtr = ctrAtPosition(band.target);
        const potential = Math.max(0, q.impressions * targetCtr - q.clicks);
        q._band = band;
        q._potential = potential;
        qualifying.push(q);
        totalPotential += potential;
        if (!bestQuery || potential > bestQuery._potential) bestQuery = q;
      }
      if (!bestQuery) continue;   // no qualifying query → not an opportunity

      // Per-band aggregates for this page: queryCount, impressions, potential,
      // and the best (highest-potential) query in that band. Lets a page count
      // in every band where it has at least one qualifying query.
      const perBand = {};
      for (const q of qualifying) {
        const id = q._band.id;
        if (!perBand[id]) {
          perBand[id] = {
            band: q._band, queryCount: 0, impressions: 0, potential: 0, bestQuery: null
          };
        }
        const slot = perBand[id];
        slot.queryCount++;
        slot.impressions += q.impressions;
        slot.potential += q._potential;
        if (!slot.bestQuery || q._potential > slot.bestQuery._potential) slot.bestQuery = q;
      }
      const bandIds = Object.keys(perBand);

      // Sort the per-page queries: best opportunity first (potential clicks),
      // then by impressions — gives a clean drill-down without an extra API call.
      p.queries.sort((a, b) => {
        const pa = a._potential ?? -1, pb = b._potential ?? -1;
        if (pa !== pb) return pb - pa;
        return (b.impressions || 0) - (a.impressions || 0);
      });

      const avgPosition = p.totalImpr > 0 ? p.weightedPosSum / p.totalImpr : 0;
      const avgCtr = p.totalImpr > 0 ? p.totalClicks / p.totalImpr : 0;
      const crawl = csState.crawlPages ? csState.crawlPages.get(normaliseUrlForJoin(p.page)) : null;

      const newRow = {
        page: p.page,
        impressions: p.totalImpr,
        clicks: p.totalClicks,
        ctr: avgCtr,
        position: avgPosition,
        band: bestQuery._band,
        bandIds,
        perBand,
        targetPos: bestQuery._band.target,
        potentialClicks: totalPotential,
        bestQuery: bestQuery.query,
        bestQueryPosition: bestQuery.position,
        bestQueryImpressions: bestQuery.impressions,
        qualifyingCount: qualifying.length,
        crawl: crawl || null,
        topQueries: p.queries.slice(0, 50)
      };
      newRow.recommendation = recommendStrategy(newRow);
      rows.push(newRow);
    }

    // ── Award each query to a single "winner" page ─────────────────────
    // The previous dedup picked whichever page was *first* in the sort —
    // that meant a typo brand variant ("group mutuel" without the e)
    // sneaked past the brand-only guard and ended up flagged on a deep
    // inner page like /clients-prives/nos-services/espace-client.html.
    //
    // New model: for every distinct query, decide a winner globally.
    //   - Brand-only queries (incl. fuzzy variants) → page with the
    //     shortest URL path wins. That maps "groupe mutuel" onto the
    //     homepage if it ranks, else /fr/, else /fr/clients-prives.html
    //     — never onto a deep services page just because it ranks too.
    //   - Every other query → page with the highest per-query potential.
    //
    // Then each row picks the highest-potential query it actually wins.
    // Rows with no winning query are dropped (the page is already covered
    // by the action item on the winning row).
    const queryClaimants = new Map();   // query → [{ page, q }]
    for (const r of rows) {
      for (const q of r.topQueries) {
        if (!q._band) continue;
        if (!queryClaimants.has(q.query)) queryClaimants.set(q.query, []);
        queryClaimants.get(q.query).push({ page: r.page, q });
      }
    }
    const queryToWinner = new Map();
    for (const [qstr, claims] of queryClaimants) {
      const isBrand = brandStem ? isBrandOnlyQuery(qstr, brandStem) : false;
      claims.sort((a, b) => {
        if (isBrand) {
          // Shortest URL path wins. Tie-break on impressions desc so a
          // /fr/ and a /fr/contact/ page resolve deterministically.
          const dd = urlPathDepth(a.page) - urlPathDepth(b.page);
          if (dd) return dd;
          return (b.q.impressions || 0) - (a.q.impressions || 0);
        }
        return (b.q._potential || 0) - (a.q._potential || 0);
      });
      queryToWinner.set(qstr, claims[0].page);
    }

    const survivors = [];
    for (const r of rows) {
      // r.topQueries is sorted potential-desc, so the first match wins
      // for this row automatically.
      const won = r.topQueries.find(q => q._band && queryToWinner.get(q.query) === r.page);
      if (!won) continue;   // every query this page ranks for is awarded elsewhere
      if (won.query !== r.bestQuery) {
        r.bestQuery = won.query;
        r.bestQueryPosition = won.position;
        r.bestQueryImpressions = won.impressions;
        r.band = won._band;
        r.targetPos = won._band.target;
        r.recommendation = recommendStrategy(r);
      }
      // Brand-only queries this page ranks for but didn't win. They stay
      // visible in the per-query coverage table (informational) but are
      // filtered out of action items + "missing keywords per section" —
      // we don't want to tell the user to rewrite an inner page's title
      // around the brand when the brand belongs to a shallower URL.
      r.offLimitsQueries = new Set();
      if (brandStem) {
        for (const q of r.topQueries) {
          if (q._band
              && isBrandOnlyQuery(q.query, brandStem)
              && queryToWinner.get(q.query) !== r.page) {
            r.offLimitsQueries.add(q.query);
          }
        }
      }
      survivors.push(r);
    }
    rows.length = 0;
    for (const r of survivors) rows.push(r);

    rows.sort((a, b) => b.potentialClicks - a.potentialClicks);
    csState.rows = rows;
    csState.excluded = excluded;
    csState.minImpressions = minImpressions;
    csState.expanded.clear();

    // Warn the user if we likely hit the 25000-row cap.
    if ((data.rows || []).length >= 25000) {
      console.warn('Content Strategy: hit GSC 25k row cap; some long-tail queries may be excluded.');
    }

    renderStrategySummary();
    renderStrategicOverview();
    renderExcludedHint();
    renderCoverageHint();
    renderStrategyTable();

    // Auto-run the keyword-coverage analyser so users don't have to click
    // "Analyse keyword coverage" before every export. Fires-and-forgets;
    // each completed page re-renders its row/card live.
    if (csState.rows.length) {
      setTimeout(() => { analyseAllCoverage().catch(() => {}); }, 50);
    }
  } catch (e) {
    document.getElementById('csTable').innerHTML = renderGscErrorOrReconnect(e);
    csState.rows = [];
  } finally {
    btn.disabled = false; btn.textContent = 'Find opportunities';
  }
}

function renderStrategySummary() {
  const wrap = document.getElementById('csSummary');
  if (!csState.rows.length) { wrap.style.display = 'none'; return; }
  const total = csState.rows.length;
  const totalPotential = csState.rows.reduce((s, r) => s + r.potentialClicks, 0);
  const totalImpressions = csState.rows.reduce((s, r) => s + r.impressions, 0);

  // A page counts in every band where it has at least one qualifying query,
  // so the sum of band counts can exceed the page count.
  const byBand = {};
  for (const b of STRATEGY_BANDS) byBand[b.id] = { pages: 0, impressions: 0, potential: 0 };
  for (const r of csState.rows) {
    for (const bandId of r.bandIds || [r.band.id]) {
      byBand[bandId].pages++;
      if (r.perBand && r.perBand[bandId]) {
        byBand[bandId].impressions += r.perBand[bandId].impressions;
        byBand[bandId].potential   += r.perBand[bandId].potential;
      }
    }
  }

  const card = (label, value, hint) => `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px">
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em">${label}</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${value}</div>
      ${hint ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${hint}</div>` : ''}
    </div>`;
  const bandChips = STRATEGY_BANDS.map(b => {
    const s = byBand[b.id];
    const pot = Math.round(s.potential);
    return `<div style="display:flex;align-items:center;gap:6px;font-size:12px" title="${s.impressions.toLocaleString()} impressions · +${pot.toLocaleString()} potential clicks">
       <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${b.color}"></span>
       <b>${s.pages}</b> <span style="color:var(--text-muted)">${escapeHtml(b.label)}</span>
       ${s.pages ? `<span style="color:var(--text-muted);margin-left:auto">+${pot.toLocaleString()}</span>` : ''}
     </div>`;
  }).join('');

  const quickWins = csState.rows.filter(r => r.isQuickWin === true).length;
  const analysed = csState.rows.filter(r => r.coverage && Array.isArray(r.coverage.queries)).length;

  wrap.style.display = 'grid';
  wrap.innerHTML =
    card('Opportunities', total.toLocaleString()) +
    card('Total impressions', totalImpressions.toLocaleString()) +
    card('Estimated extra clicks', Math.round(totalPotential).toLocaleString(), 'if moved to target rank') +
    (analysed > 0
      ? card('Quick wins', quickWins.toLocaleString(), `pages missing ≥ 1 ranked keyword (analysed ${analysed} / ${total})`)
      : '');
}

// Highlights ranking queries that were dropped by the min-impressions
// threshold, broken down per band — so an "all-zero" band is never silent.
function renderExcludedHint() {
  const el = document.getElementById('csExcludedHint');
  if (!el) return;
  const ex = csState.excluded;
  if (!ex) { el.innerHTML = ''; return; }

  const totalExcluded = STRATEGY_BANDS.reduce((sum, b) => sum + ((ex[b.id] && ex[b.id].queries) || 0), 0);
  if (!totalExcluded) { el.innerHTML = ''; return; }

  // Per-band chips moved into a <details>, so the strip stays one line
  // unless the user actively wants the breakdown.
  const bandChips = STRATEGY_BANDS.map(b => {
    const s = ex[b.id] || { queries: 0, impressions: 0 };
    if (!s.queries) return '';
    return `<button data-cs-band-focus="${b.id}" title="Lower threshold to 1 and filter to ${escapeHtml(b.label)}" style="display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid ${b.color};border-radius:999px;background:var(--bg-input);color:var(--text);font-size:11px;margin:2px 4px 0 0;cursor:pointer">
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${b.color}"></span>
        <b>${s.queries}</b> ${escapeHtml(b.label)}
      </button>`;
  }).filter(Boolean).join('');

  el.innerHTML = `
    <details style="margin-top:10px">
      <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;background:rgba(217,119,6,.06);border:1px solid rgba(217,119,6,.30);font-size:13px;color:var(--text)">
        <span style="font-size:14px">⚠️</span>
        <span><b>${totalExcluded.toLocaleString()} queries</b> below your ${csState.minImpressions.toLocaleString()}-impression filter — some bands may be undercounted.</span>
        <span style="margin-left:auto;display:flex;gap:6px" onclick="event.stopPropagation()">
          ${[5, 1].filter(v => v < csState.minImpressions).map(v =>
            `<button data-cs-lower="${v}" class="btn btn-secondary" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);cursor:pointer;font-size:11px">Lower to ${v}</button>`
          ).join('')}
        </span>
      </summary>
      <div style="padding:8px 14px 4px">${bandChips}</div>
    </details>`;

  el.querySelectorAll('[data-cs-lower]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('csMinImpressions').value = btn.dataset.csLower;
      runStrategyQuery();
    });
  });

  el.querySelectorAll('[data-cs-band-focus]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const bandId = btn.dataset.csBandFocus;
      document.getElementById('csMinImpressions').value = '1';
      for (const cb of document.querySelectorAll('.strategy-band')) {
        cb.checked = cb.dataset.band === bandId;
      }
      runStrategyQuery();
    });
  });
}

// Top-of-table banner: shows whenever any opportunities lack live-page
// coverage analysis. Without it, the slides + tables can only show what we
// can infer from the crawl (often nothing), so this is the action that
// Strategic overview — three big icon cards summarising the recommendation
// mix across all opportunities. Most important "at a glance" view in the
// tab: how much work goes into optimising existing pages vs creating new
// landing pages, and how many quick wins exist.
function renderStrategicOverview() {
  const el = document.getElementById('csStrategicOverview');
  if (!el) return;
  if (!csState.rows || !csState.rows.length) { el.innerHTML = ''; return; }

  const cats = [
    { id: 'optimize',       icon: '✏️', color: '#16a34a', tint: 'rgba(22,163,74,.10)',
      label: 'Optimize',           hint: 'Page is on-topic — refine titles, content depth, internal links.' },
    { id: 'rewrite-expand', icon: '🔧', color: '#d97706', tint: 'rgba(217,119,6,.10)',
      label: 'Rewrite & expand',   hint: 'Page partially relevant — meaningful content rework needed.' },
    { id: 'create-landing', icon: '🆕', color: '#dc2626', tint: 'rgba(220,38,38,.10)',
      label: 'Create new landing', hint: 'Page only tangentially related — needs a dedicated URL.' }
  ];
  const agg = {};
  cats.forEach(c => agg[c.id] = { pages: 0, potential: 0 });
  for (const r of csState.rows) {
    const t = (r.recommendation && r.recommendation.type) || 'optimize';
    if (!agg[t]) continue;
    agg[t].pages++;
    agg[t].potential += r.potentialClicks;
  }

  const cards = cats.map(c => {
    const a = agg[c.id];
    return `<button data-cs-rec-filter="${c.id}" title="Show only opportunities of this type" style="text-align:left;cursor:pointer;background:var(--bg-card);border:1px solid var(--border);border-left:5px solid ${c.color};border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;transition:transform .12s ease,box-shadow .12s ease" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 16px -8px rgba(0,0,0,.15)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:22px">${c.icon}</span>
        <span style="font-weight:700;color:${c.color};font-size:14px">${escapeHtml(c.label)}</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:8px">
        <span style="font-size:30px;font-weight:800;color:var(--text);line-height:1">${a.pages.toLocaleString()}</span>
        <span style="font-size:12px;color:var(--text-muted)">pages</span>
        <span style="margin-left:auto;font-size:13px;color:var(--primary);font-weight:700">+${Math.round(a.potential).toLocaleString()}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(c.hint)}</div>
    </button>`;
  }).join('');

  el.innerHTML = `
    <div style="margin-top:16px">
      <div style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:10px">Recommended actions</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">${cards}</div>
      ${csState.recFilter ? `<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">Showing only <b style="color:var(--text)">${escapeHtml(cats.find(c => c.id === csState.recFilter).label)}</b> opportunities · <a href="#" id="csClearRecFilter" style="color:var(--primary);text-decoration:none">clear filter</a></div>` : ''}
    </div>`;
  const clearLink = document.getElementById('csClearRecFilter');
  if (clearLink) clearLink.addEventListener('click', (e) => { e.preventDefault(); csState.recFilter = null; renderStrategicOverview(); renderStrategyTable(); });

  el.querySelectorAll('[data-cs-rec-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      csState.recFilter = csState.recFilter === btn.dataset.csRecFilter ? null : btn.dataset.csRecFilter;
      renderStrategicOverview();   // re-render so the active card highlights
      renderStrategyTable();
    });
    if (csState.recFilter === btn.dataset.csRecFilter) {
      btn.style.boxShadow = '0 0 0 3px ' + cats.find(c => c.id === btn.dataset.csRecFilter).color + '33';
    }
  });
}

function renderCoverageHint() {
  const el = document.getElementById('csCoverageHint');
  if (!el) return;
  if (!csState.rows || !csState.rows.length) { el.innerHTML = ''; return; }
  const total = csState.rows.length;
  const analysed = csState.rows.filter(r => r.coverage && Array.isArray(r.coverage.queries)).length;
  const remaining = total - analysed;
  if (remaining === 0) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;margin-top:10px;border-radius:8px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.25);font-size:13px;color:var(--text)">
      <span style="font-size:14px">ℹ️</span>
      <span><b>${remaining.toLocaleString()}</b> of ${total.toLocaleString()} pages still need keyword coverage analysis to populate Quick wins, the "Where" column, and action items.</span>
      <button id="csCoverageHintRun" class="btn btn-secondary" style="margin-left:auto;padding:5px 12px;border-radius:6px;border:1px solid var(--primary);background:var(--primary);color:#fff;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap">Run analysis</button>
    </div>`;
  const btn = document.getElementById('csCoverageHintRun');
  if (btn) btn.addEventListener('click', analyseAllCoverage);
}

function activeBandIds() {
  return new Set(Array.from(document.querySelectorAll('.strategy-band'))
    .filter(cb => cb.checked).map(cb => cb.dataset.band));
}

function renderStrategyTable() {
  const wrap = document.getElementById('csTable');
  if (!csState.rows.length) { wrap.innerHTML = '<div style="padding:20px;color:var(--text-muted)">No opportunities. Try lowering "Min impressions" or expanding bands.</div>'; return; }

  const bands = activeBandIds();
  const textFilter = (document.getElementById('csTextFilter').value || '').toLowerCase();
  const quickWinsOnly = !!document.getElementById('csQuickWins')?.checked;
  const recFilter = csState.recFilter || null;
  // A page passes if at least one of its qualifying bands is checked.
  const pageInBands = (r) => (r.bandIds || [r.band.id]).some(id => bands.has(id));
  const filtered = csState.rows.filter(r =>
    pageInBands(r) &&
    (!textFilter || r.page.toLowerCase().includes(textFilter)) &&
    (!quickWinsOnly || r.isQuickWin === true) &&
    (!recFilter || (r.recommendation && r.recommendation.type === recFilter))
  );

  if (!filtered.length) {
    wrap.innerHTML = '<div style="padding:20px;color:var(--text-muted)">No rows match the current filters.</div>';
    return;
  }

  // Card layout: each opportunity is a self-contained card. Replaces the
  // earlier 8-column table that forced horizontal scrolling on laptops —
  // the URL now wraps, stats sit inline, and the potential-clicks number
  // is right-anchored as the visual anchor.
  const cardsHtml = filtered.map((r, idx) => {
    const isOpen = csState.expanded.has(r.page);
    const crawl = r.crawl;
    const quickWinBadge = r.isQuickWin === true
      ? `<span title="At least one query the page ranks for is missing from the page entirely" style="background:rgba(22,163,74,.15);color:var(--success);padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap">⚡ quick win</span>`
      : '';
    const rec = r.recommendation;
    const recIcon = rec ? (rec.type === 'optimize' ? '✏️' : rec.type === 'rewrite-expand' ? '🔧' : '🆕') : '';
    const recBadge = rec
      ? `<span title="${escapeHtml(rec.reason)}" style="display:inline-flex;align-items:center;gap:5px;background:#${rec.color}15;color:#${rec.color};padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid #${rec.color}55;white-space:nowrap">${recIcon}<span>${escapeHtml(rec.label)}</span></span>`
      : '';
    const bandPills = STRATEGY_BANDS.filter(b => (r.bandIds || [r.band.id]).includes(b.id)).map(b => {
      const slot = r.perBand && r.perBand[b.id];
      const isPrimary = b.id === r.band.id;
      const count = slot ? slot.queryCount : 0;
      const pot = slot ? Math.round(slot.potential) : 0;
      return `<span title="${count} ranking ${count === 1 ? 'query' : 'queries'} in this band · +${pot.toLocaleString()} potential clicks" style="display:inline-block;background:${b.color}22;color:${b.color};padding:2px 8px;border-radius:999px;font-weight:${isPrimary ? '600' : '500'};font-size:11px;${isPrimary ? '' : 'opacity:.85'};white-space:nowrap">${escapeHtml(b.label)} <span style="opacity:.75">×${count}</span></span>`;
    }).join('');

    const card = `
      <div class="cs-card" data-page="${escapeHtml(r.page)}" style="cursor:pointer;background:var(--bg-card);border:1px solid var(--border);border-left:4px solid ${r.band.color};border-radius:8px;padding:14px 16px;margin-bottom:${isOpen ? '0' : '10px'};${isOpen ? 'border-bottom-left-radius:0;border-bottom-right-radius:0;' : ''}display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:start">
        <div style="min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
            ${recBadge}
            ${quickWinBadge}
          </div>
          <a href="${escapeHtml(r.page)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"
             style="color:var(--text);text-decoration:none;font-weight:600;word-break:break-word;display:inline-block;line-height:1.35">${escapeHtml(r.page)}</a>
          ${crawl && crawl.title ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px;word-break:break-word">${escapeHtml(crawl.title)}</div>` : ''}
          ${r.bestQuery ? `<div style="font-size:12px;color:var(--text-muted);margin-top:7px">▸ <b style="color:${r.band.color}">${escapeHtml(r.bestQuery)}</b> · rank ${r.bestQueryPosition.toFixed(1)} · ${r.bestQueryImpressions.toLocaleString()} impr${r.qualifyingCount > 1 ? ` <span style="opacity:.7">(+${r.qualifyingCount - 1} more)</span>` : ''}</div>` : ''}
          <div style="margin-top:9px;display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-muted)">
            <span><b style="color:var(--text)">${r.impressions.toLocaleString()}</b> impr</span>
            <span><b style="color:var(--text)">${r.clicks.toLocaleString()}</b> clicks</span>
            <span><b style="color:var(--text)">${(r.ctr * 100).toFixed(2)}%</b> CTR</span>
            <span title="Page-average rank across all queries">pos <b style="color:var(--text)">${r.position.toFixed(1)}</b></span>
          </div>
          ${bandPills ? `<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">${bandPills}</div>` : ''}
          ${crawl ? `<div style="margin-top:7px;font-size:11px;color:var(--text-muted)">From crawl: ${crawl.wordCount} words · ${crawl.h1Count} H1${crawl.h1Count === 1 ? '' : 's'} · title ${crawl.titleLength}ch</div>` : ''}
          ${rec && rec.type === 'create-landing' && rec.suggestedUrl ? `<div style="font-size:12px;margin-top:8px;padding:6px 10px;background:rgba(220,38,38,.06);border-left:3px solid #${rec.color};border-radius:4px;word-break:break-all"><b style="color:#${rec.color}">Suggested new URL:</b> <code style="background:transparent;color:var(--text)">${escapeHtml(rec.suggestedUrl)}</code></div>` : ''}
        </div>
        <div style="text-align:right;min-width:120px;display:flex;flex-direction:column;align-items:flex-end">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Potential</div>
          <div style="font-size:26px;font-weight:800;color:var(--primary);line-height:1.05;margin-top:2px">+${Math.round(r.potentialClicks).toLocaleString()}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">if @ #${r.targetPos}</div>
          <div style="font-size:14px;color:var(--text-muted);margin-top:10px">${isOpen ? '▾' : '▸'}</div>
        </div>
      </div>`;
    const expansion = isOpen ? `
      <div data-expansion="${escapeHtml(r.page)}" style="background:var(--bg-hover);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;padding:14px 16px;margin-bottom:10px">
        <div id="csQueries-${idx}" style="font-size:13px;color:var(--text-muted)">Loading top queries…</div>
      </div>` : '';
    return card + expansion;
  }).join('');

  wrap.innerHTML = `
    <div>${cardsHtml}</div>
    <div style="padding:10px 4px;color:var(--text-muted);font-size:12px">Showing ${filtered.length.toLocaleString()} of ${csState.rows.length.toLocaleString()} opportunities. Potential-clicks estimate uses an average CTR-by-position curve and is a rough upper-bound.</div>
  `;

  // Card click → toggle expansion + load queries on first open.
  // Scoped to .cs-card so nested th[data-page] inside the expansion's
  // per-query sort headers doesn't get caught here.
  wrap.querySelectorAll('.cs-card').forEach((el) => {
    const page = el.dataset.page;
    el.addEventListener('click', async () => {
      if (csState.expanded.has(page)) {
        csState.expanded.delete(page);
      } else {
        csState.expanded.add(page);
      }
      renderStrategyTable();
      if (csState.expanded.has(page)) {
        const row = csState.rows.find(r => r.page === page);
        if (row && !row.topQueries) await loadStrategyQueries(row);
        renderStrategyQueriesFor(page);
      }
    });
  });

  // Re-fill expanded blocks already known (after re-render they're "Loading…").
  for (const page of csState.expanded) renderStrategyQueriesFor(page);
}

async function loadStrategyQueries(row) {
  const siteUrl = document.getElementById('csSite').value;
  const startDate = document.getElementById('csStart').value;
  const endDate = document.getElementById('csEnd').value;
  const searchType = document.getElementById('csType').value;
  try {
    const r = await fetch('/api/gsc/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteUrl, startDate, endDate,
        dimensions: ['query'],
        rowLimit: 50,
        searchType,
        dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: row.page }] }]
      })
    });
    const data = await r.json();
    row.topQueries = (data.rows || []).map(x => ({
      query: (x.keys || [])[0] || '',
      impressions: x.impressions || 0,
      clicks: x.clicks || 0,
      position: x.position || 0,
      ctr: x.ctr || 0
    }));
  } catch (e) {
    row.topQueries = { error: e.message };
    return;
  }

  // Kick off the keyword-coverage analysis in parallel. The queries table
  // renders immediately; coverage badges appear when this resolves.
  loadStrategyCoverage(row);
}

async function loadStrategyCoverage(row, { silent } = {}) {
  if (!Array.isArray(row.topQueries) || !row.topQueries.length) return;
  row.coverage = { loading: true };
  if (!silent) renderStrategyQueriesFor(row.page);
  try {
    const r = await fetch('/api/content-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: row.page,
        queries: row.topQueries.map(q => q.query)
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'analysis failed');
    if (data.error) throw new Error(data.error);
    row.coverage = data;
    row.isQuickWin = computeQuickWin(row);
    row.recommendation = recommendStrategy(row);
  } catch (e) {
    row.coverage = { error: e.message };
  }
  if (!silent) {
    renderStrategyQueriesFor(row.page);
    renderStrategySummary();
    renderStrategicOverview();
    renderCoverageHint();
    enableQuickWinsIfAny();
  }
}

// A row is a "quick win" when at least one of its ranking queries is
// completely absent from the page (not in title, H1, headings, or body).
function computeQuickWin(row) {
  const cov = row.coverage;
  if (!cov || !Array.isArray(cov.queries)) return false;
  return cov.queries.some(q => !q.presentSomewhere);
}

// Bulk-fetch queries + coverage for every row currently passing band /
// text filters, with bounded concurrency so we don't hammer the server.
let csBulkAbort = false;
async function analyseAllCoverage() {
  if (!csState.rows.length) return;
  const btn = document.getElementById('csAnalyse');
  const progress = document.getElementById('csAnalyseProgress');

  // If a run is in flight, this click cancels it.
  if (btn.dataset.running === '1') {
    csBulkAbort = true;
    btn.textContent = 'Stopping…';
    return;
  }

  const bands = activeBandIds();
  const textFilter = (document.getElementById('csTextFilter').value || '').toLowerCase();
  const targets = csState.rows.filter(r =>
    (r.bandIds || [r.band.id]).some(id => bands.has(id)) &&
    (!textFilter || r.page.toLowerCase().includes(textFilter)) &&
    !(r.coverage && Array.isArray(r.coverage.queries))
  );
  if (!targets.length) {
    enableQuickWinsIfAny();
    progress.style.display = 'block';
    progress.textContent = 'All visible rows are already analysed.';
    return;
  }

  csBulkAbort = false;
  btn.dataset.running = '1';
  btn.textContent = 'Stop';
  progress.style.display = 'block';

  const total = targets.length;
  let done = 0, errors = 0;
  const CONCURRENCY = 3;
  const queue = targets.slice();
  const renderBar = (state) => {
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const headline =
      state === 'done'    ? 'All set — content opportunities are ready.' :
      state === 'stopped' ? 'Analysis paused. Click Resume to keep going.' :
                            'Hang tight — finding your content opportunities…';
    const fillClass = state === 'done' ? 'cs-progress-fill done'
                    : state === 'stopped' ? 'cs-progress-fill stopped'
                    : 'cs-progress-fill';
    const fillWidth = state === 'done' ? '100%' : pct + '%';
    progress.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;font-size:12px;color:var(--text)">
        <span style="font-weight:600">${escapeHtml(headline)}</span>
        <span style="color:var(--text-muted)"><b style="color:var(--text)">${done.toLocaleString()}</b> / ${total.toLocaleString()} pages${errors ? ` · <span style="color:var(--danger)">${errors} errors</span>` : ''}</span>
      </div>
      <div class="cs-progress-bar"><div class="${fillClass}" style="width:${fillWidth}"></div></div>`;
  };
  const tick = () => renderBar('running');
  tick();

  const worker = async () => {
    while (queue.length && !csBulkAbort) {
      const row = queue.shift();
      try {
        if (!row.topQueries) await loadStrategyQueries(row);    // queries + coverage chained
        else if (!row.coverage) await loadStrategyCoverage(row, { silent: true });
        if (row.coverage && row.coverage.error) errors++;
      } catch { errors++; }
      done++;
      tick();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  btn.dataset.running = '0';
  btn.textContent = csBulkAbort ? 'Resume analysis' : 'Re-analyse';
  renderBar(csBulkAbort ? 'stopped' : 'done');
  if (!csBulkAbort) {
    // Quietly hide the bar a few seconds after success so it doesn't
    // crowd the table once the user has the opportunities they want.
    setTimeout(() => {
      if (progress && btn.dataset.running !== '1') progress.style.display = 'none';
    }, 4000);
  }

  // Update quick-win flags for every row that has coverage but hasn't been
  // flagged yet (covers the case where coverage was loaded via expansion).
  // Recompute the strategy recommendation too — coverage data may flip a
  // row from "optimize" to "create-landing" or vice versa now that we know
  // whether the page actually contains the keyword.
  for (const r of csState.rows) {
    if (r.coverage && Array.isArray(r.coverage.queries) && r.isQuickWin === undefined) {
      r.isQuickWin = computeQuickWin(r);
    }
    r.recommendation = recommendStrategy(r);
  }
  enableQuickWinsIfAny();
  renderStrategySummary();
  renderCoverageHint();
  renderStrategyTable();
}

function enableQuickWinsIfAny() {
  const cb = document.getElementById('csQuickWins');
  const label = document.getElementById('csQuickWinsLabel');
  if (!cb || !label) return;
  const analysedCount = csState.rows.filter(r => r.coverage && Array.isArray(r.coverage.queries)).length;
  if (analysedCount > 0) {
    cb.disabled = false;
    label.style.opacity = '1';
    label.style.color = 'var(--text)';
  }
}

function renderStrategyQueriesFor(page) {
  const row = csState.rows.find(r => r.page === page);
  const container = document.querySelector(`[data-expansion="${CSS.escape(page)}"]`);
  if (!row || !container) return;
  const target = container.querySelector('div[id^="csQueries-"]');
  if (!target) return;
  if (!row.topQueries) { target.textContent = 'Loading top queries…'; return; }
  if (row.topQueries.error) { target.innerHTML = `<span style="color:var(--danger)">Error loading queries: ${escapeHtml(row.topQueries.error)}</span>`; return; }
  if (!row.topQueries.length) { target.textContent = 'No queries for this page in the selected date range.'; return; }

  // Build a query → coverage lookup once.
  const coverageByQuery = {};
  const cov = row.coverage;
  if (cov && Array.isArray(cov.queries)) {
    for (const q of cov.queries) coverageByQuery[q.query] = q;
  }

  // Where-score: 0–5, number of sections the phrase appears in
  // (title / meta description / H1 / Hn / body).
  const whereScore = (c) => c ? ((c.phrase.inTitle?1:0) + (c.phrase.inMetaDescription?1:0) + (c.phrase.inH1?1:0) + (c.phrase.inHeadings?1:0) + (c.phrase.bodyOccurrences>0?1:0)) : -1;
  const valueFor = (q, key) => {
    const c = coverageByQuery[q.query];
    switch (key) {
      case 'query':       return (q.query || '').toLowerCase();
      case 'impressions': return q.impressions || 0;
      case 'clicks':      return q.clicks || 0;
      case 'ctr':         return q.ctr || 0;
      case 'position':    return q.position || 0;
      case 'inBody':      return c ? (c.phrase.bodyOccurrences || 0) : -1;
      case 'density':     return c ? (c.density || 0) : -1;
      case 'where':       return whereScore(c);
      default:            return 0;
    }
  };
  const { key: sortKey, dir: sortDir } = csState.querySort;
  const sortedQueries = row.topQueries.slice().sort((a, b) => {
    const va = valueFor(a, sortKey), vb = valueFor(b, sortKey);
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const yesPill = (ok, label) => `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;background:${ok ? 'rgba(22,163,74,.15)' : 'rgba(220,38,38,.12)'};color:${ok ? 'var(--success)' : 'var(--danger)'}">${ok ? '✓' : '✗'} ${label}</span>`;

  const rows = sortedQueries.map(q => {
    const c = coverageByQuery[q.query];
    let badges = '';
    let bodyCount = '';
    let density = '';
    if (cov && cov.loading) {
      badges = '<span style="color:var(--text-muted);font-size:11px">analysing…</span>';
    } else if (c) {
      badges = [
        yesPill(c.phrase.inTitle, 'title'),
        yesPill(c.phrase.inMetaDescription, 'desc'),
        yesPill(c.phrase.inH1, 'H1'),
        yesPill(c.phrase.inH2, 'H2'),
        yesPill(c.phrase.inH3, 'H3'),
        yesPill(c.phrase.bodyOccurrences > 0, `body${c.phrase.bodyOccurrences > 0 ? ' (' + c.phrase.bodyOccurrences + '×)' : ''}`)
      ].join(' ');
      bodyCount = c.phrase.bodyOccurrences > 0 ? c.phrase.bodyOccurrences + '×'
                  : (c.looseMatch.bodyAllWords ? '<span title="All words present individually but not as the exact phrase" style="color:var(--warning)">words only</span>'
                                               : '<span style="color:var(--danger)">0</span>');
      density = c.phrase.bodyOccurrences > 0 ? c.density.toFixed(2) + '%' : '—';
    }
    return `
      <tr>
        <td style="padding:6px 10px">${escapeHtml(q.query)}</td>
        <td style="padding:6px 10px;text-align:right">${q.impressions.toLocaleString()}</td>
        <td style="padding:6px 10px;text-align:right">${q.clicks.toLocaleString()}</td>
        <td style="padding:6px 10px;text-align:right">${(q.ctr * 100).toFixed(2)}%</td>
        <td style="padding:6px 10px;text-align:right">${q.position.toFixed(1)}</td>
        <td style="padding:6px 10px;text-align:right">${bodyCount}</td>
        <td style="padding:6px 10px;text-align:right">${density}</td>
        <td style="padding:6px 10px;display:flex;gap:4px;flex-wrap:wrap">${badges}</td>
      </tr>`;
  }).join('');

  const crawl = row.crawl;
  const crawlBlock = crawl ? `
    <div style="margin-bottom:10px;padding:10px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;font-size:12px">
      <b style="color:var(--text)">From your crawl:</b>
      <span style="color:var(--text-muted)">title</span> "${escapeHtml(crawl.title || '(missing)')}" (${crawl.titleLength}ch) ·
      <span style="color:var(--text-muted)">H1s</span> ${crawl.h1Count} ·
      <span style="color:var(--text-muted)">words</span> ${crawl.wordCount} ·
      <span style="color:var(--text-muted)">status</span> ${crawl.statusCode}
    </div>` : (currentCrawlId
      ? `<div style="margin-bottom:10px;padding:8px 12px;background:var(--bg-card);border:1px dashed var(--border);border-radius:6px;font-size:12px;color:var(--text-muted)">This URL isn't in your latest crawl — likely an orphan page or not linked from the homepage.</div>`
      : '');

  // Coverage summary above the query table.
  let coverageBlock = '';
  if (cov && cov.loading) {
    coverageBlock = `<div style="margin-bottom:10px;padding:10px 12px;background:var(--bg-card);border:1px dashed var(--border);border-radius:6px;font-size:12px;color:var(--text-muted)">Fetching live page to analyse keyword coverage…</div>`;
  } else if (cov && cov.error) {
    coverageBlock = `<div style="margin-bottom:10px;padding:10px 12px;background:rgba(220,38,38,.08);border:1px solid var(--danger);color:var(--danger);border-radius:6px;font-size:12px">Could not analyse page content: ${escapeHtml(cov.error)}</div>`;
  } else if (cov && cov.queries) {
    const totalQ = cov.queries.length;
    const inTitle = cov.queries.filter(q => q.phrase.inTitle).length;
    const inMeta = cov.queries.filter(q => q.phrase.inMetaDescription).length;
    const inH1 = cov.queries.filter(q => q.phrase.inH1).length;
    const inH2 = cov.queries.filter(q => q.phrase.inH2).length;
    const inH3 = cov.queries.filter(q => q.phrase.inH3).length;
    const inBody = cov.queries.filter(q => q.phrase.bodyOccurrences > 0).length;
    const absent = cov.queries.filter(q => !q.presentSomewhere);
    const absentImpressions = absent.reduce((sum, q) => {
      const t = row.topQueries.find(x => x.query === q.query);
      return sum + (t ? t.impressions : 0);
    }, 0);
    const tone = (n, total) => n === 0 ? 'var(--danger)' : (n < total / 2 ? 'var(--warning)' : 'var(--success)');
    const metaLen = cov.metaDescriptionLength || 0;
    const metaHint = metaLen === 0 ? ' <span style="color:var(--danger);font-weight:600">(missing)</span>'
                   : (metaLen > 160 ? ` <span style="color:var(--warning)">(${metaLen}ch — over 160)</span>`
                                    : (metaLen < 70 ? ` <span style="color:var(--warning)">(${metaLen}ch — under 70)</span>` : ` <span style="color:var(--text-muted)">(${metaLen}ch)</span>`));
    coverageBlock = `
      <div style="margin-bottom:10px;padding:12px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;font-size:13px">
        <div style="font-weight:600;margin-bottom:6px">Keyword coverage <span style="color:var(--text-muted);font-weight:400;font-size:12px">— live page has ${cov.wordCount.toLocaleString()} words</span></div>
        <div style="display:flex;gap:18px;flex-wrap:wrap">
          <div><span style="color:${tone(inTitle, totalQ)};font-weight:700">${inTitle}</span><span style="color:var(--text-muted)"> / ${totalQ} queries in <b>title</b></span></div>
          <div><span style="color:${tone(inMeta, totalQ)};font-weight:700">${inMeta}</span><span style="color:var(--text-muted)"> / ${totalQ} in <b>meta description</b>${metaHint}</span></div>
          <div><span style="color:${tone(inH1, totalQ)};font-weight:700">${inH1}</span><span style="color:var(--text-muted)"> / ${totalQ} in <b>H1</b></span></div>
          <div><span style="color:${tone(inH2, totalQ)};font-weight:700">${inH2}</span><span style="color:var(--text-muted)"> / ${totalQ} in <b>H2</b></span></div>
          <div><span style="color:${tone(inH3, totalQ)};font-weight:700">${inH3}</span><span style="color:var(--text-muted)"> / ${totalQ} in <b>H3</b></span></div>
          <div><span style="color:${tone(inBody, totalQ)};font-weight:700">${inBody}</span><span style="color:var(--text-muted)"> / ${totalQ} in <b>body</b></span></div>
          ${absent.length ? `<div style="color:var(--danger)"><b>${absent.length}</b> queries not on page <span style="color:var(--text-muted)">(${absentImpressions.toLocaleString()} impressions)</span></div>` : ''}
        </div>
        ${absent.length ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Missing: ${absent.slice(0, 6).map(q => '<code style="background:rgba(220,38,38,.08);color:var(--danger);padding:1px 6px;border-radius:3px">' + escapeHtml(q.query) + '</code>').join(' ')}${absent.length > 6 ? ` <span>and ${absent.length - 6} more</span>` : ''}</div>` : ''}
      </div>`;
  }

  const arrow = (k) => sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const th = (k, label, align) => `<th data-sort="${k}" data-page="${escapeHtml(row.page)}" style="padding:6px 10px;text-align:${align};cursor:pointer;user-select:none${sortKey === k ? ';color:var(--primary)' : ''}">${escapeHtml(label)}${arrow(k)}</th>`;

  target.innerHTML = `
    ${crawlBlock}
    ${coverageBlock}
    <div style="font-weight:600;margin-bottom:6px">Top queries driving this page</div>
    <div style="overflow:auto;border:1px solid var(--border);border-radius:6px;background:var(--bg-card)">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:var(--bg-hover)">
          ${th('query', 'Query', 'left')}
          ${th('impressions', 'Impressions', 'right')}
          ${th('clicks', 'Clicks', 'right')}
          ${th('ctr', 'CTR', 'right')}
          ${th('position', 'Position', 'right')}
          ${th('inBody', 'In body', 'right')}
          ${th('density', 'Density', 'right')}
          ${th('where', 'Where', 'left')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  // Wire click-to-sort on the header cells of this expansion only.
  target.querySelectorAll('th[data-sort]').forEach(thEl => {
    thEl.addEventListener('click', () => {
      const key = thEl.dataset.sort;
      // String columns default to asc; numeric columns default to desc.
      const numericDefaultDesc = key !== 'query';
      if (csState.querySort.key === key) {
        csState.querySort.dir = csState.querySort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        csState.querySort.key = key;
        csState.querySort.dir = numericDefaultDesc ? 'desc' : 'asc';
      }
      // Re-render every currently expanded row's queries table so the
      // sort is consistent across the page.
      for (const p of csState.expanded) renderStrategyQueriesFor(p);
    });
  });
}

function exportStrategyCsv() {
  if (!csState.rows.length) { alert('Run a query first.'); return; }
  const bands = activeBandIds();
  const textFilter = (document.getElementById('csTextFilter').value || '').toLowerCase();
  const quickWinsOnly = !!document.getElementById('csQuickWins')?.checked;
  const rows = csState.rows.filter(r =>
    (r.bandIds || [r.band.id]).some(id => bands.has(id)) &&
    (!textFilter || r.page.toLowerCase().includes(textFilter)) &&
    (!quickWinsOnly || r.isQuickWin === true)
  );
  const headers = [
    'page','band','impressions','clicks','ctr','page_avg_position','potential_clicks','target_position',
    'primary_band_id','all_bands','best_query','best_query_position','best_query_impressions','qualifying_query_count',
    'crawl_title','crawl_word_count',
    'coverage_analysed','page_word_count','queries_analysed',
    'queries_in_title','queries_in_meta_description','queries_in_h1','queries_in_body',
    'meta_description_length',
    'missing_queries_count','missing_queries_impressions','missing_queries_top','quick_win'
  ];
  const escape = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    const cov = r.coverage && Array.isArray(r.coverage.queries) ? r.coverage : null;
    let pageWords = '', qAnalysed = '', inTitle = '', inMeta = '', inH1 = '', inBody = '', metaLen = '';
    let missingCount = '', missingImpressions = '', missingTop = '';
    if (cov) {
      pageWords = cov.wordCount || 0;
      qAnalysed = cov.queries.length;
      inTitle = cov.queries.filter(q => q.phrase.inTitle).length;
      inMeta = cov.queries.filter(q => q.phrase.inMetaDescription).length;
      inH1 = cov.queries.filter(q => q.phrase.inH1).length;
      inBody = cov.queries.filter(q => q.phrase.bodyOccurrences > 0).length;
      metaLen = cov.metaDescriptionLength || 0;
      const missing = cov.queries.filter(q => !q.presentSomewhere);
      missingCount = missing.length;
      // Sum impressions of missing queries by matching them back to topQueries.
      missingImpressions = missing.reduce((s, q) => {
        const t = (r.topQueries || []).find(x => x.query === q.query);
        return s + (t ? t.impressions : 0);
      }, 0);
      missingTop = missing.slice(0, 10).map(q => q.query).join(' | ');
    }
    lines.push([
      r.page, r.band.label, r.impressions, r.clicks, r.ctr, r.position,
      Math.round(r.potentialClicks), r.targetPos,
      r.band.id, (r.bandIds || [r.band.id]).join('|'),
      r.bestQuery || '', r.bestQueryPosition != null ? r.bestQueryPosition.toFixed(1) : '',
      r.bestQueryImpressions || '', r.qualifyingCount || '',
      r.crawl ? r.crawl.title : '',
      r.crawl ? r.crawl.wordCount : '',
      cov ? 'yes' : 'no',
      pageWords, qAnalysed, inTitle, inMeta, inH1, inBody,
      metaLen,
      missingCount, missingImpressions, missingTop,
      r.isQuickWin === true ? 'yes' : (r.isQuickWin === false ? 'no' : '')
    ].map(escape).join(','));
  }
  const siteUrl = document.getElementById('csSite').value || 'site';
  const startDate = document.getElementById('csStart').value;
  const endDate = document.getElementById('csEnd').value;
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const safe = siteUrl.replace(/[^a-z0-9]/gi, '_');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `content-strategy_${safe}_${startDate}_${endDate}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── PowerPoint export ─────────────────────────────────────────────────────
// One slide per opportunity, plus a cover + summary. Auto-generates action
// items per page based on the keyword-coverage gaps so the deck is ready
// to present to a client.

async function loadPptxLib() {
  if (window.PptxGenJS) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load the PowerPoint library (network?). Try again in a moment.'));
    document.head.appendChild(s);
  });
}

// Returns an array of { text, priority, icon } objects so the PPT can
// colour-code action items by priority.
//   critical  — fixes that block ranking (missing core terms, no meta desc)
//   important — on-page edits that should ship next (title/H1/desc rewrites)
//   recommended — supporting work (internal links, content expansion)
// ── PPT export i18n ─────────────────────────────────────────────────────
// Keys cover every literal that ends up in the deck. Action templates are
// builder functions so they can interpolate dynamic data (URLs, counts).
// ── PPT executive-dashboard helpers ──────────────────────────────────────

// Lightweight search-intent classifier. Heuristics only — flags clear
// question / informational patterns (FR + EN + DE) and obvious commercial
// signals; everything else defaults to Info. Returns 'Info' | 'Trans.' | 'Nav.'
function classifyIntent(query) {
  const q = String(query || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!q) return 'Info';
  if (/\b(buy|cheap|price|cost|deal|discount|best|top|vs|review|comparison|acheter|prix|coût|cout|tarif|tarifs|meilleur|meilleure|comparatif|avis|promo|soldes|kaufen|preis|kosten|vergleich)\b/.test(q)) return 'Trans.';
  if (/\b(login|sign in|sign up|connexion|connecter|inscription|portal|portail|anmelden|kontakt)\b/.test(q)) return 'Nav.';
  return 'Info';
}

// Map our recommendation type to a one-word editorial action.
function mapActionFromRec(recType, T) {
  if (recType === 'create-landing') return T.actNew;
  if (recType === 'rewrite-expand') return T.actGuide;
  return T.actRefresh;   // optimize → Refresh
}

// Cluster opportunities by URL-path prefix (first non-empty segment after
// the domain). Pages that share a parent path almost always cover the same
// topic on a real site. Returns up to N clusters sorted by impressions.
function clusterTopics(rows, max = 6) {
  const palette = ['EEEAFE', 'E6F4EE', 'FDEEDA', 'FDE7E7', 'EEE8E0', 'E3EBF6'];
  const accents = ['7C3AED', '16A34A', 'D97706', 'DC2626', '92704B', '2563EB'];
  const buckets = new Map();
  for (const r of rows) {
    let key = 'root';
    try {
      const u = new URL(r.page);
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg) key = seg;
    } catch { /* ignore */ }
    if (!buckets.has(key)) buckets.set(key, { id: key, pages: 0, impressions: 0 });
    const b = buckets.get(key);
    b.pages++;
    b.impressions += r.impressions;
  }
  const arr = [...buckets.values()].sort((a, b) => b.impressions - a.impressions).slice(0, max);
  arr.forEach((b, i) => {
    b.tint = palette[i % palette.length];
    b.accent = accents[i % accents.length];
    b.label = b.id === 'root'
      ? 'Homepage'
      : b.id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  });
  return arr;
}

// Identify the top "pages losing traffic" — rows whose previous-period
// impressions outpace current impressions by the biggest %. Needs the
// previous-period map keyed by URL.
function findLosingPages(rows, prevByUrl, limit = 4) {
  if (!prevByUrl || !prevByUrl.size) return [];
  const losing = [];
  for (const r of rows) {
    const prev = prevByUrl.get(r.page);
    if (!prev || prev.impressions < 20) continue;   // ignore noise
    const delta = (r.impressions - prev.impressions) / prev.impressions;
    if (delta < -0.05) losing.push({ page: r.page, prev: prev.impressions, curr: r.impressions, delta });
  }
  losing.sort((a, b) => a.delta - b.delta);
  return losing.slice(0, limit);
}

// Wraps a fetch with an abort-timeout so a stuck GSC call can't hang the
// whole PPT export.
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Hits the existing /api/gsc/query route to pull totals for an explicit
// date range. Returns { clicks, impressions, ctr, position } or null on
// failure / timeout — the caller treats null as "no data".
async function fetchPeriodTotals(siteUrl, startDate, endDate, searchType, country) {
  const body = { siteUrl, startDate, endDate, dimensions: [], rowLimit: 1, searchType };
  const cf = gscCountryFilterGroup(country);
  if (cf) body.dimensionFilterGroups = cf;
  try {
    const r = await fetchWithTimeout('/api/gsc/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 15000);
    if (!r.ok) return null;
    const data = await r.json();
    const row = (data.rows || [])[0];
    return row ? { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 } : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  } catch { return null; }
}

// Per-page totals for the previous period — used to flag pages losing
// traffic. Same route, with dimension=page. Capped at 1000 rows to keep
// the call snappy (was 5000 — could time out on large properties).
async function fetchPreviousPagesByUrl(siteUrl, startDate, endDate, searchType, country) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end   = new Date(endDate   + 'T00:00:00Z');
  const days  = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
  const prevEnd = new Date(start); prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setUTCDate(prevStart.getUTCDate() - days + 1);
  const fmt = d => d.toISOString().slice(0, 10);

  const body = { siteUrl, startDate: fmt(prevStart), endDate: fmt(prevEnd), dimensions: ['page'], rowLimit: 1000, searchType };
  const cf = gscCountryFilterGroup(country);
  if (cf) body.dimensionFilterGroups = cf;
  try {
    const r = await fetchWithTimeout('/api/gsc/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 20000);
    if (!r.ok) return { byUrl: new Map(), startDate: fmt(prevStart), endDate: fmt(prevEnd) };
    const data = await r.json();
    const byUrl = new Map();
    for (const row of (data.rows || [])) {
      const u = (row.keys || [])[0];
      if (u) byUrl.set(u, { impressions: row.impressions || 0, clicks: row.clicks || 0 });
    }
    return { byUrl, startDate: fmt(prevStart), endDate: fmt(prevEnd) };
  } catch { return { byUrl: new Map(), startDate: '', endDate: '' }; }
}

const PPT_I18N = {
  en: {
    contentStrategy: 'CONTENT STRATEGY',
    audit: 'AUDIT',
    inThisDeck: 'IN THIS DECK',
    opportunityPages: 'Opportunity pages',
    totalImpressions: 'Total impressions',
    quickWins: 'Quick wins',
    heroSubtitle: 'estimated extra clicks per month if every opportunity reaches its target rank.',
    deckIntro: (n) => `${n} opportunity slide${n === 1 ? '' : 's'}. Each slide shows the page, its title / meta description / H1, the queries it ranks for, on-page coverage gaps, and prioritised actions.`,
    filtersLabel: (s) => `Filters: ${s}`,
    noFilters: 'no filters',
    filterQuickWins: 'quick wins only',
    filterText: (t) => `text filter "${t}"`,
    filterBands: (b) => `bands: ${b}`,
    opportunitiesByBand: 'Opportunities by band',
    opportunitiesByBandDesc: 'Each band groups pages by the rank of their best opportunity query. Lower bands = easier wins.',
    band: { push: 'Push to #1', striking: 'Striking distance', page2: 'Page 2', deep: 'Hidden volume', deeper: 'Deep but searched' },
    positionsRange: (lo, hi, t) => `Positions ${lo}–${hi}  ·  target #${t}`,
    pagesLabel: 'pages',
    impressionsLabel: 'impressions',
    extraClicksAt: (t) => `extra clicks @ #${t}`,
    includedInDeck: (a, b) => `${a} / ${b} included in this deck`,
    distributionByPotential: 'Distribution of potential clicks',
    strategyMix: 'Strategy mix',
    strategyMixDesc: 'Each opportunity falls into one of three actions. Use this to plan the work split with the team.',
    workSplit: 'Work split (by page count)',
    rec: {
      optimize:        { label: 'Optimize',                desc: 'Page is on-topic — refine title, content depth, internal links.',
                         reason: 'URL slug is topically aligned — refine on-page SEO to push it higher.' },
      'rewrite-expand':{ label: 'Rewrite & expand',        desc: 'Page partially relevant — meaningful content rework.',
                         reason: 'Only partially relevant to the keyword. Rewrite the title/H1, add a dedicated section, and expand the content.' },
      'create-landing':{ label: 'Create new landing page', desc: 'Page only tangentially related — needs a dedicated URL.',
                         reason: 'The current URL is only tangentially related — a dedicated landing page would convert demand into clicks.' }
    },
    examples: 'EXAMPLES',
    topOpportunitiesTitle: 'Top 5 opportunities',
    topOpportunitiesDesc: 'Highest estimated extra-clicks if pushed to target rank. Start here.',
    bestQueryShort: (rank) => `Best query @ #${rank.toFixed(1)}`,
    targetShort: (t) => `Target #${t}`,
    opportunityHeader: (a, b) => `OPPORTUNITY ${a} / ${b}`,
    quickWinBadge: 'Quick win',
    strategy: 'STRATEGY',
    impressions: 'Impressions',
    clicks: 'Clicks',
    ctr: 'CTR',
    position: 'Position',
    potentialAtRank: (t) => `Potential @ rank ${t}`,
    suggestedUrl: 'Suggested URL',
    currentPage: 'Current page',
    title: 'TITLE',
    metaDescription: 'META DESCRIPTION',
    h1Label: 'H1',
    titleMissingLabel: 'missing',
    notAnalysedShort: '(not analysed)',
    notAnalysedHint: '(not analysed — click "Analyse keyword coverage" in the tool)',
    noTitleTag: '(no <title> tag on page)',
    noMetaDesc: '(no meta description — Google will auto-generate one)',
    noH1: '(no H1 heading on page)',
    runAnalysisHint: 'Click the "Analyse keyword coverage" button above the opportunity table to populate live-page data here.',
    h1Count: (n) => `${n} H1${n === 1 ? '' : 's'}`,
    noH1Label: 'no H1',
    wordsOnLive: (w, q) => `${w.toLocaleString()} words on the live page  ·  ${q} queries analysed`,
    queriesCoverageHint: (n, w) => `Of the ${n} queries this page ranks for in Google, how many appear on the page (${w.toLocaleString()} words live):`,
    keywordsToAddHint: 'Top missing keywords per section — direct fixes:',
    allOnPage: 'all already present ✓',
    secLabel: { title: 'META TITLE', meta: 'META DESC', h1: 'H1', h2: 'H2', h3: 'H3', body: 'BODY' },
    execSummaryTitle: 'Executive summary',
    execSummaryKicker: 'The headline number and the top 5 pages to start with.',
    execHeroSub: (n, site) => `extra clicks per month available across ${n.toLocaleString()} ranking pages on ${site}.`,
    execTopHeader: 'Start here — top 5 priority pages',
    execColPage: 'Page',
    execColBest: 'Best query @ rank',
    execColAction: 'Action',
    execColGain: 'Extra clicks',
    execChartTitle: 'Work breakdown',
    execBandChartTitle: 'Pages by opportunity band',
    execTopFooterNote: (n) => `Top 5 of ${n.toLocaleString()} opportunities by potential clicks. Every page has its own slide.`,
    execTargetShort: 'at rank',
    execSummaryFooter: 'Every opportunity has its own slide in this deck with the exact actions to take.',
    printSave: 'Print → Save as PDF',
    printHint: 'Tip: choose "Save as PDF" in your browser print dialog.',
    pdfTagTitle: 'title',
    pdfTagMeta: 'meta description',
    pdfTagH1: 'H1',
    pdfTagH2: 'H2',
    pdfTagH3: 'H3',
    pdfTagSubheadings: 'subheadings',
    pdfTagBody: 'body',
    pdfAbsent: 'absent',
    execKeyInsightLabel: 'KEY INSIGHT',
    execKeyInsight: ({ strikingPages, strikingPot, strikingShare, totalPages, quickWins }) => {
      const wins = quickWins
        ? ` ${quickWins} are quick wins where the keyword is missing from the page entirely.`
        : '';
      if (!strikingPages) {
        return `${totalPages} pages currently rank for queries below position #1.${wins}`;
      }
      return `${strikingPages} pages already rank in positions 4–10 — pushing them up captures roughly ${strikingShare}% of the total upside (≈ +${strikingPot.toLocaleString()} clicks/month). Start there.${wins}`;
    },
    action: 'ACTION',
    execSummaryPara1: (a) =>
      `We analysed ${a.siteUrl} between ${a.startDate} and ${a.endDate}. ${a.totalRows.toLocaleString()} pages currently rank in Google for queries below position #1 — together they generate ${a.totalImpr.toLocaleString()} impressions per month but only ${a.totalClicks.toLocaleString()} clicks. Pushing each to its target rank could add roughly +${a.totalPotential.toLocaleString()} clicks per month.`,
    execSummaryPara2: (a) =>
      `The work splits three ways: ${a.optimize} pages need light optimisation (refine title / content / internal links), ${a.rewriteExpand} need a rewrite or significant expansion, and ${a.createLanding} would benefit from a brand-new dedicated landing page.${a.quickWins ? ` Of those, ${a.quickWins} pages have at least one ranking query that doesn't appear anywhere on the page — the fastest wins.` : ''}`,
    execSummaryPara3: 'The next slide is a one-page dashboard with the headline numbers, an opportunity matrix, topic clusters and a 4-week editorial plan. After that, every opportunity has its own slide with the current page state, prioritised actions and the queries it ranks for.',
    matrixTopNote: (n, m) => `(top ${n} of ${m} by impressions)`,
    statIn: { title: 'queries in title', meta: 'queries in meta', H1: 'queries in H1', body: 'queries in body' },
    actionItems: 'Action items',
    priority: { critical: 'CRITICAL', important: 'IMPORTANT', recommended: 'RECOMMENDED' },
    topRankingQueries: 'Top ranking queries',
    query: 'Query',
    impr: 'Impr',
    pos: 'Pos',
    inPage: 'In page?',
    wordsOnly: 'words only',
    missingOnPage: (n, impr) => `Missing on this page  ·  ${n} ${n === 1 ? 'query' : 'queries'}  ·  ${impr.toLocaleString()} impressions`,
    allCovered: 'Every ranking query already appears somewhere on the page. Focus on titles, H1 and internal linking.',
    missingNotRun: 'Missing-keywords analysis not run yet.',
    plusMore: (n) => `+${n} more`,
    methodologyTitle: 'How to read this deck',
    methodologyDesc: 'A quick reference for what each metric means and how the numbers were computed.',
    appendixTitle: () => 'All other opportunities',
    appendixSubtitle: (from, to, page, total) => `Opportunities ${from}–${to} · page ${page} / ${total} — top 15 already covered in detail above.`,
    appendixCols: ['#', 'Page', 'Band', 'Pos', 'Impr', 'Best query', 'Potential'],
    opportunityBandsHeader: 'OPPORTUNITY BANDS',
    ctrCurveHeader: 'AVERAGE CTR BY POSITION',
    potentialHowTitle: 'How "potential extra clicks" is computed',
    potentialHowDesc: 'For each ranking query: potential = (query impressions × target-rank CTR) − current clicks. A page\'s total potential is the sum across all its qualifying queries. The CTR curve above is an industry average — treat figures as a directional upper bound, not a forecast.',
    preparedBy: 'Prepared by Converta  ·  seo.converta.ro',
    siteAndDates: (site, s, e) => `${site}  ·  ${s} → ${e}`,
    // Executive dashboard slide
    dashTitle: 'Executive dashboard',
    dashSubtitle: 'Search performance, opportunity matrix, topic clusters and a 4-week editorial plan — at a glance.',
    kpiClicks: 'Clicks',
    kpiImpressions: 'Impressions',
    kpiAvgCtr: 'Avg. CTR',
    kpiAvgPosition: 'Avg. position',
    kpiExtraClicks: 'Estimated extra clicks',
    tileScopeAll: (n) => `across all ${n} ranking queries`,
    tileScopeOverall: 'page-level average (all queries)',
    tileScopeBest: (q) => {
      const s = String(q || '');
      const short = s.length > 20 ? s.slice(0, 19) + '…' : s;
      return `if "${short}" hits target`;
    },
    matrixTitle: 'Keyword opportunity matrix',
    matrixSubtitle: 'From GSC queries, pos. 5–20, high impressions',
    matrixQuery: 'Query',
    matrixPos: 'Pos.',
    matrixImpr: 'Impr.',
    matrixIntent: 'Intent',
    matrixAction: 'Action',
    clustersTitle: 'Topic clusters',
    clustersSubtitle: 'Grouped from GSC pages + queries',
    clusterPagesShort: (n, imp) => `${n} pages · ${(imp / 1000).toFixed(1)}k impr.`,
    calendarTitle: 'Editorial calendar — next 4 weeks',
    week: 'Week',
    losingTitle: 'Pages losing traffic',
    losingSubtitle: 'Compared vs previous period',
    losingNoneAnalysed: 'Previous-period comparison unavailable.',
    losingNone: 'No pages losing more than 5% impressions vs previous period.',
    goalsTitle: 'Quarterly goals',
    goalOrganicClicks: 'Organic clicks',
    goalTop10: 'Top-10 keywords',
    goalNewPages: 'New cluster pages',
    actRefresh: 'Refresh',
    actNew: 'New post',
    actGuide: 'Guide',
    actExpand: 'Expand',
    // Action templates
    actCreateLanding: (url, kw) => `Create a dedicated landing page at ${url} targeting "${kw}".`,
    actRewriteAround: (kw) => `Rewrite this page around "${kw}" (title, H1, dedicated section in the body).`,
    actRefineFor: (kw) => `Refine this page for "${kw}" — tighten the title and add depth to the relevant section.`,
    actMissingTerms: (top, extra) => `Write content covering the missing terms: ${top}${extra ? ` (${extra})` : ''}.`,
    actAddMetaDesc: 'Add a meta description (~150 characters) that includes the top ranking queries.',
    actRewriteMeta: (top) => `Rewrite the meta description to include: ${top}.`,
    actMetaTooLong: (len) => `Meta description is ${len}ch — trim under 160ch to avoid SERP truncation.`,
    actMetaTooShort: (len) => `Meta description is only ${len}ch — expand to ~120–155ch with the main keywords.`,
    actRewriteTitle: (top) => `Rewrite the page title to lead with: ${top}.`,
    actSurfaceInH1: (top) => `Surface in an H1 or H2: ${top}.`,
    actThinPage: (w) => `Page is thin (${w} words). Expand to 800–1200 words covering the queries above.`,
    actMissingH1: 'Page has no H1 heading — add one that contains the main query.',
    actMultipleH1: (n) => `Page has ${n} H1s — keep a single H1.`,
    actTitleLength: (len) => `Title length (${len} ch) is outside the 30–60 sweet spot — rewrite it.`,
    actInternalLinks: 'Boost internal links from related pages using the target keywords as anchor text.',
    actInternalLinksAuth: 'Add internal links from high-authority pages with target-keyword anchors.',
    actFallback: 'Refresh content, expand topical coverage, and strengthen internal linking with target-keyword anchors.'
  },
  fr: {
    contentStrategy: 'STRATÉGIE DE CONTENU',
    audit: 'AUDIT',
    inThisDeck: 'DANS CE DOCUMENT',
    opportunityPages: 'Pages à fort potentiel',
    totalImpressions: 'Impressions totales',
    quickWins: 'Gains rapides',
    heroSubtitle: 'clics supplémentaires estimés par mois si chaque opportunité atteint son rang cible.',
    deckIntro: (n) => `${n} diapositive${n === 1 ? '' : 's'} d'opportunité. Chaque diapositive montre la page, son title / meta description / H1, les requêtes pour lesquelles elle se positionne, les lacunes de couverture et les actions priorisées.`,
    filtersLabel: (s) => `Filtres : ${s}`,
    noFilters: 'aucun filtre',
    filterQuickWins: 'gains rapides uniquement',
    filterText: (t) => `recherche "${t}"`,
    filterBands: (b) => `bandes : ${b}`,
    opportunitiesByBand: 'Opportunités par bande',
    opportunitiesByBandDesc: 'Chaque bande regroupe les pages selon le rang de leur meilleure requête. Bande basse = gain plus facile.',
    band: { push: 'Pousser au #1', striking: 'Distance de frappe', page2: 'Page 2', deep: 'Volume caché', deeper: 'Profond mais recherché' },
    positionsRange: (lo, hi, t) => `Positions ${lo}–${hi}  ·  cible #${t}`,
    pagesLabel: 'pages',
    impressionsLabel: 'impressions',
    extraClicksAt: (t) => `clics supplémentaires @ #${t}`,
    includedInDeck: (a, b) => `${a} / ${b} inclus dans ce document`,
    distributionByPotential: 'Répartition des clics potentiels',
    strategyMix: 'Mix stratégique',
    strategyMixDesc: 'Chaque opportunité relève de l\'une des trois actions. Utilisez ceci pour planifier la répartition du travail.',
    workSplit: 'Répartition du travail (par nombre de pages)',
    rec: {
      optimize:        { label: 'Optimiser',                    desc: 'Page pertinente — affiner le title, approfondir le contenu, renforcer le maillage interne.',
                         reason: 'L\'URL est cohérente avec le sujet — affiner le SEO on-page pour gagner des positions.' },
      'rewrite-expand':{ label: 'Réécrire et étoffer',          desc: 'Page partiellement pertinente — réécriture de contenu nécessaire.',
                         reason: 'Pertinence partielle pour le mot-clé. Réécrire le title/H1, ajouter une section dédiée et étoffer le contenu.' },
      'create-landing':{ label: 'Créer une nouvelle landing page', desc: 'Page peu pertinente — il faut une URL dédiée.',
                         reason: 'L\'URL actuelle n\'est que tangentiellement liée — une landing page dédiée convertirait mieux la demande en clics.' }
    },
    examples: 'EXEMPLES',
    topOpportunitiesTitle: 'Top 5 opportunités',
    topOpportunitiesDesc: 'Plus haut potentiel de clics supplémentaires si poussées au rang cible. Commencer ici.',
    bestQueryShort: (rank) => `Meilleure requête @ #${rank.toFixed(1)}`,
    targetShort: (t) => `Cible #${t}`,
    opportunityHeader: (a, b) => `OPPORTUNITÉ ${a} / ${b}`,
    quickWinBadge: 'Gain rapide',
    strategy: 'STRATÉGIE',
    impressions: 'Impressions',
    clicks: 'Clics',
    ctr: 'CTR',
    position: 'Position',
    potentialAtRank: (t) => `Potentiel @ rang ${t}`,
    suggestedUrl: 'URL suggérée',
    currentPage: 'Page actuelle',
    title: 'TITLE',
    metaDescription: 'META DESCRIPTION',
    h1Label: 'H1',
    titleMissingLabel: 'manquant',
    notAnalysedShort: '(non analysée)',
    notAnalysedHint: '(non analysée — cliquer sur "Analyse keyword coverage" dans l\'outil)',
    noTitleTag: '(aucune balise <title> sur la page)',
    noMetaDesc: '(aucune meta description — Google en générera une)',
    noH1: '(aucun titre H1 sur la page)',
    runAnalysisHint: 'Cliquer sur "Analyse keyword coverage" au-dessus du tableau pour remplir les données live ici.',
    h1Count: (n) => `${n} H1`,
    noH1Label: 'pas de H1',
    wordsOnLive: (w, q) => `${w.toLocaleString()} mots sur la page live  ·  ${q} requêtes analysées`,
    queriesCoverageHint: (n, w) => `Sur les ${n} requêtes pour lesquelles cette page se positionne dans Google, combien apparaissent réellement dans la page (${w.toLocaleString()} mots live) :`,
    keywordsToAddHint: 'Mots-clés manquants par section — corrections directes :',
    allOnPage: 'tous présents ✓',
    secLabel: { title: 'META TITLE', meta: 'META DESC', h1: 'H1', h2: 'H2', h3: 'H3', body: 'CORPS' },
    execSummaryTitle: 'Résumé exécutif',
    execSummaryKicker: 'Le chiffre clé et les 5 pages prioritaires par lesquelles commencer.',
    execHeroSub: (n, site) => `clics supplémentaires par mois disponibles sur ${n.toLocaleString()} pages positionnées de ${site}.`,
    execTopHeader: 'Commencer ici — 5 pages prioritaires',
    execColPage: 'Page',
    execColBest: 'Meilleure requête @ rang',
    execColAction: 'Action',
    execColGain: 'Clics suppl.',
    execChartTitle: 'Répartition du travail',
    execBandChartTitle: 'Pages par bande d\'opportunité',
    execTopFooterNote: (n) => `Top 5 sur ${n.toLocaleString()} opportunités par clics potentiels. Chaque page a sa propre diapositive.`,
    execTargetShort: 'au rang',
    execSummaryFooter: 'Chaque opportunité a sa propre diapositive dans ce document avec les actions à mener.',
    printSave: 'Imprimer → Enregistrer en PDF',
    printHint: 'Astuce : choisir « Enregistrer en PDF » dans la boîte de dialogue d\'impression.',
    pdfTagTitle: 'title',
    pdfTagMeta: 'meta description',
    pdfTagH1: 'H1',
    pdfTagH2: 'H2',
    pdfTagH3: 'H3',
    pdfTagSubheadings: 'sous-titres',
    pdfTagBody: 'corps',
    pdfAbsent: 'absent',
    execKeyInsightLabel: 'IDÉE CLÉ',
    execKeyInsight: ({ strikingPages, strikingPot, strikingShare, totalPages, quickWins }) => {
      const wins = quickWins
        ? ` ${quickWins} sont des gains rapides où le mot-clé est totalement absent de la page.`
        : '';
      if (!strikingPages) {
        return `${totalPages} pages se positionnent actuellement sur des requêtes en dehors du #1.${wins}`;
      }
      return `${strikingPages} pages se positionnent déjà entre #4 et #10 — les faire grimper capture environ ${strikingShare}% du potentiel total (≈ +${strikingPot.toLocaleString()} clics/mois). Commencer ici.${wins}`;
    },
    action: 'ACTION',
    execSummaryPara1: (a) =>
      `Nous avons analysé ${a.siteUrl} entre le ${a.startDate} et le ${a.endDate}. ${a.totalRows.toLocaleString()} pages se positionnent actuellement sur Google pour des requêtes en dehors du rang #1 — elles génèrent ensemble ${a.totalImpr.toLocaleString()} impressions par mois mais seulement ${a.totalClicks.toLocaleString()} clics. En les poussant chacune vers son rang cible, on pourrait gagner environ +${a.totalPotential.toLocaleString()} clics par mois.`,
    execSummaryPara2: (a) =>
      `Le travail se répartit en trois axes : ${a.optimize} pages à optimiser (affiner title / contenu / maillage interne), ${a.rewriteExpand} à réécrire ou étoffer significativement, et ${a.createLanding} qui gagneraient à avoir une landing page dédiée.${a.quickWins ? ` Parmi celles-ci, ${a.quickWins} pages ont au moins une requête ranking qui n'apparaît nulle part sur la page — les gains les plus rapides.` : ''}`,
    execSummaryPara3: 'La diapositive suivante est un tableau de bord d\'une page avec les chiffres clés, une matrice d\'opportunités, des clusters thématiques et un plan éditorial sur 4 semaines. Ensuite, chaque opportunité a sa propre diapositive avec l\'état actuel de la page, les actions priorisées et les requêtes pour lesquelles elle se positionne.',
    matrixTopNote: (n, m) => `(top ${n} sur ${m} par impressions)`,
    statIn: { title: 'requêtes dans le title', meta: 'requêtes dans la meta', H1: 'requêtes dans le H1', body: 'requêtes dans le corps' },
    actionItems: 'Actions à mener',
    priority: { critical: 'CRITIQUE', important: 'IMPORTANT', recommended: 'RECOMMANDÉ' },
    topRankingQueries: 'Top requêtes positionnées',
    query: 'Requête',
    impr: 'Impr',
    pos: 'Pos',
    inPage: 'Sur la page ?',
    wordsOnly: 'mots seuls',
    missingOnPage: (n, impr) => `Absent de la page  ·  ${n} ${n === 1 ? 'requête' : 'requêtes'}  ·  ${impr.toLocaleString()} impressions`,
    allCovered: 'Toutes les requêtes apparaissent déjà quelque part sur la page. Travailler le title, le H1 et le maillage interne.',
    missingNotRun: 'Analyse des mots-clés manquants pas encore lancée.',
    plusMore: (n) => `+${n} de plus`,
    methodologyTitle: 'Lecture du document',
    methodologyDesc: 'Référence rapide : signification des métriques et calculs utilisés.',
    appendixTitle: () => 'Autres opportunités',
    appendixSubtitle: (from, to, page, total) => `Opportunités ${from}–${to} · page ${page} / ${total} — top 15 déjà détaillé ci-dessus.`,
    appendixCols: ['#', 'Page', 'Bande', 'Pos', 'Impr', 'Meilleure requête', 'Potentiel'],
    opportunityBandsHeader: 'BANDES D\'OPPORTUNITÉ',
    ctrCurveHeader: 'CTR MOYEN PAR POSITION',
    potentialHowTitle: 'Comment sont calculés les "clics supplémentaires potentiels"',
    potentialHowDesc: 'Pour chaque requête : potentiel = (impressions × CTR au rang cible) − clics actuels. Le potentiel total d\'une page est la somme sur toutes ses requêtes éligibles. La courbe CTR ci-dessus est une moyenne sectorielle — à considérer comme un plafond indicatif, pas une prévision.',
    preparedBy: 'Préparé par Converta  ·  seo.converta.ro',
    siteAndDates: (site, s, e) => `${site}  ·  ${s} → ${e}`,
    dashTitle: 'Tableau de bord exécutif',
    dashSubtitle: 'Performance de recherche, matrice d\'opportunités, clusters thématiques et plan éditorial sur 4 semaines.',
    kpiClicks: 'Clics',
    kpiImpressions: 'Impressions',
    kpiAvgCtr: 'CTR moyen',
    kpiAvgPosition: 'Position moy.',
    kpiExtraClicks: 'Clics supplémentaires estimés',
    tileScopeAll: (n) => `sur les ${n} requêtes positionnées`,
    tileScopeOverall: 'moyenne page (toutes requêtes)',
    tileScopeBest: (q) => {
      const s = String(q || '');
      const short = s.length > 18 ? s.slice(0, 17) + '…' : s;
      return `si « ${short} » au rang cible`;
    },
    matrixTitle: 'Matrice d\'opportunités',
    matrixSubtitle: 'Requêtes GSC, pos. 5–20, fortes impressions',
    matrixQuery: 'Requête',
    matrixPos: 'Pos.',
    matrixImpr: 'Impr.',
    matrixIntent: 'Intention',
    matrixAction: 'Action',
    clustersTitle: 'Clusters thématiques',
    clustersSubtitle: 'Pages et requêtes GSC regroupées',
    clusterPagesShort: (n, imp) => `${n} pages · ${(imp / 1000).toFixed(1)}k impr.`,
    calendarTitle: 'Calendrier éditorial — 4 prochaines semaines',
    week: 'Semaine',
    losingTitle: 'Pages perdant du trafic',
    losingSubtitle: 'Comparées à la période précédente',
    losingNoneAnalysed: 'Comparaison à la période précédente indisponible.',
    losingNone: 'Aucune page ne perd plus de 5% d\'impressions par rapport à la période précédente.',
    goalsTitle: 'Objectifs trimestriels',
    goalOrganicClicks: 'Clics organiques',
    goalTop10: 'Mots-clés top 10',
    goalNewPages: 'Nouvelles pages cluster',
    actRefresh: 'Rafraîchir',
    actNew: 'Nouvel article',
    actGuide: 'Guide',
    actExpand: 'Étoffer',
    actCreateLanding: (url, kw) => `Créer une landing page dédiée à ${url} ciblant « ${kw} ».`,
    actRewriteAround: (kw) => `Réécrire la page autour de « ${kw} » (title, H1, section dédiée dans le corps).`,
    actRefineFor: (kw) => `Affiner la page pour « ${kw} » — resserrer le title et approfondir la section concernée.`,
    actMissingTerms: (top, extra) => `Écrire du contenu couvrant les termes manquants : ${top}${extra ? ` (${extra})` : ''}.`,
    actAddMetaDesc: 'Ajouter une meta description (~150 caractères) incluant les requêtes principales.',
    actRewriteMeta: (top) => `Réécrire la meta description pour inclure : ${top}.`,
    actMetaTooLong: (len) => `Meta description de ${len}ch — réduire sous 160ch pour éviter la troncature dans le SERP.`,
    actMetaTooShort: (len) => `Meta description de seulement ${len}ch — étendre à ~120–155ch avec les mots-clés principaux.`,
    actRewriteTitle: (top) => `Réécrire le title pour démarrer par : ${top}.`,
    actSurfaceInH1: (top) => `Faire apparaître dans un H1 ou H2 : ${top}.`,
    actThinPage: (w) => `Page trop courte (${w} mots). Étendre à 800–1200 mots couvrant les requêtes ci-dessus.`,
    actMissingH1: 'La page n\'a pas de H1 — en ajouter un contenant la requête principale.',
    actMultipleH1: (n) => `La page a ${n} H1 — ne garder qu\'un seul H1.`,
    actTitleLength: (len) => `Title de ${len} caractères — hors de la plage idéale 30–60. À réécrire.`,
    actInternalLinks: 'Renforcer le maillage interne depuis les pages connexes avec les mots-clés cibles en ancre.',
    actInternalLinksAuth: 'Ajouter des liens internes depuis les pages à forte autorité avec les mots-clés cibles en ancre.',
    actFallback: 'Rafraîchir le contenu, étendre la couverture thématique, renforcer le maillage interne avec des ancres ciblées.'
  }
};

function tFor(lang) {
  return PPT_I18N[lang] || PPT_I18N.en;
}

function deriveActions(r, lang) {
  const T = tFor(lang || 'en');
  const actions = [];
  const cov = r.coverage && Array.isArray(r.coverage.queries) ? r.coverage : null;
  const crawl = r.crawl;
  const push = (priority, text) => actions.push({ priority, text });
  const rec = r.recommendation;
  // Brand-only queries won by another (shallower) page must not appear
  // as action items here — see the survivors loop in runStrategyQuery.
  const offLimits = r.offLimitsQueries || new Set();
  const allowed = (q) => !offLimits.has(q.query);

  if (rec) {
    if (rec.type === 'create-landing' && rec.suggestedUrl) {
      push('critical', T.actCreateLanding(rec.suggestedUrl, r.bestQuery));
    } else if (rec.type === 'rewrite-expand') {
      push('critical', T.actRewriteAround(r.bestQuery));
    } else if (rec.type === 'optimize') {
      push('important', T.actRefineFor(r.bestQuery));
    }
  }

  if (cov) {
    const missing = cov.queries.filter(q => !q.presentSomewhere && allowed(q));
    if (missing.length) {
      const top = missing.slice(0, 5).map(q => q.query).join(', ');
      push('critical', T.actMissingTerms(top, missing.length > 5 ? T.plusMore(missing.length - 5) : null));
    }
    if (cov.metaDescriptionLength === 0) {
      push('critical', T.actAddMetaDesc);
    } else {
      const notInMeta = cov.queries.filter(q => !q.phrase.inMetaDescription && q.presentSomewhere && allowed(q));
      if (notInMeta.length) {
        const top = notInMeta.slice(0, 2).map(q => q.query).join(' / ');
        push('important', T.actRewriteMeta(top));
      }
      if (cov.metaDescriptionLength > 160) push('important', T.actMetaTooLong(cov.metaDescriptionLength));
      else if (cov.metaDescriptionLength < 70) push('important', T.actMetaTooShort(cov.metaDescriptionLength));
    }
    const notInTitle = cov.queries.filter(q => !q.phrase.inTitle && q.presentSomewhere && allowed(q));
    if (notInTitle.length) {
      const top = notInTitle.slice(0, 2).map(q => q.query).join(' / ');
      push('important', T.actRewriteTitle(top));
    }
    const notInH1 = cov.queries.filter(q => !q.phrase.inH1 && !q.phrase.inHeadings && q.phrase.bodyOccurrences > 0 && allowed(q));
    if (notInH1.length) {
      const top = notInH1.slice(0, 2).map(q => q.query).join(' / ');
      push('important', T.actSurfaceInH1(top));
    }
    if (cov.wordCount && cov.wordCount < 500) push('recommended', T.actThinPage(cov.wordCount));
  }
  if (crawl && (!crawl.h1Count || crawl.h1Count === 0)) push('critical', T.actMissingH1);
  else if (crawl && crawl.h1Count > 1) push('important', T.actMultipleH1(crawl.h1Count));

  if (crawl && crawl.titleLength && (crawl.titleLength < 30 || crawl.titleLength > 65)) {
    push('important', T.actTitleLength(crawl.titleLength));
  }
  if (r.band.id === 'push' || r.band.id === 'striking') push('recommended', T.actInternalLinks);
  else if (r.band.id === 'page2') push('recommended', T.actInternalLinksAuth);

  if (!actions.length) push('recommended', T.actFallback);

  const order = { critical: 0, important: 1, recommended: 2 };
  return actions.sort((a, b) => order[a.priority] - order[b.priority]);
}

// Build the executive dashboard slide. Lays out six sections per the
// template the user provided: KPI strip, opportunity matrix, topic
// clusters, editorial calendar, pages losing traffic, quarterly goals.
// Renders the executive dashboard to mirror the template the user
// provided: a 7-section single slide on cream background with white
// rounded cards, KPI deltas, opportunity matrix table, topic cluster
// pills, editorial-calendar week cards, pages-losing list and quarterly
// goal progress bars. Everything localised via T.
// Executive summary — a single slide of plain-text narrative that opens
// the deck. Frames the audit in human language before the dense data
// slides start.
function addExecutiveSummarySlide(pptx, T, ctx) {
  const { siteUrl, startDate, endDate, allRows, rows } = ctx;
  const PAGE_BG = 'FAF8F4';
  const CARD_BG = 'FFFFFF';
  const CARD_BORDER = 'E8E3D9';
  const TEXT = '1A1D2E';
  const MUTED = '6B7085';
  const PRIMARY = '6366F1';

  const totalPotential = Math.round(allRows.reduce((s, r) => s + r.potentialClicks, 0));
  const totalImpr = allRows.reduce((s, r) => s + r.impressions, 0);
  const totalClicks = allRows.reduce((s, r) => s + r.clicks, 0);
  const totalQuickWins = allRows.filter(r => r.isQuickWin === true).length;

  // Per-recommendation aggregates so the action cards are real numbers,
  // not just page counts. Same logic that powers the Strategy mix slide.
  const recAgg = { optimize: { pages: 0, potential: 0 }, 'rewrite-expand': { pages: 0, potential: 0 }, 'create-landing': { pages: 0, potential: 0 } };
  for (const r of allRows) {
    const t = (r.recommendation && r.recommendation.type) || 'optimize';
    if (!recAgg[t]) continue;
    recAgg[t].pages++;
    recAgg[t].potential += r.potentialClicks;
  }

  // Striking distance = positions 4–10, the band where most clicks
  // realistically live. Use it for the headline insight.
  const strikingPot = Math.round(allRows.reduce((sum, r) => {
    const slot = r.perBand && r.perBand.striking;
    return sum + ((slot && slot.potential) || 0);
  }, 0));
  const strikingPages = allRows.filter(r => (r.bandIds || [r.band.id]).includes('striking')).length;
  const strikingShare = totalPotential > 0 ? Math.round((strikingPot / totalPotential) * 100) : 0;

  const s = pptx.addSlide();
  s.background = { color: PAGE_BG };

  // Title row
  s.addText(T.execSummaryTitle, { x: 0.55, y: 0.25, w: 12.2, h: 0.40, fontSize: 22, bold: true, color: TEXT });
  s.addText(T.execSummaryKicker, { x: 0.55, y: 0.68, w: 12.2, h: 0.26, fontSize: 12, color: MUTED });

  // ── Hero band: big number + headline sentence + KEY INSIGHT ─────────
  s.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: 1.05, w: 12.25, h: 1.70, fill: { color: CARD_BG }, line: { color: CARD_BORDER, width: 0.5 }, rectRadius: 0.12 });
  s.addShape(pptx.ShapeType.rect, { x: 0.55, y: 1.05, w: 0.18, h: 1.70, fill: { color: PRIMARY }, line: { type: 'none' } });
  s.addText(`+${totalPotential.toLocaleString()}`, { x: 0.85, y: 1.15, w: 4.7, h: 1.0, fontSize: 56, bold: true, color: '#' + PRIMARY });
  s.addText(T.execHeroSub(allRows.length, siteUrl),
    { x: 5.45, y: 1.25, w: 7.15, h: 0.5, fontSize: 12, color: MUTED });
  const insightLine = T.execKeyInsight
    ? T.execKeyInsight({ strikingPages, strikingPot, strikingShare, totalPages: allRows.length, quickWins: totalQuickWins })
    : `${strikingPages} pages already rank in positions 4–10 — pushing them up captures ${strikingShare}% of the total upside (≈ +${strikingPot.toLocaleString()} clicks/month). Start there.`;
  s.addText([
    { text: (T.execKeyInsightLabel || 'KEY INSIGHT') + '  ', options: { fontSize: 10, bold: true, color: '#' + PRIMARY, charSpacing: 4 } },
    { text: insightLine, options: { fontSize: 12, color: TEXT } }
  ], { x: 0.85, y: 2.18, w: 11.75, h: 0.5, fontSize: 12, valign: 'top' });

  // ── 3 strategic action cards — what to actually do ──────────────────
  // Replaces the two pies on this slide. Pies still live on the
  // dedicated Strategy mix / Opportunity bands slides for clients who
  // want the visual; the exec summary leads with actions.
  const recTypes = [
    { id: 'optimize',       color: '16A34A', tint: 'E8F7EE' },
    { id: 'rewrite-expand', color: 'D97706', tint: 'FEF1E3' },
    { id: 'create-landing', color: 'DC2626', tint: 'FCE9E9' }
  ];
  recTypes.forEach((rt, i) => {
    const x = 0.55 + i * 4.10;
    const w = 4.00;
    const a = recAgg[rt.id];
    const lab = T.rec[rt.id];
    s.addShape(pptx.ShapeType.roundRect, { x, y: 2.90, w, h: 2.30, fill: { color: rt.tint }, line: { color: '#' + rt.color, width: 0.75 }, rectRadius: 0.12 });
    s.addShape(pptx.ShapeType.rect, { x, y: 2.90, w, h: 0.05, fill: { color: '#' + rt.color }, line: { type: 'none' } });
    s.addText((T.action || 'ACTION') + ' ' + (i + 1), { x: x + 0.20, y: 3.05, w: w - 0.4, h: 0.24, fontSize: 9, bold: true, color: '#' + rt.color, charSpacing: 4 });
    s.addText(lab.label, { x: x + 0.20, y: 3.32, w: w - 0.4, h: 0.36, fontSize: 16, bold: true, color: TEXT });
    s.addText(a.pages.toLocaleString() + ' ' + (T.pagesLabel || 'pages'), { x: x + 0.20, y: 3.74, w: (w - 0.4) / 2, h: 0.28, fontSize: 11, color: MUTED });
    s.addText('+' + Math.round(a.potential).toLocaleString(), { x: x + 0.20 + (w - 0.4) / 2, y: 3.74, w: (w - 0.4) / 2, h: 0.28, fontSize: 14, bold: true, color: '#' + PRIMARY, align: 'right' });
    s.addText(lab.desc, { x: x + 0.20, y: 4.10, w: w - 0.4, h: 1.05, fontSize: 10, color: TEXT, italic: true, valign: 'top' });
  });

  // ── Bottom: top 5 priority pages table ──────────────────────────────
  s.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: 5.30, w: 12.25, h: 1.75, fill: { color: CARD_BG }, line: { color: CARD_BORDER, width: 0.5 }, rectRadius: 0.12 });
  s.addText(T.execTopHeader, { x: 0.80, y: 5.38, w: 11.7, h: 0.28, fontSize: 12, bold: true, color: TEXT });

  const top5 = rows.slice().sort((a, b) => b.potentialClicks - a.potentialClicks).slice(0, 5);
  if (top5.length) {
    const recColorOf = (t) => t === 'create-landing' ? 'DC2626' : (t === 'rewrite-expand' ? 'D97706' : '16A34A');
    const headerStyle = { bold: true, color: MUTED, fontSize: 9, fill: { color: 'F5F1E8' } };
    const headerRow = [
      { text: '#',                                          options: headerStyle },
      { text: T.execColPage,                                options: headerStyle },
      { text: T.execColBest || 'Best query @ rank',         options: headerStyle },
      { text: T.execColGain,                                options: { ...headerStyle, align: 'right' } }
    ];
    const dataRows = top5.map((r, i) => {
      const recType = (r.recommendation && r.recommendation.type) || 'optimize';
      let path = r.page;
      try { path = new URL(r.page).pathname || '/'; } catch { /* ignore */ }
      return [
        { text: String(i + 1), options: { fontSize: 11, bold: true, color: '#' + recColorOf(recType), align: 'center' } },
        { text: trunc(path, 50), options: { fontSize: 10, bold: true, color: TEXT } },
        { text: `"${trunc(r.bestQuery || '', 40)}"  @ ${r.bestQueryPosition.toFixed(1)}`, options: { fontSize: 10, color: TEXT } },
        { text: '+' + Math.round(r.potentialClicks).toLocaleString(), options: { fontSize: 11, bold: true, color: '#' + PRIMARY, align: 'right' } }
      ];
    });
    s.addTable([headerRow, ...dataRows], {
      x: 0.80, y: 5.65, w: 11.75, colW: [0.45, 4.40, 5.30, 1.60],
      fontFace: 'Calibri', color: TEXT,
      border: { type: 'solid', color: CARD_BORDER, pt: 0.5 },
      rowH: 0.22
    });
  }

  s.addText(T.preparedBy, { x: 0.55, y: 7.20, w: 12.2, h: 0.22, fontSize: 9, color: MUTED });
}

function addExecutiveDashboardSlide(pptx, T, ctx) {
  const { siteUrl, startDate, endDate, allRows, rows, curTotals, prevTotals, prevPagesData } = ctx;
  const PAGE_BG = 'FAF8F4';
  const CARD_BG = 'FFFFFF';
  const CARD_BORDER = 'E8E3D9';
  const TILE_BG = 'F5F1E8';
  const TEXT = '1A1D2E';
  const MUTED = '6B7085';
  const POS_DELTA = '16A34A';
  const NEG_DELTA = 'DC2626';

  const d = pptx.addSlide();
  d.background = { color: PAGE_BG };

  // Header
  d.addText(T.dashTitle, { x: 0.55, y: 0.25, w: 12.2, h: 0.45, fontSize: 22, bold: true, color: TEXT });
  d.addText(T.dashSubtitle, { x: 0.55, y: 0.72, w: 12.2, h: 0.28, fontSize: 11, color: MUTED });

  // ── KPI strip (4 tiles, cream tinted) ───────────────────────────────
  const kpis = [
    { label: T.kpiClicks,       curr: curTotals && curTotals.clicks,      prev: prevTotals && prevTotals.clicks,      fmt: (n) => Number(n).toLocaleString() },
    { label: T.kpiImpressions,  curr: curTotals && curTotals.impressions, prev: prevTotals && prevTotals.impressions, fmt: (n) => n >= 1000000 ? (n/1000000).toFixed(1) + 'M' : (n >= 10000 ? (n/1000).toFixed(0) + 'k' : Number(n).toLocaleString()) },
    { label: T.kpiAvgCtr,       curr: curTotals && curTotals.ctr,         prev: prevTotals && prevTotals.ctr,         fmt: (v) => (v * 100).toFixed(1) + '%' },
    { label: T.kpiAvgPosition,  curr: curTotals && curTotals.position,    prev: prevTotals && prevTotals.position,    fmt: (v) => v.toFixed(1) }
  ];
  kpis.forEach((k, i) => {
    const x = 0.55 + i * 3.10;
    d.addShape(pptx.ShapeType.roundRect, { x, y: 1.05, w: 2.95, h: 0.95, fill: { color: TILE_BG }, line: { color: CARD_BORDER, width: 0.5 }, rectRadius: 0.12 });
    d.addText(k.label, { x: x + 0.20, y: 1.10, w: 2.55, h: 0.25, fontSize: 10, color: MUTED });
    d.addText(k.curr != null ? k.fmt(k.curr) : '—', { x: x + 0.20, y: 1.30, w: 2.55, h: 0.42, fontSize: 22, bold: true, color: TEXT });
    if (k.curr != null && k.prev != null && k.prev !== 0) {
      let delta, up, label;
      if (k.label === T.kpiAvgPosition) {       // lower = better
        delta = k.prev - k.curr; up = delta > 0; label = Math.abs(delta).toFixed(1);
      } else if (k.label === T.kpiAvgCtr) {
        delta = (k.curr - k.prev) * 100; up = delta > 0; label = Math.abs(delta).toFixed(1) + '%';
      } else {
        delta = ((k.curr - k.prev) / k.prev) * 100; up = delta > 0; label = Math.abs(delta).toFixed(0) + '%';
      }
      d.addText((up ? '▲ ' : '▼ ') + label, { x: x + 0.20, y: 1.74, w: 2.55, h: 0.22, fontSize: 9, color: up ? POS_DELTA : NEG_DELTA, bold: true });
    }
  });

  // ── Middle row: Keyword matrix + Topic clusters ─────────────────────
  // Matrix card
  d.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: 2.15, w: 7.60, h: 2.45, fill: { color: CARD_BG }, line: { color: CARD_BORDER, width: 0.5 }, rectRadius: 0.12 });
  d.addText('◎  ' + T.matrixTitle, { x: 0.75, y: 2.22, w: 7.25, h: 0.30, fontSize: 13, bold: true, color: TEXT });
  d.addText(T.matrixSubtitle, { x: 0.75, y: 2.50, w: 7.25, h: 0.24, fontSize: 10, color: MUTED });

  const intentTints = { 'Info': 'DBEAFE', 'Trans.': 'FFEDD5', 'Nav.': 'F3E8FF' };
  const intentColors = { 'Info': '1D4ED8', 'Trans.': 'C2410C', 'Nav.': '6D28D9' };
  const topMatrix = (rows.length ? rows : allRows).slice(0, 5);
  const hStyle = { bold: true, color: MUTED, fontSize: 9, fill: { color: TILE_BG } };
  const matrixHeader = [
    { text: T.matrixQuery,  options: hStyle },
    { text: T.matrixPos,    options: { ...hStyle, align: 'right' } },
    { text: T.matrixImpr,   options: { ...hStyle, align: 'right' } },
    { text: T.matrixIntent, options: hStyle },
    { text: T.matrixAction, options: hStyle }
  ];
  const matrixRows = topMatrix.map(r => {
    const intent = classifyIntent(r.bestQuery || '');
    const action = mapActionFromRec((r.recommendation && r.recommendation.type) || 'optimize', T);
    return [
      { text: trunc(r.bestQuery || '', 34), options: { fontSize: 10, color: TEXT } },
      { text: r.bestQueryPosition.toFixed(1), options: { fontSize: 10, align: 'right', color: TEXT } },
      { text: r.bestQueryImpressions.toLocaleString(), options: { fontSize: 10, align: 'right', color: TEXT } },
      { text: ' ' + intent + ' ', options: { fontSize: 9, color: intentColors[intent], fill: { color: intentTints[intent] }, bold: true } },
      { text: action, options: { fontSize: 10, color: TEXT, bold: true } }
    ];
  });
  if (matrixRows.length) {
    // Table sits below the card title + subtitle and must end before
    // the card itself does (y=4.60). 6 rows × 0.28 = 1.68 → ends at 4.55.
    d.addTable([matrixHeader, ...matrixRows], {
      x: 0.75, y: 2.85, w: 7.25, colW: [3.0, 0.7, 0.95, 1.0, 1.6],
      fontFace: 'Calibri', color: TEXT,
      border: { type: 'solid', color: CARD_BORDER, pt: 0.4 },
      rowH: 0.28
    });
  }

  // Clusters card
  d.addShape(pptx.ShapeType.roundRect, { x: 8.30, y: 2.15, w: 4.45, h: 2.45, fill: { color: CARD_BG }, line: { color: CARD_BORDER, width: 0.5 }, rectRadius: 0.12 });
  d.addText('⌭  ' + T.clustersTitle, { x: 8.50, y: 2.22, w: 4.25, h: 0.30, fontSize: 13, bold: true, color: TEXT });
  d.addText(T.clustersSubtitle, { x: 8.50, y: 2.50, w: 4.25, h: 0.24, fontSize: 10, color: MUTED });
  const clusters = clusterTopics(allRows, 5);
  clusters.forEach((c, i) => {
    const cy = 2.82 + i * 0.36;
    d.addShape(pptx.ShapeType.roundRect, { x: 8.50, y: cy, w: 4.10, h: 0.32, fill: { color: c.tint }, line: { type: 'none' }, rectRadius: 0.08 });
    d.addText(c.label, { x: 8.62, y: cy + 0.04, w: 2.4, h: 0.25, fontSize: 10, bold: true, color: '#' + c.accent });
    d.addText(T.clusterPagesShort(c.pages, c.impressions), { x: 10.85, y: cy + 0.04, w: 1.65, h: 0.25, fontSize: 9, color: '#' + c.accent, align: 'right' });
  });

  // ── Editorial calendar — 4 weekly cards ─────────────────────────────
  d.addText('📅  ' + T.calendarTitle, { x: 0.55, y: 4.78, w: 12.2, h: 0.28, fontSize: 13, bold: true, color: TEXT });
  const editorial = rows.slice(0, 4);
  const TOPIC_TAGS = [
    { test: /track|analytics|gtm|ga4|tag |sgtm/i,                label: 'Tracking',  color: '6366F1', tint: 'EEEAFE' },
    { test: /ads|capi|pixel|conversion|tiktok|meta /i,           label: 'Ads',       color: 'D97706', tint: 'FDEEDA' },
    { test: /consent|privacy|cookie|gdpr|rgpd/i,                 label: 'Privacy',   color: '92704B', tint: 'EEE8E0' },
    { test: /seo|crawl|sitemap|schema/i,                         label: 'SEO',       color: 'DC2626', tint: 'FDE7E7' },
    { test: /shop|buy|price|cart|product|product/i,              label: 'Commercial',color: '16A34A', tint: 'E6F4EE' }
  ];
  for (let i = 0; i < 4; i++) {
    const r = editorial[i];
    const x = 0.55 + i * 3.10;
    d.addShape(pptx.ShapeType.roundRect, { x, y: 5.10, w: 2.95, h: 1.20, fill: { color: CARD_BG }, line: { color: CARD_BORDER, width: 0.5 }, rectRadius: 0.12 });
    d.addText(T.week + ' ' + (i + 1), { x: x + 0.18, y: 5.16, w: 2.6, h: 0.22, fontSize: 9, color: MUTED });
    if (!r) {
      d.addText('—', { x: x + 0.18, y: 5.45, w: 2.6, h: 0.32, fontSize: 14, color: MUTED });
      continue;
    }
    const heading = r.bestQuery || r.page.replace(/^https?:\/\/[^/]+/, '') || '';
    const action = mapActionFromRec((r.recommendation && r.recommendation.type) || 'optimize', T);
    const intent = classifyIntent(r.bestQuery || '');
    d.addText(trunc(heading, 26), { x: x + 0.18, y: 5.38, w: 2.6, h: 0.36, fontSize: 12, bold: true, color: TEXT });
    d.addText(`${action} · ${intent.toLowerCase()}`, { x: x + 0.18, y: 5.74, w: 2.6, h: 0.22, fontSize: 9, color: MUTED });
    const tag = TOPIC_TAGS.find(t => t.test.test(heading)) || { label: 'Editorial', color: '6366F1', tint: 'EEEAFE' };
    d.addShape(pptx.ShapeType.roundRect, { x: x + 0.18, y: 5.97, w: 1.10, h: 0.24, fill: { color: tag.tint }, line: { type: 'none' }, rectRadius: 0.12 });
    d.addText(tag.label, { x: x + 0.18, y: 5.97, w: 1.10, h: 0.24, fontSize: 9, color: '#' + tag.color, bold: true, align: 'center' });
  }

  // ── Bottom row: Pages losing traffic + Quarterly goals ──────────────
  const bottomY = 6.45, bottomH = 0.85;
  // Pages losing
  d.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: bottomY, w: 6.10, h: bottomH, fill: { color: CARD_BG }, line: { color: CARD_BORDER, width: 0.5 }, rectRadius: 0.12 });
  d.addText('↘  ' + T.losingTitle, { x: 0.75, y: bottomY + 0.06, w: 5.7, h: 0.22, fontSize: 11, bold: true, color: TEXT });
  d.addText(T.losingSubtitle, { x: 0.75, y: bottomY + 0.27, w: 5.7, h: 0.18, fontSize: 9, color: MUTED });
  const losing = findLosingPages(allRows, prevPagesData && prevPagesData.byUrl, 3);
  if (losing.length) {
    losing.forEach((p, i) => {
      const ly = bottomY + 0.48 + i * 0.14;
      let path = p.page;
      try { path = new URL(p.page).pathname; } catch { /* keep raw */ }
      d.addText(trunc(path, 55), { x: 0.75, y: ly, w: 4.6, h: 0.14, fontSize: 9, color: TEXT });
      d.addText(`${(p.delta * 100).toFixed(0)}%`, { x: 5.40, y: ly, w: 1.05, h: 0.14, fontSize: 9, color: NEG_DELTA, bold: true, align: 'right' });
    });
  } else {
    d.addText(prevPagesData && prevPagesData.byUrl && prevPagesData.byUrl.size ? T.losingNone : T.losingNoneAnalysed,
      { x: 0.75, y: bottomY + 0.50, w: 5.7, h: 0.3, fontSize: 9, color: MUTED, italic: true });
  }

  // Quarterly goals with real progress bars
  d.addShape(pptx.ShapeType.roundRect, { x: 6.80, y: bottomY, w: 5.95, h: bottomH, fill: { color: CARD_BG }, line: { color: CARD_BORDER, width: 0.5 }, rectRadius: 0.12 });
  d.addText('⚑  ' + T.goalsTitle, { x: 7.00, y: bottomY + 0.06, w: 5.7, h: 0.22, fontSize: 11, bold: true, color: TEXT });

  const totalClicks   = curTotals ? curTotals.clicks : allRows.reduce((s, r) => s + r.clicks, 0);
  const prevClicks    = prevTotals ? prevTotals.clicks : 0;
  const clicksGrowth  = prevClicks ? ((totalClicks - prevClicks) / prevClicks) * 100 : 0;
  const top10Count    = allRows.filter(r => r.bestQueryPosition <= 10).length;
  const newPagesCount = allRows.filter(r => r.recommendation && r.recommendation.type === 'create-landing').length;
  const goals = [
    { label: T.goalOrganicClicks, value: (clicksGrowth >= 0 ? '+' : '') + clicksGrowth.toFixed(0) + '%', pct: Math.min(1, Math.max(0.05, (clicksGrowth + 25) / 50)), color: '16A34A' },
    { label: T.goalTop10,         value: String(top10Count),    pct: Math.min(1, top10Count / 120),    color: '2563EB' },
    { label: T.goalNewPages,      value: String(newPagesCount), pct: Math.min(1, newPagesCount / 16), color: 'D97706' }
  ];
  goals.forEach((g, i) => {
    const gy = bottomY + 0.32 + i * 0.18;
    d.addText(g.label, { x: 7.00, y: gy, w: 3.0, h: 0.18, fontSize: 9, color: TEXT });
    d.addText(g.value, { x: 12.00, y: gy, w: 0.70, h: 0.18, fontSize: 10, bold: true, color: '#' + g.color, align: 'right' });
    // Bar track + fill
    d.addShape(pptx.ShapeType.rect, { x: 10.00, y: gy + 0.06, w: 2.00, h: 0.07, fill: { color: TILE_BG }, line: { type: 'none' } });
    d.addShape(pptx.ShapeType.rect, { x: 10.00, y: gy + 0.06, w: Math.max(0.04, 2.00 * g.pct), h: 0.07, fill: { color: '#' + g.color }, line: { type: 'none' } });
  });

  d.addText(T.siteAndDates(siteUrl, startDate, endDate), { x: 0.55, y: 7.36, w: 12.2, h: 0.20, fontSize: 9, color: MUTED });
}

async function exportStrategyPpt() {
  if (!csState.rows.length) { alert('Run a query first.'); return; }
  const lang = (document.getElementById('csExportLang') || {}).value || 'en';
  const T = tFor(lang);
  const bands = activeBandIds();
  const textFilter = (document.getElementById('csTextFilter').value || '').toLowerCase();
  const quickWinsOnly = !!document.getElementById('csQuickWins')?.checked;
  const rows = csState.rows.filter(r =>
    (r.bandIds || [r.band.id]).some(id => bands.has(id)) &&
    (!textFilter || r.page.toLowerCase().includes(textFilter)) &&
    (!quickWinsOnly || r.isQuickWin === true)
  );
  if (!rows.length) { alert('No opportunities match the current filters.'); return; }
  if (rows.length > 60 && !confirm(`This will create ${rows.length + 2} slides — that can take a minute. Continue?`)) return;

  // (Removed pre-flight prompt that ran analyseAllCoverage. It analysed
  // EVERY visible row, not just the rows being exported — turning a 60-
  // row export into a 500-row coverage crawl that took several minutes.
  // The slides already render a friendly "(not analysed)" placeholder
  // for rows without coverage; users who want real data click the
  // "Analyse keyword coverage" button before exporting.)

  const btn = document.getElementById('csExportPpt');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Loading…';
  try {
    await loadPptxLib();
  } catch (e) {
    btn.disabled = false; btn.textContent = originalLabel;
    alert(e.message);
    return;
  }
  btn.textContent = 'Building deck…';

  const siteUrl = document.getElementById('csSite').value || 'site';
  const startDate = document.getElementById('csStart').value;
  const endDate = document.getElementById('csEnd').value;

  const pptx = new window.PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';                  // 13.333 × 7.5 in
  pptx.author = 'Converta SEO';
  pptx.company = 'Converta';
  pptx.title = `Content Strategy — ${siteUrl}`;

  // Template palette — warm cream page, white cards, soft borders, brand
  // primary purple, the dashboard pastels reused across every slide.
  const COLORS = {
    bg:           'FAF8F4',
    text:         '1A1D2E',
    muted:        '6B7085',
    border:       'E8E3D9',
    panelBg:      'FFFFFF',
    panelAccent:  'F5F1E8',
    primary:      '6366F1',
    primaryDark:  '4F46E5',
    success:      '16A34A',
    warning:      'D97706',
    danger:       'DC2626'
  };
  const bandColor = (b) => ({ push: '16A34A', striking: '2563EB', page2: '6366F1', deep: 'D97706', deeper: 'DC2626' }[b.id] || '6366F1');
  const trunc = (s, n) => (s || '').length > n ? s.slice(0, n - 1) + '…' : (s || '');

  // ── Cover slide ────────────────────────────────────────────────────────
  // Headline numbers are computed against the FULL csState.rows so the
  // figures match what the user sees in the tool, independent of any
  // filter applied to the per-opportunity slides.
  const allRows = csState.rows;
  const totalImpr = allRows.reduce((s, r) => s + r.impressions, 0);
  const totalPot = Math.round(allRows.reduce((s, r) => s + r.potentialClicks, 0));
  const totalAnalysed = allRows.filter(r => r.coverage && Array.isArray(r.coverage.queries)).length;
  const totalQuickWins = allRows.filter(r => r.isQuickWin === true).length;

  const filterDescParts = [];
  if (quickWinsOnly) filterDescParts.push(T.filterQuickWins);
  if (textFilter) filterDescParts.push(T.filterText(textFilter));
  if (bands.size < STRATEGY_BANDS.length) {
    const labels = STRATEGY_BANDS.filter(b => bands.has(b.id)).map(b => T.band[b.id] || b.label);
    filterDescParts.push(T.filterBands(labels.join(', ')));
  }
  const filterDesc = filterDescParts.length ? filterDescParts.join(' · ') : T.noFilters;

  const cover = pptx.addSlide();
  cover.background = { color: COLORS.bg };

  // Template aesthetic: cream page, dark text, cream KPI tiles, soft borders.
  cover.addText(T.contentStrategy, { x: 0.55, y: 0.55, w: 12, h: 0.4, fontSize: 12, bold: true, color: COLORS.muted, charSpacing: 6 });
  cover.addText(`+${totalPot.toLocaleString()}`, { x: 0.55, y: 0.95, w: 8, h: 1.8, fontSize: 96, bold: true, color: COLORS.text });
  cover.addText(T.heroSubtitle, { x: 0.55, y: 2.75, w: 11.5, h: 0.6, fontSize: 16, color: COLORS.muted });

  // 4 KPI tiles (cream)
  const coverKpis = [
    { label: T.opportunityPages, value: allRows.length.toLocaleString() },
    { label: T.totalImpressions, value: totalImpr.toLocaleString() },
    { label: T.kpiExtraClicks || 'Estimated extra clicks', value: '+' + totalPot.toLocaleString(), accent: true },
    { label: T.quickWins,        value: totalAnalysed ? totalQuickWins.toLocaleString() : '–' }
  ];
  coverKpis.forEach((k, i) => {
    const x = 0.55 + i * 3.15;
    cover.addShape(pptx.ShapeType.roundRect, { x, y: 3.6, w: 3.0, h: 1.4, fill: { color: COLORS.panelAccent }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.14 });
    cover.addText(k.label, { x: x + 0.2, y: 3.72, w: 2.7, h: 0.32, fontSize: 11, color: COLORS.muted });
    cover.addText(k.value, { x: x + 0.2, y: 4.05, w: 2.7, h: 0.95, fontSize: 32, bold: true, color: k.accent ? COLORS.primary : COLORS.text });
  });

  // Audit / deck context — single white card spanning the bottom
  cover.addShape(pptx.ShapeType.roundRect, { x: 0.55, y: 5.25, w: 12.25, h: 1.55, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.14 });
  cover.addText(T.audit, { x: 0.85, y: 5.4, w: 5, h: 0.3, fontSize: 11, bold: true, color: COLORS.muted, charSpacing: 6 });
  cover.addText(siteUrl, { x: 0.85, y: 5.7, w: 7, h: 0.4, fontSize: 18, bold: true, color: COLORS.text });
  cover.addText(`${startDate}  →  ${endDate}`, { x: 0.85, y: 6.15, w: 7, h: 0.32, fontSize: 13, color: COLORS.muted });
  cover.addText(T.inThisDeck, { x: 8.15, y: 5.4, w: 4.5, h: 0.3, fontSize: 11, bold: true, color: COLORS.muted, charSpacing: 6 });
  cover.addText([
    { text: T.deckIntro(rows.length) + '\n', options: { color: COLORS.text, fontSize: 11 } },
    { text: T.filtersLabel(filterDesc), options: { color: COLORS.muted, fontSize: 10, italic: true } }
  ], { x: 8.15, y: 5.7, w: 4.5, h: 1.0, fontSize: 11 });

  cover.addText(T.preparedBy, { x: 0.55, y: 7.05, w: 12.25, h: 0.3, fontSize: 9, color: COLORS.muted });

  btn.textContent = 'Building deck…';

  // Executive summary opens the deck. Wrapped defensively so one bad row
  // can't break the export.
  try {
    addExecutiveSummarySlide(pptx, T, { siteUrl, startDate, endDate, allRows, rows });
  } catch (e) {
    console.error('Executive summary slide failed — skipping:', e);
  }
  // (Executive dashboard slide removed at user request — too dense to
  // render cleanly across PowerPoint viewers, and the data it carried is
  // already covered by the summary, strategy mix and top-5 slides.)

  // ── Summary slide: breakdown by band ───────────────────────────────────
  // Stats use the FULL csState.rows so all bands always show real numbers,
  // independent of the filter the user has in the tool when exporting.
  const summary = pptx.addSlide();
  summary.background = { color: COLORS.bg };
  summary.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: COLORS.primary }, line: { type: 'none' } });
  summary.addText(T.opportunitiesByBand, { x: 0.7, y: 0.35, w: 12, h: 0.6, fontSize: 26, bold: true, color: COLORS.text });
  summary.addText(T.opportunitiesByBandDesc,
    { x: 0.7, y: 0.95, w: 12, h: 0.4, fontSize: 12, color: COLORS.muted });

  const bandStats = STRATEGY_BANDS.map(band => {
    const inBand = allRows.filter(r => (r.bandIds || [r.band.id]).includes(band.id));
    const impr = inBand.reduce((s, r) => s + ((r.perBand && r.perBand[band.id] && r.perBand[band.id].impressions) || 0), 0);
    const pot = Math.round(inBand.reduce((s, r) => s + ((r.perBand && r.perBand[band.id] && r.perBand[band.id].potential) || 0), 0));
    const inDeck = rows.filter(r => (r.bandIds || [r.band.id]).includes(band.id)).length;
    return { band, pages: inBand.length, impressions: impr, potential: pot, inDeck };
  });

  // Left column: 5 compact band rows. Right column: donut chart showing the
  // % of total potential clicks per band — clients grasp distribution
  // instantly from the shape.
  bandStats.forEach((s, idx) => {
    const band = s.band;
    const y = 1.55 + idx * 1.06;
    const bc = bandColor(band);
    const bandLabel = T.band[band.id] || band.label;

    summary.addShape(pptx.ShapeType.roundRect, { x: 0.7, y, w: 7.4, h: 0.92, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.1 });
    summary.addShape(pptx.ShapeType.rect, { x: 0.7, y, w: 0.22, h: 0.92, fill: { color: bc }, line: { type: 'none' } });
    summary.addText(bandLabel, { x: 1.05, y: y + 0.08, w: 3.0, h: 0.36, fontSize: 14, bold: true, color: COLORS.text });
    summary.addText(T.positionsRange(band.min === 1.5 ? 2 : Math.ceil(band.min), Math.floor(band.max), band.target),
      { x: 1.05, y: y + 0.42, w: 3.0, h: 0.3, fontSize: 10, color: COLORS.muted });

    summary.addText(s.pages.toLocaleString(),       { x: 4.1, y: y + 0.10, w: 1.0, h: 0.45, fontSize: 18, bold: true, color: COLORS.text, align: 'center' });
    summary.addText(T.pagesLabel,                   { x: 4.1, y: y + 0.54, w: 1.0, h: 0.28, fontSize: 9,  color: COLORS.muted, align: 'center' });
    summary.addText(s.impressions.toLocaleString(), { x: 5.15, y: y + 0.10, w: 1.5, h: 0.45, fontSize: 18, bold: true, color: COLORS.text, align: 'center' });
    summary.addText(T.impressionsLabel,             { x: 5.15, y: y + 0.54, w: 1.5, h: 0.28, fontSize: 9,  color: COLORS.muted, align: 'center' });
    summary.addText('+' + s.potential.toLocaleString(), { x: 6.7, y: y + 0.10, w: 1.35, h: 0.45, fontSize: 18, bold: true, color: COLORS.primary, align: 'center' });
    summary.addText(T.extraClicksAt(band.target),       { x: 6.7, y: y + 0.54, w: 1.35, h: 0.28, fontSize: 9,  color: COLORS.muted, align: 'center' });
  });

  // Donut chart — potential clicks distribution
  const donutData = [{
    name: T.distributionByPotential,
    labels: bandStats.map(s => T.band[s.band.id] || s.band.label),
    values: bandStats.map(s => Math.max(1, s.potential))   // 1-min so empty bands still register
  }];
  const donutColors = bandStats.map(s => bandColor(s.band));
  summary.addText(T.distributionByPotential, { x: 8.3, y: 1.4, w: 4.4, h: 0.35, fontSize: 12, bold: true, color: COLORS.text, align: 'center' });
  summary.addChart(pptx.ChartType.doughnut, donutData, {
    x: 8.3, y: 1.7, w: 4.4, h: 4.6,
    chartColors: donutColors,
    showLegend: true,
    legendPos: 'b',
    legendFontSize: 10,
    legendColor: COLORS.text,
    dataLabelFontSize: 10,
    showPercent: true,
    showValue: false,
    showLabel: false,
    dataLabelColor: 'FFFFFF',
    dataLabelFontBold: true,
    holeSize: 60
  });

  summary.addText(T.siteAndDates(siteUrl, startDate, endDate), { x: 0.7, y: 7.1, w: 12, h: 0.3, fontSize: 9, color: COLORS.muted });

  // ── Strategy mix overview ─────────────────────────────────────────────
  // Three categories — Optimize / Rewrite & expand / Create landing page.
  // Each row sums up to a single recommended action; client immediately
  // sees the work split.
  const REC_TYPES = [
    { id: 'optimize',         color: '16A34A' },
    { id: 'rewrite-expand',   color: 'D97706' },
    { id: 'create-landing',   color: 'DC2626' }
  ];
  const recAgg = {};
  REC_TYPES.forEach(t => recAgg[t.id] = { pages: 0, potential: 0, samples: [] });
  for (const r of allRows) {
    const id = (r.recommendation && r.recommendation.type) || 'optimize';
    if (!recAgg[id]) continue;
    recAgg[id].pages++;
    recAgg[id].potential += r.potentialClicks;
    if (recAgg[id].samples.length < 3) recAgg[id].samples.push(r);
  }
  const mix = pptx.addSlide();
  mix.background = { color: COLORS.bg };
  mix.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: COLORS.primary }, line: { type: 'none' } });
  mix.addText(T.strategyMix, { x: 0.7, y: 0.35, w: 12, h: 0.6, fontSize: 26, bold: true, color: COLORS.text });
  mix.addText(T.strategyMixDesc,
    { x: 0.7, y: 0.95, w: 12, h: 0.4, fontSize: 12, color: COLORS.muted });

  // Top half: donut chart visualising the work split by page count.
  mix.addText(T.workSplit, { x: 0.7, y: 1.45, w: 5.5, h: 0.3, fontSize: 11, bold: true, color: COLORS.muted, charSpacing: 3 });
  const mixChartData = [{
    name: T.strategyMix,
    labels: REC_TYPES.map(t => T.rec[t.id].label),
    values: REC_TYPES.map(t => Math.max(1, recAgg[t.id].pages))
  }];
  mix.addChart(pptx.ChartType.doughnut, mixChartData, {
    x: 0.7, y: 1.75, w: 5.4, h: 3.6,
    chartColors: REC_TYPES.map(t => t.color),
    showLegend: true,
    legendPos: 'r',
    legendFontSize: 11,
    legendColor: COLORS.text,
    showPercent: true,
    showValue: false,
    showLabel: false,
    dataLabelColor: 'FFFFFF',
    dataLabelFontSize: 11,
    dataLabelFontBold: true,
    holeSize: 60
  });

  // Right half: stacked cards with examples per recommendation type.
  REC_TYPES.forEach((t, idx) => {
    const x = 6.4;
    const y = 1.45 + idx * 1.85;
    const agg = recAgg[t.id];
    const lab = T.rec[t.id];
    mix.addShape(pptx.ShapeType.roundRect, { x, y, w: 6.3, h: 1.7, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.1 });
    mix.addShape(pptx.ShapeType.rect, { x, y, w: 0.18, h: 1.7, fill: { color: '#' + t.color }, line: { type: 'none' } });
    mix.addText(lab.label, { x: x + 0.3, y: y + 0.08, w: 3.8, h: 0.35, fontSize: 14, bold: true, color: '#' + t.color });
    mix.addText(agg.pages.toLocaleString() + '  ', { x: x + 4.0, y: y + 0.08, w: 2.2, h: 0.35, fontSize: 18, bold: true, color: COLORS.text, align: 'right' });
    mix.addText(`+${Math.round(agg.potential).toLocaleString()}`, { x: x + 0.3, y: y + 0.42, w: 5.8, h: 0.3, fontSize: 11, bold: true, color: COLORS.primary });
    mix.addText(lab.desc, { x: x + 0.3, y: y + 0.72, w: 5.9, h: 0.28, fontSize: 9, color: COLORS.muted, italic: true });
    // Sample pages
    if (agg.samples.length) {
      const examples = agg.samples.slice(0, 2).map(sr =>
        `${trunc(sr.page.replace(/^https?:\/\//, ''), 38)}  ·  "${trunc(sr.bestQuery || '', 26)}"  →  +${Math.round(sr.potentialClicks).toLocaleString()}`
      ).join('\n');
      mix.addText(examples, { x: x + 0.3, y: y + 1.05, w: 5.9, h: 0.62, fontSize: 9, color: COLORS.text });
    }
  });

  mix.addText(T.siteAndDates(siteUrl, startDate, endDate), { x: 0.7, y: 7.1, w: 12, h: 0.3, fontSize: 9, color: COLORS.muted });

  // ── Top opportunities ─────────────────────────────────────────────────
  // A separate "punch list" slide of the 5 highest-impact rows so the
  // client sees the headline actions before drilling into details.
  const topRows = rows.slice(0, 5);
  if (topRows.length) {
    const tw = pptx.addSlide();
    tw.background = { color: COLORS.bg };
    tw.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: COLORS.primary }, line: { type: 'none' } });
    tw.addText(T.topOpportunitiesTitle, { x: 0.7, y: 0.35, w: 12, h: 0.6, fontSize: 26, bold: true, color: COLORS.text });
    tw.addText(T.topOpportunitiesDesc,
      { x: 0.7, y: 0.95, w: 12, h: 0.4, fontSize: 12, color: COLORS.muted });

    topRows.forEach((r, idx) => {
      const y = 1.6 + idx * 1.05;
      const bc = bandColor(r.band);
      tw.addShape(pptx.ShapeType.roundRect, { x: 0.7, y, w: 12.0, h: 0.95, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.12 });
      tw.addShape(pptx.ShapeType.rect, { x: 0.7, y, w: 0.22, h: 0.95, fill: { color: bc }, line: { type: 'none' } });

      // Rank circle
      tw.addShape(pptx.ShapeType.ellipse, { x: 1.05, y: y + 0.2, w: 0.55, h: 0.55, fill: { color: bc }, line: { type: 'none' } });
      tw.addText(String(idx + 1), { x: 1.05, y: y + 0.2, w: 0.55, h: 0.55, fontSize: 18, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' });

      // URL + best query
      tw.addText(trunc(r.page, 75), { x: 1.75, y: y + 0.1, w: 7.5, h: 0.4, fontSize: 13, bold: true, color: COLORS.primaryDark, hyperlink: { url: r.page } });
      const bestLine = r.bestQuery
        ? `${T.bestQueryShort(r.bestQueryPosition)} · "${r.bestQuery}" · ${r.bestQueryImpressions.toLocaleString()} ${T.impressionsLabel}`
        : '';
      tw.addText(bestLine, { x: 1.75, y: y + 0.5, w: 7.5, h: 0.4, fontSize: 11, color: COLORS.muted });

      // Potential clicks big
      tw.addText('+' + Math.round(r.potentialClicks).toLocaleString(), { x: 9.5, y: y + 0.12, w: 1.8, h: 0.55, fontSize: 24, bold: true, color: COLORS.primary, align: 'right' });
      tw.addText(`@ #${r.targetPos}`, { x: 9.5, y: y + 0.62, w: 1.8, h: 0.3, fontSize: 10, color: COLORS.muted, align: 'right' });

      tw.addShape(pptx.ShapeType.roundRect, { x: 11.45, y: y + 0.3, w: 1.15, h: 0.35, fill: { color: bc }, line: { type: 'none' }, rectRadius: 0.18 });
      tw.addText(T.band[r.band.id] || r.band.label, { x: 11.45, y: y + 0.3, w: 1.15, h: 0.35, fontSize: 10, color: 'FFFFFF', bold: true, align: 'center' });
    });

    tw.addText(T.siteAndDates(siteUrl, startDate, endDate), { x: 0.7, y: 7.1, w: 12, h: 0.3, fontSize: 9, color: COLORS.muted });
  }

  // ── Per-opportunity slides ─────────────────────────────────────────────
  const priorityColor = (p) => p === 'critical' ? COLORS.danger : (p === 'important' ? COLORS.warning : COLORS.primary);
  const priorityLabel = (p) => p === 'critical' ? 'Critical' : (p === 'important' ? 'Important' : 'Recommended');

  // Cap per-opportunity slides at the top 15 by potential. The remaining
  // rows go into a compact appendix table at the back — this keeps the
  // deck under ~25 slides instead of one-per-page (which produced 100+
  // slide decks that no client read past slide 10).
  // Render every opportunity as its own slide. The user wants full
  // content strategy on every URL, not a summary table for the long
  // tail. PPT generation is slower than HTML (each slide is built
  // explicitly) so very large decks may take a minute or two, but the
  // progress strip on the button shows live counts.
  const detailRows = rows;
  const appendixRows = [];

  for (let idx = 0; idx < detailRows.length; idx++) {
    if (idx % 5 === 0) {
      btn.textContent = `Building slide ${idx + 1} / ${detailRows.length}…`;
      await new Promise(res => setTimeout(res, 0));   // yield to the UI
    }
    const r = detailRows[idx];
    try {
    const s = pptx.addSlide();
    s.background = { color: COLORS.bg };
    const bc = bandColor(r.band);
    const cov = r.coverage && Array.isArray(r.coverage.queries) ? r.coverage : null;

    // Slim accent stripe + cream header band (template-friendly, no dark bar).
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.10, fill: { color: bc }, line: { type: 'none' } });
    s.addText(T.opportunityHeader(idx + 1, rows.length),
      { x: 0.6, y: 0.22, w: 4, h: 0.30, fontSize: 11, color: COLORS.muted, bold: true, charSpacing: 4 });
    s.addShape(pptx.ShapeType.roundRect, { x: 4.6, y: 0.22, w: 2.0, h: 0.30, fill: { color: bc }, line: { type: 'none' }, rectRadius: 0.15 });
    s.addText(T.band[r.band.id] || r.band.label, { x: 4.6, y: 0.22, w: 2.0, h: 0.30, fontSize: 10, color: 'FFFFFF', bold: true, align: 'center' });
    s.addText(`${T.bestQueryShort(r.bestQueryPosition)}  ·  ${T.targetShort(r.targetPos)}`,
      { x: 6.7, y: 0.22, w: 4.7, h: 0.30, fontSize: 11, color: COLORS.muted });
    if (r.isQuickWin) {
      s.addShape(pptx.ShapeType.roundRect, { x: 11.55, y: 0.22, w: 1.55, h: 0.30, fill: { color: COLORS.success }, line: { type: 'none' }, rectRadius: 0.15 });
      s.addText('⚡ ' + T.quickWinBadge, { x: 11.55, y: 0.22, w: 1.55, h: 0.30, fontSize: 10, color: 'FFFFFF', bold: true, align: 'center' });
    }

    // URL + page title. Gap between rows so the boxes never overlap.
    const truncatedUrl = trunc(r.page, 105);
    s.addText(truncatedUrl, { x: 0.6, y: 0.74, w: 12.1, h: 0.36, fontSize: 15, bold: true, color: COLORS.primaryDark, hyperlink: { url: r.page } });
    const pageTitle = (cov && cov.title) || (r.crawl && r.crawl.title) || '';
    if (pageTitle) {
      s.addText(pageTitle, { x: 0.6, y: 1.12, w: 12.1, h: 0.26, fontSize: 11, color: COLORS.muted, italic: true });
    }

    // ── Strategic recommendation banner — headline of every slide.
    const rec = r.recommendation;
    if (rec) {
      const recColor = '#' + rec.color;
      const tint = rec.type === 'optimize'       ? 'E8F7EE'
                 : rec.type === 'rewrite-expand' ? 'FEF1E3'
                 :                                  'FCE9E9';
      const recLabel  = (T.rec[rec.type] && T.rec[rec.type].label)  || rec.label;
      const recReason = (T.rec[rec.type] && T.rec[rec.type].reason) || rec.reason;
      s.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 1.52, w: 12.13, h: 0.95, fill: { color: tint }, line: { color: recColor, width: 1 }, rectRadius: 0.12 });
      s.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.52, w: 0.18, h: 0.95, fill: { color: recColor }, line: { type: 'none' } });
      s.addText(T.strategy, { x: 0.92, y: 1.58, w: 1.6, h: 0.25, fontSize: 9, bold: true, color: recColor, charSpacing: 4 });
      s.addText(recLabel, { x: 0.92, y: 1.82, w: 5.5, h: 0.4, fontSize: 17, bold: true, color: recColor });
      s.addText(recReason, { x: 6.5, y: 1.62, w: 6.3, h: 0.6, fontSize: 10, color: COLORS.text });
      if (rec.type === 'create-landing' && rec.suggestedUrl) {
        s.addShape(pptx.ShapeType.rect, { x: 6.5, y: 2.18, w: 6.13, h: 0.25, fill: { color: 'FFFFFF' }, line: { color: COLORS.border, width: 0.5 } });
        s.addText([
          { text: T.suggestedUrl + '  ', options: { color: COLORS.muted, fontSize: 9, bold: true } },
          { text: trunc(rec.suggestedUrl, 78), options: { color: recColor, fontSize: 10, bold: true } }
        ], { x: 6.6, y: 2.19, w: 5.9, h: 0.23 });
      }
    }

    // Metric tiles. Sub-label tells the reader WHICH queries the number
    // aggregates — three of the tiles are totals across every query this
    // page ranks for, the fourth (potential) is for the best query only.
    const queriesCount = Array.isArray(r.topQueries) ? r.topQueries.length : 0;
    const metrics = [
      { label: T.impressions, value: r.impressions.toLocaleString(),  sub: T.tileScopeAll ? T.tileScopeAll(queriesCount) : `across ${queriesCount} queries`,         color: COLORS.text },
      { label: T.clicks,      value: r.clicks.toLocaleString(),       sub: T.tileScopeAll ? T.tileScopeAll(queriesCount) : `across ${queriesCount} queries`,         color: COLORS.text },
      { label: T.ctr,         value: (r.ctr * 100).toFixed(2) + '%',  sub: T.tileScopeOverall || 'page-level average',                                              color: COLORS.text },
      { label: T.potentialAtRank(r.targetPos), value: '+' + Math.round(r.potentialClicks).toLocaleString(),
        sub: T.tileScopeBest ? T.tileScopeBest(r.bestQuery) : `if "${r.bestQuery}" hits target`, color: COLORS.primary, accent: true }
    ];
    metrics.forEach((m, i) => {
      const x = 0.6 + i * 3.15;
      s.addShape(pptx.ShapeType.roundRect, { x, y: 2.55, w: 2.95, h: 0.85, fill: { color: m.accent ? COLORS.panelAccent : COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.1 });
      s.addText(m.label, { x: x + 0.15, y: 2.58, w: 2.7, h: 0.20, fontSize: 9, color: COLORS.muted, bold: true });
      s.addText(m.value, { x: x + 0.15, y: 2.76, w: 2.7, h: 0.34, fontSize: 18, bold: true, color: m.color });
      s.addText(m.sub, { x: x + 0.15, y: 3.12, w: 2.7, h: 0.26, fontSize: 8, color: COLORS.muted, italic: true, shrinkText: true });
    });

    // ── Left column: CURRENT PAGE
    s.addShape(pptx.ShapeType.roundRect, { x: 0.6, y: 3.48, w: 6.1, h: 3.60, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.1 });
    s.addText(T.currentPage, { x: 0.78, y: 3.55, w: 5.9, h: 0.3, fontSize: 12, bold: true, color: COLORS.text });

    // TITLE — distinguish three cases: analysed-and-present (green/amber
    // by length), analysed-and-absent (red "missing"), and not-analysed
    // (muted "(not analysed)"). The previous version conflated the last
    // two and falsely reported "missing" for pages we hadn't fetched.
    let liveTitle = '';
    let titleLen = 0;
    let titleStatus = 'unknown';   // 'present' | 'missing' | 'unknown'
    if (cov) {
      liveTitle = cov.title || '';
      titleLen = liveTitle.length;
      titleStatus = titleLen > 0 ? 'present' : 'missing';
    } else if (r.crawl && r.crawl.title) {
      liveTitle = r.crawl.title;
      titleLen = r.crawl.titleLength || liveTitle.length;
      titleStatus = 'present';
    }
    const titleLenColor = titleStatus === 'present'
      ? ((titleLen >= 30 && titleLen <= 60) ? COLORS.success : COLORS.warning)
      : (titleStatus === 'missing' ? COLORS.danger : COLORS.muted);
    const titleLenLabel = titleStatus === 'present' ? `${titleLen}ch`
                       : (titleStatus === 'missing' ? T.titleMissingLabel : T.notAnalysedShort);
    s.addText([
      { text: T.title, options: { fontSize: 9, color: COLORS.muted, bold: true } },
      { text: `  ${titleLenLabel}`, options: { fontSize: 9, color: titleLenColor, bold: true } }
    ], { x: 0.78, y: 3.85, w: 5.9, h: 0.22 });
    const titleBody = liveTitle
      ? liveTitle
      : (titleStatus === 'missing' ? T.noTitleTag : T.notAnalysedHint);
    s.addText(titleBody, { x: 0.78, y: 4.03, w: 5.9, h: 0.30, fontSize: 10,
      color: liveTitle ? COLORS.text : (titleStatus === 'missing' ? COLORS.danger : COLORS.muted),
      italic: !liveTitle });

    // META DESCRIPTION — same three-state logic.
    let metaText = '';
    let metaLen = 0;
    let metaStatus = 'unknown';
    if (cov) {
      metaText = cov.metaDescription || '';
      metaLen = cov.metaDescriptionLength || 0;
      metaStatus = metaLen > 0 ? 'present' : 'missing';
    }
    const metaLenColor = metaStatus === 'present'
      ? (metaLen >= 70 && metaLen <= 160 ? COLORS.success : COLORS.warning)
      : (metaStatus === 'missing' ? COLORS.danger : COLORS.muted);
    const metaLenLabel = metaStatus === 'present' ? `${metaLen}ch`
                     : (metaStatus === 'missing' ? T.titleMissingLabel : T.notAnalysedShort);
    s.addText([
      { text: T.metaDescription, options: { fontSize: 9, color: COLORS.muted, bold: true } },
      { text: `  ${metaLenLabel}`, options: { fontSize: 9, color: metaLenColor, bold: true } }
    ], { x: 0.78, y: 4.40, w: 5.9, h: 0.22 });
    const metaBody = metaText
      ? metaText
      : (metaStatus === 'missing' ? T.noMetaDesc : T.notAnalysedHint);
    s.addText(metaBody, { x: 0.78, y: 4.58, w: 5.9, h: 0.55, fontSize: 10,
      color: metaText ? COLORS.text : (metaStatus === 'missing' ? COLORS.danger : COLORS.muted),
      italic: !metaText });

    // H1 — same three-state logic.
    let liveH1 = '';
    let h1Count = 0;
    let h1Status = 'unknown';
    if (cov) {
      liveH1 = (cov.h1 && cov.h1[0]) || '';
      h1Count = cov.h1 ? cov.h1.length : 0;
      h1Status = h1Count > 0 ? 'present' : 'missing';
    } else if (r.crawl && typeof r.crawl.h1Count === 'number') {
      h1Count = r.crawl.h1Count;
      h1Status = h1Count > 0 ? 'present' : 'missing';
    }
    const h1Color = h1Status === 'present'
      ? (h1Count === 1 ? COLORS.success : COLORS.warning)
      : (h1Status === 'missing' ? COLORS.danger : COLORS.muted);
    const h1Label = h1Status === 'present' ? T.h1Count(h1Count)
                : (h1Status === 'missing' ? T.noH1Label : T.notAnalysedShort);
    s.addText([
      { text: T.h1Label, options: { fontSize: 9, color: COLORS.muted, bold: true } },
      { text: `  ${h1Label}`, options: { fontSize: 9, color: h1Color, bold: true } }
    ], { x: 0.78, y: 5.20, w: 5.9, h: 0.22 });
    const h1Body = liveH1
      ? liveH1
      : (h1Status === 'missing' ? T.noH1 : T.notAnalysedHint);
    s.addText(h1Body, { x: 0.78, y: 5.38, w: 5.9, h: 0.32, fontSize: 10,
      color: liveH1 ? COLORS.text : (h1Status === 'missing' ? COLORS.danger : COLORS.muted),
      italic: !liveH1 });

    // Replace the abstract 0/27 tiles with named "keywords to add" rows.
    // Pulls the top-impressions queries that are NOT yet in each section
    // and lists them by name. That's what the eye actually needs.
    if (cov) {
      const queriesByImpr = (q) => {
        const t = (r.topQueries || []).find(x => x.query === q.query);
        return t ? t.impressions : 0;
      };
      // Filter out brand-only queries this page didn't win so the per-
      // section "direct fixes" don't recommend the brand on an inner
      // page. See r.offLimitsQueries in runStrategyQuery's survivors loop.
      const offLimits = r.offLimitsQueries || new Set();
      const sorted = cov.queries
        .filter(q => !offLimits.has(q.query))
        .sort((a, b) => queriesByImpr(b) - queriesByImpr(a));
      const missingForSection = (predicate) => sorted.filter(predicate).slice(0, 3).map(q => q.query);

      const sections = [
        { label: T.secLabel.title, keys: missingForSection(q => !q.phrase.inTitle) },
        { label: T.secLabel.meta,  keys: missingForSection(q => !q.phrase.inMetaDescription) },
        { label: T.secLabel.h1,    keys: missingForSection(q => !q.phrase.inH1) },
        { label: T.secLabel.h2,    keys: missingForSection(q => !q.phrase.inH2) },
        { label: T.secLabel.h3,    keys: missingForSection(q => !q.phrase.inH3) },
        { label: T.secLabel.body,  keys: missingForSection(q => q.phrase.bodyOccurrences === 0) }
      ];

      s.addText(T.keywordsToAddHint,
        { x: 0.78, y: 5.66, w: 5.9, h: 0.20, fontSize: 9, color: COLORS.muted, italic: true });

      // Compressed rows (rowH 0.20, fontSize 9) so all 6 sections fit
      // inside the Page actuelle card without overflowing the footer.
      sections.forEach((sec, i) => {
        const sy = 5.88 + i * 0.20;
        const list = sec.keys.length ? sec.keys.map(k => trunc(k, 18)).join(' · ') : T.allOnPage;
        s.addText([
          { text: sec.label + '  ',
            options: { color: sec.keys.length ? COLORS.danger : COLORS.success, bold: true, fontSize: 9 } },
          { text: list, options: { color: COLORS.text, fontSize: 9 } }
        ], { x: 0.78, y: sy, w: 5.9, h: 0.20 });
      });
    } else {
      s.addText(T.runAnalysisHint,
        { x: 0.78, y: 5.8, w: 5.9, h: 0.45, fontSize: 10, color: COLORS.muted, italic: true });
    }

    // ── Right column: ACTION ITEMS (priority-coded) — top half
    s.addShape(pptx.ShapeType.roundRect, { x: 6.85, y: 3.48, w: 5.88, h: 1.65, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.1 });
    s.addText(T.actionItems, { x: 7.03, y: 3.55, w: 5.6, h: 0.28, fontSize: 11, bold: true, color: COLORS.text });
    const actions = deriveActions(r, lang);
    const actionLines = actions.slice(0, 4).map(a => ({
      text: `[${T.priority[a.priority]}] ${a.text}`,
      options: { color: priorityColor(a.priority), bullet: { code: '25CF' }, breakLine: true, bold: a.priority === 'critical' }
    }));
    s.addText(actionLines, { x: 7.03, y: 3.84, w: 5.6, h: 1.25, fontSize: 9, paraSpaceAfter: 3, color: COLORS.text });

    // ── Right column: TOP RANKING QUERIES TABLE — bottom half (replaces
    //   the second slide we used to generate; client gets the data inline.)
    // Top queries for the PPT table: sort by impressions desc so the
    // table reads "volume-first", regardless of how csState ordered them
    // for the in-app drill-down (which sorts by potential clicks).
    const topQ = Array.isArray(r.topQueries)
      ? r.topQueries.slice().sort((a, b) => (b.impressions || 0) - (a.impressions || 0)).slice(0, 6)
      : [];
    const coverageByQuery = {};
    if (cov) for (const q of cov.queries) coverageByQuery[q.query] = q;

    if (topQ.length) {
      // Tiny header with missing-count callout to preserve the signal we used to
      // dedicate a red panel to.
      let missingCount = 0, missingImpr = 0;
      if (cov) {
        const missing = cov.queries.filter(q => !q.presentSomewhere);
        missingCount = missing.length;
        missingImpr = missing.reduce((sum, q) => {
          const t = (r.topQueries || []).find(x => x.query === q.query);
          return sum + (t ? t.impressions : 0);
        }, 0);
      }
      // Header line for the queries table — names the table and warns
      // about the top-N truncation so the audience knows what they're
      // looking at.
      // Two-line header so the missing-count + sub-note never overflow.
      const totalRanking = Array.isArray(r.topQueries) ? r.topQueries.length : 0;
      const shownCount = Math.min(6, topQ.length);
      s.addText([
        { text: T.topRankingQueries, options: { bold: true, color: COLORS.text } },
        { text: totalRanking > shownCount ? `   ${T.matrixTopNote(shownCount, totalRanking)}` : '',
          options: { color: COLORS.muted, italic: true } }
      ], { x: 7.03, y: 5.10, w: 5.6, h: 0.22, fontSize: 10 });
      s.addText(
        missingCount ? T.missingOnPage(missingCount, missingImpr) : (cov ? T.allCovered : ''),
        { x: 7.03, y: 5.32, w: 5.6, h: 0.20, fontSize: 9, color: missingCount ? COLORS.danger : COLORS.muted, italic: !missingCount }
      );

      const headerStyle = { bold: true, fill: { color: COLORS.panelAccent }, color: COLORS.text, fontSize: 9 };
      const tHeader = [
        { text: T.query,         options: headerStyle },
        { text: T.impr,          options: { ...headerStyle, align: 'right' } },
        { text: T.pos,           options: { ...headerStyle, align: 'right' } },
        { text: T.inPage,        options: headerStyle }
      ];
      const tRows = topQ.map(q => {
        const c = coverageByQuery[q.query];
        let where, whereColor = COLORS.muted, whereBold = false;
        if (!c) {
          where = T.notAnalysedShort;
          whereBold = true;
        } else if (!c.presentSomewhere) {
          where = (T.titleMissingLabel || 'missing').toUpperCase();
          whereColor = COLORS.danger;
          whereBold = true;
        } else {
          const parts = [];
          if (c.phrase.inTitle) parts.push('title');
          if (c.phrase.inMetaDescription) parts.push('desc');
          if (c.phrase.inH1) parts.push('H1');
          if (c.phrase.inHeadings) parts.push('Hn');
          if (c.phrase.bodyOccurrences > 0) parts.push(`body ${c.phrase.bodyOccurrences}×`);
          if (parts.length) {
            where = parts.join(' · ');
            whereColor = COLORS.success;
          } else if (c.looseMatch && c.looseMatch.bodyAllWords) {
            // All words present individually in the body but not as the
            // exact phrase. The previous version left this cell empty.
            where = (T.wordsOnly || 'words only');
            whereColor = COLORS.warning;
            whereBold = true;
          } else {
            where = (T.titleMissingLabel || 'missing').toUpperCase();
            whereColor = COLORS.danger;
            whereBold = true;
          }
        }
        return [
          { text: trunc(q.query, 40), options: { fontSize: 9 } },
          { text: q.impressions.toLocaleString(), options: { fontSize: 9, align: 'right' } },
          { text: q.position.toFixed(1), options: { fontSize: 9, align: 'right' } },
          { text: where, options: { fontSize: 9, color: whereColor, bold: whereBold } }
        ];
      });
      s.addTable([tHeader, ...tRows], {
        x: 6.85, y: 5.55, w: 5.88, colW: [2.6, 0.9, 0.6, 1.78],
        fontFace: 'Calibri', color: COLORS.text,
        border: { type: 'solid', color: COLORS.border, pt: 0.4 },
        rowH: 0.21
      });
    } else {
      s.addShape(pptx.ShapeType.roundRect, { x: 6.85, y: 5.20, w: 5.88, h: 1.75, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.1 });
      s.addText(T.missingNotRun, { x: 7.03, y: 5.9, w: 5.6, h: 0.4, fontSize: 10, color: COLORS.muted, italic: true, align: 'center' });
    }

    s.addText(T.siteAndDates(siteUrl, startDate, endDate), { x: 0.6, y: 7.12, w: 12.1, h: 0.3, fontSize: 9, color: COLORS.muted });
    } catch (e) {
      console.error(`Opportunity slide ${idx + 1} failed — skipping:`, e, detailRows[idx] && detailRows[idx].page);
    }
  }

  // ── Appendix: compact table for opportunities #16+ ───────────────────
  // The remaining opportunities (everything beyond the top 15 detail
  // slides) are listed in a paginated table — clients keep the full list
  // but the deck stops being a 100-slide marathon.
  if (appendixRows.length) {
    const PER_PAGE = 22;
    const pageCount = Math.ceil(appendixRows.length / PER_PAGE);
    for (let p = 0; p < pageCount; p++) {
      const slice = appendixRows.slice(p * PER_PAGE, (p + 1) * PER_PAGE);
      const a = pptx.addSlide();
      a.background = { color: COLORS.bg };
      a.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: COLORS.primary }, line: { type: 'none' } });
      const titleTxt = T.appendixTitle ? T.appendixTitle() : 'All other opportunities';
      const subTxt = T.appendixSubtitle
        ? T.appendixSubtitle(MAX_DETAIL_SLIDES + 1, MAX_DETAIL_SLIDES + appendixRows.length, p + 1, pageCount)
        : `Opportunities ${MAX_DETAIL_SLIDES + 1}–${MAX_DETAIL_SLIDES + appendixRows.length} of ${MAX_DETAIL_SLIDES + appendixRows.length} · page ${p + 1} / ${pageCount}`;
      a.addText(titleTxt, { x: 0.7, y: 0.35, w: 12, h: 0.5, fontSize: 24, bold: true, color: COLORS.text });
      a.addText(subTxt, { x: 0.7, y: 0.88, w: 12, h: 0.32, fontSize: 11, color: COLORS.muted });

      // Header row
      const headerLabels = T.appendixCols || ['#', 'Page', 'Band', 'Pos', 'Impr', 'Best query', 'Potential'];
      const colW = [0.55, 5.2, 1.55, 0.7, 1.0, 2.8, 1.1];
      const colX = colW.reduce((acc, w, i) => { acc.push(i === 0 ? 0.7 : acc[i - 1] + colW[i - 1]); return acc; }, []);
      const headerY = 1.35;
      a.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: headerY, w: 12.13, h: 0.36, fill: { color: COLORS.panelAccent }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.06 });
      headerLabels.forEach((label, i) => {
        const align = i === 0 || i === 3 || i === 4 || i === 6 ? 'center' : 'left';
        a.addText(label, { x: colX[i] + 0.06, y: headerY + 0.05, w: colW[i] - 0.12, h: 0.26, fontSize: 10, bold: true, color: COLORS.muted, charSpacing: 2, align });
      });

      const rowH = 0.245;
      slice.forEach((r, i) => {
        const y = headerY + 0.42 + i * rowH;
        const bc = bandColor(r.band);
        const rank = MAX_DETAIL_SLIDES + p * PER_PAGE + i + 1;
        // Subtle zebra: even rows tinted, odd left white.
        if (i % 2 === 0) {
          a.addShape(pptx.ShapeType.rect, { x: 0.7, y: y - 0.02, w: 12.13, h: rowH, fill: { color: 'FFFFFF' }, line: { type: 'none' } });
        }
        // Band stripe on the left edge of the row.
        a.addShape(pptx.ShapeType.rect, { x: 0.7, y: y - 0.02, w: 0.08, h: rowH, fill: { color: bc }, line: { type: 'none' } });

        a.addText(String(rank), { x: colX[0] + 0.06, y, w: colW[0] - 0.12, h: rowH - 0.04, fontSize: 10, color: COLORS.muted, align: 'center' });
        a.addText(trunc(r.page.replace(/^https?:\/\//, ''), 78), { x: colX[1] + 0.06, y, w: colW[1] - 0.12, h: rowH - 0.04, fontSize: 9, color: COLORS.text, hyperlink: { url: r.page } });
        a.addText(T.band[r.band.id] || r.band.label, { x: colX[2] + 0.06, y, w: colW[2] - 0.12, h: rowH - 0.04, fontSize: 9, color: bc, bold: true });
        a.addText(r.bestQueryPosition.toFixed(1), { x: colX[3] + 0.06, y, w: colW[3] - 0.12, h: rowH - 0.04, fontSize: 9, color: COLORS.text, align: 'center' });
        a.addText(r.impressions.toLocaleString(), { x: colX[4] + 0.06, y, w: colW[4] - 0.12, h: rowH - 0.04, fontSize: 9, color: COLORS.text, align: 'center' });
        a.addText(trunc(r.bestQuery || '', 36), { x: colX[5] + 0.06, y, w: colW[5] - 0.12, h: rowH - 0.04, fontSize: 9, italic: true, color: COLORS.muted });
        a.addText('+' + Math.round(r.potentialClicks).toLocaleString(), { x: colX[6] + 0.06, y, w: colW[6] - 0.12, h: rowH - 0.04, fontSize: 10, bold: true, color: COLORS.primary, align: 'center' });
      });

      a.addText(T.siteAndDates(siteUrl, startDate, endDate), { x: 0.7, y: 7.1, w: 12, h: 0.3, fontSize: 9, color: COLORS.muted });
    }
  }

  // ── Closing methodology slide ────────────────────────────────────────
  const m = pptx.addSlide();
  m.background = { color: COLORS.bg };
  m.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: COLORS.primary }, line: { type: 'none' } });
  m.addText(T.methodologyTitle, { x: 0.7, y: 0.4, w: 12, h: 0.6, fontSize: 24, bold: true, color: COLORS.text });
  m.addText(T.methodologyDesc,
    { x: 0.7, y: 1.0, w: 12, h: 0.4, fontSize: 12, color: COLORS.muted });

  m.addText(T.opportunityBandsHeader, { x: 0.7, y: 1.6, w: 12, h: 0.3, fontSize: 11, bold: true, color: COLORS.muted, charSpacing: 4 });
  STRATEGY_BANDS.forEach((b, i) => {
    const x = 0.7 + (i % 3) * 4.15;
    const y = 1.95 + Math.floor(i / 3) * 0.85;
    const bc = bandColor(b);
    m.addShape(pptx.ShapeType.roundRect, { x, y, w: 4.0, h: 0.75, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 }, rectRadius: 0.1 });
    m.addShape(pptx.ShapeType.rect, { x, y, w: 0.18, h: 0.75, fill: { color: bc }, line: { type: 'none' } });
    m.addText(T.band[b.id] || b.label, { x: x + 0.3, y: y + 0.07, w: 3.6, h: 0.28, fontSize: 12, bold: true, color: COLORS.text });
    m.addText(T.positionsRange(b.min === 1.5 ? 2 : Math.ceil(b.min), Math.floor(b.max), b.target),
      { x: x + 0.3, y: y + 0.36, w: 3.6, h: 0.32, fontSize: 10, color: COLORS.muted });
  });

  m.addText(T.ctrCurveHeader, { x: 0.7, y: 4.0, w: 12, h: 0.3, fontSize: 11, bold: true, color: COLORS.muted, charSpacing: 4 });
  const ctrSamples = [1, 2, 3, 4, 5, 7, 10, 15, 25].map(p => ({ p, ctr: ctrAtPosition(p) }));
  const ctrMax = Math.max(...ctrSamples.map(s => s.ctr));
  const ctrChartX = 0.7, ctrChartY = 4.4, ctrChartW = 12.0, ctrChartH = 1.4;
  m.addShape(pptx.ShapeType.rect, { x: ctrChartX, y: ctrChartY, w: ctrChartW, h: ctrChartH, fill: { color: COLORS.panelBg }, line: { color: COLORS.border, width: 0.5 } });
  const barW = (ctrChartW - 0.4) / ctrSamples.length;
  ctrSamples.forEach((s, i) => {
    const h = (s.ctr / ctrMax) * (ctrChartH - 0.5);
    const x = ctrChartX + 0.2 + i * barW;
    const y = ctrChartY + ctrChartH - 0.35 - h;
    m.addShape(pptx.ShapeType.rect, { x: x + 0.1, y, w: barW - 0.2, h, fill: { color: COLORS.primary }, line: { type: 'none' } });
    m.addText((s.ctr * 100).toFixed(1) + '%', { x, y: y - 0.3, w: barW, h: 0.28, fontSize: 9, color: COLORS.text, align: 'center', bold: true });
    m.addText('#' + s.p, { x, y: ctrChartY + ctrChartH - 0.3, w: barW, h: 0.25, fontSize: 10, color: COLORS.muted, align: 'center', bold: true });
  });

  // Bottom row: two side-by-side panels — left is the "In page?" legend so
  // the client can decode every row in the queries tables; right is the
  // potential-clicks computation explainer.
  m.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 6.0, w: 5.85, h: 1.0, fill: { color: COLORS.panelAccent }, line: { type: 'none' }, rectRadius: 0.1 });
  m.addText('"In page?" legend', { x: 0.9, y: 6.08, w: 5.55, h: 0.30, fontSize: 11, bold: true, color: COLORS.primaryDark });
  const inPageLegend = [
    { text: '  title · H1 · body 4×  ', options: { fontSize: 10, color: COLORS.success, bold: true, fill: { color: 'E6F4EE' } } },
    { text: '    exact phrase found in those sections.', options: { fontSize: 10, color: COLORS.text, breakLine: true } },
    { text: '  words only  ',  options: { fontSize: 10, color: COLORS.warning, bold: true, fill: { color: 'FDEEDA' } } },
    { text: '    the query\'s words appear separately in the page, but never as a contiguous phrase.', options: { fontSize: 10, color: COLORS.text, breakLine: true } },
    { text: '  MISSING  ', options: { fontSize: 10, color: COLORS.danger, bold: true, fill: { color: 'FDE7E7' } } },
    { text: '    neither the phrase nor all its words are present — write content for it.', options: { fontSize: 10, color: COLORS.text } }
  ];
  m.addText(inPageLegend, { x: 0.9, y: 6.36, w: 5.55, h: 0.6, fontSize: 10, paraSpaceAfter: 2 });

  m.addShape(pptx.ShapeType.roundRect, { x: 6.85, y: 6.0, w: 5.85, h: 1.0, fill: { color: COLORS.panelAccent }, line: { type: 'none' }, rectRadius: 0.1 });
  m.addText(T.potentialHowTitle, { x: 7.05, y: 6.08, w: 5.55, h: 0.30, fontSize: 11, bold: true, color: COLORS.primaryDark });
  m.addText(T.potentialHowDesc,
    { x: 7.05, y: 6.36, w: 5.55, h: 0.6, fontSize: 10, color: COLORS.text });

  m.addText(`${T.siteAndDates(siteUrl, startDate, endDate)}  ·  ${T.preparedBy.replace(/\s+·\s+seo\.converta\.ro$/, '')}`, { x: 0.7, y: 7.1, w: 12, h: 0.3, fontSize: 9, color: COLORS.muted });

  const safe = siteUrl.replace(/[^a-z0-9]/gi, '_');
  btn.textContent = 'Saving file…';
  try {
    await pptx.writeFile({ fileName: `content-strategy_${safe}_${startDate}_${endDate}.pptx` });
  } catch (e) {
    console.error('PPT writeFile failed:', e);
    alert('Could not save the PPT file: ' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false; btn.textContent = originalLabel;
  }
}

// Generates a printable HTML report and opens it in a new tab. Users save
// it as PDF via their browser's Print → "Save as PDF" dialog. No new
// library dependency — the report is self-contained CSS + HTML tuned for
// A4 / Letter portrait printing.
function exportStrategyPdf() {
  if (!csState.rows.length) { alert('Run a query first.'); return; }
  const lang = (document.getElementById('csExportLang') || {}).value || 'en';
  const T = tFor(lang);
  const bands = activeBandIds();
  const textFilter = (document.getElementById('csTextFilter').value || '').toLowerCase();
  const quickWinsOnly = !!document.getElementById('csQuickWins')?.checked;
  const rows = csState.rows.filter(r =>
    (r.bandIds || [r.band.id]).some(id => bands.has(id)) &&
    (!textFilter || r.page.toLowerCase().includes(textFilter)) &&
    (!quickWinsOnly || r.isQuickWin === true)
  );
  if (!rows.length) { alert('No opportunities match the current filters.'); return; }

  const siteUrl = document.getElementById('csSite').value || 'site';
  const startDate = document.getElementById('csStart').value;
  const endDate = document.getElementById('csEnd').value;

  const allRows = csState.rows;
  const totalImpr = allRows.reduce((s, r) => s + r.impressions, 0);
  const totalClicks = allRows.reduce((s, r) => s + r.clicks, 0);
  const totalPot = Math.round(allRows.reduce((s, r) => s + r.potentialClicks, 0));
  const totalQuickWins = allRows.filter(r => r.isQuickWin === true).length;

  const recAgg = { optimize: { pages: 0, potential: 0 }, 'rewrite-expand': { pages: 0, potential: 0 }, 'create-landing': { pages: 0, potential: 0 } };
  for (const r of allRows) {
    const t = (r.recommendation && r.recommendation.type) || 'optimize';
    if (!recAgg[t]) continue;
    recAgg[t].pages++;
    recAgg[t].potential += r.potentialClicks;
  }
  const recColors = { optimize: '#16A34A', 'rewrite-expand': '#D97706', 'create-landing': '#DC2626' };

  const strikingPot = Math.round(allRows.reduce((sum, r) => {
    const slot = r.perBand && r.perBand.striking;
    return sum + ((slot && slot.potential) || 0);
  }, 0));
  const strikingPages = allRows.filter(r => (r.bandIds || [r.band.id]).includes('striking')).length;
  const strikingShare = totalPot > 0 ? Math.round((strikingPot / totalPot) * 100) : 0;
  const insight = T.execKeyInsight
    ? T.execKeyInsight({ strikingPages, strikingPot, strikingShare, totalPages: allRows.length, quickWins: totalQuickWins })
    : '';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Render every opportunity in full detail in the PDF — the user
  // explicitly wants content strategy on every page, not a one-liner in
  // an appendix table. The browser handles 935 cards comfortably; the
  // resulting PDF will be long, which is the intent.
  const detailRows = rows;
  const appendixRows = [];

  const bandColorHex = (b) => ({ push: '#16A34A', striking: '#2563EB', page2: '#6366F1', deep: '#D97706', deeper: '#DC2626' }[b.id] || '#6366F1');

  const top5 = rows.slice(0, 5);
  const top5Html = top5.map((r, i) => {
    const rec = r.recommendation;
    const recCol = rec ? recColors[rec.type] : '#6366F1';
    let path = r.page; try { path = new URL(r.page).pathname || '/'; } catch {}
    return `
      <tr>
        <td class="rank" style="color:${recCol}">${i + 1}</td>
        <td><a href="${esc(r.page)}">${esc(path)}</a></td>
        <td class="muted">"${esc(r.bestQuery || '')}" @ ${r.bestQueryPosition.toFixed(1)}</td>
        <td class="num primary">+${Math.round(r.potentialClicks).toLocaleString()}</td>
      </tr>`;
  }).join('');

  const detailCardHtml = (r, idx) => {
    const cov = r.coverage && Array.isArray(r.coverage.queries) ? r.coverage : null;
    const rec = r.recommendation;
    const recCol = rec ? recColors[rec.type] : '#6366F1';
    const recLab = rec ? (T.rec[rec.type] && T.rec[rec.type].label) : '';
    const recReason = rec ? (T.rec[rec.type] && T.rec[rec.type].reason) : '';
    const bandLab = T.band[r.band.id] || r.band.label;
    const bc = bandColorHex(r.band);
    const pageTitle = (cov && cov.title) || (r.crawl && r.crawl.title) || '';

    // ── Page actuelle field states (mirrors the PPT logic) ─────────────
    const titleState = (() => {
      let live = '', len = 0, status = 'unknown';
      if (cov) { live = cov.title || ''; len = live.length; status = len > 0 ? 'present' : 'missing'; }
      else if (r.crawl && r.crawl.title) { live = r.crawl.title; len = r.crawl.titleLength || live.length; status = 'present'; }
      const color = status === 'present' ? (len >= 30 && len <= 60 ? '#16A34A' : '#D97706') : (status === 'missing' ? '#DC2626' : '#6B7085');
      const label = status === 'present' ? `${len}ch` : (status === 'missing' ? T.titleMissingLabel : T.notAnalysedShort);
      const body = live || (status === 'missing' ? T.noTitleTag : T.notAnalysedHint);
      return { status, color, label, body, live };
    })();
    const metaState = (() => {
      let txt = '', len = 0, status = 'unknown';
      if (cov) { txt = cov.metaDescription || ''; len = cov.metaDescriptionLength || 0; status = len > 0 ? 'present' : 'missing'; }
      const color = status === 'present' ? (len >= 70 && len <= 160 ? '#16A34A' : '#D97706') : (status === 'missing' ? '#DC2626' : '#6B7085');
      const label = status === 'present' ? `${len}ch` : (status === 'missing' ? T.titleMissingLabel : T.notAnalysedShort);
      const body = txt || (status === 'missing' ? T.noMetaDesc : T.notAnalysedHint);
      return { status, color, label, body, txt };
    })();
    const h1State = (() => {
      let live = '', count = 0, status = 'unknown';
      if (cov) { live = (cov.h1 && cov.h1[0]) || ''; count = cov.h1 ? cov.h1.length : 0; status = count > 0 ? 'present' : 'missing'; }
      else if (r.crawl && typeof r.crawl.h1Count === 'number') { count = r.crawl.h1Count; status = count > 0 ? 'present' : 'missing'; }
      const color = status === 'present' ? (count === 1 ? '#16A34A' : '#D97706') : (status === 'missing' ? '#DC2626' : '#6B7085');
      const label = status === 'present' ? T.h1Count(count) : (status === 'missing' ? T.noH1Label : T.notAnalysedShort);
      const body = live || (status === 'missing' ? T.noH1 : T.notAnalysedHint);
      return { status, color, label, body, live };
    })();

    // ── Top missing keywords per section ───────────────────────────────
    let missingSections = null;
    if (cov) {
      const queriesByImpr = (q) => {
        const t = (r.topQueries || []).find(x => x.query === q.query);
        return t ? t.impressions : 0;
      };
      // Drop brand-only queries this page didn't win — they belong to a
      // shallower URL and shouldn't be recommended here.
      const offLimits = r.offLimitsQueries || new Set();
      const sorted = cov.queries
        .filter(q => !offLimits.has(q.query))
        .sort((a, b) => queriesByImpr(b) - queriesByImpr(a));
      const pick = (pred) => sorted.filter(pred).slice(0, 3).map(q => q.query);
      missingSections = [
        { label: T.secLabel.title, keys: pick(q => !q.phrase.inTitle) },
        { label: T.secLabel.meta,  keys: pick(q => !q.phrase.inMetaDescription) },
        { label: T.secLabel.h1,    keys: pick(q => !q.phrase.inH1) },
        { label: T.secLabel.h2,    keys: pick(q => !q.phrase.inH2) },
        { label: T.secLabel.h3,    keys: pick(q => !q.phrase.inH3) },
        { label: T.secLabel.body,  keys: pick(q => q.phrase.bodyOccurrences === 0) }
      ];
    }

    // ── Actions list (priority-coded) ──────────────────────────────────
    const actions = deriveActions(r, lang);
    const actionsHtml = actions.slice(0, 5).map(a =>
      `<li class="${a.priority}"><span class="pri">[${esc(T.priority[a.priority])}]</span> ${esc(a.text)}</li>`
    ).join('');

    // ── Absent-from-page callout (above the queries table) ─────────────
    let missingCount = 0, missingImpr = 0;
    if (cov) {
      const missing = cov.queries.filter(q => !q.presentSomewhere);
      missingCount = missing.length;
      missingImpr = missing.reduce((sum, q) => {
        const t = (r.topQueries || []).find(x => x.query === q.query);
        return sum + (t ? t.impressions : 0);
      }, 0);
    }
    const missingCallout = missingCount
      ? `<div class="missingCallout">${esc(T.missingOnPage(missingCount, missingImpr))}</div>`
      : '';

    // ── Top queries — SORTED BY IMPRESSIONS DESC (was API order) ──────
    const sortedQueries = (r.topQueries || []).slice()
      .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
      .slice(0, 8);

    const queriesTable = cov && cov.queries.length
      ? `
        <table class="qtbl">
          <thead><tr><th class="qt-q">${esc(T.query)}</th><th class="num">${esc(T.impr)}</th><th class="num">${esc(T.pos)}</th><th>${esc(T.inPage)}</th></tr></thead>
          <tbody>
            ${sortedQueries.map(q => {
              const c = (cov.queries || []).find(x => x.query === q.query);
              let inSect;
              if (!c) {
                inSect = '<span class="muted">—</span>';
              } else {
                const tags = [];
                if (c.phrase.inTitle)            tags.push(`<span class="tag">${esc(T.pdfTagTitle || 'title')}</span>`);
                if (c.phrase.inMetaDescription)  tags.push(`<span class="tag">${esc(T.pdfTagMeta || 'meta description')}</span>`);
                if (c.phrase.inH1)               tags.push(`<span class="tag">${esc(T.pdfTagH1 || 'H1')}</span>`);
                if (c.phrase.inH2)               tags.push(`<span class="tag">${esc(T.pdfTagH2 || 'H2')}</span>`);
                if (c.phrase.inH3)               tags.push(`<span class="tag">${esc(T.pdfTagH3 || 'H3')}</span>`);
                // Lower-level subheadings (h4-h6) only — H2/H3 are surfaced
                // above as their own pills.
                if (c.phrase.inHeadings && !c.phrase.inH2 && !c.phrase.inH3)
                  tags.push(`<span class="tag">${esc(T.pdfTagSubheadings || 'subheadings')}</span>`);
                if (c.phrase.bodyOccurrences > 0) tags.push(`<span class="tag">${esc((T.pdfTagBody || 'body') + ' (' + c.phrase.bodyOccurrences + '×)')}</span>`);
                if (tags.length) inSect = tags.join(' ');
                else if (c.looseMatch.bodyAllWords) inSect = `<span class="warn">${esc(T.wordsOnly || 'words only')}</span>`;
                else inSect = `<span class="danger">${esc(T.pdfAbsent || 'absent')}</span>`;
              }
              return `<tr><td>${esc(q.query)}</td><td class="num">${q.impressions.toLocaleString()}</td><td class="num">${q.position.toFixed(1)}</td><td>${inSect}</td></tr>`;
            }).join('')}
          </tbody>
        </table>`
      : `<p class="muted small">${esc(T.notAnalysedShort || '(not analysed)')}</p>`;

    const fieldRow = (label, st) => `
      <div class="fieldRow">
        <span class="lbl">${esc(label)}</span>
        <span class="badge" style="color:${st.color}">${esc(st.label)}</span>
        <span class="body${st.live || st.txt ? '' : (st.status === 'missing' ? ' missing' : ' unknown')}">${esc(st.body)}</span>
      </div>`;

    const missingListHtml = missingSections
      ? `<div class="missList">
          ${missingSections.map(sec => `
            <div class="sec">
              <span class="lab ${sec.keys.length ? 'has' : 'none'}">${esc(sec.label)}</span>
              <span class="content">${sec.keys.length ? sec.keys.map(esc).join(' · ') : esc(T.allOnPage)}</span>
            </div>`).join('')}
         </div>`
      : `<p class="muted small">${esc(T.runAnalysisHint)}</p>`;

    return `
      <section class="opp page-break">
        <header class="opp-head" style="border-top-color:${bc}">
          <div class="opp-kicker">${esc(T.opportunityHeader(idx + 1, rows.length))} <span class="band" style="background:${bc}">${esc(bandLab)}</span> ${r.isQuickWin ? '<span class="qw">⚡ ' + esc(T.quickWinBadge) + '</span>' : ''}</div>
          <h2><a href="${esc(r.page)}">${esc(r.page)}</a></h2>
          ${pageTitle ? `<p class="pgtitle">${esc(pageTitle)}</p>` : ''}
        </header>
        ${rec ? `
          <div class="rec" style="border-color:${recCol};background:${recCol}15">
            <span class="rec-label" style="color:${recCol}">${esc(T.strategy)}</span>
            <strong style="color:${recCol}">${esc(recLab)}</strong>
            <p>${esc(recReason)}</p>
            ${rec.type === 'create-landing' && rec.suggestedUrl ? `<p class="sug"><b>${esc(T.suggestedUrl)}:</b> <code>${esc(rec.suggestedUrl)}</code></p>` : ''}
          </div>` : ''}
        <div class="kpis">
          <div class="kpi"><span class="lbl">${esc(T.impressions)}</span><span class="val">${r.impressions.toLocaleString()}</span></div>
          <div class="kpi"><span class="lbl">${esc(T.clicks)}</span><span class="val">${r.clicks.toLocaleString()}</span></div>
          <div class="kpi"><span class="lbl">${esc(T.ctr)}</span><span class="val">${(r.ctr * 100).toFixed(2)}%</span></div>
          <div class="kpi accent"><span class="lbl">${esc(T.potentialAtRank(r.targetPos))}</span><span class="val">+${Math.round(r.potentialClicks).toLocaleString()}</span></div>
        </div>
        <div class="opp-body">
          <div class="opp-col">
            <div class="subcard">
              <h4>${esc(T.currentPage)}</h4>
              ${fieldRow(T.title, titleState)}
              ${fieldRow(T.metaDescription, metaState)}
              ${fieldRow(T.h1Label, h1State)}
            </div>
            <div class="subcard">
              <h4>${esc(T.keywordsToAddHint)}</h4>
              ${missingListHtml}
            </div>
          </div>
          <div class="opp-col">
            <div class="subcard">
              <h4>${esc(T.actionItems)}</h4>
              <ul class="actions-list">${actionsHtml}</ul>
            </div>
            <div class="subcard">
              <h4>${esc(T.topRankingQueries)}</h4>
              ${missingCallout}
              ${queriesTable}
            </div>
          </div>
        </div>
      </section>`;
  };

  const appendixHtml = appendixRows.length
    ? `
      <section class="page-break appendix">
        <h2>${esc((T.appendixTitle && T.appendixTitle()) || 'All other opportunities')}</h2>
        <table class="apx">
          <thead><tr>${(T.appendixCols || ['#', 'Page', 'Band', 'Pos', 'Impr', 'Best query', 'Potential']).map((c, i) => `<th class="${i >= 2 && i !== 5 ? 'num' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${appendixRows.map((r, i) => {
              const rank = 16 + i;
              let path = r.page; try { path = new URL(r.page).pathname || '/'; } catch {}
              return `<tr>
                <td class="num muted">${rank}</td>
                <td><a href="${esc(r.page)}">${esc(path)}</a></td>
                <td class="bandc" style="color:${bandColorHex(r.band)}">${esc(T.band[r.band.id] || r.band.label)}</td>
                <td class="num">${r.bestQueryPosition.toFixed(1)}</td>
                <td class="num">${r.impressions.toLocaleString()}</td>
                <td class="muted small">${esc(r.bestQuery || '')}</td>
                <td class="num primary"><b>+${Math.round(r.potentialClicks).toLocaleString()}</b></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </section>`
    : '';

  const html = `<!DOCTYPE html><html lang="${esc(lang)}"><head>
    <meta charset="utf-8">
    <title>${esc(T.contentStrategy)} — ${esc(siteUrl)}</title>
    <style>
      @page { size: A4 portrait; margin: 14mm 12mm; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1A1D2E; background: #FAF8F4; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { padding: 24px; max-width: 920px; margin: 0 auto; }
      h1 { font-size: 32px; margin: 0 0 4px; letter-spacing: -0.01em; }
      h2 { font-size: 18px; margin: 0 0 4px; letter-spacing: -0.01em; }
      a { color: #4F46E5; text-decoration: none; }
      .muted { color: #6B7085; }
      .small { font-size: 11px; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .primary { color: #4F46E5; font-weight: 600; }
      .warn { color: #D97706; font-weight: 600; }
      .danger { color: #DC2626; font-weight: 600; }
      .page-break { page-break-before: always; }
      .page-break:first-child { page-break-before: auto; }
      .cover { padding: 40px 0; }
      .kicker { font-size: 11px; color: #6B7085; letter-spacing: 0.4em; font-weight: 600; margin-bottom: 10px; }
      .hero { font-size: 96px; font-weight: 800; color: #6366F1; line-height: 1; margin: 12px 0 8px; letter-spacing: -0.03em; }
      .heroSub { font-size: 16px; color: #6B7085; margin: 0 0 28px; max-width: 720px; line-height: 1.4; }
      .kpiGrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 28px 0; }
      .kpiBig { background: #fff; border: 1px solid #E8E3D9; border-radius: 10px; padding: 18px 20px; }
      .kpiBig .lbl { display: block; font-size: 11px; color: #6B7085; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
      .kpiBig .val { font-size: 28px; font-weight: 700; }
      .insight { background: #EEF2FF; border-left: 4px solid #6366F1; border-radius: 6px; padding: 14px 18px; margin: 24px 0; }
      .insight .lbl { display: inline-block; font-size: 11px; color: #4F46E5; font-weight: 700; letter-spacing: 0.3em; margin-right: 10px; }
      .insight .body { font-size: 13px; line-height: 1.5; }
      .actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 20px 0; }
      .action { border: 1px solid; border-radius: 10px; padding: 14px; }
      .action .head { font-size: 16px; font-weight: 700; margin-bottom: 8px; }
      .action .stats { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 8px; }
      .action .stats b { font-size: 16px; }
      .action .desc { font-size: 11px; color: #1A1D2E; font-style: italic; line-height: 1.4; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      table th, table td { padding: 8px 10px; border-bottom: 1px solid #E8E3D9; text-align: left; }
      table th { background: #F5F1E8; font-size: 11px; color: #6B7085; text-transform: uppercase; letter-spacing: 0.06em; }
      table .rank { font-weight: 700; font-size: 14px; }
      .audit { display: grid; grid-template-columns: 1fr auto; gap: 20px; align-items: end; margin-top: 40px; }
      .audit .site { font-size: 18px; font-weight: 600; }
      .audit .dates { color: #6B7085; font-size: 13px; margin-top: 4px; }
      .footer { text-align: right; font-size: 11px; color: #6B7085; }
      .topbox { background: #fff; border: 1px solid #E8E3D9; border-radius: 10px; padding: 18px 20px; margin-top: 18px; }
      .topbox h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7085; }
      .opp { background: #fff; border: 1px solid #E8E3D9; border-radius: 10px; padding: 18px 22px; margin: 0 0 18px; border-top: 6px solid #6366F1; }
      .opp-head .opp-kicker { font-size: 10px; color: #6B7085; letter-spacing: 0.2em; text-transform: uppercase; margin-bottom: 8px; }
      .opp-head .band, .opp-head .qw { display: inline-block; padding: 2px 8px; border-radius: 999px; color: #fff; font-size: 10px; font-weight: 700; margin-left: 6px; letter-spacing: 0; text-transform: none; }
      .opp-head .qw { background: #16A34A; }
      .opp-head h2 { font-size: 17px; margin: 4px 0 2px; word-break: break-all; }
      .opp-head .pgtitle { font-size: 12px; color: #6B7085; margin: 0 0 12px; font-style: italic; }
      .rec { border: 1px solid; border-radius: 8px; padding: 12px 14px; margin: 8px 0 14px; }
      .rec .rec-label { font-size: 10px; font-weight: 700; letter-spacing: 0.2em; }
      .rec strong { display: block; font-size: 16px; margin: 4px 0; }
      .rec p { margin: 4px 0; font-size: 12px; }
      .rec .sug { font-size: 11px; }
      .rec .sug code { background: #fff; padding: 1px 6px; border-radius: 3px; word-break: break-all; }
      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 10px 0 14px; }
      .kpis .kpi { background: #F5F1E8; border-radius: 6px; padding: 10px 12px; }
      .kpis .kpi .lbl { display: block; font-size: 10px; color: #6B7085; text-transform: uppercase; letter-spacing: 0.06em; }
      .kpis .kpi .val { font-size: 18px; font-weight: 700; margin-top: 4px; display: block; }
      .kpis .kpi.accent .val { color: #6366F1; }
      .qheader { font-size: 11px; font-weight: 700; color: #6B7085; text-transform: uppercase; letter-spacing: 0.08em; margin: 12px 0 6px; }
      .qtbl th, .qtbl td { padding: 5px 8px; font-size: 11px; vertical-align: middle; }
      .qtbl .qt-q { width: 42%; }
      .qtbl .tag { display: inline-block; background: #EEF2FF; color: #4F46E5; border: 1px solid #C7D2FE; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; margin: 1px 3px 1px 0; white-space: nowrap; }
      .opp-body { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
      .opp-col { display: flex; flex-direction: column; gap: 12px; }
      .subcard { background: #F8F4EB; border: 1px solid #EEE6D5; border-radius: 8px; padding: 12px 14px; }
      .subcard h4 { margin: 0 0 8px; font-size: 10px; text-transform: uppercase; color: #6B7085; letter-spacing: 0.08em; font-weight: 700; }
      .fieldRow { margin-bottom: 10px; }
      .fieldRow:last-child { margin-bottom: 0; }
      .fieldRow .lbl { font-size: 10px; font-weight: 700; color: #6B7085; letter-spacing: 0.05em; }
      .fieldRow .badge { font-size: 10px; font-weight: 700; margin-left: 8px; }
      .fieldRow .body { display: block; font-size: 11px; line-height: 1.45; margin-top: 4px; color: #1A1D2E; word-break: break-word; }
      .fieldRow .body.missing { color: #DC2626; font-style: italic; }
      .fieldRow .body.unknown { color: #6B7085; font-style: italic; }
      .missList .sec { display: grid; grid-template-columns: 88px 1fr; gap: 8px; font-size: 11px; margin-bottom: 6px; line-height: 1.4; }
      .missList .sec:last-child { margin-bottom: 0; }
      .missList .sec .lab { font-weight: 700; font-size: 10px; letter-spacing: 0.04em; }
      .missList .sec .lab.has { color: #DC2626; }
      .missList .sec .lab.none { color: #16A34A; }
      .missList .sec .content { color: #1A1D2E; word-break: break-word; }
      .actions-list { list-style: none; padding: 0; margin: 0; }
      .actions-list li { font-size: 11px; line-height: 1.45; padding: 4px 0 4px 16px; position: relative; }
      .actions-list li::before { content: '●'; position: absolute; left: 0; top: 4px; font-size: 9px; }
      .actions-list li.critical { color: #1A1D2E; font-weight: 600; }
      .actions-list li.critical::before { color: #DC2626; }
      .actions-list li.important::before { color: #D97706; }
      .actions-list li.recommended::before { color: #4F46E5; }
      .actions-list li .pri { font-weight: 700; font-size: 9px; letter-spacing: 0.06em; margin-right: 4px; }
      .actions-list li.critical .pri { color: #DC2626; }
      .actions-list li.important .pri { color: #D97706; }
      .actions-list li.recommended .pri { color: #4F46E5; }
      .missingCallout { background: rgba(220, 38, 38, 0.08); border-left: 3px solid #DC2626; color: #DC2626; padding: 6px 10px; font-size: 11px; margin: 0 0 8px; border-radius: 4px; font-weight: 600; }
      .opp { break-inside: avoid; page-break-inside: avoid; }
      .appendix h2 { margin-bottom: 12px; }
      .apx th, .apx td { padding: 6px 8px; font-size: 11px; }
      .apx .bandc { font-weight: 600; }
      .printBar { position: fixed; top: 0; left: 0; right: 0; background: #6366F1; color: #fff; padding: 10px 16px; display: flex; align-items: center; gap: 16px; z-index: 1000; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
      .printBar button { background: #fff; color: #4F46E5; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 700; cursor: pointer; }
      .printBar span { font-size: 13px; }
      @media print { .printBar { display: none; } body { padding: 0; max-width: none; background: #fff; } }
    </style>
  </head><body>
    <div class="printBar">
      <button onclick="window.print()">${esc(T.printSave || 'Print → Save as PDF')}</button>
      <span>${esc(T.printHint || 'Tip: choose "Save as PDF" in your browser print dialog.')}</span>
    </div>

    <!-- Cover -->
    <section class="cover">
      <div class="kicker">${esc(T.contentStrategy)}</div>
      <div class="hero">+${totalPot.toLocaleString()}</div>
      <p class="heroSub">${esc(T.heroSubtitle)}</p>
      <div class="audit">
        <div>
          <div class="kicker">${esc(T.audit)}</div>
          <div class="site">${esc(siteUrl)}</div>
          <div class="dates">${esc(startDate)} → ${esc(endDate)}</div>
        </div>
        <div class="footer">${esc(T.preparedBy)}</div>
      </div>
      <div class="kpiGrid">
        <div class="kpiBig"><span class="lbl">${esc(T.opportunityPages)}</span><span class="val">${allRows.length.toLocaleString()}</span></div>
        <div class="kpiBig"><span class="lbl">${esc(T.totalImpressions)}</span><span class="val">${totalImpr.toLocaleString()}</span></div>
        <div class="kpiBig"><span class="lbl">${esc(T.quickWins)}</span><span class="val">${totalQuickWins.toLocaleString()}</span></div>
      </div>
    </section>

    <!-- Executive summary -->
    <section class="page-break">
      <h1>${esc(T.execSummaryTitle)}</h1>
      <p class="muted">${esc(T.execSummaryKicker)}</p>
      ${insight ? `<div class="insight"><span class="lbl">${esc(T.execKeyInsightLabel || 'KEY INSIGHT')}</span><span class="body">${esc(insight)}</span></div>` : ''}
      <div class="actions">
        ${['optimize', 'rewrite-expand', 'create-landing'].map(id => {
          const a = recAgg[id], lab = T.rec[id], col = recColors[id];
          return `<div class="action" style="border-color:${col};background:${col}10">
            <div class="head" style="color:${col}">${esc(lab.label)}</div>
            <div class="stats"><span>${a.pages} ${esc(T.pagesLabel || 'pages')}</span><b style="color:#4F46E5">+${Math.round(a.potential).toLocaleString()}</b></div>
            <div class="desc">${esc(lab.desc)}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="topbox">
        <h3>${esc(T.execTopHeader)}</h3>
        <table>
          <thead><tr><th style="width:5%">#</th><th style="width:42%">${esc(T.execColPage)}</th><th>${esc(T.execColBest || 'Best query @ rank')}</th><th class="num" style="width:14%">${esc(T.execColGain)}</th></tr></thead>
          <tbody>${top5Html}</tbody>
        </table>
      </div>
    </section>

    <!-- Per-opportunity detail (top 15) -->
    ${detailRows.map((r, i) => detailCardHtml(r, i)).join('')}

    <!-- Appendix table for the rest -->
    ${appendixHtml}
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w) {
    alert('Please allow pop-ups for this site, then click "Export PDF" again.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// ── AI audit assistant ──────────────────────────────────────────────
// Floating launcher + resizable side panel. Talks to /api/chat/:crawlId
// which streams Claude responses over SSE. The crawl's analysis is
// prompt-cached server-side so follow-up turns are cheap.
(function initAuditChatbot() {
  let chatAvailable = false;
  let chatHistory = [];      // [{role: 'user' | 'assistant', content: string}, ...]
  let chatStreaming = false;
  let chatHistoryCrawlId = null;

  // Light Markdown → HTML for the assistant bubbles. Intentionally narrow:
  // bold, italics, code, fenced code, simple lists, links, line breaks.
  // Escapes HTML first so user-supplied text can't inject markup.
  function mdToHtml(src) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let s = esc(src);
    s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.replace(/^\n/, '')}</code></pre>`);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/(^|\n)(\s*)([-*•])\s+(.+)/g, (_, lead, indent, _b, txt) => `${lead}${indent}<li>${txt}</li>`);
    s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
    s = s.replace(/<\/ul>\s*<ul>/g, '');
    s = s.split(/\n{2,}/).map(p => /^<(ul|pre|h\d|li)/.test(p.trim()) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    return s;
  }

  function renderMessages() {
    const wrap = document.getElementById('chatMessages');
    if (!wrap) return;
    if (!chatHistory.length) {
      wrap.innerHTML = `
        <div class="chatbot-empty">
          <h3>What do you want to know about this audit?</h3>
          <p>Ask anything about the crawl results, issues, or what to fix first.</p>
          <div class="chatbot-suggestions">
            <button class="chatbot-suggestion" data-q="What are the top 5 issues I should fix first?">What are the top 5 issues I should fix first?</button>
            <button class="chatbot-suggestion" data-q="Summarize the SEO health of this site in 3 sentences.">Summarize the SEO health in 3 sentences.</button>
            <button class="chatbot-suggestion" data-q="Which pages have the most critical problems?">Which pages have the most critical problems?</button>
            <button class="chatbot-suggestion" data-q="How is my hreflang implementation? Any conflicts with canonicals?">How is my hreflang implementation?</button>
          </div>
        </div>`;
      wrap.querySelectorAll('.chatbot-suggestion').forEach(btn => {
        btn.addEventListener('click', () => sendChat(btn.dataset.q));
      });
      return;
    }
    wrap.innerHTML = chatHistory.map(m => {
      const body = m.role === 'assistant' && m.streaming && !m.content
        ? '<div class="chatbot-bubble thinking">Thinking</div>'
        : `<div class="chatbot-bubble">${m.role === 'assistant' ? mdToHtml(m.content || '') : (m.content || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</div>`;
      return `<div class="chatbot-msg ${m.role}">${body}</div>`;
    }).join('');
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function sendChat(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || chatStreaming) return;
    if (!currentCrawlId) {
      alert('Load a crawl first — the assistant needs the audit data.');
      return;
    }
    if (chatHistoryCrawlId && chatHistoryCrawlId !== currentCrawlId) {
      chatHistory = [];
      chatHistoryCrawlId = currentCrawlId;
    } else if (!chatHistoryCrawlId) {
      chatHistoryCrawlId = currentCrawlId;
    }
    chatHistory.push({ role: 'user', content: trimmed });
    const assistantMsg = { role: 'assistant', content: '', streaming: true };
    chatHistory.push(assistantMsg);
    chatStreaming = true;
    document.getElementById('chatSend').disabled = true;
    document.getElementById('chatInput').value = '';
    renderMessages();

    try {
      const res = await fetch(`/api/chat/${currentCrawlId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: chatHistory
            .filter(m => !(m.role === 'assistant' && m.streaming && !m.content))
            .map(m => ({ role: m.role, content: m.content }))
        })
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === 'delta') {
              assistantMsg.content += evt.text;
              assistantMsg.streaming = true;
              renderMessages();
            } else if (evt.type === 'error') {
              assistantMsg.content = (assistantMsg.content || '') + '\n\n*Error: ' + evt.message + '*';
            }
          } catch { /* ignore malformed sse frame */ }
        }
      }
      assistantMsg.streaming = false;
      if (!assistantMsg.content) assistantMsg.content = '*(no response)*';
    } catch (e) {
      console.error('Chat request failed:', e);
      assistantMsg.content = '*Error: ' + (e.message || 'request failed') + '*';
      assistantMsg.streaming = false;
    } finally {
      chatStreaming = false;
      document.getElementById('chatSend').disabled = false;
      renderMessages();
      document.getElementById('chatInput').focus();
    }
  }

  function openPanel() {
    document.getElementById('chatPanel').classList.add('open');
    document.getElementById('chatPanel').setAttribute('aria-hidden', 'false');
    document.getElementById('chatFab').classList.add('hidden');
    if (chatHistoryCrawlId && chatHistoryCrawlId !== currentCrawlId) {
      chatHistory = [];
      chatHistoryCrawlId = currentCrawlId;
    }
    renderMessages();
    setTimeout(() => document.getElementById('chatInput').focus(), 250);
  }
  function closePanel() {
    document.getElementById('chatPanel').classList.remove('open');
    document.getElementById('chatPanel').setAttribute('aria-hidden', 'true');
    if (currentCrawlId && chatAvailable) document.getElementById('chatFab').classList.remove('hidden');
  }

  // Bootstrap once the DOM is in place.
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const r = await fetch('/api/chat-status');
      const d = await r.json();
      chatAvailable = !!d.available;
    } catch { chatAvailable = false; }
    if (!chatAvailable) return;

    const fab = document.getElementById('chatFab');
    if (currentCrawlId) fab.classList.remove('hidden');

    // Watch loadCrawl so the FAB appears after the user opens an audit.
    const originalLoadCrawl = window.loadCrawl;
    if (typeof originalLoadCrawl === 'function') {
      window.loadCrawl = async function(id) {
        const result = await originalLoadCrawl.apply(this, arguments);
        if (chatAvailable) fab.classList.remove('hidden');
        return result;
      };
    }

    fab.addEventListener('click', openPanel);
    document.getElementById('chatClose').addEventListener('click', closePanel);
    document.getElementById('chatClear').addEventListener('click', () => {
      chatHistory = [];
      renderMessages();
    });

    // Fullscreen toggle.
    document.getElementById('chatFullscreen').addEventListener('click', () => {
      document.getElementById('chatPanel').classList.toggle('fullscreen');
    });

    // Form: submit on enter, shift+enter for newline.
    document.getElementById('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      sendChat(document.getElementById('chatInput').value);
    });
    document.getElementById('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat(document.getElementById('chatInput').value);
      }
    });

    // Drag the left edge to resize. Width persists via localStorage.
    const panel = document.getElementById('chatPanel');
    const savedWidth = parseInt(localStorage.getItem('chat-panel-width') || '0', 10);
    if (savedWidth >= 320) panel.style.width = savedWidth + 'px';
    const handle = document.getElementById('chatResize');
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', (e) => {
      if (panel.classList.contains('fullscreen')) return;
      dragging = true; startX = e.clientX; startW = panel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const newW = Math.min(window.innerWidth - 40, Math.max(320, startW + (startX - e.clientX)));
      panel.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      localStorage.setItem('chat-panel-width', String(panel.getBoundingClientRect().width));
    });
  });
})();
