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
    `);

    // Migrations: add columns to existing tables
    const migrations = [
      'ALTER TABLE pages ADD COLUMN og_locale TEXT',
      'ALTER TABLE pages ADD COLUMN detected_content_lang TEXT',
      'ALTER TABLE pages ADD COLUMN language_mismatch TEXT',
      'ALTER TABLE crawls ADD COLUMN saved INTEGER DEFAULT 0',
      'ALTER TABLE crawls ADD COLUMN domain TEXT'
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
        og_locale, detected_content_lang, language_mismatch, crawled_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      JSON.stringify((pageData.links || []).map(l => ({ href: l.href, anchor: l.anchor, isInternal: l.isInternal, isNofollow: l.isNofollow }))),
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
      pageData.crawledAt || new Date().toISOString()
    );
  }

  getCrawl(id) {
    return this.db.prepare('SELECT * FROM crawls WHERE id = ?').get(id);
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

  close() {
    this.db.close();
  }
}

module.exports = CrawlDatabase;
