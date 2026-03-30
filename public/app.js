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
      ${statCard('Images Missing Alt', o.imagesWithoutAlt, o.imagesWithoutAlt > 0 ? 'warning' : 'success')}
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
      const d = (c, p, inv = false) => {
        const diff = (c || 0) - (p || 0);
        if (diff === 0) return '<span style="color:var(--text-muted)">—</span>';
        const good = inv ? diff < 0 : diff > 0;
        const color = good ? 'var(--success)' : 'var(--danger)';
        const arrow = diff > 0 ? '▲' : '▼';
        return `<span style="color:${color};font-weight:600">${arrow} ${Math.abs(diff)}</span>`;
      };
      html += `
        <div style="margin-top:12px;padding:12px;background:var(--bg-tertiary);border-radius:8px">
          <strong style="font-size:13px">Latest vs Previous:</strong>
          <span style="margin-left:12px;font-size:12px">Pages: ${d(cur.crawled, prev.crawled)}</span>
          <span style="margin-left:12px;font-size:12px">2xx: ${d(cur.status2xx, prev.status2xx)}</span>
          <span style="margin-left:12px;font-size:12px">3xx: ${d(cur.status3xx, prev.status3xx, true)}</span>
          <span style="margin-left:12px;font-size:12px">4xx: ${d(cur.status4xx, prev.status4xx, true)}</span>
          <span style="margin-left:12px;font-size:12px">5xx: ${d(cur.status5xx, prev.status5xx, true)}</span>
          <span style="margin-left:12px;font-size:12px">Errors: ${d(cur.errors, prev.errors, true)}</span>
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
      ${detailItem('In Sitemap', p.in_sitemap ? 'Yes' : 'No')}
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
        ${detailItem('In Sitemap', p.in_sitemap ? 'Yes' : 'No')}
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
function renderConflicts(analysis) {
  const r = analysis.hreflangCanonicalConflicts;
  if (r.totalConflicts === 0) {
    $('#conflictsContent').innerHTML = `<div class="section-card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h3>No Hreflang/Canonical Conflicts Found</h3>
      <p style="color:var(--text-muted)">All pages with hreflang tags have consistent canonical tags.</p>
    </div>`;
    return;
  }

  let html = `<div class="stats-grid">
    ${statCard('Pages with Conflicts', r.totalPagesWithConflicts, 'danger')}
    ${statCard('Total Conflicts', r.totalConflicts, 'danger')}
  </div>
  <div class="section-card" style="border-left:4px solid var(--danger)">
    <h3>Why This Matters</h3>
    <p style="color:var(--text-muted);font-size:13px">When canonical tags and hreflang tags conflict, Google typically follows the canonical signal and may ignore hreflang annotations. This can cause the wrong language version to appear in search results for different regions.</p>
  </div>`;

  for (const page of r.pages) {
    const hasCritical = page.conflicts.some(c => c.severity === 'critical');
    html += `<div class="conflict-card ${hasCritical ? '' : 'warning'}">
      <div class="conflict-url">${esc(page.url)}</div>
      <div style="margin-bottom:12px;font-size:13px;color:var(--text-muted)">
        Canonical: <strong>${esc(page.canonical || 'None')}</strong> |
        Hreflangs: ${(page.hreflangs || []).map(h => `<span class="badge badge-info">${esc(h.lang)}</span>`).join(' ')}
      </div>
      ${page.conflicts.map(c => `<div class="conflict-item">
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
      <p style="margin-bottom:12px;color:var(--text-muted);font-size:13px">Pages where the URL path language doesn't match the content language, html lang attribute, or og:locale. For example, a <code>/en/</code> URL serving French content.</p>
      <table><thead><tr><th>URL</th><th>URL Lang</th><th>html lang</th><th>og:locale</th><th>Content Lang</th><th>Issues</th></tr></thead>
      <tbody>${lm.pages.slice(0, 100).map(p => {
        const urlLangMatch = p.url.match(/^https?:\/\/[^/]+\/([a-z]{2}(?:-[a-z]{2})?)\//i);
        const urlLang = urlLangMatch ? urlLangMatch[1] : '—';
        const issueList = p.issues.map(i => `<span class="badge badge-critical" style="margin:2px">${esc(i.message)}</span>`).join('');
        return `<tr>
          <td>${urlLink(p.url)}</td>
          <td><strong>${esc(urlLang)}</strong></td>
          <td>${esc(p.htmlLang || '—')}</td>
          <td>${esc(p.ogLocale || '—')}</td>
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
function renderImages(analysis) {
  const r = analysis.imageAnalysis;
  let html = `<div class="stats-grid">
    ${statCard('Total Images', r.totalImages, '')}
    ${statCard('Missing Alt Attr', r.missingAlt, r.missingAlt > 0 ? 'danger' : 'success')}
    ${statCard('Empty Alt Text', r.emptyAlt, r.emptyAlt > 0 ? 'warning' : 'success')}
    ${statCard('Unique Images with Issues', r.uniqueIssueImages || 0, r.uniqueIssueImages > 0 ? 'danger' : 'success')}
  </div>`;

  const issues = r.issueImages || [];
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
      <h3>All Images Have Alt Text</h3>
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
  let html = `<div class="stats-grid">
    ${statCard('Orphan Pages', r.orphanCount, r.orphanCount > 0 ? 'warning' : 'success')}
    ${statCard('Avg Internal Links', r.avgInternalLinks, '')}
  </div>`;

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
  let html = `<div class="stats-grid">
    ${statCard('Sitemap Files', r.files.length, 'info')}
    ${statCard('URLs in Sitemaps', r.totalSitemapUrls, '')}
    ${statCard('Source', r.fromRobots ? 'robots.txt' : 'Auto-discovered', r.fromRobots ? 'success' : 'warning')}
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
  return ''; // Export buttons removed
}
function exportSection(section) {
  if (!currentCrawlId) return;
  window.open(`/api/crawls/${currentCrawlId}/export-section/${section}`, '_blank');
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
