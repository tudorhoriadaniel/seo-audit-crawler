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
    headingStructure: JSON.parse(p.heading_structure || '[]')
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
  const pages = db.getPages(req.params.id);
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
  const { url, maxPages, maxDepth, concurrency, respectRobots, userAgent } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const crawlId = uuidv4();
  const config = {
    maxPages: Math.min(parseInt(maxPages) || 5000, 50000),
    maxDepth: Math.min(parseInt(maxDepth) || 10, 50),
    concurrency: Math.min(parseInt(concurrency) || 5, 20),
    respectRobots: respectRobots !== false,
    userAgent: userAgent || undefined
  };

  db.createCrawl(crawlId, parsedUrl.href, config);

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
    // Store robotsTxt and sitemapData in stats for later retrieval
    const statsWithExtra = {
      ...summary.stats,
      robotsTxt: summary.robotsTxt || null,
      sitemapData: summary.sitemapData || null
    };
    db.updateCrawlStatus(crawlId, 'completed', statsWithExtra);
    activeCrawls.delete(crawlId);

    // Run analysis
    const pages = db.getCrawlPages(crawlId);
    const resultsForAnalysis = mapPagesForAnalysis(pages);

    const analyzer = new Analyzer(resultsForAnalysis, {
      robotsTxt: summary.robotsTxt,
      sitemapData: summary.sitemapData
    });
    const analysis = analyzer.analyze();

    io.to(crawlId).emit('complete', { stats: summary.stats, analysis });
  };

  activeCrawls.set(crawlId, crawler);

  // Start crawl async
  crawler.start(parsedUrl.href).catch(err => {
    db.updateCrawlStatus(crawlId, 'error', { error: err.message });
    io.to(crawlId).emit('error', { message: err.message });
    activeCrawls.delete(crawlId);
  });

  res.json({ id: crawlId, url: parsedUrl.href, status: 'running' });
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

// Per-section XLSX export
app.get('/api/crawls/:id/export-section/:section', (req, res) => {
  const crawl = db.getCrawl(req.params.id);
  if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  const pages = db.getPages(req.params.id);
  const mapped = mapPagesForAnalysis(pages);
  const Analyzer = require('./lib/analyzer');
  const analysis = new Analyzer(mapped).analyze();
  const XLSX = require('xlsx');
  const section = req.params.section;

  let data = [];
  let sheetName = section;

  switch (section) {
    case 'issues':
      data = (analysis.issues || []).map(i => ({ URL: i.url, Severity: i.severity, Category: i.category, Issue: i.issue }));
      sheetName = 'Issues';
      break;
    case 'canonicals':
      data = mapped.filter(p => p.statusCode < 300).map(p => ({ URL: p.url, Canonical: p.canonical || '', 'Self-Referencing': p.canonicalIsSelf ? 'Yes' : 'No' }));
      sheetName = 'Canonicals';
      break;
    case 'hreflang':
      data = mapped.filter(p => p.hreflangs?.length > 0).map(p => ({ URL: p.url, Hreflangs: p.hreflangs.map(h => `${h.lang}: ${h.url}`).join(' | ') }));
      sheetName = 'Hreflang';
      break;
    case 'hreflang-canonical':
      data = (analysis.hreflangCanonicalReport?.conflicts || []).map(c => ({ URL: c.url, Canonical: c.canonical, Type: c.type, Details: c.details }));
      sheetName = 'Hreflang vs Canonical';
      break;
    case 'redirects':
      data = (analysis.redirectReport?.chains || []).map(r => ({ 'Original URL': r.url, 'Final URL': r.finalUrl, Hops: r.hops, Chain: (r.chain || []).map(c => `${c.statusCode}: ${c.url}`).join(' → ') }));
      sheetName = 'Redirects';
      break;
    case 'statuscodes':
      data = mapped.map(p => ({ URL: p.url, Status: p.statusCode, 'Final URL': p.finalUrl || '' }));
      sheetName = 'Status Codes';
      break;
    case 'metatitles':
      data = mapped.filter(p => p.statusCode < 300).map(p => ({ URL: p.url, Title: p.title || '', Length: p.titleLength || 0 }));
      sheetName = 'Meta Titles';
      break;
    case 'metadescriptions':
      data = mapped.filter(p => p.statusCode < 300).map(p => ({ URL: p.url, 'Meta Description': p.metaDescription || '', Length: p.metaDescriptionLength || 0 }));
      sheetName = 'Meta Descriptions';
      break;
    case 'images':
      data = (analysis.imageAnalysis?.issueImages || []).map(i => ({ 'Image URL': i.src, 'Found On': i.pageUrl, Issue: i.issue, Occurrences: i.occurrences }));
      sheetName = 'Image Issues';
      break;
    case 'anchors':
      data = (analysis.anchorsReport?.emptyAnchors || []).map(a => ({ 'Origin Page': a.from, 'Destination URL': a.to, Nofollow: a.isNofollow ? 'Yes' : 'No' }));
      sheetName = 'Empty Anchors';
      break;
    case 'sitemaps':
      const sm = analysis.sitemapReport || {};
      data = (sm.notInSitemap || []).map(u => ({ URL: u, Status: 'Crawled, not in sitemap' }));
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
      const lnk = analysis.internalLinksReport || {};
      data = (lnk.mostLinked || []).map(l => ({ URL: l.url, 'Inbound Links': l.inboundLinks }));
      sheetName = 'Internal Links';
      break;
    case 'allpages':
      data = mapped.map(p => ({ URL: p.url, Status: p.statusCode, Title: p.title || '', 'Title Length': p.titleLength || 0, 'Meta Description': (p.metaDescription || '').substring(0, 200), 'Meta Desc Length': p.metaDescriptionLength || 0, 'Word Count': p.wordCount || 0, Canonical: p.canonical || '', 'Response Time': p.responseTime || 0 }));
      sheetName = 'All Pages';
      break;
    case 'summary': {
      const sc = analysis.statusCodesReport || {};
      const mt = analysis.metaTitlesReport || {};
      const md = analysis.metaDescriptionsReport || {};
      data = [
        { Category: 'Total Pages', Value: sc.total || 0 },
        { Category: '2xx Pages', Value: sc.groups?.['2xx']?.urls?.length || 0 },
        { Category: '3xx Redirects', Value: sc.groups?.['3xx']?.urls?.length || 0 },
        { Category: '4xx Errors', Value: sc.groups?.['4xx']?.urls?.length || 0 },
        { Category: '5xx Errors', Value: sc.groups?.['5xx']?.urls?.length || 0 },
        { Category: 'Missing Titles', Value: mt.missing?.length || 0 },
        { Category: 'Duplicate Titles', Value: mt.duplicates?.length || 0 },
        { Category: 'Missing Descriptions', Value: md.missing?.length || 0 },
        { Category: 'Duplicate Descriptions', Value: md.duplicates?.length || 0 },
        { Category: 'Images Missing Alt', Value: analysis.imageAnalysis?.missingAlt || 0 },
        { Category: 'Critical Issues', Value: (analysis.issues || []).filter(i => i.severity === 'critical').length },
        { Category: 'Warnings', Value: (analysis.issues || []).filter(i => i.severity === 'warning').length },
      ];
      sheetName = 'Summary';
      break;
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
