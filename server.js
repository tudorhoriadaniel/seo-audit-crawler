const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const CrawlerEngine = require('./lib/crawler-engine');
const Analyzer = require('./lib/analyzer');
const CrawlDatabase = require('./lib/database');
const Exporter = require('./lib/exporter');

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, { cors: { origin: '*' } });

const db = new CrawlDatabase();

// Active crawls map
const activeCrawls = new Map();

app.use(express.json());

// ── Password protection ──
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'converta2026';
const cookieParser = (req) => {
  const raw = req.headers.cookie || '';
  const cookies = {};
  raw.split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) cookies[k] = v;
  });
  return cookies;
};

app.get('/login', (req, res) => {
  const error = req.query.error ? '<p style="color:#ef4444;margin-bottom:16px">Incorrect password</p>' : '';
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login - SEO Audit Crawler</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f1117;color:#e4e6ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#1a1d27;border:1px solid #2a2e3d;border-radius:12px;padding:40px;width:100%;max-width:400px;text-align:center}
h1{font-size:24px;margin-bottom:8px}p.sub{color:#8b8fa3;font-size:14px;margin-bottom:24px}
input{width:100%;padding:12px 16px;background:#141620;border:1px solid #2a2e3d;border-radius:8px;color:#e4e6ef;font-size:15px;margin-bottom:16px;outline:none}
input:focus{border-color:#6366f1}
button{width:100%;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#818cf8}</style></head><body>
<div class="login-box">
<h1>SEO Audit Crawler</h1><p class="sub">Enter password to access</p>
${error}
<form method="POST" action="/login"><input type="password" name="password" placeholder="Password" autofocus required><button type="submit">Login</button></form>
</div></body></html>`);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === SITE_PASSWORD) {
    // Set auth cookie (24h)
    res.setHeader('Set-Cookie', `seo_auth=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${req.secure ? '; Secure' : ''}`);
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'seo_auth=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/login');
});

// Auth middleware — protect everything except /login and /api/health
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/api/health') return next();
  const cookies = cookieParser(req);
  if (cookies.seo_auth === '1') return next();
  // For API calls return 401, for pages redirect to login
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Shared helper: map DB rows to analysis format ──
function mapPagesForAnalysis(pages) {
  return pages.map(p => ({
    ...p,
    statusCode: p.status_code,
    titleLength: p.title_length,
    metaDescriptionLength: p.meta_description_length,
    metaRobots: p.meta_robots,
    canonicalIsSelf: !!p.canonical_is_self,
    h1: JSON.parse(p.h1 || '[]'),
    h1Count: p.h1_count,
    h2Count: p.h2_count,
    wordCount: p.word_count,
    textRatio: p.text_ratio,
    responseTime: p.response_time,
    contentLength: p.content_length,
    internalLinks: p.internal_links,
    externalLinks: p.external_links,
    totalImages: p.images_total,
    imagesWithoutAlt: p.images_without_alt,
    hasStructuredData: !!p.has_structured_data,
    structuredData: JSON.parse(p.structured_data_types || '[]'),
    hasViewport: !!p.has_viewport,
    htmlLang: p.html_lang,
    ogTitle: p.og_title,
    ogDescription: p.og_description,
    ogImage: p.og_image,
    inSitemap: !!p.in_sitemap,
    hreflangs: JSON.parse(p.hreflangs || '[]'),
    hreflangCanonicalConflicts: JSON.parse(p.hreflang_canonical_conflicts || '[]'),
    redirectChain: JSON.parse(p.redirect_chain || '[]'),
    securityHeaders: JSON.parse(p.security_headers || '{}'),
    links: JSON.parse(p.links || '[]'),
    images: JSON.parse(p.images || '[]'),
    isHtml: (p.content_type || '').includes('html'),
    contentHash: p.content_hash,
    titleHash: p.title_hash,
    metaDescription: p.meta_description,
    blockedByRobots: !!p.blocked_by_robots,
    finalUrl: p.final_url,
    headingStructure: JSON.parse(p.heading_structure || '[]'),
    ogLocale: p.og_locale,
    detectedContentLang: p.detected_content_lang,
    languageMismatch: JSON.parse(p.language_mismatch || 'null')
  }));
}

// ── API Routes ──

// List crawls
app.get('/api/crawls', (req, res) => {
  const crawls = db.listCrawls(50);
  res.json(crawls.map(c => ({ ...c, stats: JSON.parse(c.stats || '{}') })));
});

// Export project JSON
app.get('/api/crawls/:id/export-project', (req, res) => {
  const crawl = db.getCrawl(req.params.id);
  if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  const pages = db.getCrawlPages(req.params.id);
  const mapped = mapPagesForAnalysis(pages);
  const analyzer = new Analyzer(mapped, { robotsTxt: crawl.robots_txt, sitemapData: crawl.sitemap_data ? JSON.parse(crawl.sitemap_data) : null });
  const analysis = analyzer.analyze();
  const project = { version: '2.0', crawl: { ...crawl, stats: JSON.parse(crawl.stats || '{}') }, pages: mapped, analysis };
  res.setHeader('Content-Disposition', `attachment; filename="seo-crawl-${req.params.id.slice(0,8)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(project);
});

// Import project JSON
app.post('/api/import-project', express.json({ limit: '200mb' }), (req, res) => {
  try {
    const project = req.body;
    if (!project.analysis || !project.pages) return res.status(400).json({ error: 'Invalid project file' });
    res.json({ analysis: project.analysis, pages: project.pages, crawl: project.crawl });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse project: ' + e.message });
  }
});

// Start a new crawl
app.post('/api/crawls', (req, res) => {
  const { url, maxPages, maxDepth, concurrency, respectRobots, userAgent, saveProject } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const domain = parsedUrl.hostname;
  const crawlId = uuidv4();
  const config = {
    maxPages: Math.min(parseInt(maxPages) || 5000, 50000),
    maxDepth: Math.min(parseInt(maxDepth) || 10, 50),
    concurrency: Math.min(parseInt(concurrency) || 5, 20),
    respectRobots: respectRobots !== false,
    userAgent: userAgent || undefined
  };

  const saved = saveProject ? 1 : 0;
  db.createCrawl(crawlId, parsedUrl.href, config, { saved, domain });

  // If not saving, clean up previous unsaved crawls for this domain
  if (!saveProject) {
    db.cleanupUnsavedCrawls(domain, crawlId);
  }

  const crawler = new CrawlerEngine(config);

  crawler.onProgress = (progress) => {
    io.to(crawlId).emit('progress', progress);
  };

  crawler.onPageCrawled = (pageData) => {
    try {
      db.insertPage(crawlId, pageData);
    } catch (e) { /* continue */ }

    io.to(crawlId).emit('page', {
      url: pageData.url,
      statusCode: pageData.statusCode,
      title: pageData.title,
      responseTime: pageData.responseTime,
      depth: pageData.depth,
      issues: (pageData.hreflangCanonicalConflicts || []).length +
              (!pageData.title ? 1 : 0) + (!pageData.metaDescription ? 1 : 0) +
              (!pageData.canonical ? 1 : 0) + (pageData.h1Count === 0 ? 1 : 0)
    });
  };

  crawler.onComplete = (summary) => {
    activeCrawls.delete(crawlId);

    // Run analysis
    const pages = db.getCrawlPages(crawlId);
    const resultsForAnalysis = mapPagesForAnalysis(pages);

    const analyzer = new Analyzer(resultsForAnalysis, {
      robotsTxt: summary.robotsTxt,
      sitemapData: summary.sitemapData
    });
    const analysis = analyzer.analyze();

    // Extract issue metrics from analysis to store alongside crawler stats
    const mt = analysis.metaTitlesReport || {};
    const md = analysis.metaDescriptionsReport || {};
    const hr = analysis.hreflangReport || {};
    const cr = analysis.canonicalReport || {};
    const ia = analysis.imageAnalysis || {};
    const issues = analysis.issues || [];
    const issueMetrics = {
      missingTitles: mt.missing?.length || 0,
      duplicateTitles: mt.duplicates?.length || 0,
      missingDescriptions: md.missing?.length || 0,
      duplicateDescriptions: md.duplicates?.length || 0,
      hreflangIssues: hr.totalReturnLinkIssues || 0,
      missingCanonicals: cr.missing || 0,
      imagesWithAltIssues: ia.uniqueIssueImages || 0,
      criticalIssues: issues.filter(i => i.severity === 'critical').length,
      warnings: issues.filter(i => i.severity === 'warning').length
    };

    // Store robotsTxt, sitemapData, and issue metrics in stats for history comparison
    const statsWithExtra = {
      ...summary.stats,
      ...issueMetrics,
      robotsTxt: summary.robotsTxt || null,
      sitemapData: summary.sitemapData || null
    };
    db.updateCrawlStatus(crawlId, 'completed', statsWithExtra);

    io.to(crawlId).emit('complete', { stats: { ...summary.stats, ...issueMetrics }, analysis });
  };

  activeCrawls.set(crawlId, crawler);

  // Start crawl async
  crawler.start(parsedUrl.href).catch(err => {
    db.updateCrawlStatus(crawlId, 'error', { error: err.message });
    io.to(crawlId).emit('error', { message: err.message });
    activeCrawls.delete(crawlId);
  });

  res.json({ id: crawlId, url: parsedUrl.href, domain, saved, status: 'running' });
});

// Get crawl details
app.get('/api/crawls/:id', (req, res) => {
  const crawl = db.getCrawl(req.params.id);
  if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  res.json({ ...crawl, stats: JSON.parse(crawl.stats || '{}'), config: JSON.parse(crawl.config || '{}') });
});

// Get crawl pages
app.get('/api/crawls/:id/pages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 1000, 10000);
  const offset = parseInt(req.query.offset) || 0;
  const statusCode = req.query.status ? parseInt(req.query.status) : null;

  const pages = db.getCrawlPages(req.params.id, { limit, offset, statusCode });
  res.json(pages);
});

// Get crawl analysis
app.get('/api/crawls/:id/analysis', (req, res) => {
  const pages = db.getCrawlPages(req.params.id);
  if (pages.length === 0) return res.status(404).json({ error: 'No pages found' });

  const crawl = db.getCrawl(req.params.id);
  const stats = JSON.parse(crawl?.stats || '{}');
  const resultsForAnalysis = mapPagesForAnalysis(pages);
  const analyzer = new Analyzer(resultsForAnalysis, { robotsTxt: stats.robotsTxt, sitemapData: stats.sitemapData });
  res.json(analyzer.analyze());
});

// Export
app.get('/api/crawls/:id/export/:format', (req, res) => {
  const pages = db.getCrawlPages(req.params.id);
  if (pages.length === 0) return res.status(404).json({ error: 'No pages found' });

  const crawl = db.getCrawl(req.params.id);
  const stats = JSON.parse(crawl?.stats || '{}');
  const resultsForAnalysis = mapPagesForAnalysis(pages);
  const analyzer = new Analyzer(resultsForAnalysis, { robotsTxt: stats.robotsTxt, sitemapData: stats.sitemapData });
  const analysis = analyzer.analyze();

  switch (req.params.format) {
    case 'csv':
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=seo-audit.csv');
      res.send(Exporter.toCSV(pages));
      break;
    case 'xlsx':
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=seo-audit.xlsx');
      res.send(Exporter.toXLSX(pages, analysis));
      break;
    case 'json':
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=seo-audit.json');
      res.send(Exporter.toJSON(pages, analysis));
      break;
    default:
      res.status(400).json({ error: 'Invalid format. Use csv, xlsx, or json' });
  }
});

// PDF Audit Report export
const { generatePDFReport } = require('./lib/pdf-report');
app.get('/api/crawls/:id/export-pdf', (req, res) => {
  try {
    const pages = db.getCrawlPages(req.params.id, { limit: 10000 });
    if (!pages.length) return res.status(404).json({ error: 'No pages found' });
    const crawl = db.getCrawl(req.params.id);
    const stats = JSON.parse(crawl?.stats || '{}');
    const mapped = mapPagesForAnalysis(pages);
    const analyzer = new Analyzer(mapped, { robotsTxt: stats.robotsTxt, sitemapData: stats.sitemapData });
    const analysis = analyzer.analyze();
    const siteUrl = crawl?.url || 'Unknown';
    generatePDFReport(res, analysis, siteUrl);
  } catch (err) {
    console.error('PDF export error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Per-section XLSX export
app.get('/api/crawls/:id/export-section/:section', (req, res) => {
  try {
  const crawl = db.getCrawl(req.params.id);
  if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  const pages = db.getCrawlPages(req.params.id);
  const mapped = mapPagesForAnalysis(pages);
  const Analyzer = require('./lib/analyzer');
  const analysis = new Analyzer(mapped).analyze();
  const XLSX = require('xlsx');
  const section = req.params.section;

  let data = [];
  let sheetName = section;

  switch (section) {
    case 'issues': {
      const allIssues = analysis.issues || [];
      if (allIssues.length === 0) {
        data = [{ Note: 'No issues found' }];
        sheetName = 'Issues';
        break;
      }
      // Group issues by category into separate sheets
      const byCategory = {};
      for (const i of allIssues) {
        const cat = i.category || 'Other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push({ URL: i.url, Issue: i.message || i.issue || '', Severity: i.severity, Type: i.type || '' });
      }
      const addSheet = (wb, rows, name) => {
        if (!rows.length) return;
        const ws = XLSX.utils.json_to_sheet(rows);
        const cols = Object.keys(rows[0]).map(k => ({ wch: Math.min(100, Math.max(k.length, ...rows.slice(0,100).map(r => String(r[k]||'').length)) + 2) }));
        ws['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      const wb2 = XLSX.utils.book_new();
      // Summary sheet first
      const summaryRows = Object.keys(byCategory).sort().map(cat => ({ Category: cat, 'Issue Count': byCategory[cat].length, 'Critical': byCategory[cat].filter(i => i.Severity === 'critical').length, 'Warning': byCategory[cat].filter(i => i.Severity === 'warning').length, 'Info': byCategory[cat].filter(i => i.Severity === 'info').length }));
      addSheet(wb2, summaryRows, 'Summary');
      // One sheet per category
      for (const cat of Object.keys(byCategory).sort()) {
        const sn = cat.replace(/[\\/*?\[\]:]/g, '').substring(0, 31) || 'Other';
        addSheet(wb2, byCategory[cat], sn);
      }
      const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=issues-by-category.xlsx');
      return res.send(buf2);
    }
    case 'canonicals': {
      const cr = analysis.canonicalReport || {};
      const addSheet = (wb, rows, name) => {
        if (!rows.length) return;
        const ws = XLSX.utils.json_to_sheet(rows);
        const cols = Object.keys(rows[0]).map(k => ({ wch: Math.min(100, Math.max(k.length, ...rows.slice(0,100).map(r => String(r[k]||'').length)) + 2) }));
        ws['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      const wb2 = XLSX.utils.book_new();
      addSheet(wb2, (cr.missingPages || []).map(u => ({ URL: u, Issue: 'Missing Canonical' })), 'Missing Canonical');
      addSheet(wb2, (cr.canonicalizedPages || []).map(p => ({ URL: p.url, 'Canonical URL': p.canonical, Type: 'Canonicalized to Other' })), 'Canonicalized to Other');
      addSheet(wb2, (cr.selfReferencingPages || []).map(u => ({ URL: u, 'Canonical URL': u, Type: 'Self-Referencing' })), 'Self-Referencing');
      if (!wb2.SheetNames.length) XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet([{ Note: 'No canonical issues found' }]), 'Canonicals');
      const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=canonicals.xlsx');
      return res.send(buf2);
    }
    case 'hreflang': {
      const hr = analysis.hreflangReport || {};
      const addSheet = (wb, rows, name) => {
        if (!rows.length) return;
        const ws = XLSX.utils.json_to_sheet(rows);
        const cols = Object.keys(rows[0]).map(k => ({ wch: Math.min(100, Math.max(k.length, ...rows.slice(0,100).map(r => String(r[k]||'').length)) + 2) }));
        ws['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      const wb2 = XLSX.utils.book_new();
      addSheet(wb2, (hr.returnLinkIssues || []).map(i => ({ 'From URL': i.from, 'To URL': i.to, Language: i.lang, Issue: i.message })), 'Return Link Issues');
      const pagesRows = mapped.filter(p => p.hreflangs?.length > 0).map(p => ({ URL: p.url, Hreflangs: p.hreflangs.map(h => `${h.lang}: ${h.href || h.url || ''}`).join(' | '), Count: p.hreflangs.length }));
      addSheet(wb2, pagesRows, 'All Hreflang Tags');
      if (!wb2.SheetNames.length) XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet([{ Note: 'No hreflang data found' }]), 'Hreflang');
      const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=hreflang.xlsx');
      return res.send(buf2);
    }
    case 'hreflang-canonical': {
      data = [];
      for (const page of (analysis.hreflangCanonicalConflicts?.pages || [])) {
        for (const c of (page.conflicts || [])) {
          data.push({ URL: page.url, Canonical: page.canonical || '', 'Conflict Type': c.type, Severity: c.severity, Message: c.message });
        }
      }
      sheetName = 'Hreflang vs Canonical';
      break;
    }
    case 'redirects':
      data = (analysis.redirectChains?.chains || []).map(r => ({ 'Original URL': r.originalUrl, 'Final URL': r.finalUrl, Hops: r.hops, Chain: (r.chain || []).map(c => `${c.statusCode}: ${c.url}`).join(' → ') }));
      sheetName = 'Redirects';
      break;
    case 'statuscodes': {
      const scFilter = req.query.filter || 'all';
      let scPages = mapped;
      if (scFilter === '2xx') scPages = mapped.filter(p => p.statusCode >= 200 && p.statusCode < 300);
      else if (scFilter === '3xx') scPages = mapped.filter(p => p.statusCode >= 300 && p.statusCode < 400);
      else if (scFilter === '4xx') scPages = mapped.filter(p => p.statusCode >= 400 && p.statusCode < 500);
      else if (scFilter === '5xx') scPages = mapped.filter(p => p.statusCode >= 500);
      else if (scFilter === 'error') scPages = mapped.filter(p => p.error);
      data = scPages.map(p => ({ URL: p.url, Status: p.statusCode, 'Final URL': p.finalUrl || '' }));
      sheetName = scFilter === 'all' ? 'Status Codes' : scFilter.toUpperCase() + ' Status Codes';
      break;
    }
    case 'metatitles': {
      const mt = analysis.metaTitlesReport || {};
      const mtFilter = req.query.filter || 'all';
      const addSheet = (wb, rows, name) => {
        if (!rows.length) return;
        const ws = XLSX.utils.json_to_sheet(rows);
        const cols = Object.keys(rows[0]).map(k => ({ wch: Math.min(100, Math.max(k.length, ...rows.slice(0,100).map(r => String(r[k]||'').length)) + 2) }));
        ws['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      const wb2 = XLSX.utils.book_new();
      if (mtFilter === 'all' || mtFilter === 'missing') addSheet(wb2, (mt.missing || []).map(p => ({ URL: p.url, Issue: 'Missing Title' })), 'Missing Title');
      if (mtFilter === 'all' || mtFilter === 'short') addSheet(wb2, (mt.tooShort || []).map(p => ({ URL: p.url, Title: p.title, Length: p.length, Issue: 'Too Short (<30 chars)' })), 'Too Short');
      if (mtFilter === 'all' || mtFilter === 'long') addSheet(wb2, (mt.tooLong || []).map(p => ({ URL: p.url, Title: p.title, Length: p.length, Issue: 'Too Long (>60 chars)' })), 'Too Long');
      if (mtFilter === 'all' || mtFilter === 'dup') {
        const dupRows = [];
        for (const d of (mt.duplicates || [])) for (const u of d.urls) dupRows.push({ URL: u, Title: d.title, 'Group Count': d.count });
        addSheet(wb2, dupRows, 'Duplicate Titles');
      }
      if (!wb2.SheetNames.length) XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet([{ Note: 'No meta title issues found' }]), 'Meta Titles');
      const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=meta-titles-issues.xlsx');
      return res.send(buf2);
    }
    case 'metadescriptions': {
      const md = analysis.metaDescriptionsReport || {};
      const mdFilter = req.query.filter || 'all';
      const addSheet = (wb, rows, name) => {
        if (!rows.length) return;
        const ws = XLSX.utils.json_to_sheet(rows);
        const cols = Object.keys(rows[0]).map(k => ({ wch: Math.min(100, Math.max(k.length, ...rows.slice(0,100).map(r => String(r[k]||'').length)) + 2) }));
        ws['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      const wb2 = XLSX.utils.book_new();
      if (mdFilter === 'all' || mdFilter === 'missing') addSheet(wb2, (md.missing || []).map(p => ({ URL: p.url, Issue: 'Missing Meta Description' })), 'Missing Description');
      if (mdFilter === 'all' || mdFilter === 'short') addSheet(wb2, (md.tooShort || []).map(p => ({ URL: p.url, 'Meta Description': p.metaDescription, Length: p.length, Issue: 'Too Short (<70 chars)' })), 'Too Short');
      if (mdFilter === 'all' || mdFilter === 'long') addSheet(wb2, (md.tooLong || []).map(p => ({ URL: p.url, 'Meta Description': p.metaDescription, Length: p.length, Issue: 'Too Long (>160 chars)' })), 'Too Long');
      if (mdFilter === 'all' || mdFilter === 'dup') {
        const dupRows = [];
        for (const d of (md.duplicates || [])) for (const u of d.urls) dupRows.push({ URL: u, 'Meta Description': d.description, 'Group Count': d.count });
        addSheet(wb2, dupRows, 'Duplicate Descriptions');
      }
      if (!wb2.SheetNames.length) XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet([{ Note: 'No meta description issues found' }]), 'Meta Descriptions');
      const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=meta-descriptions-issues.xlsx');
      return res.send(buf2);
    }
    case 'images': {
      let imgIssues = analysis.imageAnalysis?.issueImages || [];
      const imgFilter = req.query.filter || 'all';
      if (imgFilter === 'missingalt') imgIssues = imgIssues.filter(i => i.issue === 'Missing alt attribute');
      else if (imgFilter === 'emptyalt') imgIssues = imgIssues.filter(i => i.issue !== 'Missing alt attribute');
      data = imgIssues.map(i => ({ 'Image URL': i.src || '(no src)', 'Found On': i.pageUrl, Issue: i.issue, Occurrences: i.occurrences }));
      sheetName = imgFilter === 'all' ? 'Image Alt Issues' : imgFilter === 'missingalt' ? 'Missing Alt Attr' : 'Empty Alt Text';
      break;
    }
    case 'anchors':
      data = (analysis.anchorsReport?.emptyAnchors || []).map(a => ({ 'Origin Page': a.from, 'Destination URL': a.to, Nofollow: a.isNofollow ? 'Yes' : 'No' }));
      sheetName = 'Empty Anchors';
      break;
    case 'sitemaps':
      const sm = analysis.sitemapReport || {};
      data = (sm.crawledNotInSitemap || []).map(u => ({ URL: u, Status: 'Crawled, not in sitemap' }));
      (sm.inSitemapNotCrawled || []).forEach(u => data.push({ URL: u, Status: 'In sitemap, not crawled' }));
      sheetName = 'Sitemap Analysis';
      break;
    case 'content':
      data = mapped.filter(p => p.statusCode < 300).map(p => ({ URL: p.url, 'Word Count': p.wordCount || 0, 'H1 Count': p.h1Count || 0, 'H2 Count': p.h2Count || 0, 'Response Time (ms)': p.responseTime || 0 }));
      sheetName = 'Content';
      break;
    case 'structured':
      data = mapped.filter(p => p.statusCode < 300).map(p => ({ URL: p.url, 'Has Schema': p.hasStructuredData ? 'Yes' : 'No', Types: (p.structuredData || []).join(', ') }));
      sheetName = 'Structured Data';
      break;
    case 'security':
      data = mapped.filter(p => p.statusCode < 300).map(p => ({ URL: p.url, HTTPS: p.url.startsWith('https') ? 'Yes' : 'No', HSTS: p.securityHeaders?.['strict-transport-security'] ? 'Yes' : 'No', 'X-Frame-Options': p.securityHeaders?.['x-frame-options'] || 'Missing' }));
      sheetName = 'Security';
      break;
    case 'links':
      const lnk = analysis.internalLinkAnalysis || {};
      data = (lnk.mostLinked || []).map(l => ({ URL: l.url, 'Inbound Links': l.inboundLinks }));
      sheetName = 'Internal Links';
      break;
    case 'headings':
      data = mapped.filter(p => p.statusCode < 300).map(p => ({ URL: p.url, 'H1 Count': p.h1Count || 0, 'H1 Tags': (p.h1 || []).join(' | '), 'H2 Count': p.h2Count || 0 }));
      sheetName = 'Headings';
      break;
    case 'directives':
      data = mapped.filter(p => p.statusCode < 300).map(p => ({ URL: p.url, 'Meta Robots': p.metaRobots || 'None' }));
      sheetName = 'Directives';
      break;
    case 'allpages':
      data = mapped.map(p => ({ URL: p.url, Status: p.statusCode, 'Meta Title': p.title || '', 'Title Length': p.titleLength || 0, 'Meta Description': p.metaDescription || '', 'Desc Length': p.metaDescriptionLength || 0, H1: (p.h1 || [])[0] || '', 'H1 Count': p.h1Count || 0, 'H2 Count': p.h2Count || 0, 'Word Count': p.wordCount || 0, Canonical: p.canonical || '', 'Hreflangs': (p.hreflangs || []).map(h => h.lang).join(', '), 'Schema Types': (p.structuredData || []).join(', '), Directives: p.metaRobots || 'index, follow', 'Response Time': p.responseTime || 0, Depth: p.depth || 0 }));
      sheetName = 'All Pages';
      break;
    case 'summary': {
      const sc = analysis.statusCodesReport || {};
      const mt = analysis.metaTitlesReport || {};
      const md = analysis.metaDescriptionsReport || {};
      const img = analysis.imageAnalysis || {};
      const hdg = analysis.headingsReport || {};
      const can = analysis.canonicalReport || {};
      const hrf = analysis.hreflangReport || {};
      const cnt = analysis.contentAnalysis || {};
      const addSheet = (wb, rows, name) => {
        if (!rows || !rows.length) return;
        const ws = XLSX.utils.json_to_sheet(rows);
        const cols = Object.keys(rows[0]).map(k => ({ wch: Math.min(120, Math.max(k.length, ...rows.slice(0,100).map(r => String(r[k]||'').length)) + 2) }));
        ws['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
      };
      const wb2 = XLSX.utils.book_new();

      // Summary overview sheet
      addSheet(wb2, [
        { Category: 'Total Pages', Value: sc.total || 0 },
        { Category: '2xx Pages', Value: sc.groups?.['2xx']?.urls?.length || 0 },
        { Category: '3xx Redirects', Value: sc.groups?.['3xx']?.urls?.length || 0 },
        { Category: '4xx Errors', Value: sc.groups?.['4xx']?.urls?.length || 0 },
        { Category: '5xx Errors', Value: sc.groups?.['5xx']?.urls?.length || 0 },
        { Category: 'Missing Titles', Value: mt.missing?.length || 0 },
        { Category: 'Too Short Titles (<30)', Value: mt.tooShort?.length || 0 },
        { Category: 'Too Long Titles (>60)', Value: mt.tooLong?.length || 0 },
        { Category: 'Duplicate Titles', Value: mt.duplicates?.length || 0 },
        { Category: 'Missing Descriptions', Value: md.missing?.length || 0 },
        { Category: 'Too Short Descriptions (<70)', Value: md.tooShort?.length || 0 },
        { Category: 'Too Long Descriptions (>160)', Value: md.tooLong?.length || 0 },
        { Category: 'Duplicate Descriptions', Value: md.duplicates?.length || 0 },
        { Category: 'Missing H1', Value: hdg.missingH1?.length || 0 },
        { Category: 'Multiple H1s', Value: hdg.multipleH1?.length || 0 },
        { Category: 'Missing Canonical', Value: can.missing || 0 },
        { Category: 'Images Missing Alt', Value: img.missingAlt || 0 },
        { Category: 'Thin Content (<300 words)', Value: (cnt.thinPages || []).length },
        { Category: 'Critical Issues', Value: (analysis.issues || []).filter(i => i.severity === 'critical').length },
        { Category: 'Warnings', Value: (analysis.issues || []).filter(i => i.severity === 'warning').length },
      ], 'Summary');

      // 4xx Errors
      if (sc.groups?.['4xx']?.urls?.length > 0) addSheet(wb2, sc.groups['4xx'].urls.map(u => ({ URL: u.url, Status: u.statusCode })), '4xx Errors');
      // 3xx Redirects
      if (sc.groups?.['3xx']?.urls?.length > 0) addSheet(wb2, sc.groups['3xx'].urls.map(u => ({ URL: u.url, Status: u.statusCode, 'Redirects To': u.finalUrl || '' })), '3xx Redirects');
      // Missing Titles
      if (mt.missing?.length > 0) addSheet(wb2, mt.missing.map(p => ({ URL: p.url })), 'Missing Titles');
      // Too Short Titles
      if (mt.tooShort?.length > 0) addSheet(wb2, mt.tooShort.map(p => ({ URL: p.url, Title: p.title, Length: p.length })), 'Short Titles');
      // Too Long Titles
      if (mt.tooLong?.length > 0) addSheet(wb2, mt.tooLong.map(p => ({ URL: p.url, Title: p.title, Length: p.length })), 'Long Titles');
      // Duplicate Titles
      if (mt.duplicates?.length > 0) {
        const dupRows = [];
        for (const d of mt.duplicates) for (const u of d.urls) dupRows.push({ URL: u, Title: d.title, 'Group Count': d.count });
        addSheet(wb2, dupRows, 'Duplicate Titles');
      }
      // Missing Descriptions
      if (md.missing?.length > 0) addSheet(wb2, md.missing.map(p => ({ URL: p.url })), 'Missing Descriptions');
      // Too Short Descriptions
      if (md.tooShort?.length > 0) addSheet(wb2, md.tooShort.map(p => ({ URL: p.url, 'Meta Description': p.metaDescription, Length: p.length })), 'Short Descriptions');
      // Too Long Descriptions
      if (md.tooLong?.length > 0) addSheet(wb2, md.tooLong.map(p => ({ URL: p.url, 'Meta Description': p.metaDescription, Length: p.length })), 'Long Descriptions');
      // Duplicate Descriptions
      if (md.duplicates?.length > 0) {
        const dupRows = [];
        for (const d of md.duplicates) for (const u of d.urls) dupRows.push({ URL: u, 'Meta Description': d.description, 'Group Count': d.count });
        addSheet(wb2, dupRows, 'Duplicate Descriptions');
      }
      // Missing H1
      if (hdg.missingH1?.length > 0) addSheet(wb2, hdg.missingH1.map(p => ({ URL: p.url })), 'Missing H1');
      // Multiple H1s
      if (hdg.multipleH1?.length > 0) addSheet(wb2, hdg.multipleH1.map(p => ({ URL: p.url, 'H1 Count': p.h1Count, 'H1 Tags': (p.h1Tags || []).join(' | ') })), 'Multiple H1s');
      // Missing Canonical
      if (can.missingPages?.length > 0) addSheet(wb2, can.missingPages.map(u => ({ URL: u })), 'Missing Canonical');
      // Canonicalized to Other
      if (can.canonicalizedPages?.length > 0) addSheet(wb2, can.canonicalizedPages.map(p => ({ URL: p.url, 'Canonical URL': p.canonical })), 'Canonicalized to Other');
      // Images Missing Alt
      if (img.issueImages?.length > 0) addSheet(wb2, img.issueImages.map(i => ({ 'Image URL': i.src || '(no src)', 'Found On': i.pageUrl, Issue: i.issue, Occurrences: i.occurrences })), 'Image Alt Issues');
      // Thin Content
      if (cnt.thinPages?.length > 0) addSheet(wb2, cnt.thinPages.map(p => ({ URL: p.url, 'Word Count': p.wordCount })), 'Thin Content');
      // Hreflang Return Link Issues
      if (hrf.returnLinkIssues?.length > 0) addSheet(wb2, hrf.returnLinkIssues.map(i => ({ 'From URL': i.from, 'To URL': i.to, Language: i.lang, Issue: i.message })), 'Hreflang Issues');
      // Redirects
      const rdc = analysis.redirectChains?.chains || [];
      if (rdc.length > 0) addSheet(wb2, rdc.map(r => ({ 'Original URL': r.originalUrl, 'Final URL': r.finalUrl, Hops: r.hops })), 'Redirect Chains');

      const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=full-seo-audit.xlsx');
      return res.send(buf2);
    }
    default:
      return res.status(400).json({ error: 'Unknown section' });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  // Auto-size columns
  if (data.length > 0) {
    const cols = Object.keys(data[0]).map(k => {
      const maxLen = Math.max(k.length, ...data.slice(0, 100).map(r => String(r[k] || '').length));
      return { wch: Math.min(80, maxLen + 2) };
    });
    ws['!cols'] = cols;
  }
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${section}-export.xlsx`);
  res.send(buf);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Export filtered pages (POST with row data from client)
app.post('/api/crawls/:id/export-filtered-xlsx', (req, res) => {
  try {
    const { rows, sheetName, fileName } = req.body;
    if (!rows || !rows.length) return res.status(400).json({ error: 'No data to export' });
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    if (rows.length > 0) {
      const cols = Object.keys(rows[0]).map(k => {
        const maxLen = Math.max(k.length, ...rows.slice(0, 100).map(r => String(r[k] || '').length));
        return { wch: Math.min(100, maxLen + 2) };
      });
      ws['!cols'] = cols;
    }
    const sn = (sheetName || 'Filtered').replace(/[\\/*?\[\]:]/g, '').substring(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sn);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName || 'export'}.xlsx`);
    res.send(buf);
  } catch (err) {
    console.error('Filtered export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// Pause/Resume/Abort
app.post('/api/crawls/:id/pause', (req, res) => {
  const crawler = activeCrawls.get(req.params.id);
  if (!crawler) return res.status(404).json({ error: 'Crawl not active' });
  crawler.pause();
  res.json({ status: 'paused' });
});

app.post('/api/crawls/:id/resume', (req, res) => {
  const crawler = activeCrawls.get(req.params.id);
  if (!crawler) return res.status(404).json({ error: 'Crawl not active' });
  crawler.resume();
  res.json({ status: 'resumed' });
});

app.post('/api/crawls/:id/abort', (req, res) => {
  const crawler = activeCrawls.get(req.params.id);
  if (!crawler) return res.status(404).json({ error: 'Crawl not active' });
  crawler.abort();
  db.updateCrawlStatus(req.params.id, 'aborted', crawler.stats);
  activeCrawls.delete(req.params.id);
  res.json({ status: 'aborted' });
});

// Delete crawl
app.delete('/api/crawls/:id', (req, res) => {
  db.deleteCrawl(req.params.id);
  res.json({ deleted: true });
});

// Get crawl history for a domain (for evolution comparison)
// List all saved projects (grouped by domain)
app.get('/api/projects', (req, res) => {
  const projects = db.getSavedProjects();
  res.json(projects);
});

app.get('/api/projects/:domain/history', (req, res) => {
  const crawls = db.getCrawlsByDomain(req.params.domain, 20);
  res.json(crawls.map(c => ({ ...c, stats: JSON.parse(c.stats || '{}') })));
});

// Toggle saved status for a crawl
app.patch('/api/crawls/:id/saved', (req, res) => {
  const { saved } = req.body;
  db.setCrawlSaved(req.params.id, saved);
  // If unsaving, clean up old unsaved crawls for same domain
  const crawl = db.getCrawl(req.params.id);
  if (!saved && crawl) {
    const domain = crawl.domain || new URL(crawl.url).hostname;
    db.cleanupUnsavedCrawls(domain, req.params.id);
  }
  res.json({ saved: !!saved });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeCrawls: activeCrawls.size });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── WebSocket ──
io.on('connection', (socket) => {
  socket.on('join', (crawlId) => {
    socket.join(crawlId);
  });
  socket.on('leave', (crawlId) => {
    socket.leave(crawlId);
  });
});

// ── Start ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`SEO Audit Crawler running on port ${PORT}`);
});
