const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(process.cwd(), 'data');

class CrawlDatabase {
  constructor() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    this.dbPath = path.join(DB_DIR, 'crawls.db');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crawls (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        config TEXT,
        stats TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crawl_id TEXT NOT NULL,
        url TEXT NOT NULL,
        final_url TEXT,
        status_code INTEGER,
        content_type TEXT,
        title TEXT,
        title_length INTEGER,
        meta_description TEXT,
        meta_description_length INTEGER,
        meta_robots TEXT,
        canonical TEXT,
        canonical_is_self INTEGER,
        h1 TEXT,
        h1_count INTEGER,
        h2_count INTEGER,
        word_count INTEGER,
        text_ratio REAL,
        response_time INTEGER,
        content_length INTEGER,
        depth INTEGER,
        parent TEXT,
        internal_links INTEGER,
        external_links INTEGER,
        images_total INTEGER,
        images_without_alt INTEGER,
        has_structured_data INTEGER,
        structured_data_types TEXT,
        has_viewport INTEGER,
        html_lang TEXT,
        og_title TEXT,
        og_description TEXT,
        og_image TEXT,
        twitter_card TEXT,
        in_sitemap INTEGER,
        error TEXT,
        blocked_by_robots INTEGER DEFAULT 0,
        heading_structure TEXT,
        hreflangs TEXT,
        hreflang_canonical_conflicts TEXT,
        redirect_chain TEXT,
        security_headers TEXT,
        links TEXT,
        images TEXT,
        scripts_count INTEGER,
        stylesheets_count INTEGER,
        content_hash TEXT,
        title_hash TEXT,
        server_header TEXT,
        x_robots_tag TEXT,
        rel_next TEXT,
        rel_prev TEXT,
        favicon TEXT,
        og_locale TEXT,
        detected_content_lang TEXT,
        language_mismatch TEXT,
        crawled_at DATETIME,
        FOREIGN KEY (crawl_id) REFERENCES crawls(id)
      );

      CREATE INDEX IF NOT EXISTS idx_pages_crawl ON pages(crawl_id);
      CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(crawl_id, url);
      CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(crawl_id, status_code);

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ai_visibility_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        query TEXT NOT NULL,
        engine TEXT NOT NULL,
        cited INTEGER DEFAULT 0,
        position INTEGER,
        total_citations INTEGER,
        citations TEXT,
        matched_url TEXT,
        answer_excerpt TEXT,
        error TEXT,
        checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_aivis_domain ON ai_visibility_results(domain, checked_at);
    `);

    // Migrations: add columns to existing tables
    const migrations = [
      'ALTER TABLE pages ADD COLUMN og_locale TEXT',
      'ALTER TABLE pages ADD COLUMN detected_content_lang TEXT',
      'ALTER TABLE pages ADD COLUMN language_mismatch TEXT',
      'ALTER TABLE crawls ADD COLUMN saved INTEGER DEFAULT 0',
      'ALTER TABLE crawls ADD COLUMN domain TEXT',
      // Cached full analysis JSON, computed once when a crawl finishes (or is
      // stopped). Lets us serve the report instantly on every reload instead
      // of re-running the analyzer over every page on each request — which was
      // timing out for large (10k+ page) crawls.
      'ALTER TABLE crawls ADD COLUMN analysis TEXT',
      // WAF/bot-protection vendor that challenged this page fetch (Cloudflare,
      // Akamai, …) — null when the page was served normally
      'ALTER TABLE pages ADD COLUMN bot_challenge TEXT',
      // GEO / AI-readiness signals JSON blob (snippet directives, answerability,
      // citation stats, schema E-E-A-T) — null for pages from older crawls
      'ALTER TABLE pages ADD COLUMN geo_signals TEXT'
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch (e) { /* column already exists */ }
    }
  }

  createCrawl(id, url, config, { saved = 0, domain = null } = {}) {
    this.db.prepare('INSERT INTO crawls (id, url, config, status, saved, domain) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, url, JSON.stringify(config), 'running', saved ? 1 : 0, domain
    );
    return id;
  }

  updateCrawlStatus(id, status, stats) {
    const completedAt = (status === 'completed' || status === 'error') ? new Date().toISOString() : null;
    this.db.prepare('UPDATE crawls SET status = ?, stats = ?, updated_at = CURRENT_TIMESTAMP, completed_at = COALESCE(?, completed_at) WHERE id = ?')
      .run(status, JSON.stringify(stats || {}), completedAt, id);
  }

  insertPage(crawlId, pageData) {
    const stmt = this.db.prepare(`
      INSERT INTO pages (
        crawl_id, url, final_url, status_code, content_type, title, title_length,
        meta_description, meta_description_length, meta_robots, canonical, canonical_is_self,
        h1, h1_count, h2_count, word_count, text_ratio, response_time, content_length,
        depth, parent, internal_links, external_links, images_total, images_without_alt,
        has_structured_data, structured_data_types, has_viewport, html_lang,
        og_title, og_description, og_image, twitter_card, in_sitemap,
        error, blocked_by_robots, heading_structure, hreflangs, hreflang_canonical_conflicts,
        redirect_chain, security_headers, links, images, scripts_count, stylesheets_count,
        content_hash, title_hash, server_header, x_robots_tag, rel_next, rel_prev, favicon,
        og_locale, detected_content_lang, language_mismatch, bot_challenge, geo_signals, crawled_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      crawlId,
      pageData.url,
      pageData.finalUrl || null,
      pageData.statusCode || 0,
      pageData.contentType || null,
      pageData.title || null,
      pageData.titleLength || 0,
      pageData.metaDescription || null,
      pageData.metaDescriptionLength || 0,
      pageData.metaRobots || null,
      pageData.canonical || null,
      pageData.canonicalIsSelf ? 1 : 0,
      JSON.stringify(pageData.h1 || []),
      pageData.h1Count || 0,
      pageData.h2Count || 0,
      pageData.wordCount || 0,
      pageData.textRatio || 0,
      pageData.responseTime || 0,
      pageData.contentLength || 0,
      pageData.depth || 0,
      pageData.parent || null,
      pageData.internalLinks || 0,
      pageData.externalLinks || 0,
      pageData.totalImages || 0,
      pageData.imagesWithoutAlt || 0,
      pageData.hasStructuredData ? 1 : 0,
      JSON.stringify(pageData.structuredData || []),
      pageData.hasViewport ? 1 : 0,
      pageData.htmlLang || null,
      pageData.ogTitle || null,
      pageData.ogDescription || null,
      pageData.ogImage || null,
      pageData.twitterCard || null,
      pageData.inSitemap ? 1 : 0,
      pageData.error || null,
      pageData.blockedByRobots ? 1 : 0,
      JSON.stringify(pageData.headingStructure || []),
      JSON.stringify(pageData.hreflangs || []),
      JSON.stringify(pageData.hreflangCanonicalConflicts || []),
      JSON.stringify(pageData.redirectChain || []),
      JSON.stringify(pageData.securityHeaders || {}),
      JSON.stringify((pageData.links || []).map(l => ({ href: l.href, anchor: l.anchor, isInternal: l.isInternal, isNofollow: l.isNofollow, isMalformed: l.isMalformed || false, rawHref: l.rawHref }))),
      JSON.stringify((pageData.images || []).map(i => ({ src: i.src, alt: i.alt, hasAlt: i.hasAlt, altEmpty: i.altEmpty }))),
      pageData.scripts ? pageData.scripts.length : 0,
      pageData.stylesheets ? pageData.stylesheets.length : 0,
      pageData.contentHash || null,
      pageData.titleHash || null,
      pageData.server || null,
      pageData.xRobotsTag || null,
      pageData.relNext || null,
      pageData.relPrev || null,
      pageData.favicon || null,
      pageData.ogLocale || null,
      pageData.detectedContentLang || null,
      JSON.stringify(pageData.languageMismatch || null),
      pageData.botChallenge || null,
      pageData.geoSignals ? JSON.stringify(pageData.geoSignals) : null,
      pageData.crawledAt || new Date().toISOString()
    );
  }

  getCrawl(id) {
    return this.db.prepare('SELECT * FROM crawls WHERE id = ?').get(id);
  }

  // Persist the computed analysis JSON for a crawl so subsequent loads don't
  // recompute it. Stored as a string blob; callers JSON.parse on read.
  saveAnalysis(id, analysis) {
    const json = typeof analysis === 'string' ? analysis : JSON.stringify(analysis);
    this.db.prepare('UPDATE crawls SET analysis = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(json, id);
  }

  // Returns the parsed cached analysis, or null if none stored yet.
  getAnalysis(id) {
    const row = this.db.prepare('SELECT analysis FROM crawls WHERE id = ?').get(id);
    if (!row || !row.analysis) return null;
    try { return JSON.parse(row.analysis); } catch { return null; }
  }

  getCrawlPages(id, options = {}) {
    let query = 'SELECT * FROM pages WHERE crawl_id = ?';
    const params = [id];

    if (options.statusCode) {
      query += ' AND status_code = ?';
      params.push(options.statusCode);
    }
    if (options.hasIssue) {
      // Filter will be done in JS
    }

    query += ' ORDER BY depth ASC, url ASC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    return this.db.prepare(query).all(...params);
  }

  // Lightweight projection for the All Pages list: only the columns the table
  // + its filters/sorts need. Crucially omits the big per-page blobs (links,
  // images, heading_structure, security_headers, redirect_chain) so we can
  // return EVERY crawled page (10k–50k) in one payload without shipping
  // hundreds of MB. Full per-page detail is fetched on demand via
  // getCrawlPageByUrl when a row is opened.
  getCrawlPagesLite(id) {
    return this.db.prepare(`
      SELECT url, status_code, content_type, title, title_length,
             meta_description, meta_description_length, h1, h1_count, h2_count,
             word_count, canonical, canonical_is_self, hreflangs,
             structured_data_types, meta_robots, response_time, depth
      FROM pages WHERE crawl_id = ?
      ORDER BY depth ASC, url ASC
    `).all(id);
  }

  // Full single-page row, used to populate the page-detail modal on click.
  getCrawlPageByUrl(id, url) {
    return this.db.prepare('SELECT * FROM pages WHERE crawl_id = ? AND url = ? ORDER BY id ASC LIMIT 1').get(id, url);
  }

  // Count of crawled page rows for a crawl (used to keep "Showing X of Y" and
  // exports aligned with the real total without loading every row).
  countCrawlPages(id) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM pages WHERE crawl_id = ?').get(id);
    return row ? row.n : 0;
  }

  listCrawls(limit = 50) {
    return this.db.prepare('SELECT id, url, status, stats, saved, domain, created_at, completed_at FROM crawls ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  deleteCrawl(id) {
    this.db.prepare('DELETE FROM pages WHERE crawl_id = ?').run(id);
    this.db.prepare('DELETE FROM crawls WHERE id = ?').run(id);
  }

  // Get all saved projects grouped by domain
  getSavedProjects() {
    return this.db.prepare(`
      SELECT domain, COUNT(*) as crawl_count,
             MAX(completed_at) as last_crawl,
             MIN(created_at) as first_crawl
      FROM crawls
      WHERE saved = 1 AND status = 'completed' AND domain IS NOT NULL
      GROUP BY domain
      ORDER BY MAX(completed_at) DESC
    `).all();
  }

  // Get completed crawls for a domain (for history/comparison)
  getCrawlsByDomain(domain, limit = 20) {
    return this.db.prepare(
      'SELECT id, url, status, stats, saved, created_at, completed_at FROM crawls WHERE domain = ? AND status = ? ORDER BY created_at DESC LIMIT ?'
    ).all(domain, 'completed', limit);
  }

  // Delete unsaved crawls for a domain (keep only the latest unsaved one)
  cleanupUnsavedCrawls(domain, keepCrawlId) {
    const unsaved = this.db.prepare(
      'SELECT id FROM crawls WHERE domain = ? AND saved = 0 AND id != ?'
    ).all(domain, keepCrawlId);
    for (const c of unsaved) {
      this.deleteCrawl(c.id);
    }
    return unsaved.length;
  }

  // Mark a crawl as saved/unsaved
  setCrawlSaved(id, saved) {
    this.db.prepare('UPDATE crawls SET saved = ? WHERE id = ?').run(saved ? 1 : 0, id);
  }

  // ── Key/value store (used by GSC token storage) ──
  kvGet(key) {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  kvSet(key, value) {
    const serialised = typeof value === 'string' ? value : JSON.stringify(value);
    this.db.prepare(`
      INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, serialised);
  }

  kvDelete(key) {
    this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
  }

  // ── AI Visibility (citations in AI answers) ──
  saveAiVisibilityResult(r) {
    this.db.prepare(`
      INSERT INTO ai_visibility_results
        (domain, query, engine, cited, position, total_citations, citations, matched_url, answer_excerpt, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.domain, r.query, r.engine, r.cited ? 1 : 0, r.position ?? null,
      r.totalCitations ?? null, JSON.stringify(r.citations || []),
      r.matchedUrl || null, r.answerExcerpt || null, r.error || null
    );
  }

  getAiVisibilityHistory(domain, limit = 200) {
    return this.db.prepare(`
      SELECT * FROM ai_visibility_results WHERE domain = ?
      ORDER BY checked_at DESC, id DESC LIMIT ?
    `).all(domain, limit);
  }

  close() {
    this.db.close();
  }
}

module.exports = CrawlDatabase;
