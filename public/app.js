/* global io */
const socket = io();

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
$('#startCrawl').addEventListener('click', startCrawl);
$('#urlInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') startCrawl(); });

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
  const url = $('#urlInput').value.trim();
  if (!url) return;

  const saveProject = $('#optSaveProject').checked;
  const body = {
    url,
    maxPages: parseInt($('#optMaxPages').value) || 500,
    maxDepth: parseInt($('#optMaxDepth').value) || 10,
    concurrency: parseInt($('#optConcurrency').value) || 5,
    respectRobots: $('#optRobots').checked,
    userAgent: $('#optUserAgent').value || undefined,
    saveProject
  };

  // Persist save preference per domain
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
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

    setCurrentCrawlId(data.id);
    pagesData = [];
    analysisData = null;

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
  await fetch(`/api/crawls/${currentCrawlId}/abort`, { method: 'POST' });
  resetCrawlUI();
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
  $('#pauseCrawl').classList.add('hidden');
  $('#resumeCrawl').classList.add('hidden');
  $('#progressContainer').classList.add('hidden');
  $('#liveFeed').classList.add('hidden');
}

// ── Socket events ──
socket.on('progress', (data) => {
  const pct = data.total > 0 ? ((data.crawled / Math.min(data.total, parseInt($('#optMaxPages').value) || 500)) * 100).toFixed(1) : 0;
  $('#progressFill').style.width = `${Math.min(pct, 100)}%`;
  $('#progressText').textContent = `Crawling... ${data.crawled} pages`;
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
      <span class="feed-url" title="${esc(page.url)}">${esc(page.url)}</span>
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

socket.on('complete', (data) => {
  resetCrawlUI();
  analysisData = data.analysis;
  renderDashboard(data.stats, data.analysis);
  loadPages();
  renderHreflang(data.analysis);
  renderCanonicals(data.analysis);
  renderConflicts(data.analysis);
  renderRedirects(data.analysis);
  renderContent(data.analysis);
  renderImages(data.analysis);
  renderStructuredData(data.analysis);
  renderSecurity(data.analysis);
  renderLinks(data.analysis);
  renderAiBots(data.analysis);
  renderSearchEngines(data.analysis);
  renderSitemaps(data.analysis);
  renderStatusCodes(data.analysis);
  renderAnchors(data.analysis);
  renderMetaTitles(data.analysis);
  renderMetaDescriptions(data.analysis);
  renderHeadings(data.analysis);
  renderDirectives(data.analysis);
  renderSummary(data.analysis);

  // Load project history if save is enabled
  if ($('#optSaveProject').checked) {
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
  const html = `
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
  const res = await fetch(`/api/crawls/${currentCrawlId}/pages?limit=5000`);
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
  const sortIcon = (col) => _sortCol === col ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const html = `<p style="color:var(--text-muted);font-size:13px;margin-bottom:8px">Showing ${count} of ${pages.length} pages</p>
  <table>
    <thead><tr>
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
    <tbody>${filtered.slice(0, 2000).map(p => {
      const h1s = JSON.parse(p.h1 || '[]');
      const hls = JSON.parse(p.hreflangs || '[]');
      const sdt = JSON.parse(p.structured_data_types || '[]');
      const dir = p.meta_robots || 'index, follow';
      return `<tr class="page-row" data-url="${esc(p.url)}">
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
  $('#pagesTable').innerHTML = html;

  $$('.page-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't trigger row click if clicking a URL link (let the link handle it)
      if (e.target.closest('a.url-cell')) return;
      showPageDetail(row.dataset.url, pages);
    });
  });
}

['pagesFilter'].forEach(id => { $('#'+id)?.addEventListener('input', () => { if (pagesData.length) renderPagesTable(pagesData); }); });
['pagesStatusFilter','pagesTitleFilter','pagesDescFilter','pagesDirectiveFilter','pagesCanonicalFilter','pagesH1Filter','pagesWordFilter','pagesHreflangFilter'].forEach(id => {
  $('#'+id)?.addEventListener('change', () => { if (pagesData.length) renderPagesTable(pagesData); });
});

function showPageDetail(url, pages) {
  const p = pages.find(pg => pg.url === url);
  if (!p) return;
  const hreflangs = JSON.parse(p.hreflangs || '[]');
  const conflicts = JSON.parse(p.hreflang_canonical_conflicts || '[]');
  const headings = JSON.parse(p.heading_structure || '[]');
  const secHeaders = JSON.parse(p.security_headers || '{}');

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal">
    <button class="modal-close">&times;</button>
    <h3>${esc(p.url)}</h3>
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

  // Find pages linking TO this URL (deduplicated by source URL)
  const inboundMap = new Map();
  for (const page of pagesData) {
    try {
      const links = JSON.parse(page.links || '[]');
      for (const link of links) {
        if (link.href === url && link.isInternal && !inboundMap.has(page.url)) {
          inboundMap.set(page.url, { from: page.url, anchor: link.anchor || '(no text)', nofollow: link.isNofollow });
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
      ${inboundLinks.length > 0 ? `<div class="section-card" style="margin-top:16px"><h3>Pages Linking Here (${inboundLinks.length})</h3>
        <table><thead><tr><th>Source Page</th><th>Anchor Text</th><th>Nofollow</th></tr></thead><tbody>
        ${inboundLinks.slice(0, 100).map(l => `<tr><td>${urlLink(l.from)}</td><td>${esc(l.anchor)}</td><td>${l.nofollow ? '<span class="badge badge-warning">Yes</span>' : 'No'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p style="color:var(--text-muted)">No internal pages link to this URL.</p>'}
    </div>`;
  } else {
    const hreflangs = JSON.parse(p.hreflangs || '[]');
    const conflicts = JSON.parse(p.hreflang_canonical_conflicts || '[]');
    const headings = JSON.parse(p.heading_structure || '[]');
    const secHeaders = JSON.parse(p.security_headers || '{}');
    const sdt = JSON.parse(p.structured_data_types || '[]');

    modal.innerHTML = `<div class="modal">
      <button class="modal-close">&times;</button>
      <h3 style="word-break:break-all">${esc(p.url)}</h3>
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
        <h3>Pages Linking Here (${inboundLinks.length})</h3>
        ${inboundLinks.length > 0 ? `<table><thead><tr><th>Source Page</th><th>Anchor Text</th><th>Nofollow</th></tr></thead><tbody>
        ${inboundLinks.slice(0, 100).map(l => `<tr><td>${urlLink(l.from)}</td><td>${esc(l.anchor)}</td><td>${l.nofollow ? '<span class="badge badge-warning">Yes</span>' : 'No'}</td></tr>`).join('')}
        </tbody></table>` : '<p style="color:var(--text-muted)">No internal pages link to this URL.</p>'}
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
        <td style="font-size:12px">${esc(i.message)}</td>
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
      <div class="conflict-url">${esc(page.url)}</div>
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
  let html = `<div class="stats-grid">
    ${statCard('Total Redirects', r.total, r.total > 0 ? 'warning' : 'success')}
    ${statCard('Long Chains (3+)', r.longChains, r.longChains > 0 ? 'danger' : 'success')}
  </div>`;

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

  $('#redirectsContent').innerHTML = exportBtn('redirects') + html;
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
        ${group.map(p => `<li style="font-size:13px;color:var(--text-muted)">${esc(p.url)}</li>`).join('')}
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
  const r = _imgData;
  const f = _imgFilter;
  const cb = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterImg('${key}')">${statCardInner(label, count)}</div>`;
  };
  let html = `<div class="stats-grid">
    ${cb('all', 'Total Images', r.totalImages, '')}
    ${cb('missingalt', 'Missing Alt Attr', r.missingAlt, r.missingAlt > 0 ? 'danger' : 'success')}
    ${cb('emptyalt', 'Empty Alt Text', r.emptyAlt, r.emptyAlt > 0 ? 'warning' : 'success')}
    ${cb('unique', 'Unique Images with Issues', r.uniqueIssueImages || 0, r.uniqueIssueImages > 0 ? 'danger' : 'success')}
  </div>`;

  let issues = r.issueImages || [];
  if (f === 'missingalt') issues = issues.filter(i => i.issue === 'Missing alt attribute');
  else if (f === 'emptyalt') issues = issues.filter(i => i.issue !== 'Missing alt attribute');

  if (issues.length > 0) {
    html += `<div class="section-card"><h3>Images with Alt Issues (${issues.length} unique images)</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">Each image URL is shown once with one example origin page. "Occurrences" shows how many times this image appears across the site.</p>
      <table><thead><tr><th>Image URL</th><th>Found On</th><th>Issue</th><th>Occurrences</th></tr></thead>
      <tbody>${issues.slice(0, 500).map(i => `<tr>
        <td>${i.src ? urlLink(i.src) : '<span style="color:var(--text-muted)">No src</span>'}</td>
        <td>${urlLink(i.pageUrl)}</td>
        <td>${i.issue === 'Missing alt attribute' ? '<span class="badge badge-danger">Missing alt attr</span>' : '<span class="badge badge-warning">Empty alt text</span>'}</td>
        <td>${i.occurrences}</td>
      </tr>`).join('')}</tbody></table></div>`;
  } else {
    html += `<div class="section-card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h3>${f === 'all' ? 'All Images Have Alt Text' : 'No images match this filter'}</h3>
    </div>`;
  }

  $('#imagesContent').innerHTML = exportBtn('images') + html;
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

  $('#linksContent').innerHTML = exportBtn('links') + html;
}

window.loadCrawl = async function(id) {
  setCurrentCrawlId(id);
  const res = await fetch(`/api/crawls/${id}/analysis`);
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

// ── Status Codes ──
let _statusCodesData = null;
let _statusCodesActiveFilter = 'all';

function renderStatusCodes(analysis) {
  const r = analysis.statusCodesReport;
  if (!r) { $('#statuscodesContent').innerHTML = '<p style="color:var(--text-muted)">No data.</p>'; return; }
  _statusCodesData = r;
  _statusCodesActiveFilter = 'all';
  _renderStatusCodesUI();
}

function _renderStatusCodesUI() {
  const r = _statusCodesData;
  const f = _statusCodesActiveFilter;

  const cardBtn = (key, label, count, color) => {
    const active = f === key ? 'border:2px solid #fff;' : 'cursor:pointer;opacity:' + (f === 'all' || f === key ? '1' : '0.5') + ';';
    return `<div class="stat-card${count > 0 && color ? ' stat-' + color : ''}" style="${active}" onclick="filterStatusCodes('${key}')">${statCardInner(label, count)}</div>`;
  };

  let html = `<div class="stats-grid">
    ${cardBtn('all', 'Total URLs', r.total, '')}
    ${cardBtn('2xx', '2xx Success', r.groups['2xx'].urls.length, 'success')}
    ${cardBtn('3xx', '3xx Redirect', r.groups['3xx'].urls.length, r.groups['3xx'].urls.length > 0 ? 'warning' : '')}
    ${cardBtn('4xx', '4xx Client Error', r.groups['4xx'].urls.length, r.groups['4xx'].urls.length > 0 ? 'danger' : 'success')}
    ${cardBtn('5xx', '5xx Server Error', r.groups['5xx'].urls.length, r.groups['5xx'].urls.length > 0 ? 'danger' : 'success')}
    ${cardBtn('error', 'Conn Errors', r.groups['error'].urls.length, r.groups['error'].urls.length > 0 ? 'danger' : '')}
  </div>`;

  // Pie chart
  if (r.pieChart.length > 0) {
    html += `<div class="section-card"><h3>Status Code Distribution</h3>
      <div class="pie-chart-container">
        ${renderPieChart(r.pieChart, 200)}
        <div class="pie-legend">
          ${r.pieChart.map(s => `<div class="pie-legend-item">
            <div class="pie-legend-dot" style="background:${s.color}"></div>
            <span class="pie-legend-label">${esc(s.label)}</span>
            <span class="pie-legend-count">${s.count} (${s.percentage}%)</span>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  // Tables for filtered groups
  const groupOrder = f === 'all' ? ['2xx', '3xx', '4xx', '5xx', 'error'] : [f];
  for (const key of groupOrder) {
    const g = r.groups[key];
    if (!g || g.urls.length === 0) continue;
    html += `<div class="section-card" style="border-left:4px solid ${g.color}">
      <h3>${esc(g.label)} (${g.urls.length})</h3>
      <table><thead><tr><th>URL</th><th>Status</th>${key === '3xx' ? '<th>Redirects To</th>' : ''}${key === 'error' ? '<th>Error</th>' : ''}</tr></thead>
      <tbody>${g.urls.slice(0, 500).map(u => `<tr>
        <td>${urlLink(u.url)}</td>
        <td>${u.statusCode ? statusBadge(u.statusCode) : '<span class="badge badge-danger">Error</span>'}</td>
        ${key === '3xx' ? `<td>${u.finalUrl ? urlLink(u.finalUrl) : '-'}</td>` : ''}
        ${key === 'error' ? `<td style="font-size:12px;color:var(--text-muted)">${esc(u.error || '')}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#statuscodesContent').innerHTML = exportBtn('statuscodes') + html;
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
    if (r.missing.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Missing Title (${r.missing.length})</h3><table><thead><tr><th>URL</th></tr></thead><tbody>${r.missing.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'dup') {
    if (r.duplicates.length > 0) { html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Duplicate Titles (${r.duplicates.length} groups)</h3>`;
      for (const d of r.duplicates.slice(0,50)) html += `<div style="margin-bottom:16px;padding:12px;background:var(--bg-hover);border-radius:8px"><strong style="color:var(--text-muted)">"${esc(truncate(d.title,80))}"</strong> <span class="badge badge-danger">${d.count}x</span><table style="margin-top:8px"><tbody>${d.urls.map(u=>`<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
      html += `</div>`; }
  }
  if (f === 'all' || f === 'short') {
    if (r.tooShort.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Short (${r.tooShort.length})</h3><table><thead><tr><th>URL</th><th>Title</th><th>Len</th></tr></thead><tbody>${r.tooShort.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.title)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'long') {
    if (r.tooLong.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Long (${r.tooLong.length})</h3><table><thead><tr><th>URL</th><th>Title</th><th>Len</th></tr></thead><tbody>${r.tooLong.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.title)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
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
    if (r.missing.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Missing Description (${r.missing.length})</h3><table><thead><tr><th>URL</th></tr></thead><tbody>${r.missing.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'dup') {
    if (r.duplicates.length > 0) { html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Duplicate Descriptions (${r.duplicates.length} groups)</h3>`;
      for (const d of r.duplicates.slice(0,50)) html += `<div style="margin-bottom:16px;padding:12px;background:var(--bg-hover);border-radius:8px"><strong style="color:var(--text-muted)">"${esc(truncate(d.description,80))}"</strong> <span class="badge badge-danger">${d.count}x</span><table style="margin-top:8px"><tbody>${d.urls.map(u=>`<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
      html += `</div>`; }
  }
  if (f === 'all' || f === 'short') {
    if (r.tooShort.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Short (${r.tooShort.length})</h3><table><thead><tr><th>URL</th><th>Description</th><th>Len</th></tr></thead><tbody>${r.tooShort.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.metaDescription)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'long') {
    if (r.tooLong.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Long (${r.tooLong.length})</h3><table><thead><tr><th>URL</th><th>Description</th><th>Len</th></tr></thead><tbody>${r.tooLong.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.metaDescription)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
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
  const r = size / 2;
  const cx = r, cy = r;
  let currentAngle = -Math.PI / 2;

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
      paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${slice.color}"/>`;
    } else {
      paths += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z" fill="${slice.color}"/>`;
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
function renderSearchEngines(analysis) {
  const r = analysis.searchEnginesReport;
  if (!r || !r.hasRobotsTxt) {
    $('#searchenginesContent').innerHTML = `<div class="section-card" style="text-align:center;padding:40px">
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

  let html = '';

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

  $('#searchenginesContent').innerHTML = html;
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
    if (r.missingH1.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Missing H1 (${r.missingH1.length})</h3><table><thead><tr><th>URL</th><th>H2 Count</th></tr></thead><tbody>${r.missingH1.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${p.h2Count}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'multipleH1') {
    if (r.multipleH1.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Multiple H1s (${r.multipleH1.length})</h3><table><thead><tr><th>URL</th><th>H1 Count</th><th>H1 Tags</th></tr></thead><tbody>${r.multipleH1.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${p.h1Count}</td><td style="font-size:12px">${(p.h1||[]).map(h=>esc(h)).join(', ')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'missingH2') {
    if (r.missingH2.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Missing H2 (${r.missingH2.length})</h3><table><thead><tr><th>URL</th><th>H1 Count</th></tr></thead><tbody>${r.missingH2.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${p.h1Count}</td></tr>`).join('')}</tbody></table></div>`;
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

  let html = `
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
function exportBtn(section) {
  return `<div style="display:flex;justify-content:flex-end;margin-bottom:12px">
    <button onclick="exportSection('${section}')" style="display:inline-flex;align-items:center;gap:6px;background:#1d6f42;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:background .15s" onmouseover="this.style.background='#238d53'" onmouseout="this.style.background='#1d6f42'">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 17 15 14"/></svg>
      Export to Excel
    </button>
  </div>`;
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
function urlLink(url) {
  if (!url) return '-';
  return `<a href="${esc(url)}" target="_blank" rel="noopener" class="url-cell" title="${esc(url)}">${esc(url)}</a>`;
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
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Start date</label>
            <input type="date" id="gscStart" value="${start}" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">End date</label>
            <input type="date" id="gscEnd" value="${today}" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
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

function findMatchingGscSite(sites, host) {
  if (!sites || !sites.length || !host) return null;
  let best = null, bestScore = 0;
  for (const s of sites) {
    const score = scoreGscMatch(s.siteUrl, host);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
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

  if (!siteUrl) { alert('Select a property first.'); return; }

  const btn = document.getElementById('gscRun');
  btn.disabled = true; btn.textContent = 'Loading…';
  const results = document.getElementById('gscResults');
  results.innerHTML = '<p style="color:var(--text-muted);padding:20px">Querying Google Search Console…</p>';

  try {
    const r = await fetch('/api/gsc/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteUrl, startDate, endDate, dimensions, rowLimit, searchType, dataState })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Query failed');
    gscState.lastResult = { rows: data.rows || [], dimensions, siteUrl, startDate, endDate };
    renderGscTotals();
    renderGscResults();
  } catch (e) {
    results.innerHTML = `<div style="padding:20px;color:var(--danger)">${escapeHtml(e.message)}</div>`;
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

// Auto-restore the previously-loaded crawl after a full page reload (e.g.
// after the OAuth round-trip). sessionStorage keeps the crawl id per tab;
// only re-hydrate if that crawl is still on the server and is completed.
// If the URL says we returned to a specific tab (e.g. ?gsc=...), restore
// that tab after loadCrawl forces the dashboard view.
(async function restoreCrawlOnBoot() {
  const id = sessionStorage.getItem('currentCrawlId');
  if (!id) return;
  const returningToGsc = location.hash === '#gsc' || new URLSearchParams(location.search).get('gsc');
  try {
    const r = await fetch(`/api/crawls/${id}`);
    if (!r.ok) { sessionStorage.removeItem('currentCrawlId'); return; }
    const crawl = await r.json();
    if (!crawl || crawl.status !== 'completed') return;
    if (typeof window.loadCrawl === 'function') {
      await window.loadCrawl(id);
      if (returningToGsc) {
        const link = document.querySelector('.nav-link[data-view="gsc"]');
        if (link) link.click();
      }
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

const csState = {
  sites: [],
  selectedSite: localStorage.getItem('gsc-selected-site') || '',
  rows: [],         // enriched rows for the table
  expanded: new Set(),
  crawlPages: null  // URL → { title, h1Count, wordCount } from active crawl
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
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Start date</label>
            <input type="date" id="csStart" value="${start}" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">End date</label>
            <input type="date" id="csEnd" value="${today}" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
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
            <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Min impressions</label>
            <input type="number" id="csMinImpressions" value="100" min="0" style="width:100%;padding:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          </div>
          <div>
            <button id="csRun" class="btn btn-primary" style="width:100%;padding:9px;border-radius:6px;background:var(--primary);color:#fff;border:none;cursor:pointer;font-weight:600">Find opportunities</button>
          </div>
        </div>
        <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span style="font-size:12px;color:var(--text-muted);margin-right:4px">Bands:</span>
          ${bandCheckboxes}
        </div>
        <div style="display:flex;gap:12px;margin-top:12px;flex-wrap:wrap;align-items:center">
          <input type="text" id="csTextFilter" placeholder="Filter rows (URL or query)…" style="flex:1;min-width:200px;padding:7px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text)">
          <button id="csAnalyse" class="btn btn-secondary" title="Fetch each page and analyse whether the queries it ranks for actually appear on the page" style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Analyse keyword coverage</button>
          <label id="csQuickWinsLabel" title="Show only opportunities where at least one query is completely missing from the page" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);opacity:.6">
            <input type="checkbox" id="csQuickWins" disabled> Quick wins only
          </label>
          <button id="csExport" class="btn btn-secondary" style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);cursor:pointer">Export CSV</button>
        </div>
        <div id="csAnalyseProgress" style="display:none;margin-top:8px;font-size:12px;color:var(--text-muted)"></div>
      </div>

      <div id="csSummary" style="display:none;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px"></div>
      <div id="csTable"></div>
    </div>
  `;

  document.getElementById('csRun').addEventListener('click', runStrategyQuery);
  document.getElementById('csExport').addEventListener('click', exportStrategyCsv);
  document.getElementById('csTextFilter').addEventListener('input', renderStrategyTable);
  document.getElementById('csAnalyse').addEventListener('click', analyseAllCoverage);
  document.getElementById('csQuickWins').addEventListener('change', renderStrategyTable);
  document.getElementById('csSite').addEventListener('change', (e) => {
    csState.selectedSite = e.target.value;
    localStorage.setItem('gsc-selected-site', csState.selectedSite);
  });
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
  if (!siteUrl) { alert('Select a property first.'); return; }

  const btn = document.getElementById('csRun');
  btn.disabled = true; btn.textContent = 'Loading…';
  document.getElementById('csTable').innerHTML = '<p style="color:var(--text-muted);padding:20px">Querying Search Console for opportunities…</p>';
  document.getElementById('csSummary').style.display = 'none';

  try {
    const r = await fetch('/api/gsc/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteUrl, startDate, endDate,
        dimensions: ['page'],
        rowLimit: 25000,
        searchType
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Query failed');

    csState.rows = (data.rows || [])
      .map(row => {
        const page = (row.keys || [])[0] || '';
        const impressions = row.impressions || 0;
        const clicks = row.clicks || 0;
        const position = row.position || 0;
        const ctr = row.ctr || 0;
        if (position < 1.5 || position > 40.5) return null;       // ignore #1 and ranks past 40
        if (impressions < minImpressions) return null;
        const band = bandForPosition(position);
        if (!band) return null;
        const targetCtr = ctrAtPosition(band.target);
        const potentialClicks = Math.max(0, impressions * targetCtr - clicks);
        const crawl = csState.crawlPages ? csState.crawlPages.get(normaliseUrlForJoin(page)) : null;
        return {
          page, impressions, clicks, position, ctr,
          band, potentialClicks, targetPos: band.target,
          crawl: crawl || null,
          topQueries: null   // lazy-loaded on expand
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.potentialClicks - a.potentialClicks);

    csState.expanded.clear();
    renderStrategySummary();
    renderStrategyTable();
  } catch (e) {
    document.getElementById('csTable').innerHTML = `<div style="padding:20px;color:var(--danger)">${escapeHtml(e.message)}</div>`;
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
  const byBand = {};
  for (const b of STRATEGY_BANDS) byBand[b.id] = 0;
  for (const r of csState.rows) byBand[r.band.id]++;

  const card = (label, value, hint) => `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px">
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em">${label}</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${value}</div>
      ${hint ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">${hint}</div>` : ''}
    </div>`;
  const bandChips = STRATEGY_BANDS.map(b =>
    `<div style="display:flex;align-items:center;gap:6px;font-size:12px">
       <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${b.color}"></span>
       <b>${byBand[b.id]}</b> <span style="color:var(--text-muted)">${escapeHtml(b.label)}</span>
     </div>`).join('');

  const quickWins = csState.rows.filter(r => r.isQuickWin === true).length;
  const analysed = csState.rows.filter(r => r.coverage && Array.isArray(r.coverage.queries)).length;

  wrap.style.display = 'grid';
  wrap.innerHTML =
    card('Opportunities', total.toLocaleString()) +
    card('Total impressions', totalImpressions.toLocaleString()) +
    card('Estimated extra clicks', Math.round(totalPotential).toLocaleString(), 'if moved to target rank') +
    (analysed > 0
      ? card('Quick wins', quickWins.toLocaleString(), `pages missing ≥ 1 ranked keyword (analysed ${analysed} / ${total})`)
      : '') +
    `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:14px">
       <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">By band</div>
       <div style="display:flex;flex-direction:column;gap:5px">${bandChips}</div>
     </div>`;
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
  const filtered = csState.rows.filter(r =>
    bands.has(r.band.id) &&
    (!textFilter || r.page.toLowerCase().includes(textFilter)) &&
    (!quickWinsOnly || r.isQuickWin === true)
  );

  if (!filtered.length) {
    wrap.innerHTML = '<div style="padding:20px;color:var(--text-muted)">No rows match the current filters.</div>';
    return;
  }

  const rowsHtml = filtered.map((r, idx) => {
    const isOpen = csState.expanded.has(r.page);
    const crawl = r.crawl;
    const crawlTags = crawl ? `
      <span style="color:var(--text-muted);font-size:12px">·</span>
      <span style="font-size:12px;color:var(--text-muted)" title="From the active crawl">
        ${crawl.wordCount} words · ${crawl.h1Count} H1${crawl.h1Count === 1 ? '' : 's'} · title ${crawl.titleLength}ch
      </span>` : '';
    const quickWinBadge = r.isQuickWin === true
      ? `<span title="At least one query the page ranks for is missing from the page entirely" style="background:rgba(22,163,74,.15);color:var(--success);padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600">⚡ quick win</span>`
      : '';
    const main = `
      <tr data-page="${escapeHtml(r.page)}" style="cursor:pointer">
        <td style="padding:10px 12px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${r.band.color}" title="${escapeHtml(r.band.label)}"></span>
            <a href="${escapeHtml(r.page)}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;word-break:break-all" onclick="event.stopPropagation()">${escapeHtml(r.page)}</a>
            ${quickWinBadge}
            ${crawlTags}
          </div>
          ${crawl && crawl.title ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">${escapeHtml(crawl.title)}</div>` : ''}
        </td>
        <td style="padding:10px 12px;font-size:12px"><span style="background:${r.band.color}22;color:${r.band.color};padding:2px 8px;border-radius:999px;font-weight:600">${escapeHtml(r.band.label)}</span></td>
        <td style="padding:10px 12px;text-align:right">${r.impressions.toLocaleString()}</td>
        <td style="padding:10px 12px;text-align:right">${r.clicks.toLocaleString()}</td>
        <td style="padding:10px 12px;text-align:right">${(r.ctr * 100).toFixed(2)}%</td>
        <td style="padding:10px 12px;text-align:right">${r.position.toFixed(1)}</td>
        <td style="padding:10px 12px;text-align:right"><b>+${Math.round(r.potentialClicks).toLocaleString()}</b><div style="font-size:11px;color:var(--text-muted)">if @${r.targetPos}</div></td>
        <td style="padding:10px 12px;text-align:center;color:var(--text-muted)">${isOpen ? '▾' : '▸'}</td>
      </tr>`;
    const expansion = isOpen ? `
      <tr data-expansion="${escapeHtml(r.page)}">
        <td colspan="8" style="background:var(--bg-hover);padding:14px 18px">
          <div id="csQueries-${idx}" style="font-size:13px;color:var(--text-muted)">Loading top queries…</div>
        </td>
      </tr>` : '';
    return main + expansion;
  }).join('');

  wrap.innerHTML = `
    <div class="table-container" style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;overflow:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:var(--bg-hover)">
            <th style="padding:10px 12px;text-align:left;border-bottom:1px solid var(--border)">Page</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:1px solid var(--border)">Band</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid var(--border)">Impressions</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid var(--border)">Clicks</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid var(--border)">CTR</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid var(--border)">Position</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid var(--border)">Potential clicks</th>
            <th style="padding:10px 12px;border-bottom:1px solid var(--border)"></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div style="padding:10px 4px;color:var(--text-muted);font-size:12px">Showing ${filtered.length.toLocaleString()} of ${csState.rows.length.toLocaleString()} opportunities. Potential-clicks estimate uses an average CTR-by-position curve and is a rough upper-bound.</div>
  `;

  // Row click → toggle expansion + load queries on first open.
  wrap.querySelectorAll('tr[data-page]').forEach((tr, idx) => {
    const page = tr.dataset.page;
    tr.addEventListener('click', async () => {
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
  } catch (e) {
    row.coverage = { error: e.message };
  }
  if (!silent) {
    renderStrategyQueriesFor(row.page);
    renderStrategySummary();
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
    bands.has(r.band.id) &&
    (!textFilter || r.page.toLowerCase().includes(textFilter)) &&
    !(r.coverage && Array.isArray(r.coverage.queries))
  );
  if (!targets.length) {
    enableQuickWinsIfAny();
    progress.style.display = 'block';
    progress.textContent = 'All visible rows are already analysed.';
    return;
  }
  if (targets.length > 200) {
    if (!confirm(`This will analyse ${targets.length} pages and could take a few minutes (and hits Search Console + the live URLs). Continue?`)) return;
  }

  csBulkAbort = false;
  btn.dataset.running = '1';
  btn.textContent = 'Stop';
  progress.style.display = 'block';

  const total = targets.length;
  let done = 0, errors = 0;
  const CONCURRENCY = 3;
  const queue = targets.slice();
  const tick = () => {
    progress.innerHTML = `Analysed <b>${done}</b> / ${total}${errors ? ` · <span style="color:var(--danger)">${errors} errors</span>` : ''}`;
  };
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
  if (csBulkAbort) progress.innerHTML = `Stopped at ${done} / ${total}${errors ? ` · <span style="color:var(--danger)">${errors} errors</span>` : ''}.`;
  else progress.innerHTML = `Done — analysed ${done} / ${total}${errors ? ` · <span style="color:var(--danger)">${errors} errors</span>` : ''}.`;

  // Update quick-win flags for every row that has coverage but hasn't been
  // flagged yet (covers the case where coverage was loaded via expansion).
  for (const r of csState.rows) {
    if (r.coverage && Array.isArray(r.coverage.queries) && r.isQuickWin === undefined) {
      r.isQuickWin = computeQuickWin(r);
    }
  }
  enableQuickWinsIfAny();
  renderStrategySummary();
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
  const tr = document.querySelector(`tr[data-expansion="${CSS.escape(page)}"]`);
  if (!row || !tr) return;
  const target = tr.querySelector('td > div');
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

  const yesPill = (ok, label) => `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;background:${ok ? 'rgba(22,163,74,.15)' : 'rgba(220,38,38,.12)'};color:${ok ? 'var(--success)' : 'var(--danger)'}">${ok ? '✓' : '✗'} ${label}</span>`;

  const rows = row.topQueries.map(q => {
    const c = coverageByQuery[q.query];
    let badges = '';
    let bodyCount = '';
    let density = '';
    if (cov && cov.loading) {
      badges = '<span style="color:var(--text-muted);font-size:11px">analysing…</span>';
    } else if (c) {
      badges = [
        yesPill(c.phrase.inTitle, 'title'),
        yesPill(c.phrase.inH1, 'H1'),
        yesPill(c.phrase.inHeadings, 'Hn'),
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
    const inH1 = cov.queries.filter(q => q.phrase.inH1).length;
    const inBody = cov.queries.filter(q => q.phrase.bodyOccurrences > 0).length;
    const absent = cov.queries.filter(q => !q.presentSomewhere);
    const absentImpressions = absent.reduce((sum, q) => {
      const t = row.topQueries.find(x => x.query === q.query);
      return sum + (t ? t.impressions : 0);
    }, 0);
    const tone = (n, total) => n === 0 ? 'var(--danger)' : (n < total / 2 ? 'var(--warning)' : 'var(--success)');
    coverageBlock = `
      <div style="margin-bottom:10px;padding:12px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;font-size:13px">
        <div style="font-weight:600;margin-bottom:6px">Keyword coverage <span style="color:var(--text-muted);font-weight:400;font-size:12px">— live page has ${cov.wordCount.toLocaleString()} words</span></div>
        <div style="display:flex;gap:18px;flex-wrap:wrap">
          <div><span style="color:${tone(inTitle, totalQ)};font-weight:700">${inTitle}</span><span style="color:var(--text-muted)"> / ${totalQ} queries in <b>title</b></span></div>
          <div><span style="color:${tone(inH1, totalQ)};font-weight:700">${inH1}</span><span style="color:var(--text-muted)"> / ${totalQ} in <b>H1</b></span></div>
          <div><span style="color:${tone(inBody, totalQ)};font-weight:700">${inBody}</span><span style="color:var(--text-muted)"> / ${totalQ} in <b>body</b></span></div>
          ${absent.length ? `<div style="color:var(--danger)"><b>${absent.length}</b> queries not on page <span style="color:var(--text-muted)">(${absentImpressions.toLocaleString()} impressions)</span></div>` : ''}
        </div>
        ${absent.length ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Missing: ${absent.slice(0, 6).map(q => '<code style="background:rgba(220,38,38,.08);color:var(--danger);padding:1px 6px;border-radius:3px">' + escapeHtml(q.query) + '</code>').join(' ')}${absent.length > 6 ? ` <span>and ${absent.length - 6} more</span>` : ''}</div>` : ''}
      </div>`;
  }

  target.innerHTML = `
    ${crawlBlock}
    ${coverageBlock}
    <div style="font-weight:600;margin-bottom:6px">Top queries driving this page</div>
    <div style="overflow:auto;border:1px solid var(--border);border-radius:6px;background:var(--bg-card)">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:var(--bg-hover)">
          <th style="padding:6px 10px;text-align:left">Query</th>
          <th style="padding:6px 10px;text-align:right">Impressions</th>
          <th style="padding:6px 10px;text-align:right">Clicks</th>
          <th style="padding:6px 10px;text-align:right">CTR</th>
          <th style="padding:6px 10px;text-align:right">Position</th>
          <th style="padding:6px 10px;text-align:right">In body</th>
          <th style="padding:6px 10px;text-align:right">Density</th>
          <th style="padding:6px 10px;text-align:left">Where</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function exportStrategyCsv() {
  if (!csState.rows.length) { alert('Run a query first.'); return; }
  const bands = activeBandIds();
  const textFilter = (document.getElementById('csTextFilter').value || '').toLowerCase();
  const quickWinsOnly = !!document.getElementById('csQuickWins')?.checked;
  const rows = csState.rows.filter(r =>
    bands.has(r.band.id) &&
    (!textFilter || r.page.toLowerCase().includes(textFilter)) &&
    (!quickWinsOnly || r.isQuickWin === true)
  );
  const headers = [
    'page','band','impressions','clicks','ctr','position','potential_clicks','target_position',
    'crawl_title','crawl_word_count',
    'coverage_analysed','page_word_count','queries_analysed',
    'queries_in_title','queries_in_h1','queries_in_body',
    'missing_queries_count','missing_queries_impressions','missing_queries_top','quick_win'
  ];
  const escape = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    const cov = r.coverage && Array.isArray(r.coverage.queries) ? r.coverage : null;
    let pageWords = '', qAnalysed = '', inTitle = '', inH1 = '', inBody = '';
    let missingCount = '', missingImpressions = '', missingTop = '';
    if (cov) {
      pageWords = cov.wordCount || 0;
      qAnalysed = cov.queries.length;
      inTitle = cov.queries.filter(q => q.phrase.inTitle).length;
      inH1 = cov.queries.filter(q => q.phrase.inH1).length;
      inBody = cov.queries.filter(q => q.phrase.bodyOccurrences > 0).length;
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
      r.crawl ? r.crawl.title : '',
      r.crawl ? r.crawl.wordCount : '',
      cov ? 'yes' : 'no',
      pageWords, qAnalysed, inTitle, inH1, inBody,
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
