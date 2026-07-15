const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const CrawlerEngine = require('./lib/crawler-engine');
const Analyzer = require('./lib/analyzer');
const CrawlDatabase = require('./lib/database');
const Exporter = require('./lib/exporter');
const gsc = require('./lib/gsc');
const contentAnalyzer = require('./lib/content-analyzer');

// Anthropic client for the in-app audit assistant chat. Optional — if
// ANTHROPIC_API_KEY isn't set, /api/chat returns a friendly 503 and the
// UI hides the button.
const Anthropic = require('@anthropic-ai/sdk');
const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const app = express();
const server = http.createServer(app);
// maxHttpBufferSize: socket.io silently drops any single message larger than
// this (default 1 MB). We no longer send the (multi-MB) analysis over the
// socket — it goes via HTTP — but bump the cap to 10 MB so live page/progress
// events always have generous headroom and never get dropped silently.
const io = new SocketIO(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e7 });

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

// Only same-origin paths are allowed in ?next= to prevent the login
// page being turned into an open redirector to evil.example.com.
function safeNext(value) {
  const v = String(value || '');
  if (!v) return '/';
  if (!v.startsWith('/') || v.startsWith('//')) return '/';
  return v;
}

app.get('/login', (req, res) => {
  const error = req.query.error ? '<p style="color:#ef4444;margin-bottom:16px">Incorrect password</p>' : '';
  const next = safeNext(req.query.next);
  // Escape the next value for safe HTML attribute embedding.
  const nextAttr = next.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
<form method="POST" action="/login"><input type="hidden" name="next" value="${nextAttr}"><input type="password" name="password" placeholder="Password" autofocus required><button type="submit">Login</button></form>
</div></body></html>`);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const next = safeNext(req.body.next);
  if (req.body.password === SITE_PASSWORD) {
    // Set auth cookie (24h). SameSite=Lax so the cookie survives the
    // OAuth round-trip back from accounts.google.com to our callback;
    // Strict would drop it on any cross-site-initiated navigation.
    res.setHeader('Set-Cookie', `seo_auth=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${req.secure ? '; Secure' : ''}`);
    res.redirect(next);
  } else {
    res.redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'seo_auth=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/login');
});

// Auth middleware — protect everything except /login, /api/health, and the
// GSC OAuth callback (Google's redirect back loses the SameSite=Strict cookie;
// the random `state` param provides CSRF protection on that route).
app.use((req, res, next) => {
  if (
    req.path === '/login' ||
    req.path === '/api/health' ||
    req.path === '/api/gsc/oauth/callback'
  ) return next();
  const cookies = cookieParser(req);
  if (cookies.seo_auth === '1') return next();
  // For API calls return 401, for pages redirect to login. Preserve the
  // original URL via ?next= so /share/<id> survives the login round-trip
  // and the recipient lands back on the report after authenticating.
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  const target = encodeURIComponent(req.originalUrl || req.url || '/');
  res.redirect(`/login?next=${target}`);
});

app.use(express.static(path.join(__dirname, 'public')));

// Loose hreflang-equivalence key. Treats encoding (literal Unicode vs %xx),
// non-root trailing slash and host case as equivalent — Google does too.
// Used here to retroactively drop crawler-time false positives stored in
// pages.hreflang_canonical_conflicts without needing a re-crawl.
function hreflangKey(u, base) {
  if (!u) return '';
  try {
    const x = new URL(u, base || undefined);
    x.hash = '';
    let h = x.href;
    if (x.pathname !== '/' && h.endsWith('/')) h = h.slice(0, -1);
    return h.toLowerCase();
  } catch { return String(u).toLowerCase(); }
}

// Drop conflict entries that an older, strict-comparison crawler emitted but
// the loose hreflang-equivalence key reveals as false positives. Currently
// covers `missing_self_referencing_hreflang` (the one that produced the "no
// self" badges on URLs with literal-unicode vs percent-encoded mismatch).
function filterStaleHreflangConflicts(conflicts, pageUrl, hreflangs, canonical) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return conflicts || [];
  const pageKey = hreflangKey(pageUrl, pageUrl);
  const canonicalKey = canonical ? hreflangKey(canonical, pageUrl) : null;
  const hreflangKeys = (hreflangs || []).map(h => hreflangKey(h.href, pageUrl));
  return conflicts.filter(c => {
    if (c.type !== 'missing_self_referencing_hreflang') return true;
    // If any hreflang matches the page key (or the canonical's key) under
    // the loose equivalence, the original "missing self-ref" verdict was a
    // false positive — drop it.
    const hasSelfRef = hreflangKeys.some(k => k === pageKey || (canonicalKey && k === canonicalKey));
    return !hasSelfRef;
  });
}

// Decode a URL for display so diacritics show as letters (…/qualité) instead
// of the wire form (…/qualit%C3%A9), matching how Google Search Console
// reports them. decodeURI leaves structural reserved chars (/ ? & # =) alone.
function decodeUrlSafe(s) { try { return decodeURI(s); } catch { return s; } }
// True only for string cells that actually hold a URL (http(s):// or //) at
// the start of the value or a line — so URL columns get decoded while titles /
// meta descriptions (which may contain a stray %) are left untouched.
const _looksLikeUrlCell = (v) => typeof v === 'string' && /(^|\n)\s*(https?:)?\/\//.test(v);
// Decode URL cells in an array of row objects (json_to_sheet input).
function decodeUrlCells(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => {
    if (!r || typeof r !== 'object') return r;
    const out = {};
    for (const k of Object.keys(r)) out[k] = _looksLikeUrlCell(r[k]) ? decodeUrlSafe(r[k]) : r[k];
    return out;
  });
}
// Decode URL cells in an array-of-arrays (aoa_to_sheet input).
function decodeUrlCellsAoa(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => Array.isArray(row)
    ? row.map(v => _looksLikeUrlCell(v) ? decodeUrlSafe(v) : v)
    : row);
}

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
    // Re-validate `missing_self_referencing_hreflang` on read with the loose
    // hreflang-equivalence key (encoding/trailing-slash/case insensitive).
    // The crawler's old, strict comparison falsely flagged pages whose
    // <link rel=alternate> spelled the URL differently from the recorded
    // page URL — e.g. /qualitätssicherung vs /qualit%C3%A4tssicherung.
    // Without this filter, existing crawls would still show the stale issue
    // until re-run; with it, a simple report reload clears the false rows.
    hreflangCanonicalConflicts: filterStaleHreflangConflicts(
      JSON.parse(p.hreflang_canonical_conflicts || '[]'),
      p.url,
      JSON.parse(p.hreflangs || '[]'),
      p.canonical
    ),
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

// Build the analysis for a crawl's stored pages and return { analysis,
// issueMetrics, statsWithExtra }. Shared by natural completion and the Stop
// (abort) path so a stopped crawl produces exactly the same report as a
// finished one. Pure compute — caller decides what to persist / emit.
function buildCrawlAnalysis(crawlId, summary) {
  const pages = db.getCrawlPages(crawlId);
  const resultsForAnalysis = mapPagesForAnalysis(pages);
  const analyzer = new Analyzer(resultsForAnalysis, {
    robotsTxt: summary.robotsTxt,
    sitemapData: summary.sitemapData,
    paramCheck: summary.paramCheck
  });
  const analysis = analyzer.analyze();

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
  const statsWithExtra = {
    ...summary.stats,
    ...issueMetrics,
    robotsTxt: summary.robotsTxt || null,
    sitemapData: summary.sitemapData || null,
    paramCheck: summary.paramCheck || null
  };
  return { analysis, issueMetrics, statsWithExtra };
}

// Finalize a crawl: compute the analysis once, persist it + the stats so we
// never recompute on reload (the recompute was timing out for 10k+ page
// crawls), then emit `complete` so any connected client renders immediately.
// `status` is 'completed' for a natural finish or 'aborted' when stopped.
// Runs heavy work on the next tick so an HTTP handler that triggered it (the
// abort route) can return immediately instead of blocking on the analyzer.
function finalizeCrawl(crawlId, summary, status) {
  activeCrawls.delete(crawlId);
  // Tell any connected client the crawl phase is over and we're now building
  // the report — covers BOTH the Stop button and a natural finish (e.g.
  // hitting maxPages), so the UI stops saying "Crawling…" the moment the last
  // page lands instead of looking frozen while the analyzer runs.
  io.to(crawlId).emit('building', { stats: summary.stats });
  setImmediate(() => {
    try {
      const { analysis, issueMetrics, statsWithExtra } = buildCrawlAnalysis(crawlId, summary);
      db.updateCrawlStatus(crawlId, status === 'aborted' ? 'completed' : status, statsWithExtra);
      db.saveAnalysis(crawlId, analysis);
      // Emit only a small signal — NOT the analysis itself. The analysis can be
      // tens of MB on large crawls, and socket.io silently drops any single
      // message over its 1 MB maxHttpBufferSize default (which is why
      // `complete` appeared to "do nothing" on big sites). The client fetches
      // the full report over HTTP (/analysis), which is gzipped, uncapped, and
      // served instantly from the cache we just persisted.
      io.to(crawlId).emit('complete', { stats: { ...summary.stats, ...issueMetrics }, stopped: status === 'aborted' });
    } catch (e) {
      console.error('finalizeCrawl failed:', e);
      io.to(crawlId).emit('error', { message: 'Failed to build report: ' + e.message });
    }
  });
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
  const exportStats = JSON.parse(crawl.stats || '{}');
  const analyzer = new Analyzer(mapped, { robotsTxt: crawl.robots_txt, sitemapData: crawl.sitemap_data ? JSON.parse(crawl.sitemap_data) : null, paramCheck: exportStats.paramCheck });
  const analysis = analyzer.analyze();
  const project = { version: '2.0', crawl: { ...crawl, stats: exportStats }, pages: mapped, analysis };
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

// Start a new crawl. Two modes:
//   1. Spider (default): seed with `url`, crawl everything reachable.
//   2. List: client sends `urls` (array). We crawl ONLY those URLs, no
//      discovery — matches Screaming Frog's List mode. The first URL's host
//      becomes the project domain so history/saved-projects still group sanely.
// Bot presets for "crawl as" — id/label pairs the client renders in the
// Settings dropdown; the full UA strings stay server-side in CrawlerEngine.
app.get('/api/bot-presets', (req, res) => {
  res.json(CrawlerEngine.BOT_PRESETS.map(p => ({ id: p.id, label: p.label })));
});

app.post('/api/crawls', (req, res) => {
  const { url, urls, maxPages, maxDepth, concurrency, respectRobots, userAgent, botPreset, saveProject } = req.body;

  const listMode = Array.isArray(urls) && urls.length > 0;
  if (!listMode && !url) return res.status(400).json({ error: 'URL is required' });

  let parsedUrl;
  try {
    const seed = listMode ? urls[0] : url;
    parsedUrl = new URL(String(seed).startsWith('http') ? seed : `https://${seed}`);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const domain = parsedUrl.hostname;
  const crawlId = uuidv4();

  // Resolve "crawl as" bot preset → full UA + robots.txt token. A custom UA
  // string (preset 'custom' or legacy clients sending only userAgent) is used
  // as-is for both.
  const preset = CrawlerEngine.BOT_PRESETS.find(p => p.id === botPreset);
  const resolvedUa = (preset && preset.ua) || userAgent || undefined;
  const resolvedRobotsToken = (preset && preset.robotsToken) || undefined;

  const config = {
    maxPages: Math.min(parseInt(maxPages) || 5000, 50000),
    maxDepth: Math.min(parseInt(maxDepth) || 10, 50),
    concurrency: Math.min(parseInt(concurrency) || 5, 20),
    respectRobots: respectRobots !== false,
    userAgent: resolvedUa,
    robotsUserAgent: resolvedRobotsToken,
    botPreset: preset ? preset.id : (userAgent ? 'custom' : 'default'),
    botLabel: preset ? preset.label : (userAgent ? 'Custom user agent' : 'SEO Tool (default browser UA)'),
    listMode,
    listSize: listMode ? urls.length : 0
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
    finalizeCrawl(crawlId, summary, 'completed');
  };

  activeCrawls.set(crawlId, crawler);

  // Start crawl async. Pick the entrypoint based on mode.
  const starter = listMode ? crawler.startList(urls) : crawler.start(parsedUrl.href);
  starter.catch(err => {
    db.updateCrawlStatus(crawlId, 'error', { error: err.message });
    io.to(crawlId).emit('error', { message: err.message });
    activeCrawls.delete(crawlId);
  });

  res.json({ id: crawlId, url: parsedUrl.href, domain, saved, status: 'running', mode: listMode ? 'list' : 'spider', listSize: config.listSize, botLabel: config.botLabel });
});

// Parse an uploaded .xlsx / .csv / .txt file and return the URL list. Used by
// the URL-list mode UI so the client doesn't have to bundle xlsx parsing.
// Accepts the file as raw body (Content-Type: application/octet-stream) plus
// a `?type=xlsx|csv|txt` hint; returns { urls: string[], total: number }.
app.post('/api/parse-url-list', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  try {
    const buf = req.body;
    const type = String(req.query.type || '').toLowerCase();
    if (!buf || !buf.length) return res.status(400).json({ error: 'No file body' });

    let urls = [];
    if (type === 'xlsx' || type === 'xls') {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) return res.status(400).json({ error: 'Empty workbook' });
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      // Find the column index: prefer a header named url/URL/Url, else col 0.
      let colIdx = 0;
      if (rows[0] && Array.isArray(rows[0])) {
        const header = rows[0].map(c => String(c).trim().toLowerCase());
        const found = header.findIndex(h => h === 'url' || h === 'urls' || h === 'address');
        if (found >= 0) {
          colIdx = found;
          rows.shift(); // drop header row
        }
      }
      for (const row of rows) {
        const cell = row[colIdx];
        if (cell) urls.push(String(cell).trim());
      }
    } else {
      // csv / txt: parse as text. CSV gets the first column (split on , ; or \t)
      // unless the first line has a `url` header.
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (type === 'csv' && lines.length > 0) {
        const splitRow = (l) => l.split(/[,;\t]/);
        const header = splitRow(lines[0]).map(c => c.trim().toLowerCase());
        const urlIdx = header.findIndex(h => h === 'url' || h === 'urls' || h === 'address');
        if (urlIdx >= 0) {
          for (let i = 1; i < lines.length; i++) {
            const parts = splitRow(lines[i]);
            if (parts[urlIdx]) urls.push(parts[urlIdx].trim().replace(/^["']|["']$/g, ''));
          }
        } else {
          for (const l of lines) {
            const first = splitRow(l)[0];
            if (first) urls.push(first.trim().replace(/^["']|["']$/g, ''));
          }
        }
      } else {
        urls = lines;
      }
    }
    // Filter to plausible URLs (drop empty + obviously non-URL rows like "N/A").
    const clean = urls.filter(u => /\S/.test(u) && /^(https?:\/\/|\/\/|[a-z0-9-]+\.[a-z]{2,})/i.test(u));
    res.json({ urls: clean, total: clean.length, skipped: urls.length - clean.length });
  } catch (e) {
    res.status(400).json({ error: 'Failed to parse file: ' + e.message });
  }
});

// Get crawl details
app.get('/api/crawls/:id', (req, res) => {
  const crawl = db.getCrawl(req.params.id);
  if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  res.json({ ...crawl, stats: JSON.parse(crawl.stats || '{}'), config: JSON.parse(crawl.config || '{}') });
});

// Get crawl pages. `?fields=lite` returns EVERY crawled page with only the
// columns the All Pages table needs (no huge link/image blobs), so the list
// reflects the true total instead of a 5–10k cap. Default behaviour (full
// rows, capped) is unchanged for other callers.
app.get('/api/crawls/:id/pages', (req, res) => {
  if (req.query.fields === 'lite') {
    return res.json(db.getCrawlPagesLite(req.params.id));
  }
  const limit = Math.min(parseInt(req.query.limit) || 1000, 60000);
  const offset = parseInt(req.query.offset) || 0;
  const statusCode = req.query.status ? parseInt(req.query.status) : null;

  const pages = db.getCrawlPages(req.params.id, { limit, offset, statusCode });
  res.json(pages);
});

// Full detail for a single crawled page (populates the All Pages modal on
// click — so the list itself can stay lightweight).
app.get('/api/crawls/:id/page', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  const row = db.getCrawlPageByUrl(req.params.id, String(url));
  if (!row) return res.status(404).json({ error: 'Page not found in this crawl' });
  res.json(row);
});

// Diagnostic: shows exactly what the hreflang return-link check compares, so we
// can see whether a flagged row is a real asymmetry or a normalisation gap.
// Recomputes from the live DB rows (not the cache) with the current analyzer.
// Usage: /api/crawls/:id/debug-hreflang?q=qualit  (substring filter, optional)
app.get('/api/crawls/:id/debug-hreflang', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const q = String(req.query.q || '').toLowerCase();
  const pages = mapPagesForAnalysis(db.getCrawlPages(req.params.id))
    .filter(p => p.statusCode < 300 && p.hreflangs && p.hreflangs.length > 0);

  const key = (u) => hreflangKey(u);
  const byKey = new Map();
  for (const p of pages) byKey.set(key(p.url), p);

  const rows = [];
  for (const page of pages) {
    if (q && !page.url.toLowerCase().includes(q)) continue;
    const pageKey = key(page.url);
    for (const hl of page.hreflangs) {
      const hlKey = key(hl.href);
      if (hlKey === pageKey) continue;
      const target = byKey.get(hlKey);
      const targetHasBack = target ? target.hreflangs.some(h => key(h.href) === pageKey) : null;
      // Only surface the ones the analyzer would flag (target exists, no back link)
      if (target && !targetHasBack) {
        rows.push({
          flaggedTarget: hl.href,
          flaggedTargetKey: hlKey,
          iteratingPage: page.url,
          iteratingPageKey: pageKey,
          targetExistsInCrawl: true,
          targetHreflangs: target.hreflangs.map(h => ({ lang: h.lang, href: h.href, key: key(h.href) })),
          verdict: 'target page has no hreflang whose key equals iteratingPageKey → flagged'
        });
      }
    }
  }
  res.json({
    analyzerVersion: Analyzer.VERSION,
    pagesWithHreflangs: pages.length,
    matched: rows.length,
    note: 'If iteratingPageKey is absent from targetHreflangs[].key, the asymmetry is REAL (different URLs). If it IS present but flagged, that is a normalisation bug.',
    rows: rows.slice(0, 100)
  });
});

// Treat a cached analysis as fresh only if its `_version` matches the current
// Analyzer.VERSION. Older blobs are recomputed (and the cache rewritten with
// the new version) so a deployed analyzer fix takes effect on existing crawls
// without re-running them.
function freshCachedAnalysis(crawlId) {
  const cached = db.getAnalysis(crawlId);
  if (!cached) return null;
  if (cached._version !== Analyzer.VERSION) return null;
  return cached;
}

// Get crawl analysis. Served from the cached blob written by finalizeCrawl
// when available AND its analyzer version matches the current code — so a
// deployed fix is picked up on next load instead of returning stale results.
// Falls back to computing on demand for older crawls / outdated caches (and
// back-fills the cache so the next load is instant too).
app.get('/api/crawls/:id/analysis', (req, res) => {
  // Tell the browser never to cache. Server-side caching (the analysis blob
  // in SQLite) is enough for instant loads; an extra HTTP cache here would
  // hide deployed analyzer fixes from anyone who already loaded the report.
  res.set('Cache-Control', 'no-store');
  // ?fresh=1 forces a recompute, bypassing the cache entirely — lets us prove
  // whether a lingering issue is stale cache vs a real analyzer result.
  const cached = req.query.fresh ? null : freshCachedAnalysis(req.params.id);
  if (cached) return res.json(cached);

  const pages = db.getCrawlPages(req.params.id);
  if (pages.length === 0) return res.status(404).json({ error: 'No pages found' });

  const crawl = db.getCrawl(req.params.id);
  const stats = JSON.parse(crawl?.stats || '{}');
  const resultsForAnalysis = mapPagesForAnalysis(pages);
  const analyzer = new Analyzer(resultsForAnalysis, { robotsTxt: stats.robotsTxt, sitemapData: stats.sitemapData, paramCheck: stats.paramCheck });
  const analysis = analyzer.analyze();
  try { db.saveAnalysis(req.params.id, analysis); } catch { /* non-fatal back-fill */ }
  res.json(analysis);
});

// ── Public share endpoints ──────────────────────────────────────────────
// Crawl IDs are v4 UUIDs (122 bits of entropy) so the id itself is the
// share token — anyone with the link can view the audit, no auth needed.
// Mirrors the equivalent /api/crawls/:id endpoints exactly, just gated to
// completed crawls so unfinished runs can't be exposed by accident.
app.get('/share/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/api/share/:id', (req, res) => {
  const crawl = db.getCrawl(req.params.id);
  if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  res.json({ ...crawl, stats: JSON.parse(crawl.stats || '{}'), config: JSON.parse(crawl.config || '{}') });
});
app.get('/api/share/:id/pages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 1000, 10000);
  const offset = parseInt(req.query.offset) || 0;
  const statusCode = req.query.status ? parseInt(req.query.status) : null;
  const pages = db.getCrawlPages(req.params.id, { limit, offset, statusCode });
  res.json(pages);
});
app.get('/api/share/:id/analysis', (req, res) => {
  const cached = freshCachedAnalysis(req.params.id);
  if (cached) return res.json(cached);
  const pages = db.getCrawlPages(req.params.id);
  if (pages.length === 0) return res.status(404).json({ error: 'No pages found' });
  const crawl = db.getCrawl(req.params.id);
  const stats = JSON.parse(crawl?.stats || '{}');
  const resultsForAnalysis = mapPagesForAnalysis(pages);
  const analyzer = new Analyzer(resultsForAnalysis, { robotsTxt: stats.robotsTxt, sitemapData: stats.sitemapData, paramCheck: stats.paramCheck });
  const analysis = analyzer.analyze();
  try { db.saveAnalysis(req.params.id, analysis); } catch { /* non-fatal */ }
  res.json(analysis);
});

// ── External links + status-code checker ──────────────────────────────
// Collects every off-domain link found across the crawl, returns it
// with the list of source pages that point at it. A second endpoint
// streams HEAD/GET probes back as Server-Sent Events so the UI can
// fill statuses live. Results are cached in kv_store under
// "external-status:<url>" so a re-open doesn't re-probe everything.

// Origin-URL index for status-code exports. Scans every crawled page's <a href>
// list and returns Map<normalised target URL, [{source, anchor, isNofollow}]>
// so 4xx/3xx/5xx exports can include the pages that link TO each broken URL.
// Normalisation mirrors the crawler's _dedupeKey (drop hash, strip trailing
// slash unless root, lowercase) so trailing-slash variants still match.
function buildOriginsIndex(pages) {
  const norm = (u) => {
    if (!u) return '';
    try {
      const x = new URL(u);
      x.hash = '';
      let k = x.href;
      if (x.pathname !== '/' && k.endsWith('/')) k = k.slice(0, -1);
      return k.toLowerCase();
    } catch { return String(u).toLowerCase(); }
  };
  const idx = new Map();
  for (const p of pages) {
    let links = [];
    try { links = JSON.parse(p.links || '[]'); } catch { /* malformed row */ }
    for (const l of links) {
      if (!l || !l.href) continue;
      const k = norm(l.href);
      let arr = idx.get(k);
      if (!arr) { arr = []; idx.set(k, arr); }
      arr.push({ source: p.url, anchor: l.anchor || '', isNofollow: !!l.isNofollow });
    }
  }
  return { idx, norm };
}

function originColumnsFor(targetUrl, originsIndex, maxSources = 200) {
  const { idx, norm } = originsIndex;
  const sources = idx.get(norm(targetUrl)) || [];
  const capped = sources.slice(0, maxSources);
  return {
    'Source URLs': capped.map(s => s.source).join('\n') + (sources.length > maxSources ? `\n…and ${sources.length - maxSources} more` : '')
  };
}

function collectExternalLinks(crawlId) {
  const pages = db.getCrawlPages(crawlId);
  if (!pages.length) return null;
  const byHref = new Map();   // href → { href, anchors: Set, sources: [{url, anchor, isNofollow}] }
  for (const p of pages) {
    let links = [];
    try { links = JSON.parse(p.links || '[]'); } catch { /* malformed row */ }
    for (const l of links) {
      if (!l || l.isInternal !== false || !l.href) continue;
      if (!/^https?:\/\//i.test(l.href)) continue;
      let entry = byHref.get(l.href);
      if (!entry) {
        entry = { href: l.href, sources: [] };
        byHref.set(l.href, entry);
      }
      entry.sources.push({ url: p.url, anchor: l.anchor || '', isNofollow: !!l.isNofollow });
    }
  }
  // Hydrate any cached statuses so the UI shows them on first load.
  const items = Array.from(byHref.values()).map(e => {
    const cached = db.kvGet('external-status:' + e.href);
    return {
      href: e.href,
      sourceCount: e.sources.length,
      sources: e.sources.slice(0, 50),
      status: cached?.status ?? null,
      checkedAt: cached?.checkedAt ?? null,
      error: cached?.error ?? null
    };
  });
  items.sort((a, b) => b.sourceCount - a.sourceCount || a.href.localeCompare(b.href));
  return items;
}

// Links the author wrote without a scheme (e.g. "www.foo.ch") that the
// browser resolves as a broken internal path. Flagged at crawl time.
function collectMalformedLinks(crawlId) {
  const pages = db.getCrawlPages(crawlId);
  if (!pages.length) return null;
  const byKey = new Map();
  for (const p of pages) {
    let links = [];
    try { links = JSON.parse(p.links || '[]'); } catch { /* malformed row */ }
    for (const l of links) {
      if (!l || !l.isMalformed) continue;
      const key = l.rawHref || l.href;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { rawHref: l.rawHref || '', resolved: l.href, anchor: l.anchor || '', sources: [] };
        byKey.set(key, entry);
      }
      entry.sources.push({ url: p.url, anchor: l.anchor || '' });
    }
  }
  const items = Array.from(byKey.values()).map(e => ({
    rawHref: e.rawHref,
    resolved: e.resolved,
    anchor: e.anchor,
    sourceCount: e.sources.length,
    sources: e.sources.slice(0, 50)
  }));
  items.sort((a, b) => b.sourceCount - a.sourceCount);
  return items;
}

// Internal image/asset URLs (from <img src> and <a href="...jpg">) so we
// can probe them for broken (404/410/5xx) references.
function collectImageAssets(crawlId) {
  const pages = db.getCrawlPages(crawlId);
  if (!pages.length) return null;
  const assetExt = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?)(\?|#|$)/i;
  const byHref = new Map();
  // For each asset, remember the first <img>-occurrence alt state so the
  // client can derive alt-issue counts restricted to images that actually
  // returned 200. `fromImg` is true if the URL was ever referenced as an
  // <img src> (vs. only as an <a href> to a .jpg) — only <img> uses qualify
  // for the alt-issue report. Matches the prior analyzer's "first occurrence
  // wins" dedupe semantics.
  const add = (href, source, imgMeta) => {
    if (!href || !/^https?:\/\//i.test(href)) return;
    if (!assetExt.test(href)) return;
    let entry = byHref.get(href);
    if (!entry) {
      entry = { href, sources: [], fromImg: false, firstImgHasAlt: null, firstImgAltEmpty: null, sampleAlt: null, samplePageUrl: null };
      byHref.set(href, entry);
    }
    entry.sources.push(source);
    if (imgMeta && !entry.fromImg) {
      entry.fromImg = true;
      entry.firstImgHasAlt = !!imgMeta.hasAlt;
      entry.firstImgAltEmpty = !!imgMeta.altEmpty;
      entry.sampleAlt = imgMeta.alt;
      entry.samplePageUrl = imgMeta.pageUrl;
    }
  };
  for (const p of pages) {
    let images = [];
    try { images = JSON.parse(p.images || '[]'); } catch { /* row */ }
    for (const img of images) {
      add(img.src, { url: p.url, anchor: img.alt || '[image]' }, {
        hasAlt: !!img.hasAlt, altEmpty: !!img.altEmpty, alt: img.alt, pageUrl: p.url
      });
    }
    let links = [];
    try { links = JSON.parse(p.links || '[]'); } catch { /* row */ }
    for (const l of links) if (l && !l.isMalformed) add(l.href, { url: p.url, anchor: l.anchor || '' }, null);
  }
  const items = Array.from(byHref.values()).map(e => {
    const cached = db.kvGet('asset-status:' + e.href);
    return {
      href: e.href,
      sourceCount: e.sources.length,
      sources: e.sources.slice(0, 50),
      status: cached?.status ?? null,
      checkedAt: cached?.checkedAt ?? null,
      error: cached?.error ?? null,
      fromImg: e.fromImg,
      // Alt-attribute status taken from the first <img> reference. Only
      // meaningful when fromImg is true; client filters by status === 2xx
      // before counting these so 4xx images don't pollute the alt report.
      missingAlt: e.fromImg && e.firstImgHasAlt === false,
      emptyAlt: e.fromImg && e.firstImgHasAlt === true && e.firstImgAltEmpty === true,
      sampleAlt: e.sampleAlt,
      samplePageUrl: e.samplePageUrl
    };
  });
  items.sort((a, b) => b.sourceCount - a.sourceCount || a.href.localeCompare(b.href));
  return items;
}

app.get('/api/crawls/:id/malformed-links', (req, res) => {
  const items = collectMalformedLinks(req.params.id);
  if (!items) return res.status(404).json({ error: 'Crawl not found / no pages' });
  res.json({ total: items.length, items });
});

app.get('/api/crawls/:id/image-assets', (req, res) => {
  const items = collectImageAssets(req.params.id);
  if (!items) return res.status(404).json({ error: 'Crawl not found / no pages' });
  res.json({ total: items.length, items });
});

// ── 404 source attribution ────────────────────────────────────────────
// For every 4xx URL in the crawl, find every place it is referenced FROM:
// <a href> anchors, canonical tags, hreflang alternates, <img src>,
// rel=next/prev pagination tags, the XML sitemap, redirect chains landing on
// it, and (as a fallback) the crawl-discovery parent. Powers the "404 Pages"
// tab, which filters/exports by these source types.
function collectBrokenSources(crawlId) {
  const pages = db.getCrawlPages(crawlId);
  if (!pages.length) return null;

  // 4xx targets, keyed with the loose URL-equivalence key (encoding /
  // trailing slash / host case insensitive) so a reference spelled slightly
  // differently still attributes to the right broken page.
  const targets = new Map(); // key -> { url, status, sources: [], typeSet: Set }
  for (const p of pages) {
    if (p.status_code >= 400 && p.status_code < 500) {
      const k = hreflangKey(p.url);
      if (!targets.has(k)) targets.set(k, { url: p.url, status: p.status_code, sources: [], typeSet: new Set(), inSitemap: !!p.in_sitemap, parent: p.parent || null });
    }
  }
  if (targets.size === 0) return { items: [], typeCounts: {}, total: 0 };

  const MAX_SOURCES_PER_TARGET = 100;
  const addSource = (targetKey, type, from, detail) => {
    const t = targets.get(targetKey);
    if (!t) return;
    t.typeSet.add(type);
    if (t.sources.length < MAX_SOURCES_PER_TARGET) t.sources.push({ type, from, detail: detail || '' });
    else t.overflow = (t.overflow || 0) + 1;
  };

  for (const p of pages) {
    const from = p.url;
    // <a href> anchors
    let links = [];
    try { links = JSON.parse(p.links || '[]'); } catch { /* row */ }
    for (const l of links) {
      if (!l || !l.href) continue;
      const k = hreflangKey(l.href);
      if (targets.has(k)) addSource(k, 'anchor', from, l.anchor ? `anchor: "${String(l.anchor).slice(0, 80)}"` : 'empty anchor');
    }
    // canonical
    if (p.canonical) {
      const k = hreflangKey(p.canonical);
      if (targets.has(k)) addSource(k, 'canonical', from, 'rel=canonical');
    }
    // hreflangs
    let hls = [];
    try { hls = JSON.parse(p.hreflangs || '[]'); } catch { /* row */ }
    for (const h of hls) {
      if (!h || !h.href) continue;
      const k = hreflangKey(h.href);
      if (targets.has(k)) addSource(k, 'hreflang', from, `hreflang="${h.lang || '?'}"`);
    }
    // images
    let imgs = [];
    try { imgs = JSON.parse(p.images || '[]'); } catch { /* row */ }
    for (const im of imgs) {
      if (!im || !im.src) continue;
      const k = hreflangKey(im.src);
      if (targets.has(k)) addSource(k, 'image', from, 'img src');
    }
    // pagination tags
    for (const [relVal, relName] of [[p.rel_next, 'rel=next'], [p.rel_prev, 'rel=prev']]) {
      if (!relVal) continue;
      const k = hreflangKey(relVal);
      if (targets.has(k)) addSource(k, 'pagination', from, relName);
    }
    // redirect landing on a 4xx (row is the redirecting URL, final_url is where it lands)
    if (p.final_url && p.status_code >= 300 && p.status_code < 400) {
      const k = hreflangKey(p.final_url);
      if (targets.has(k)) addSource(k, 'redirect', from, `redirects (${p.status_code}) to the broken URL`);
    }
  }

  // Per-target flags that don't come from scanning other pages
  for (const t of targets.values()) {
    if (t.inSitemap) { t.typeSet.add('sitemap'); t.sources.unshift({ type: 'sitemap', from: 'XML sitemap', detail: 'listed in sitemap' }); }
    // Discovery parent as fallback so no 404 row is ever source-less
    if (t.typeSet.size === 0 && t.parent) {
      const type = t.parent === 'sitemap' ? 'sitemap' : 'anchor';
      t.typeSet.add(type);
      t.sources.push({ type, from: t.parent === 'sitemap' ? 'XML sitemap' : t.parent, detail: 'discovered from' });
    }
  }

  const items = [...targets.values()].map(t => ({
    url: t.url,
    status: t.status,
    types: [...t.typeSet].sort(),
    sourceCount: t.sources.length + (t.overflow || 0),
    sources: t.sources
  })).sort((a, b) => b.sourceCount - a.sourceCount || a.url.localeCompare(b.url));

  const typeCounts = {};
  for (const it of items) for (const ty of it.types) typeCounts[ty] = (typeCounts[ty] || 0) + 1;

  return { items, typeCounts, total: items.length };
}

app.get('/api/crawls/:id/broken-sources', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const data = collectBrokenSources(req.params.id);
  if (!data) return res.status(404).json({ error: 'Crawl not found / no pages' });
  res.json(data);
});

app.get('/api/crawls/:id/image-assets/export/xlsx', (req, res) => {
  const items = collectImageAssets(req.params.id);
  if (!items) return res.status(404).send('Crawl not found / no pages');
  const XLSX = require('xlsx');
  const crawl = db.getCrawl(req.params.id);
  let host = 'site';
  try { host = new URL(crawl?.url || 'https://x').hostname.replace(/^www\./, ''); } catch {}
  const stamp = new Date().toISOString().slice(0, 10);
  const statusOf = (i) => i.error ? `error: ${i.error}` : (i.status == null ? '—' : String(i.status));
  const rows = [['Image URL', 'Status', 'Used on (count)', 'Top source page', 'All source pages']];
  for (const i of items) {
    rows.push([i.href, statusOf(i), i.sourceCount || (i.sources || []).length, (i.sources || [])[0]?.url || '', (i.sources || []).map(s => s.url).join('\n')]);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(decodeUrlCellsAoa(rows));
  ws['!cols'] = [{ wch: 70 }, { wch: 14 }, { wch: 14 }, { wch: 60 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Image Status Codes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="image-status_${host}_${stamp}.xlsx"`);
  res.end(buf);
});

app.get('/api/crawls/:id/external-links', (req, res) => {
  const items = collectExternalLinks(req.params.id);
  if (!items) return res.status(404).json({ error: 'Crawl not found / no pages' });
  res.json({ total: items.length, items });
});

// All source pages (uncapped) that link to a specific external href —
// powers the "where is this linked from?" modal on the External Links tab.
app.get('/api/crawls/:id/external-links/sources', (req, res) => {
  const target = String(req.query.url || '');
  if (!target) return res.status(400).json({ error: 'url query param required' });
  const pages = db.getCrawlPages(req.params.id);
  if (!pages.length) return res.status(404).json({ error: 'Crawl not found / no pages' });
  const sources = [];
  for (const p of pages) {
    let links = [];
    try { links = JSON.parse(p.links || '[]'); } catch { /* row */ }
    for (const l of links) {
      if (l && l.isInternal === false && l.href === target) {
        sources.push({ url: p.url, anchor: l.anchor || '', isNofollow: !!l.isNofollow });
      }
    }
  }
  res.json({ url: target, total: sources.length, sources });
});

// Apply the same filter the UI uses, so an export with "Broken (4xx/5xx)"
// selected only contains those rows.
function filterExternalItems(items, statusFilter, textFilter) {
  const t = (textFilter || '').toLowerCase();
  return items.filter(i => {
    if (t && !(i.href.toLowerCase().includes(t)
      || (i.sources || []).some(s => (s.url || '').toLowerCase().includes(t)
                                  || (s.anchor || '').toLowerCase().includes(t)))) return false;
    switch (statusFilter) {
      case 'checked':   return i.status != null || !!i.error;
      case 'ok':        return i.status >= 200 && i.status < 300;
      case '3xx':       return i.status >= 300 && i.status < 400;
      case '4xx':       return i.status >= 400 && i.status < 500;
      case '5xx':       return i.status >= 500;
      case 'err':       return !!i.error && i.status == null;
      case 'broken':    return (i.status != null && i.status >= 400) || !!i.error;  // back-compat
      case 'unchecked': return i.status == null && !i.error;
      default:          return true;
    }
  });
}

app.get('/api/crawls/:id/external-links/export/:format', (req, res) => {
  const items = collectExternalLinks(req.params.id);
  if (!items) return res.status(404).send('Crawl not found / no pages');
  const filtered = filterExternalItems(items, req.query.status, req.query.q);

  const crawl = db.getCrawl(req.params.id);
  let host = 'site';
  try { host = new URL(crawl?.url || 'https://x').hostname.replace(/^www\./, ''); } catch {}
  const stamp = new Date().toISOString().slice(0, 10);
  const baseName = `external-links_${host}_${stamp}`;
  const statusOf = (i) => i.error ? `error: ${i.error}` : (i.status == null ? '—' : String(i.status));

  if (req.params.format === 'xlsx') {
    const XLSX = require('xlsx');
    const summary = [
      ['External URL', 'Status', 'Source count', 'Top source page', 'All source pages']
    ];
    for (const i of filtered) {
      const all = (i.sources || []).map(s => s.url).join('\n');
      summary.push([i.href, statusOf(i), i.sourceCount || (i.sources || []).length, (i.sources || [])[0]?.url || '', all]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(decodeUrlCellsAoa(summary));
    ws['!cols'] = [{ wch: 70 }, { wch: 14 }, { wch: 12 }, { wch: 60 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws, 'External Links');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
    return res.end(buf);
  }

  if (req.params.format === 'pdf') {
    const PDFDocument = require('pdfkit');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.pipe(res);
    doc.fontSize(18).fillColor('#1A1D2E').text('External Links', { continued: false });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#6B7085')
       .text(`${crawl?.url || ''}  ·  ${stamp}  ·  ${filtered.length} link${filtered.length === 1 ? '' : 's'}`);
    doc.moveDown(0.8);
    const statusColor = (i) => i.error || (i.status != null && i.status >= 400) ? '#DC2626'
                           : (i.status != null && i.status >= 300) ? '#D97706'
                           : (i.status != null) ? '#16A34A' : '#6B7085';
    for (const i of filtered) {
      // page break room
      if (doc.y > 760) doc.addPage();
      const sources = i.sources || [];
      doc.fontSize(10).fillColor(statusColor(i)).text(statusOf(i), { continued: true });
      doc.fillColor('#1A1D2E').text(`  ${i.href}`, { link: i.href, underline: false });
      doc.fontSize(8).fillColor('#6B7085')
         .text(`Used on ${i.sourceCount || sources.length} page${(i.sourceCount || sources.length) === 1 ? '' : 's'}`);
      const top = sources.slice(0, 5);
      for (const s of top) doc.fontSize(8).fillColor('#4F46E5').text(`    ${s.url}`, { link: s.url, underline: false });
      if (sources.length > 5) doc.fontSize(8).fillColor('#6B7085').text(`    +${sources.length - 5} more`);
      doc.moveDown(0.5);
    }
    doc.end();
    return;
  }

  res.status(400).send('Unsupported format');
});

async function probeExternalUrl(url) {
  // HEAD first (cheap). Fall back to GET only when HEAD is explicitly
  // disallowed (405/501) or the HEAD failed for a NON-timeout reason —
  // a HEAD timeout almost always means a slow server where GET would
  // time out too, so retrying just doubles the wall-clock for no gain.
  const TIMEOUT = 8000;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; ConvertaSEO-LinkChecker/1.0; +https://seo.converta.ro)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
  };
  // AbortController gives a hard wall-clock deadline even if the socket
  // hangs mid-connect (axios `timeout` only covers inactivity between
  // bytes on some transports).
  const reqWithDeadline = (fn) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT + 1500);
    return fn(ac.signal).finally(() => clearTimeout(t));
  };
  const common = (signal) => ({ timeout: TIMEOUT, maxRedirects: 5, validateStatus: () => true, signal, headers });
  const isTimeout = (e) => e && (e.code === 'ECONNABORTED' || e.code === 'ERR_CANCELED' || /timeout/i.test(e.message || ''));

  try {
    const head = await reqWithDeadline((signal) => axios.head(url, common(signal)));
    if (head.status === 405 || head.status === 501) {
      const get = await reqWithDeadline((signal) => axios.get(url, { ...common(signal), responseType: 'stream' }));
      get.data?.destroy?.();
      return { status: get.status };
    }
    return { status: head.status };
  } catch (e) {
    if (isTimeout(e)) return { status: null, error: 'timeout' };
    // Non-timeout HEAD failure (server refuses HEAD, connection reset):
    // one GET attempt.
    try {
      const get = await reqWithDeadline((signal) => axios.get(url, { ...common(signal), responseType: 'stream' }));
      get.data?.destroy?.();
      return { status: get.status };
    } catch (e2) {
      return { status: null, error: isTimeout(e2) ? 'timeout' : ((e2 && e2.code) || (e2 && e2.message) || 'request failed') };
    }
  }
}

// One detached checker per (crawl, kind). Workers run independent of any
// SSE client; closing the browser tab no longer halts the scan, and every
// connected tab gets the same live event stream. `kind` lets external
// links and image assets run as separate jobs with separate caches.
const urlCheckers = new Map();   // `${crawlId}:${kind}` → state

function startUrlChecker(crawlId, kind, items, force) {
  const key = `${crawlId}:${kind}`;
  const cachePrefix = kind === 'assets' ? 'asset-status:' : 'external-status:';
  let state = urlCheckers.get(key);
  if (state && state.running) return state;

  const targets = items
    .map(i => i.href)
    .filter(h => force || db.kvGet(cachePrefix + h) == null);

  state = { running: true, total: targets.length, done: 0, listeners: new Set() };
  urlCheckers.set(key, state);

  if (targets.length === 0) {
    state.running = false;
    return state;
  }

  const broadcast = (event) => {
    for (const res of state.listeners) {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* listener gone */ }
    }
  };

  // Heartbeat so slow batches still show "alive" + a moving counter even
  // when individual probes are each taking their full timeout.
  const heartbeat = setInterval(() => {
    if (!state.running) { clearInterval(heartbeat); return; }
    broadcast({ type: 'progress', done: state.done, total: state.total });
  }, 2000);

  const CONCURRENCY = 30;
  const queue = targets.slice();
  const worker = async () => {
    while (queue.length && state.running) {
      const url = queue.shift();
      const result = await probeExternalUrl(url);
      const checkedAt = new Date().toISOString();
      try { db.kvSet(cachePrefix + url, { ...result, checkedAt }); } catch (e) { /* db hiccup */ }
      state.done++;
      broadcast({ type: 'result', url, status: result.status, error: result.error || null, checkedAt, done: state.done, total: state.total });
    }
  };
  Promise.all(Array.from({ length: CONCURRENCY }, worker))
    .then(() => {
      state.running = false;
      clearInterval(heartbeat);
      broadcast({ type: 'done', done: state.done, total: state.total });
    })
    .catch((e) => {
      state.running = false;
      clearInterval(heartbeat);
      broadcast({ type: 'error', message: e.message });
    });

  return state;
}

function streamCheckerResponse(state, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'start', total: state.total, done: state.done })}\n\n`);
  if (!state.running && state.total === 0) {
    res.write(`data: ${JSON.stringify({ type: 'done', done: 0, total: 0 })}\n\n`);
    res.end();
    return;
  }
  state.listeners.add(res);
  res.req.on('close', () => state.listeners.delete(res));
}

app.post('/api/crawls/:id/external-links/check', (req, res) => {
  const items = collectExternalLinks(req.params.id);
  if (!items) return res.status(404).json({ error: 'Crawl not found / no pages' });
  const state = startUrlChecker(req.params.id, 'external', items, !!req.body?.force);
  streamCheckerResponse(state, res);
});

app.post('/api/crawls/:id/image-assets/check', (req, res) => {
  const items = collectImageAssets(req.params.id);
  if (!items) return res.status(404).json({ error: 'Crawl not found / no pages' });
  const state = startUrlChecker(req.params.id, 'assets', items, !!req.body?.force);
  streamCheckerResponse(state, res);
});

// ── AI audit assistant ────────────────────────────────────────────────
// Streams a Claude response back over SSE, with the crawl's analysis
// baked into the cached system prompt. Caching the analysis means the
// expensive ~50K-token prefix is paid for once per audit and re-used at
// ~10% cost on every follow-up turn.
function summariseAnalysisForChat(analysis) {
  // Walk the analysis tree and cap any large array at 50 items so a
  // 5000-page crawl doesn't dump megabytes into the model's context.
  // Caches better too — the JSON stays a similar size whether the crawl
  // has 100 or 10,000 pages.
  if (!analysis) return analysis;
  const clone = JSON.parse(JSON.stringify(analysis));
  const cap = 50;
  const trim = (node) => {
    if (Array.isArray(node)) {
      if (node.length > cap) node.length = cap;
      for (const item of node) trim(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) trim(node[k]);
    }
  };
  trim(clone);
  return clone;
}

app.post('/api/chat/:crawlId', async (req, res) => {
  if (!anthropicClient) {
    return res.status(503).json({ error: 'AI assistant not configured. Set ANTHROPIC_API_KEY.' });
  }
  const crawlId = req.params.crawlId;
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'No messages.' });

  const crawl = db.getCrawl(crawlId);
  if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
  const pages = db.getCrawlPages(crawlId);
  if (!pages.length) return res.status(404).json({ error: 'Crawl has no pages' });
  const stats = JSON.parse(crawl?.stats || '{}');
  const resultsForAnalysis = mapPagesForAnalysis(pages);
  const analyzer = new Analyzer(resultsForAnalysis, { robotsTxt: stats.robotsTxt, sitemapData: stats.sitemapData, paramCheck: stats.paramCheck });
  const analysis = summariseAnalysisForChat(analyzer.analyze());

  const contextBlob = JSON.stringify({
    site: crawl.url,
    crawledAt: crawl.completed_at,
    pageCount: pages.length,
    analysis
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const stream = anthropicClient.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 8000,
      system: [
        {
          // Volatile instruction text first; it's small and intentionally
          // stable, so it stays in the cached prefix too.
          type: 'text',
          text: [
            'You are an SEO expert helping the user understand the results of a website audit.',
            'You have full read access to the audit data below — quote specific URLs, numbers, and findings when relevant.',
            'Be direct and concise. When asked "what should I fix first", lead with the highest-impact issue.',
            'If the user asks for something the data does not cover, say so plainly rather than guessing.',
            'Format responses with short paragraphs and bullet lists. Use Markdown.'
          ].join(' ')
        },
        {
          // Audit data — same bytes for every turn in this crawl's
          // conversation, so we mark it ephemeral to get the cache read
          // on every follow-up. Prefix-match rule: anything before this
          // breakpoint also caches.
          type: 'text',
          text: `# AUDIT DATA (JSON)\n\nThis is the authoritative data for this conversation.\n\n${contextBlob}`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '')
      }))
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
      }
    }
    const finalMessage = await stream.finalMessage();
    res.write(`data: ${JSON.stringify({ type: 'done', usage: finalMessage.usage })}\n\n`);
    res.end();
  } catch (e) {
    console.error('Chat error:', e);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: e.message || 'Chat failed' })}\n\n`);
    } catch { /* connection already closed */ }
    res.end();
  }
});

// Quick status probe so the UI knows whether to show the chat button.
app.get('/api/chat-status', (req, res) => {
  res.json({ available: !!anthropicClient });
});

// Export
app.get('/api/crawls/:id/export/:format', (req, res) => {
  const pages = db.getCrawlPages(req.params.id);
  if (pages.length === 0) return res.status(404).json({ error: 'No pages found' });

  const crawl = db.getCrawl(req.params.id);
  const stats = JSON.parse(crawl?.stats || '{}');
  const resultsForAnalysis = mapPagesForAnalysis(pages);
  const analyzer = new Analyzer(resultsForAnalysis, { robotsTxt: stats.robotsTxt, sitemapData: stats.sitemapData, paramCheck: stats.paramCheck });
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
    const crawl = db.getCrawl(req.params.id);
    if (!crawl) return res.status(404).json({ error: 'Crawl not found' });
    // Prefer the cached analysis — it was computed over EVERY crawled page at
    // finalize time, so "Pages Crawled" matches the dashboard. The old code
    // re-analysed a 10k-capped subset here, which is why a 20k crawl showed
    // 10000 in the PDF. Fall back to an uncapped recompute for legacy crawls.
    let analysis = freshCachedAnalysis(req.params.id);
    if (!analysis) {
      const pages = db.getCrawlPages(req.params.id);
      if (!pages.length) return res.status(404).json({ error: 'No pages found' });
      const stats = JSON.parse(crawl?.stats || '{}');
      const mapped = mapPagesForAnalysis(pages);
      analysis = new Analyzer(mapped, { robotsTxt: stats.robotsTxt, sitemapData: stats.sitemapData, paramCheck: stats.paramCheck }).analyze();
      try { db.saveAnalysis(req.params.id, analysis); } catch { /* non-fatal */ }
    }
    generatePDFReport(res, analysis, crawl?.url || 'Unknown');
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
  // Several sheets (status codes + origins, hreflang list, All Pages) need the
  // actual page rows, so we always load them — uncapped, so exports cover the
  // full crawl. The aggregate `analysis` reuses the cached full-crawl result
  // when present (matches dashboard counts; skips re-analysing 20k pages).
  const pages = db.getCrawlPages(req.params.id);
  const mapped = mapPagesForAnalysis(pages);
  const Analyzer = require('./lib/analyzer');
  let analysis = freshCachedAnalysis(req.params.id);
  if (!analysis) {
    const sectionStats = JSON.parse(crawl.stats || '{}');
    analysis = new Analyzer(mapped, { robotsTxt: sectionStats.robotsTxt, sitemapData: sectionStats.sitemapData, paramCheck: sectionStats.paramCheck }).analyze();
    try { db.saveAnalysis(req.params.id, analysis); } catch { /* non-fatal */ }
  }
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
        const ws = XLSX.utils.json_to_sheet(decodeUrlCells(rows));
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
        const ws = XLSX.utils.json_to_sheet(decodeUrlCells(rows));
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
        const ws = XLSX.utils.json_to_sheet(decodeUrlCells(rows));
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
      const _redOriginsIdx = buildOriginsIndex(pages);
      data = (analysis.redirectChains?.chains || []).map(r => ({
        URL: r.originalUrl,
        Status: r.chain?.[0]?.statusCode || '',
        ...originColumnsFor(r.originalUrl, _redOriginsIdx)
      }));
      sheetName = 'Redirects';
      break;
    case 'redirect-params': {
      const rp = analysis.redirectParamsReport || {};
      data = [
        ...(rp.activeResults || []).map(r => ({
          URL: r.url,
          'Tested URL': r.testedUrl || '',
          'Final URL': r.finalUrl || '',
          Result: r.error ? `Error: ${r.error}` : (r.dropsParams ? 'DROPS PARAMS' : 'OK'),
          'Dropped Params': (r.dropped || []).join(', '),
          'Preserved Params': (r.preserved || []).join(', '),
          Source: 'Active test'
        })),
        ...(rp.passiveDrops || []).map(r => ({
          URL: r.url,
          'Tested URL': '',
          'Final URL': r.finalUrl,
          Result: 'DROPS PARAMS',
          'Dropped Params': r.dropped.join(', '),
          'Preserved Params': '',
          Source: 'Crawled redirect'
        }))
      ];
      sheetName = 'Redirect Param Loss';
      break;
    }
    case 'statuscodes': {
      const scFilter = req.query.filter || 'all';
      let scPages = mapped;
      if (scFilter === '2xx') scPages = mapped.filter(p => p.statusCode >= 200 && p.statusCode < 300);
      else if (scFilter === '3xx') scPages = mapped.filter(p => p.statusCode >= 300 && p.statusCode < 400);
      else if (scFilter === '4xx') scPages = mapped.filter(p => p.statusCode >= 400 && p.statusCode < 500);
      else if (scFilter === '5xx') scPages = mapped.filter(p => p.statusCode >= 500);
      else if (scFilter === 'error') scPages = mapped.filter(p => p.error);
      // For non-2xx exports, attach the pages that link TO each broken URL so
      // the user can see WHERE each 3xx/4xx/5xx was discovered, not just that
      // it exists. Skipping for 2xx keeps the success export light.
      const wantOrigins = scFilter === '3xx' || scFilter === '4xx' || scFilter === '5xx' || scFilter === 'error';
      const originsIdx = wantOrigins ? buildOriginsIndex(pages) : null;
      data = scPages.map(p => (originsIdx
        ? { URL: p.url, Status: p.statusCode, ...originColumnsFor(p.url, originsIdx) }
        : { URL: p.url, Status: p.statusCode, 'Final URL': p.finalUrl || '' }
      ));
      sheetName = scFilter === 'all' ? 'Status Codes' : scFilter.toUpperCase() + ' Status Codes';
      break;
    }
    case 'metatitles': {
      const mt = analysis.metaTitlesReport || {};
      const mtFilter = req.query.filter || 'all';
      const addSheet = (wb, rows, name) => {
        if (!rows.length) return;
        const ws = XLSX.utils.json_to_sheet(decodeUrlCells(rows));
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
        const ws = XLSX.utils.json_to_sheet(decodeUrlCells(rows));
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
      const _lnk = analysis.internalLinkAnalysis || {};
      const _anch = analysis.anchorsReport || {};
      const _sm = analysis.sitemapReport || {};
      const _sec = analysis.securityReport || {};
      const _sd = analysis.structuredDataReport || {};
      const _aib = analysis.aiBotsReport || {};
      const addSheet = (wb, rows, name) => {
        if (!rows || !rows.length) return;
        const ws = XLSX.utils.json_to_sheet(decodeUrlCells(rows));
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
        { Category: 'Orphan Pages', Value: _lnk.orphanCount || 0 },
        { Category: 'Links Without Anchor Text', Value: _anch.totalEmptyAnchors || 0 },
        { Category: 'Pages with Schema', Value: _sd.pagesWithSD || 0 },
        { Category: 'Pages without Schema', Value: _sd.pagesWithoutSD || 0 },
        { Category: 'Sitemap Found', Value: _sm.found ? 'Yes' : 'No' },
        { Category: 'Crawled NOT in Sitemap', Value: _sm.crawledNotInSitemapCount || 0 },
        { Category: 'In Sitemap NOT Crawled', Value: _sm.inSitemapNotCrawledCount || 0 },
        { Category: 'HTTPS', Value: _sec.isHttps ? 'Yes' : 'No' },
        { Category: 'Critical Issues', Value: (analysis.issues || []).filter(i => i.severity === 'critical').length },
        { Category: 'Warnings', Value: (analysis.issues || []).filter(i => i.severity === 'warning').length },
      ], 'Summary');

      // 4xx Errors — with origin pages (which crawled pages link to each 4xx)
      const _summOrigins = buildOriginsIndex(pages);
      if (sc.groups?.['4xx']?.urls?.length > 0) addSheet(wb2, sc.groups['4xx'].urls.map(u => ({ URL: u.url, Status: u.statusCode, ...originColumnsFor(u.url, _summOrigins) })), '4xx Errors');
      // 3xx Redirects — with origin pages
      // 3xx Redirects — URL, Status, Source URLs (3 columns)
      if (sc.groups?.['3xx']?.urls?.length > 0) addSheet(wb2, sc.groups['3xx'].urls.map(u => ({ URL: u.url, Status: u.statusCode, ...originColumnsFor(u.url, _summOrigins) })), '3xx Redirects');
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
      // 5xx Errors
      if (sc.groups?.['5xx']?.urls?.length > 0) addSheet(wb2, sc.groups['5xx'].urls.map(u => ({ URL: u.url, Status: u.statusCode, ...originColumnsFor(u.url, _summOrigins) })), '5xx Errors');
      // Orphan Pages
      if (_lnk.orphanPages?.length > 0) addSheet(wb2, _lnk.orphanPages.map(u => ({ URL: u })), 'Orphan Pages');
      // Empty Anchor Links
      if (_anch.emptyAnchors?.length > 0) addSheet(wb2, _anch.emptyAnchors.map(a => ({ 'Origin Page': a.from, 'Destination URL': a.to, Nofollow: a.isNofollow ? 'Yes' : 'No' })), 'Empty Anchor Links');
      // Sitemap Issues
      const smData = [];
      if (_sm.non200InSitemap?.length > 0) _sm.non200InSitemap.forEach(u => smData.push({ URL: u.url, Status: u.statusCode, Issue: 'Non-200 URL in sitemap' }));
      if (_sm.crawledNotInSitemap?.length > 0) _sm.crawledNotInSitemap.forEach(u => smData.push({ URL: u, Status: '', Issue: 'Crawled, not in sitemap' }));
      if (_sm.inSitemapNotCrawled?.length > 0) _sm.inSitemapNotCrawled.forEach(u => smData.push({ URL: u, Status: '', Issue: 'In sitemap, not crawled' }));
      if (smData.length > 0) addSheet(wb2, smData, 'Sitemap Issues');
      // Non-200 in Sitemap (dedicated sheet)
      if (_sm.non200InSitemap?.length > 0) addSheet(wb2, _sm.non200InSitemap.map(u => ({ URL: u.url, Status: u.statusCode, Sitemap: u.sitemap || '' })), 'Non-200 in Sitemap');
      // Structured Data
      const sdTypes = Object.entries(_sd.typeCounts || {});
      if (sdTypes.length > 0) addSheet(wb2, sdTypes.map(([type, count]) => ({ 'Schema Type': type, Pages: count })), 'Structured Data');
      // Pages without Schema
      const noSD = mapped.filter(p => p.statusCode < 300 && !p.hasStructuredData && (!p.structuredData || p.structuredData.length === 0));
      if (noSD.length > 0) addSheet(wb2, noSD.map(p => ({ URL: p.url })), 'No Structured Data');
      // Security Headers
      const secH = _sec.headers || {};
      const secRows = mapped.filter(p => p.statusCode < 300).map(p => ({
        URL: p.url,
        HTTPS: p.url.startsWith('https') ? 'Yes' : 'No',
        HSTS: p.securityHeaders?.['strict-transport-security'] ? 'Yes' : 'No',
        'X-Frame-Options': p.securityHeaders?.['x-frame-options'] || 'Missing',
        'X-Content-Type-Options': p.securityHeaders?.['x-content-type-options'] || 'Missing'
      }));
      if (secRows.length > 0) addSheet(wb2, secRows, 'Security Headers');

      const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=full-seo-audit.xlsx');
      return res.send(buf2);
    }
    default:
      return res.status(400).json({ error: 'Unknown section' });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(decodeUrlCells(data));
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
// Own JSON parser with a raised limit: the global express.json() default is
// 100kb, and filtered exports (e.g. 404 Pages with multi-line source lists)
// can easily exceed that.
app.post('/api/crawls/:id/export-filtered-xlsx', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const { rows, sheetName, fileName } = req.body;
    if (!rows || !rows.length) return res.status(400).json({ error: 'No data to export' });
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(decodeUrlCells(rows));
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
  // Signal abort and return immediately. The crawler's _processQueue loop
  // exits on the aborted flag, then start() fires onComplete → finalizeCrawl,
  // which builds the report from everything crawled so far, persists it, and
  // emits `complete` to the client. We don't block this HTTP response on that
  // work (it can take a while for big crawls) — the client waits for the
  // socket event. Mark the row as finishing so a reload mid-drain is sane.
  crawler.abort();
  try { db.updateCrawlStatus(req.params.id, 'finishing', crawler.stats); } catch { /* non-fatal */ }
  res.status(202).json({ status: 'finishing', message: 'Building report from crawled pages…' });
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

// ── Google Search Console integration ──
const GSC_TOKEN_KEY = 'gsc:tokens';
const GSC_STATE_KEY = 'gsc:oauth_state';

async function getGscTokensOrError(res) {
  const tokens = db.kvGet(GSC_TOKEN_KEY);
  if (!tokens || !tokens.refresh_token) {
    res.status(401).json({
      error: 'Not connected to Google Search Console',
      reconnect: true,
      reconnectUrl: '/api/gsc/auth/start'
    });
    return null;
  }
  try {
    return await gsc.getValidAccessToken(tokens, (updated) => db.kvSet(GSC_TOKEN_KEY, updated));
  } catch (e) {
    // If Google rejected the refresh token (revoked, expired, or app in
    // Testing mode past 7 days), the stored creds are dead — clear them
    // so the UI can show a clean "reconnect" prompt instead of looping
    // on a broken token. Network errors leave the tokens in place so a
    // transient outage doesn't force re-auth.
    if (e && e.oauthInvalid) {
      try { db.kvDelete(GSC_TOKEN_KEY); } catch { /* ignore */ }
      res.status(401).json({
        error: 'Your Google Search Console session expired. Please reconnect.',
        reconnect: true,
        reconnectUrl: '/api/gsc/auth/start',
        reason: 'invalid_grant'
      });
      return null;
    }
    res.status(401).json({ error: 'GSC token refresh failed: ' + e.message, reconnect: false });
    return null;
  }
}

app.get('/api/gsc/status', (req, res) => {
  const tokens = db.kvGet(GSC_TOKEN_KEY);
  const configured = gsc.isConfigured();
  res.json({
    configured,
    connected: !!(tokens && tokens.refresh_token),
    email: tokens ? tokens.email || null : null,
    connectedAt: tokens ? tokens.connected_at || null : null
  });
});

app.get('/api/gsc/auth/start', (req, res) => {
  if (!gsc.isConfigured()) {
    return res.status(500).send('Google OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI environment variables.');
  }
  const state = gsc.generateState();
  db.kvSet(GSC_STATE_KEY, { state, created_at: Date.now() });
  res.redirect(gsc.buildAuthUrl(state));
});

app.get('/api/gsc/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/?gsc=error&reason=' + encodeURIComponent(String(error)));
  const stored = db.kvGet(GSC_STATE_KEY);
  if (!stored || stored.state !== state) {
    return res.redirect('/?gsc=error&reason=state_mismatch');
  }
  db.kvDelete(GSC_STATE_KEY);
  try {
    const tokens = await gsc.exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      return res.redirect('/?gsc=error&reason=no_refresh_token');
    }
    const grantedScopes = (tokens.scope || '').split(/\s+/);
    if (!grantedScopes.includes('https://www.googleapis.com/auth/webmasters.readonly')) {
      // User didn't grant Search Console access. Revoke the partial grant
      // so the next attempt starts clean, and surface a clear error.
      await gsc.revokeToken(tokens.refresh_token);
      return res.redirect('/?gsc=error&reason=missing_scope_webmasters');
    }
    const email = await gsc.fetchUserEmail(tokens.access_token);
    db.kvSet(GSC_TOKEN_KEY, { ...tokens, email, connected_at: new Date().toISOString() });
    res.redirect('/?gsc=connected#gsc');
  } catch (e) {
    res.redirect('/?gsc=error&reason=' + encodeURIComponent(e.message));
  }
});

app.post('/api/gsc/logout', async (req, res) => {
  const tokens = db.kvGet(GSC_TOKEN_KEY);
  if (tokens && tokens.refresh_token) await gsc.revokeToken(tokens.refresh_token);
  db.kvDelete(GSC_TOKEN_KEY);
  res.json({ ok: true });
});

app.get('/api/gsc/sites', async (req, res) => {
  const tokens = await getGscTokensOrError(res);
  if (!tokens) return;
  try {
    const sites = await gsc.listSites(tokens.access_token);
    res.json({ sites });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

app.post('/api/gsc/query', async (req, res) => {
  const tokens = await getGscTokensOrError(res);
  if (!tokens) return;
  const { siteUrl, startDate, endDate, dimensions, rowLimit, searchType, dataState, dimensionFilterGroups } = req.body || {};
  if (!siteUrl || !startDate || !endDate) {
    return res.status(400).json({ error: 'siteUrl, startDate and endDate are required' });
  }
  try {
    const body = {
      startDate,
      endDate,
      rowLimit: Math.min(parseInt(rowLimit) || 1000, 25000),
      startRow: 0
    };
    // GSC: omit `dimensions` entirely to get period totals. Send the array
    // when the caller supplied one; fall back to ['query'] only when the
    // caller didn't pass any `dimensions` key at all (legacy behaviour).
    if (Array.isArray(dimensions)) {
      if (dimensions.length) body.dimensions = dimensions;
    } else {
      body.dimensions = ['query'];
    }
    if (searchType) body.type = searchType;
    if (dataState) body.dataState = dataState;
    if (dimensionFilterGroups) body.dimensionFilterGroups = dimensionFilterGroups;
    const data = await gsc.searchAnalyticsQuery(tokens.access_token, siteUrl, body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// On-demand keyword coverage analysis. Pulls the page's live HTML and
// counts where the given queries appear (title, H1, headings, body).
// Used by the Content Strategy tab when a row is expanded.
app.post('/api/content-analysis', async (req, res) => {
  const { url, queries } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!Array.isArray(queries)) return res.status(400).json({ error: 'queries must be an array' });
  try {
    const data = await contentAnalyzer.analyse(url, queries.slice(0, 100));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gsc/sitemaps', async (req, res) => {
  const tokens = await getGscTokensOrError(res);
  if (!tokens) return;
  const siteUrl = req.query.siteUrl;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  try {
    const sitemaps = await gsc.listSitemaps(tokens.access_token, siteUrl);
    res.json({ sitemaps });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
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
