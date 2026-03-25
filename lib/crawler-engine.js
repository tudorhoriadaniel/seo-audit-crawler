const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const robotsParser = require('robots-parser');
const he = require('he');

class CrawlerEngine {
  constructor(options = {}) {
    this.startUrl = null;
    this.baseUrl = null;
    this.maxPages = options.maxPages || 5000;
    this.maxDepth = options.maxDepth || 10;
    this.concurrency = options.concurrency || 5;
    this.timeout = options.timeout || 30000;
    this.respectRobots = options.respectRobots !== false;
    this.followExternalLinks = options.followExternalLinks || false;
    this.userAgent = options.userAgent || 'SEOAuditCrawler/2.0 (+https://seo.converta.ro)';
    this.crawlJS = options.crawlJS || false;
    this.customHeaders = options.customHeaders || {};

    this.visited = new Set();
    this.queue = [];
    this.results = [];
    this.resources = [];
    this.redirectChains = [];
    this.sitemapUrls = new Set();
    this.robotsRules = null;
    this.running = false;
    this.paused = false;
    this.aborted = false;

    this.stats = {
      totalUrls: 0,
      crawled: 0,
      errors: 0,
      redirects: 0,
      blocked: 0,
      startTime: null,
      endTime: null
    };

    this.onProgress = null;
    this.onPageCrawled = null;
    this.onComplete = null;
    this.onError = null;
  }

  async start(url) {
    this.startUrl = url;
    this.baseUrl = new URL(url).origin;
    this.running = true;
    this.aborted = false;
    this.stats.startTime = Date.now();

    // Resolve the start URL — follow redirects to find the actual landing page
    // Record the redirect if the typed URL differs from the final URL
    const { finalUrl, redirectedFrom } = await this._resolveStartUrl(this.startUrl);

    // If there was a redirect (e.g. www -> non-www, or http -> https), record it
    if (redirectedFrom) {
      const redirectResult = {
        url: redirectedFrom.url,
        finalUrl: finalUrl,
        depth: 0,
        parent: null,
        statusCode: redirectedFrom.statusCode,
        statusText: redirectedFrom.statusCode === 301 ? 'Moved Permanently' : 'Redirect',
        contentType: 'text/html',
        responseTime: redirectedFrom.responseTime || 0,
        redirectChain: redirectedFrom.chain,
        isHtml: true,
        crawledAt: new Date().toISOString(),
        isInitialRedirect: true
      };
      this.results.push(redirectResult);
      this.stats.crawled++;
      this.stats.redirects++;
      this.visited.add(this._dedupeKey(redirectedFrom.url));
      if (this.onPageCrawled) this.onPageCrawled(redirectResult);
    }

    this.startUrl = finalUrl;
    this.baseUrl = new URL(finalUrl).origin;

    // Fetch robots.txt
    if (this.respectRobots) {
      await this._fetchRobots();
    }

    // Fetch sitemap
    await this._fetchSitemap();

    // Seed the queue with the resolved (200) URL
    this.queue.push({ url: this.startUrl, depth: 0, parent: null });
    this.stats.totalUrls = 1;

    // Also queue all sitemap URLs so we discover their status codes
    for (const smUrl of this.sitemapUrls) {
      const key = this._dedupeKey(smUrl);
      if (!this.visited.has(key) && this._isSameOrigin(smUrl)) {
        this.queue.push({ url: smUrl, depth: 1, parent: 'sitemap' });
        this.stats.totalUrls++;
      }
    }

    // Crawl with concurrency
    await this._processQueue();

    this.stats.endTime = Date.now();
    this.running = false;

    if (this.onComplete) {
      this.onComplete(this._getSummary());
    }

    return this._getSummary();
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  abort() { this.aborted = true; this.running = false; }

  /**
   * Follow redirects from the user-entered URL until we reach a 200 response.
   * Returns { finalUrl, redirectedFrom } where redirectedFrom is set if the
   * typed URL was different from the final URL (e.g. www -> non-www).
   */
  async _resolveStartUrl(url) {
    const startTime = Date.now();
    try {
      const redirectChain = [];
      const res = await axios.get(url, {
        timeout: this.timeout,
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 10,
        validateStatus: () => true,
        beforeRedirect: (options, { headers, statusCode }) => {
          redirectChain.push({ url: options.href || url, statusCode });
        }
      });
      const finalUrl = res.request?.res?.responseUrl || url;
      const elapsed = Date.now() - startTime;

      // If the final URL differs from what was typed, record the redirect
      if (finalUrl !== url && this._dedupeKey(finalUrl) !== this._dedupeKey(url)) {
        return {
          finalUrl,
          redirectedFrom: {
            url,
            statusCode: redirectChain.length > 0 ? redirectChain[0].statusCode : res.status,
            responseTime: elapsed,
            chain: redirectChain
          }
        };
      }
      return { finalUrl, redirectedFrom: null };
    } catch {
      return { finalUrl: url, redirectedFrom: null };
    }
  }

  async _fetchRobots() {
    // Try robots.txt on the resolved baseUrl (after any redirects from seed URL)
    const urlsToTry = [this.baseUrl];
    // Also try with/without www
    try {
      const u = new URL(this.baseUrl);
      if (u.hostname.startsWith('www.')) {
        urlsToTry.push(`${u.protocol}//${u.hostname.slice(4)}`);
      } else {
        urlsToTry.push(`${u.protocol}//www.${u.hostname}`);
      }
    } catch {}

    for (const base of urlsToTry) {
      try {
        const res = await axios.get(`${base}/robots.txt`, {
          timeout: 10000,
          headers: { 'User-Agent': this.userAgent },
          maxRedirects: 5,
          validateStatus: (s) => s < 400
        });
        if (res.status === 200 && typeof res.data === 'string' && res.data.length > 0) {
          this.robotsTxt = res.data;
          this.robotsRules = robotsParser(`${this.baseUrl}/robots.txt`, res.data);
          return; // found it
        }
      } catch (e) { /* try next */ }
    }
  }

  async _fetchSitemap() {
    this.sitemapSources = []; // track where sitemaps were found
    this.sitemapFiles = [];   // all sitemap file URLs discovered
    this.sitemapUrlDetails = []; // each URL with its source sitemap

    // 1. Check robots.txt for Sitemap directives
    const robotsSitemaps = [];
    if (this.robotsRules) {
      const sitemaps = this.robotsRules.getSitemaps();
      robotsSitemaps.push(...sitemaps);
      for (const s of sitemaps) {
        this.sitemapSources.push({ url: s, source: 'robots.txt' });
      }
    }

    // 2. Common sitemap URL patterns to try
    const commonPaths = [
      '/sitemap.xml',
      '/sitemap_index.xml',
      '/sitemaps.xml',
      '/sitemap-index.xml',
      '/wp-sitemap.xml',
      '/sitemap-post.xml',
      '/sitemap-page.xml',
      '/post-sitemap.xml',
      '/page-sitemap.xml',
      '/sitemap1.xml',
      '/sitemap_index.xml',
      '/sitemap/sitemap.xml',
    ];

    const toTry = new Set([...robotsSitemaps]);
    for (const p of commonPaths) {
      toTry.add(`${this.baseUrl}${p}`);
    }

    for (const smUrl of toTry) {
      await this._parseSitemap(smUrl, 0);
    }

    this.sitemapFromRobots = robotsSitemaps.length > 0;
  }

  async _parseSitemap(url, depth) {
    if (depth > 3) return;
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': this.userAgent },
        validateStatus: () => true
      });
      if (res.status !== 200) return;

      // Check it's actually XML
      const ct = (res.headers['content-type'] || '').toLowerCase();
      const data = typeof res.data === 'string' ? res.data : '';
      if (!ct.includes('xml') && !data.trim().startsWith('<?xml') && !data.trim().startsWith('<urlset') && !data.trim().startsWith('<sitemapindex')) return;

      const xml2js = require('xml2js');
      const result = await xml2js.parseStringPromise(data, { explicitArray: false });

      // Track this sitemap file
      const isInRobots = this.sitemapSources.some(s => s.url === url);
      if (!this.sitemapFiles.find(f => f.url === url)) {
        this.sitemapFiles.push({
          url,
          source: isInRobots ? 'robots.txt' : 'auto-discovery',
          type: result.sitemapindex ? 'index' : 'urlset',
          urlCount: 0
        });
      }

      if (result.sitemapindex && result.sitemapindex.sitemap) {
        const sitemaps = Array.isArray(result.sitemapindex.sitemap)
          ? result.sitemapindex.sitemap
          : [result.sitemapindex.sitemap];
        for (const sm of sitemaps) {
          if (sm.loc) {
            if (!this.sitemapFiles.find(f => f.url === sm.loc)) {
              this.sitemapSources.push({ url: sm.loc, source: `index: ${url}` });
            }
            await this._parseSitemap(sm.loc, depth + 1);
          }
        }
      }

      if (result.urlset && result.urlset.url) {
        const urls = Array.isArray(result.urlset.url)
          ? result.urlset.url
          : [result.urlset.url];
        const fileEntry = this.sitemapFiles.find(f => f.url === url);
        for (const u of urls) {
          if (u.loc) {
            this.sitemapUrls.add(u.loc);
            this.sitemapUrlDetails.push({
              url: u.loc,
              sitemap: url,
              lastmod: u.lastmod || null,
              changefreq: u.changefreq || null,
              priority: u.priority || null
            });
            if (fileEntry) fileEntry.urlCount++;
          }
        }
      }
    } catch (e) { /* skip */ }
  }

  _isAllowedByRobots(url) {
    if (!this.respectRobots || !this.robotsRules) return true;
    return this.robotsRules.isAllowed(url, this.userAgent);
  }

  _isSameOrigin(url) {
    try {
      return new URL(url).origin === this.baseUrl;
    } catch { return false; }
  }

  _normalizeUrl(url, base) {
    try {
      const u = new URL(url, base);
      u.hash = '';
      // Keep URLs as-is (preserve trailing slashes) to avoid
      // false 301s when the server enforces trailing slashes
      return u.href;
    } catch {
      return null;
    }
  }

  /**
   * For deduplication only — normalize to compare if two URLs are the same page.
   * Strips trailing slash and lowercases for comparison.
   */
  _dedupeKey(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      let key = u.href;
      if (u.pathname !== '/' && key.endsWith('/')) {
        key = key.slice(0, -1);
      }
      return key.toLowerCase();
    } catch {
      return url;
    }
  }

  async _processQueue() {
    const pLimit = require('p-limit');
    const limit = pLimit(this.concurrency);
    const active = new Set();

    while ((this.queue.length > 0 || active.size > 0) && !this.aborted) {
      if (this.paused) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      while (this.queue.length > 0 && active.size < this.concurrency && this.stats.crawled < this.maxPages) {
        const item = this.queue.shift();
        const dedupeKey = this._dedupeKey(item.url);
        if (this.visited.has(dedupeKey)) continue;
        this.visited.add(dedupeKey);

        const promise = limit(() => this._crawlPage(item))
          .then(() => active.delete(promise))
          .catch(() => active.delete(promise));
        active.add(promise);
      }

      if (active.size > 0) {
        await Promise.race([...active]);
      } else {
        break;
      }
    }

    // Wait for remaining
    if (active.size > 0) await Promise.all([...active]);
  }

  async _crawlPage(item) {
    const { url, depth, parent } = item;

    if (depth > this.maxDepth) return;
    if (this.stats.crawled >= this.maxPages) return;

    // Check robots
    if (!this._isAllowedByRobots(url)) {
      this.stats.blocked++;
      this.results.push({
        url,
        depth,
        parent,
        statusCode: 0,
        blockedByRobots: true,
        crawledAt: new Date().toISOString()
      });
      return;
    }

    const startTime = Date.now();
    let response, html, redirectChain = [];

    try {
      response = await axios.get(url, {
        timeout: this.timeout,
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          ...this.customHeaders
        },
        maxRedirects: 10,
        validateStatus: () => true,
        // Track redirects
        beforeRedirect: (options, { headers, statusCode }) => {
          redirectChain.push({ url: options.href || url, statusCode });
        }
      });

      html = typeof response.data === 'string' ? response.data : '';
    } catch (err) {
      this.stats.errors++;
      this.results.push({
        url,
        depth,
        parent,
        statusCode: 0,
        error: err.code || err.message,
        responseTime: Date.now() - startTime,
        crawledAt: new Date().toISOString()
      });
      this._emitProgress();
      return;
    }

    const responseTime = Date.now() - startTime;
    const contentType = (response.headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');

    // Track redirects
    if (redirectChain.length > 0) {
      this.stats.redirects++;
      this.redirectChains.push({
        from: url,
        chain: redirectChain,
        finalUrl: response.request?.res?.responseUrl || url,
        finalStatus: response.status
      });
    }

    const pageData = {
      url,
      finalUrl: response.request?.res?.responseUrl || url,
      depth,
      parent,
      statusCode: response.status,
      statusText: response.statusText,
      contentType,
      contentLength: parseInt(response.headers['content-length'] || '0') || Buffer.byteLength(html, 'utf8'),
      responseTime,
      redirectChain: redirectChain.length > 0 ? redirectChain : null,
      isHtml,
      crawledAt: new Date().toISOString(),

      // Headers
      server: response.headers['server'] || null,
      xRobotsTag: response.headers['x-robots-tag'] || null,
      cacheControl: response.headers['cache-control'] || null,
      contentEncoding: response.headers['content-encoding'] || null,

      // Security headers
      securityHeaders: {
        strictTransportSecurity: response.headers['strict-transport-security'] || null,
        contentSecurityPolicy: response.headers['content-security-policy'] || null,
        xContentTypeOptions: response.headers['x-content-type-options'] || null,
        xFrameOptions: response.headers['x-frame-options'] || null,
        xXssProtection: response.headers['x-xss-protection'] || null,
        referrerPolicy: response.headers['referrer-policy'] || null
      },

      // In sitemap?
      inSitemap: this.sitemapUrls.has(url) || this.sitemapUrls.has(url + '/')
    };

    if (isHtml && html) {
      const extracted = this._extractPageData(html, url);
      Object.assign(pageData, extracted);

      // Queue discovered internal links (use dedupeKey to avoid crawling same page twice)
      if (extracted.links) {
        for (const link of extracted.links) {
          const linkKey = this._dedupeKey(link.href);
          if (link.isInternal && !this.visited.has(linkKey) && this.stats.totalUrls < this.maxPages * 2) {
            this.queue.push({ url: link.href, depth: depth + 1, parent: url });
            this.stats.totalUrls++;
          }
        }
      }

      // Also queue canonical URL if it's internal and different from current page
      if (extracted.canonical && !extracted.canonicalIsSelf) {
        const canKey = this._dedupeKey(extracted.canonical);
        if (this._isSameOrigin(extracted.canonical) && !this.visited.has(canKey) && this.stats.totalUrls < this.maxPages * 2) {
          this.queue.push({ url: extracted.canonical, depth: depth + 1, parent: url });
          this.stats.totalUrls++;
        }
      }

      // Also queue hreflang URLs if internal
      if (extracted.hreflangs) {
        for (const hl of extracted.hreflangs) {
          if (!hl.href) continue;
          const hlKey = this._dedupeKey(hl.href);
          if (this._isSameOrigin(hl.href) && !this.visited.has(hlKey) && this.stats.totalUrls < this.maxPages * 2) {
            this.queue.push({ url: hl.href, depth: depth + 1, parent: url });
            this.stats.totalUrls++;
          }
        }
      }
    }

    this.stats.crawled++;
    this.results.push(pageData);
    this._emitProgress();

    if (this.onPageCrawled) {
      this.onPageCrawled(pageData);
    }
  }

  _extractPageData(html, pageUrl) {
    const $ = cheerio.load(html);
    const data = {};

    // Title
    data.title = $('title').first().text().trim() || null;
    data.titleLength = data.title ? data.title.length : 0;

    // Meta description
    data.metaDescription = $('meta[name="description"]').attr('content')?.trim() || null;
    data.metaDescriptionLength = data.metaDescription ? data.metaDescription.length : 0;

    // Meta keywords
    data.metaKeywords = $('meta[name="keywords"]').attr('content')?.trim() || null;

    // Meta robots
    data.metaRobots = $('meta[name="robots"]').attr('content')?.trim() || null;
    data.metaGooglebot = $('meta[name="googlebot"]').attr('content')?.trim() || null;

    // Canonical
    data.canonical = $('link[rel="canonical"]').attr('href')?.trim() || null;
    if (data.canonical) {
      data.canonical = this._normalizeUrl(data.canonical, pageUrl);
    }
    data.canonicalIsSelf = data.canonical === pageUrl || data.canonical === this._normalizeUrl(pageUrl, pageUrl);

    // Hreflang
    data.hreflangs = [];
    $('link[rel="alternate"][hreflang]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      const lang = $(el).attr('hreflang')?.trim();
      if (href && lang) {
        data.hreflangs.push({
          lang,
          href: this._normalizeUrl(href, pageUrl)
        });
      }
    });

    // Hreflang/Canonical conflicts
    data.hreflangCanonicalConflicts = this._detectHreflangCanonicalConflicts(
      pageUrl, data.canonical, data.hreflangs
    );

    // Headings
    data.h1 = [];
    $('h1').each((_, el) => data.h1.push($(el).text().trim()));
    data.h1Count = data.h1.length;

    data.h2 = [];
    $('h2').each((_, el) => data.h2.push($(el).text().trim()));
    data.h2Count = data.h2.length;

    data.headingStructure = [];
    $('h1,h2,h3,h4,h5,h6').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      data.headingStructure.push({
        tag,
        level: parseInt(tag[1]),
        text: $(el).text().trim().substring(0, 200)
      });
    });

    // Open Graph
    data.ogTitle = $('meta[property="og:title"]').attr('content')?.trim() || null;
    data.ogDescription = $('meta[property="og:description"]').attr('content')?.trim() || null;
    data.ogImage = $('meta[property="og:image"]').attr('content')?.trim() || null;
    data.ogType = $('meta[property="og:type"]').attr('content')?.trim() || null;
    data.ogUrl = $('meta[property="og:url"]').attr('content')?.trim() || null;

    // Twitter Card
    data.twitterCard = $('meta[name="twitter:card"]').attr('content')?.trim() || null;
    data.twitterTitle = $('meta[name="twitter:title"]').attr('content')?.trim() || null;
    data.twitterDescription = $('meta[name="twitter:description"]').attr('content')?.trim() || null;
    data.twitterImage = $('meta[name="twitter:image"]').attr('content')?.trim() || null;

    // Viewport
    data.viewport = $('meta[name="viewport"]').attr('content')?.trim() || null;
    data.hasViewport = !!data.viewport;

    // Charset
    data.charset = $('meta[charset]').attr('charset')?.trim() ||
                   $('meta[http-equiv="Content-Type"]').attr('content')?.match(/charset=([^\s;]+)/)?.[1] || null;

    // Language
    data.htmlLang = $('html').attr('lang')?.trim() || null;

    // Links
    data.links = [];
    data.internalLinks = 0;
    data.externalLinks = 0;
    data.nofollowLinks = 0;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      const resolved = this._normalizeUrl(href, pageUrl);
      if (!resolved) return;

      const isInternal = this._isSameOrigin(resolved);
      const rel = $(el).attr('rel') || '';
      const isNofollow = rel.includes('nofollow');
      // Get visible anchor: text content, or img alt, or aria-label
      let anchor = $(el).text().trim().substring(0, 200);
      if (!anchor) {
        const img = $(el).find('img');
        if (img.length > 0) anchor = img.attr('alt')?.trim() || '[image]';
      }
      if (!anchor) anchor = $(el).attr('aria-label')?.trim() || $(el).attr('title')?.trim() || '';
      const hasVisibleContent = !!(anchor || $(el).find('img,svg,picture,video,i,span[class]').length > 0);

      if (isInternal) data.internalLinks++;
      else data.externalLinks++;
      if (isNofollow) data.nofollowLinks++;

      data.links.push({
        href: resolved,
        anchor,
        hasVisibleContent,
        isInternal,
        isNofollow,
        rel,
        isUGC: rel.includes('ugc'),
        isSponsored: rel.includes('sponsored'),
        target: $(el).attr('target') || null,
        statusCode: null // filled later in link audit
      });
    });

    // Images
    data.images = [];
    data.imagesWithoutAlt = 0;
    data.totalImages = 0;

    $('img').each((_, el) => {
      const src = $(el).attr('src')?.trim();
      const alt = $(el).attr('alt');
      const width = $(el).attr('width');
      const height = $(el).attr('height');
      const loading = $(el).attr('loading');
      const hasAlt = alt !== undefined && alt !== null;
      const altText = hasAlt ? alt.trim() : null;

      if (!hasAlt || altText === '') data.imagesWithoutAlt++;
      data.totalImages++;

      data.images.push({
        src: src ? this._normalizeUrl(src, pageUrl) : null,
        alt: altText,
        hasAlt,
        altEmpty: hasAlt && altText === '',
        width,
        height,
        hasDimensions: !!(width && height),
        loading
      });
    });

    // Word count (visible text)
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    data.wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
    data.textRatio = html.length > 0 ? ((bodyText.length / html.length) * 100).toFixed(1) : 0;

    // Structured data
    data.structuredData = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        const types = Array.isArray(json) ? json.map(j => j['@type']).filter(Boolean) : [json['@type']].filter(Boolean);
        data.structuredData.push(...types);
      } catch { /* invalid JSON-LD */ }
    });
    data.hasStructuredData = data.structuredData.length > 0;

    // Scripts & Stylesheets
    data.scripts = [];
    $('script[src]').each((_, el) => {
      data.scripts.push({
        src: this._normalizeUrl($(el).attr('src'), pageUrl),
        async: $(el).attr('async') !== undefined,
        defer: $(el).attr('defer') !== undefined
      });
    });

    data.stylesheets = [];
    $('link[rel="stylesheet"]').each((_, el) => {
      data.stylesheets.push({
        href: this._normalizeUrl($(el).attr('href'), pageUrl),
        media: $(el).attr('media') || 'all'
      });
    });

    // Inline styles/scripts count
    data.inlineScripts = $('script:not([src])').length;
    data.inlineStyles = $('style').length;

    // iframes
    data.iframes = $('iframe').length;

    // Forms
    data.forms = $('form').length;

    // Pagination
    data.relNext = $('link[rel="next"]').attr('href') || null;
    data.relPrev = $('link[rel="prev"]').attr('href') || null;

    // AMP
    data.ampHref = $('link[rel="amphtml"]').attr('href') || null;

    // Favicon
    data.favicon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || null;

    // Content hash for duplicate detection
    const cleanText = bodyText.toLowerCase().replace(/[^a-z0-9\s]/g, '').substring(0, 5000);
    data.contentHash = this._simpleHash(cleanText);
    data.titleHash = data.title ? this._simpleHash(data.title.toLowerCase()) : null;

    return data;
  }

  _detectHreflangCanonicalConflicts(pageUrl, canonical, hreflangs) {
    const conflicts = [];
    const normalizedPage = this._normalizeUrl(pageUrl, pageUrl);
    const normalizedCanonical = canonical ? this._normalizeUrl(canonical, pageUrl) : null;

    if (!hreflangs || hreflangs.length === 0) return conflicts;

    // 1. Canonical points to different URL but page has hreflangs
    // This means Google may ignore hreflangs since canonical signals a different preferred URL
    if (normalizedCanonical && normalizedCanonical !== normalizedPage) {
      conflicts.push({
        type: 'canonical_differs_from_page',
        severity: 'critical',
        message: `Canonical (${normalizedCanonical}) differs from page URL. Hreflangs on this page may be ignored by Google.`,
        canonical: normalizedCanonical,
        pageUrl: normalizedPage
      });
    }

    // 2. Self-referencing hreflang missing
    const selfRef = hreflangs.find(h => {
      const norm = this._normalizeUrl(h.href, pageUrl);
      return norm === normalizedPage || norm === normalizedCanonical;
    });
    if (!selfRef) {
      conflicts.push({
        type: 'missing_self_referencing_hreflang',
        severity: 'warning',
        message: 'No self-referencing hreflang found. Google recommends including the current page in hreflang annotations.',
        pageUrl: normalizedPage
      });
    }

    // 3. x-default missing
    const hasXDefault = hreflangs.some(h => h.lang === 'x-default');
    if (!hasXDefault && hreflangs.length > 1) {
      conflicts.push({
        type: 'missing_x_default',
        severity: 'warning',
        message: 'No x-default hreflang found. Recommended for proper fallback behavior.',
        pageUrl: normalizedPage
      });
    }

    // 4. Hreflang URL conflicts with canonical
    for (const hl of hreflangs) {
      const hlNorm = this._normalizeUrl(hl.href, pageUrl);
      // If a hreflang points to a URL that is not the canonical, flag it
      if (hlNorm === normalizedPage && normalizedCanonical && normalizedCanonical !== normalizedPage) {
        conflicts.push({
          type: 'hreflang_self_vs_canonical_mismatch',
          severity: 'critical',
          message: `Hreflang for "${hl.lang}" points to ${hlNorm} but canonical points to ${normalizedCanonical}. Google will likely follow the canonical and ignore this hreflang.`,
          lang: hl.lang,
          hreflangUrl: hlNorm,
          canonical: normalizedCanonical
        });
      }
    }

    // 5. Duplicate language codes
    const langCounts = {};
    for (const hl of hreflangs) {
      langCounts[hl.lang] = (langCounts[hl.lang] || 0) + 1;
    }
    for (const [lang, count] of Object.entries(langCounts)) {
      if (count > 1) {
        conflicts.push({
          type: 'duplicate_hreflang_lang',
          severity: 'warning',
          message: `Duplicate hreflang language code "${lang}" found ${count} times.`,
          lang,
          count
        });
      }
    }

    // 6. Invalid language codes
    const validLangPattern = /^[a-z]{2}(-[A-Za-z]{2,})?$|^x-default$/;
    for (const hl of hreflangs) {
      if (!validLangPattern.test(hl.lang)) {
        conflicts.push({
          type: 'invalid_hreflang_lang',
          severity: 'error',
          message: `Invalid hreflang language code: "${hl.lang}".`,
          lang: hl.lang
        });
      }
    }

    return conflicts;
  }

  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  _emitProgress() {
    if (this.onProgress) {
      this.onProgress({
        crawled: this.stats.crawled,
        queued: this.queue.length,
        total: this.stats.totalUrls,
        errors: this.stats.errors,
        redirects: this.stats.redirects,
        blocked: this.stats.blocked,
        elapsed: Date.now() - this.stats.startTime,
        pagesPerSecond: this.stats.crawled / ((Date.now() - this.stats.startTime) / 1000) || 0
      });
    }
  }

  _getSummary() {
    return {
      stats: {
        ...this.stats,
        duration: this.stats.endTime - this.stats.startTime,
        pagesPerSecond: (this.stats.crawled / ((this.stats.endTime - this.stats.startTime) / 1000)).toFixed(2)
      },
      results: this.results,
      redirectChains: this.redirectChains,
      sitemapUrlCount: this.sitemapUrls.size,
      robotsTxt: this.robotsTxt || null,
      sitemapData: {
        fromRobots: this.sitemapFromRobots || false,
        files: this.sitemapFiles || [],
        urls: this.sitemapUrlDetails || [],
        sources: this.sitemapSources || []
      }
    };
  }
}

module.exports = CrawlerEngine;
