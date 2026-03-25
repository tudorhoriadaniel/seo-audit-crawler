/* global io */
const socket = io();
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
    if (view === 'history') loadHistory();
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

// ── Start Crawl ──
$('#startCrawl').addEventListener('click', startCrawl);
$('#urlInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') startCrawl(); });

// Save/Open project
$('#saveProject').addEventListener('click', async () => {
  if (!currentCrawlId) return alert('No crawl to save');
  window.open(`/api/crawls/${currentCrawlId}/export-project`, '_blank');
});
$('#openProject').addEventListener('click', () => $('#projectFileInput').click());
$('#projectFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const project = JSON.parse(text);
    const res = await fetch('/api/import-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
    const data = await res.json();
    if (data.error) return alert(data.error);
    analysisData = data.analysis;
    pagesData = data.pages;
    if (data.crawl) $('#urlInput').value = data.crawl.url || '';
    renderAll(data.analysis);
    $('#emptyState')?.classList.add('hidden');
    alert('Project loaded successfully!');
  } catch (err) { alert('Failed to load project: ' + err.message); }
  e.target.value = '';
});

function renderAll(analysis) {
  renderDashboard(analysis);
  renderAllPages(pagesData);
  renderIssues(analysis);
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
}

async function startCrawl() {
  const url = $('#urlInput').value.trim();
  if (!url) return;

  const body = {
    url,
    maxPages: parseInt($('#optMaxPages').value) || 500,
    maxDepth: parseInt($('#optMaxDepth').value) || 10,
    concurrency: parseInt($('#optConcurrency').value) || 5,
    respectRobots: $('#optRobots').checked,
    userAgent: $('#optUserAgent').value || undefined
  };

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
  renderIssues(data.analysis);
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
  $('#saveProject').style.display = '';
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
    window.location.href = `/api/crawls/${currentCrawlId}/export/${a.dataset.format}`;
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
  const pages = await res.json();
  renderPagesTable(pages);
}

function renderPagesTable(pages) {
  const filter = ($('#pagesFilter')?.value || '').toLowerCase();
  const statusFilter = $('#pagesStatusFilter')?.value;
  let filtered = pages;
  if (filter) filtered = filtered.filter(p => (p.url || '').toLowerCase().includes(filter));
  if (statusFilter) filtered = filtered.filter(p => String(p.status_code) === statusFilter);

  const html = `<table>
    <thead><tr>
      <th>URL</th><th>Status</th><th>Title</th><th>Title Len</th>
      <th>Meta Desc Len</th><th>H1 Count</th><th>Word Count</th>
      <th>Canonical</th><th>Hreflangs</th><th>Response (ms)</th><th>Depth</th>
    </tr></thead>
    <tbody>${filtered.map(p => `<tr class="page-row" data-url="${esc(p.url)}">
      <td class="url-cell" title="${esc(p.url)}">${truncate(p.url, 60)}</td>
      <td>${statusBadge(p.status_code)}</td>
      <td title="${esc(p.title || '')}">${truncate(p.title || '-', 40)}</td>
      <td>${p.title_length || 0}</td>
      <td>${p.meta_description_length || 0}</td>
      <td>${p.h1_count || 0}</td>
      <td>${p.word_count || 0}</td>
      <td title="${esc(p.canonical || '')}">${p.canonical ? (p.canonical_is_self ? '<span class="badge badge-success">Self</span>' : truncate(p.canonical, 30)) : '<span class="badge badge-muted">None</span>'}</td>
      <td>${JSON.parse(p.hreflangs || '[]').length || 0}</td>
      <td>${p.response_time || 0}</td>
      <td>${p.depth || 0}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  $('#pagesTable').innerHTML = html;

  // Click handler for page details
  $$('.page-row').forEach(row => {
    row.addEventListener('click', () => showPageDetail(row.dataset.url, pages));
  });
}

$('#pagesFilter')?.addEventListener('input', () => { if (currentCrawlId) loadPages(); });
$('#pagesStatusFilter')?.addEventListener('change', () => { if (currentCrawlId) loadPages(); });

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
      <div style="margin-bottom:12px"><button class="btn btn-sm" onclick="exportIssuesToCSV()">📥 Export Issues CSV</button></div>
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
        <td class="url-cell" title="${esc(i.from)}">${truncate(i.from, 40)}</td>
        <td class="url-cell" title="${esc(i.to)}">${truncate(i.to, 40)}</td>
        <td>${esc(i.lang)}</td>
        <td style="font-size:12px">${esc(i.message)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#hreflangContent').innerHTML = html;
}

// ── Canonicals ──
function renderCanonicals(analysis) {
  const r = analysis.canonicalReport;
  let html = `<div class="stats-grid">
    ${statCard('Total Pages', r.total, '')}
    ${statCard('With Canonical', r.withCanonical, 'info')}
    ${statCard('Self-Referencing', r.selfReferencing, 'success')}
    ${statCard('Canonicalized (Other)', r.canonicalized, 'warning')}
    ${statCard('Missing Canonical', r.missing, r.missing > 0 ? 'danger' : 'success')}
  </div>`;

  if (r.canonicalizedPages.length > 0) {
    html += `<div class="section-card"><h3>Canonicalized to Other URLs (${r.canonicalizedPages.length})</h3>
      <table><thead><tr><th>Page URL</th><th>Canonical Points To</th></tr></thead>
      <tbody>${r.canonicalizedPages.map(p => `<tr>
        <td class="url-cell" title="${esc(p.url)}">${truncate(p.url, 50)}</td>
        <td title="${esc(p.canonical)}">${truncate(p.canonical, 50)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  if (r.missingPages.length > 0) {
    html += `<div class="section-card"><h3>Pages Missing Canonical (${r.missingPages.length})</h3>
      <table><thead><tr><th>URL</th></tr></thead>
      <tbody>${r.missingPages.map(u => `<tr><td class="url-cell" title="${esc(u)}">${truncate(u, 80)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  $('#canonicalsContent').innerHTML = html;
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

  $('#conflictsContent').innerHTML = html;
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
        <td class="url-cell" title="${esc(c.originalUrl)}">${truncate(c.originalUrl, 40)}</td>
        <td title="${esc(c.finalUrl)}">${truncate(c.finalUrl, 40)}</td>
        <td>${c.hops} ${c.isLong ? '<span class="badge badge-danger">Long</span>' : ''}</td>
        <td style="font-size:11px">${c.chain.map(s => `${s.statusCode}`).join(' → ')}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#redirectsContent').innerHTML = html;
}

// ── Content ──
function renderContent(analysis) {
  const r = analysis.contentAnalysis;
  const d = analysis.duplicates;

  let html = `<div class="stats-grid">
    ${statCard('Avg Word Count', r.avgWordCount, r.avgWordCount < 300 ? 'warning' : '')}
    ${statCard('Avg Text Ratio', r.avgTextRatio + '%', '')}
    ${statCard('Thin Pages (<300w)', r.thinPages.length, r.thinPages.length > 0 ? 'warning' : 'success')}
    ${statCard('Duplicate Titles', d.duplicateTitles.length, d.duplicateTitles.length > 0 ? 'warning' : 'success')}
    ${statCard('Duplicate Descriptions', d.duplicateDescriptions.length, d.duplicateDescriptions.length > 0 ? 'warning' : 'success')}
    ${statCard('Duplicate Content', d.duplicateContent.length, d.duplicateContent.length > 0 ? 'warning' : 'success')}
  </div>`;

  if (r.thinPages.length > 0) {
    html += `<div class="section-card"><h3>Thin Content Pages</h3>
      <table><thead><tr><th>URL</th><th>Word Count</th></tr></thead>
      <tbody>${r.thinPages.slice(0, 50).map(p => `<tr><td class="url-cell">${truncate(p.url, 60)}</td><td>${p.wordCount}</td></tr>`).join('')}</tbody></table></div>`;
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

  $('#contentContent').innerHTML = html;
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
        <td>${i.src ? urlLink(i.src, 50) : '<span style="color:var(--text-muted)">No src</span>'}</td>
        <td>${urlLink(i.pageUrl, 45)}</td>
        <td>${i.issue === 'Missing alt attribute' ? '<span class="badge badge-danger">Missing alt attr</span>' : '<span class="badge badge-warning">Empty alt text</span>'}</td>
        <td>${i.occurrences}</td>
      </tr>`).join('')}</tbody></table></div>`;
  } else {
    html += `<div class="section-card" style="text-align:center;padding:40px">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h3>All Images Have Alt Text</h3>
    </div>`;
  }

  $('#imagesContent').innerHTML = html;
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

  $('#structuredContent').innerHTML = html;
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

  $('#securityContent').innerHTML = html;
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
      <tbody>${r.orphanPages.slice(0, 50).map(u => `<tr><td class="url-cell">${truncate(u, 80)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  if (r.topLinkedPages.length > 0) {
    html += `<div class="section-card"><h3>Most Linked Pages (Top 50)</h3>
      <table><thead><tr><th>URL</th><th>Inbound Links</th></tr></thead>
      <tbody>${r.topLinkedPages.map(p =>
        `<tr><td>${urlLink(p.url)}</td><td><strong>${p.inboundLinks}</strong></td></tr>`
      ).join('')}</tbody></table></div>`;
  }

  $('#linksContent').innerHTML = html;
}

// ── History ──
async function loadHistory() {
  const res = await fetch('/api/crawls');
  const crawls = await res.json();
  if (crawls.length === 0) {
    $('#historyContent').innerHTML = '<p style="color:var(--text-muted)">No previous crawls.</p>';
    return;
  }

  $('#historyContent').innerHTML = crawls.map(c => {
    const stats = c.stats || {};
    return `<div class="history-item" data-id="${c.id}">
      <div>
        <div class="history-url">${esc(c.url)}</div>
        <div class="history-meta">${new Date(c.created_at).toLocaleString()} | ${stats.crawled || '?'} pages | ${((stats.duration || 0)/1000).toFixed(0)}s</div>
      </div>
      <div class="history-status">
        ${c.status === 'completed' ? '<span class="badge badge-success">Completed</span>' :
          c.status === 'running' ? '<span class="badge badge-info">Running</span>' :
          c.status === 'error' ? '<span class="badge badge-danger">Error</span>' :
          '<span class="badge badge-muted">' + esc(c.status) + '</span>'}
        <button class="btn btn-sm btn-secondary" style="margin-left:8px" onclick="loadCrawl('${c.id}')">Load</button>
        <button class="btn btn-sm btn-danger" style="margin-left:4px" onclick="deleteCrawl('${c.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
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
  renderIssues(analysis);
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

  $('#emptyState').classList.add('hidden');
  $('#dashboardContent').classList.remove('hidden');

  $$('.nav-link').forEach(l => l.classList.remove('active'));
  $('[data-view="dashboard"]').classList.add('active');
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-dashboard').classList.add('active');
};

window.deleteCrawl = async function(id) {
  if (!confirm('Delete this crawl?')) return;
  await fetch(`/api/crawls/${id}`, { method: 'DELETE' });
  loadHistory();
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

  $('#statuscodesContent').innerHTML = html;
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
        <td>${urlLink(a.from, 50)}</td>
        <td>${urlLink(a.to, 50)}</td>
        <td>${a.isNofollow ? '<span class="badge badge-warning">Yes</span>' : 'No'}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  $('#anchorsContent').innerHTML = html;
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
    ${cb('optimal', 'Optimal (30-60)', r.optimal, 'success')}
    ${cb('dup', 'Duplicates', r.duplicates.length, r.duplicates.length > 0 ? 'danger' : 'success')}
  </div>`;
  if (f === 'all' || f === 'missing') {
    if (r.missing.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Missing Title (${r.missing.length})</h3><table><thead><tr><th>URL</th></tr></thead><tbody>${r.missing.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'dup') {
    if (r.duplicates.length > 0) { html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Duplicate Titles (${r.duplicates.length} groups)</h3>`;
      for (const d of r.duplicates.slice(0,50)) html += `<div style="margin-bottom:16px;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px"><strong style="color:var(--text-muted)">"${esc(truncate(d.title,80))}"</strong> <span class="badge badge-danger">${d.count}x</span><table style="margin-top:8px"><tbody>${d.urls.map(u=>`<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
      html += `</div>`; }
  }
  if (f === 'all' || f === 'short') {
    if (r.tooShort.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Short (${r.tooShort.length})</h3><table><thead><tr><th>URL</th><th>Title</th><th>Len</th></tr></thead><tbody>${r.tooShort.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.title)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'long') {
    if (r.tooLong.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Long (${r.tooLong.length})</h3><table><thead><tr><th>URL</th><th>Title</th><th>Len</th></tr></thead><tbody>${r.tooLong.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.title)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('#metatitlesContent').innerHTML = html;
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
    ${cb('optimal', 'Optimal (70-160)', r.optimal, 'success')}
    ${cb('dup', 'Duplicates', r.duplicates.length, r.duplicates.length > 0 ? 'danger' : 'success')}
  </div>`;
  if (f === 'all' || f === 'missing') {
    if (r.missing.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Missing Description (${r.missing.length})</h3><table><thead><tr><th>URL</th></tr></thead><tbody>${r.missing.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'dup') {
    if (r.duplicates.length > 0) { html += `<div class="section-card" style="border-left:4px solid var(--danger)"><h3>Duplicate Descriptions (${r.duplicates.length} groups)</h3>`;
      for (const d of r.duplicates.slice(0,50)) html += `<div style="margin-bottom:16px;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px"><strong style="color:var(--text-muted)">"${esc(truncate(d.description,80))}"</strong> <span class="badge badge-danger">${d.count}x</span><table style="margin-top:8px"><tbody>${d.urls.map(u=>`<tr><td>${urlLink(u)}</td></tr>`).join('')}</tbody></table></div>`;
      html += `</div>`; }
  }
  if (f === 'all' || f === 'short') {
    if (r.tooShort.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Short (${r.tooShort.length})</h3><table><thead><tr><th>URL</th><th>Description</th><th>Len</th></tr></thead><tbody>${r.tooShort.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.metaDescription)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  if (f === 'all' || f === 'long') {
    if (r.tooLong.length > 0) html += `<div class="section-card" style="border-left:4px solid var(--warning)"><h3>Too Long (${r.tooLong.length})</h3><table><thead><tr><th>URL</th><th>Description</th><th>Len</th></tr></thead><tbody>${r.tooLong.slice(0,500).map(p=>`<tr><td>${urlLink(p.url)}</td><td>${esc(p.metaDescription)}</td><td>${p.length}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('#metadescriptionsContent').innerHTML = html;
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
        <tbody>${r.crawledNotInSitemap.slice(0, 200).map(u => `<tr><td class="url-cell" title="${esc(u)}">${esc(u)}</td></tr>`).join('')}</tbody></table>
      </div>`;
    }

    $('#sitemapsContent').innerHTML = html;
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
      <td class="url-cell" title="${esc(f.url)}">${esc(f.url)}</td>
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
        <td class="url-cell" title="${esc(u.url)}">${truncate(u.url, 60)}</td>
        <td>${statusBadge(u.statusCode)}</td>
        <td title="${esc(u.sitemap)}">${truncate(u.sitemap, 40)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Crawled pages not in sitemap
  if (r.crawledNotInSitemapCount > 0) {
    html += `<div class="section-card" style="border-left:4px solid var(--warning)">
      <h3>Crawled Pages Not in Sitemap (${r.crawledNotInSitemapCount})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">Indexable pages (200, no noindex) that were discovered during crawling but are not included in any sitemap.</p>
      <table><thead><tr><th>URL</th></tr></thead>
      <tbody>${r.crawledNotInSitemap.slice(0, 200).map(u => `<tr><td class="url-cell" title="${esc(u)}">${esc(u)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // Sitemap URLs not reached by crawl
  if (r.inSitemapNotCrawledCount > 0) {
    html += `<div class="section-card">
      <h3>Sitemap URLs Not Reached by Crawl (${r.inSitemapNotCrawledCount})</h3>
      <p style="color:var(--text-muted);margin-bottom:12px;font-size:13px">These URLs are in the sitemap but were not discovered during the crawl (possibly orphan pages or the crawl limit was reached).</p>
      <table><thead><tr><th>URL</th></tr></thead>
      <tbody>${r.inSitemapNotCrawled.slice(0, 200).map(u => `<tr><td class="url-cell" title="${esc(u)}">${esc(u)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  $('#sitemapsContent').innerHTML = html;
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
        <td><span class="badge badge-muted">${esc(b.statusLabel)}</span></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Raw robots.txt
  html += `<div class="section-card">
    <h3>Raw robots.txt</h3>
    <pre style="background:var(--bg);padding:16px;border-radius:8px;overflow-x:auto;font-size:12px;max-height:400px;overflow-y:auto;white-space:pre-wrap">${esc(r.rawRobotsTxt)}</pre>
  </div>`;

  $('#aibotsContent').innerHTML = html;
}

// ── Helpers ──
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function truncate(s, len) { s = s || ''; return s.length > len ? s.substring(0, len) + '...' : s; }
function urlLink(url, maxLen) {
  if (!url) return '-';
  const display = maxLen ? truncate(url, maxLen) : esc(url);
  return `<a href="${esc(url)}" target="_blank" rel="noopener" class="url-cell" title="${esc(url)}">${display}</a>`;
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
    table.style.tableLayout = 'auto'; // let browser auto-size first
    requestAnimationFrame(() => {
      const ths = table.querySelectorAll('th');
      ths.forEach(th => {
        if (th.querySelector('.col-resizer')) return;
        th.style.width = th.offsetWidth + 'px';
      });
      table.style.tableLayout = 'fixed';
      ths.forEach(th => {
        const handle = document.createElement('div');
        handle.className = 'col-resizer';
        th.style.position = 'relative';
        th.appendChild(handle);
        initResizeHandle(th, handle);
      });
    });
  });
}

function initResizeHandle(th, handle) {

  let startX, startW;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
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

// Load history on page load
loadHistory();
