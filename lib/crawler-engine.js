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

    // Always fetch robots.txt — needed for AI bots analysis, sitemap discovery, and optionally for crawl rules
    await this._fetchRobots();

    // Fetch sitemap
    await this._fetchSitemap();

    // Seed the queue with the resolved (200) URL. The user typed this URL explicitly,
    // so crawl it even if robots.txt disallows generic user agents — otherwise a
    // redirect-then-block site would yield zero homepage data.
    this.queue.push({ url: this.startUrl, depth: 0, parent: null, force: true });
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
          responseType: 'text',
          validateStatus: (s) => s < 400
        });
        const txt = typeof res.data === 'string' ? res.data : String(res.data || '');
        if (res.status === 200 && txt.length > 0) {
          this.robotsTxt = txt;
          this.robotsRules = robotsParser(`${this.baseUrl}/robots.txt`, txt);
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
    // Skip if already parsed this sitemap
    if (this._parsedSitemaps && this._parsedSitemaps.has(url)) return;
    if (!this._parsedSitemaps) this._parsedSitemaps = new Set();
    this._parsedSitemaps.add(url);
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': this.userAgent },
        maxRedirects: 5,
        responseType: 'text',
        validateStatus: () => true
      });
      if (res.status !== 200) return;

      // If the sitemap redirected, use the final URL instead and skip this entry
      const finalSitemapUrl = res.request?.res?.responseUrl || url;
      if (finalSitemapUrl !== url) {
        // Queue the final URL for parsing instead, skip the redirect URL
        if (!this._parsedSitemaps.has(finalSitemapUrl)) {
          await this._parseSitemap(finalSitemapUrl, depth);
        }
        return;
      }

      // Check it's actually XML
      const ct = (res.headers['content-type'] || '').toLowerCase();
      // Force data to string even if axios parsed it
      let data = '';
      if (typeof res.data === 'string') data = res.data;
      else if (typeof res.data === 'object') data = JSON.stringify(res.data);
      else data = String(res.data || '');
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
    const { url, depth, parent, force } = item;

    if (depth > this.maxDepth) return;
    if (this.stats.crawled >= this.maxPages) return;

    // Check robots (skip for URLs the user explicitly seeded, e.g. the resolved homepage)
    if (!force && !this._isAllowedByRobots(url)) {
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

    const actualFinalUrl = response.request?.res?.responseUrl || url;
    const didRedirect = redirectChain.length > 0 && this._dedupeKey(actualFinalUrl) !== this._dedupeKey(url);

    // Same-origin page redirecting to an external origin is almost always a
    // share/outbound handler (e.g. /post/?share=facebook → facebook.com/login).
    // It's not a site-internal redirect issue — skip it entirely so it doesn't
    // inflate the 3xx report.
    const redirectsExternally = didRedirect && this._isSameOrigin(url) && !this._isSameOrigin(actualFinalUrl);
    if (redirectsExternally) {
      return;
    }

    // Track redirects
    if (redirectChain.length > 0) {
      this.stats.redirects++;
      this.redirectChains.push({
        from: url,
        chain: redirectChain,
        finalUrl: actualFinalUrl,
        finalStatus: response.status
      });
    }

    // If the URL redirected to a different page, record a minimal 301 entry
    // and queue the final URL for full crawling
    if (didRedirect) {
      const redirectResult = {
        url,
        finalUrl: actualFinalUrl,
        depth,
        parent,
        statusCode: redirectChain[0].statusCode,
        statusText: redirectChain[0].statusCode === 301 ? 'Moved Permanently' : 'Redirect',
        contentType: 'text/html',
        responseTime,
        redirectChain,
        isHtml: true,
        crawledAt: new Date().toISOString()
      };
      this.results.push(redirectResult);
      this.stats.crawled++;
      if (this.onPageCrawled) this.onPageCrawled(redirectResult);
      this._emitProgress();

      // Queue the final URL for full crawling if not already visited
      const finalKey = this._dedupeKey(actualFinalUrl);
      if (!this.visited.has(finalKey) && this._isSameOrigin(actualFinalUrl)) {
        this.visited.add(finalKey);
        this.queue.push({ url: actualFinalUrl, depth, parent: url });
      }
      return;
    }

    const pageData = {
      url,
      finalUrl: actualFinalUrl,
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

    // Language (extract early for hreflang conflict detection)
    data.htmlLang = $('html').attr('lang')?.trim() || null;

    // Hreflang/Canonical conflicts
    data.hreflangCanonicalConflicts = this._detectHreflangCanonicalConflicts(
      pageUrl, data.canonical, data.hreflangs, data.htmlLang
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
    data.ogLocale = $('meta[property="og:locale"]').attr('content')?.trim() || null;

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

    // Content language detection & mismatch
    // Extract MAIN CONTENT text only (exclude nav, header, footer, sidebar, menus)
    // This avoids false positives from navigation being in the declared language
    // while body content is in a different language
    const $contentClone = $.root().clone();
    $contentClone.find('nav, header, footer, aside, .sidebar, .nav, .menu, .navigation, .header, .footer, .breadcrumb, .breadcrumbs, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], script, style, noscript').remove();
    // Try to find main content area first
    let mainContentText = '';
    const mainSelectors = ['main', 'article', '[role="main"]', '.entry-content', '.post-content', '.page-content', '#content', '.content', '.main-content'];
    for (const sel of mainSelectors) {
      const found = $contentClone.find(sel).text().replace(/\s+/g, ' ').trim();
      if (found && found.length > 100) {
        mainContentText = found;
        break;
      }
    }
    // Fallback: use cleaned body text (without nav/header/footer)
    if (!mainContentText || mainContentText.length < 100) {
      mainContentText = $contentClone.find('body').text().replace(/\s+/g, ' ').trim();
    }
    data.detectedContentLang = this._detectContentLanguage(mainContentText);
    data.languageMismatch = this._detectLanguageMismatch(pageUrl, data.htmlLang, data.ogLocale, data.detectedContentLang);

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

  _detectHreflangCanonicalConflicts(pageUrl, canonical, hreflangs, htmlLang) {
    const conflicts = [];
    const normalizedPage = this._normalizeUrl(pageUrl, pageUrl);
    const normalizedCanonical = canonical ? this._normalizeUrl(canonical, pageUrl) : null;

    if (!hreflangs || hreflangs.length === 0) return conflicts;

    // Skip pages with ad/campaign tracking parameters (gad_*, gbraid, utm_*) —
    // these are generated by Google Ads / PPC campaigns and are not expected to have
    // proper self-referencing hreflangs or canonicals
    try {
      const pageParams = new URL(normalizedPage).searchParams;
      const hasTrackingParams = [...pageParams.keys()].some(k => /^(gad|gbraid|utm_)/i.test(k));
      if (hasTrackingParams) return conflicts;
    } catch (e) { /* ignore URL parse errors */ }

    // Detect the page's own language from htmlLang or URL path
    const pageLang = this._detectPageLanguage(normalizedPage, htmlLang);

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

    // Normalize all hreflang hrefs for comparison
    const normalizedHreflangs = hreflangs.map(h => ({
      lang: h.lang,
      href: h.href,
      norm: this._normalizeUrl(h.href, pageUrl)
    }));

    // 2. Self-referencing hreflang missing
    const selfRef = normalizedHreflangs.find(h => h.norm === normalizedPage || h.norm === normalizedCanonical);
    if (!selfRef) {
      conflicts.push({
        type: 'missing_self_referencing_hreflang',
        severity: 'warning',
        message: 'No self-referencing hreflang found. Google recommends including the current page in hreflang annotations.',
        pageUrl: normalizedPage
      });
    }

    // 3. Hreflang for page's own language points to a different URL than both page URL and canonical
    // e.g. page is /en/product/?color=sand-en, canonical is /en/product/?color=seafoam-de,
    //      hreflang[en] is /en/product/?color=seafoam-en — all three are different URLs
    if (pageLang) {
      const pageLangNorm = pageLang.toLowerCase().split('-')[0]; // "en-US" -> "en"
      const matchingHreflangs = normalizedHreflangs.filter(h => {
        if (h.lang === 'x-default') return false;
        const hlLangNorm = h.lang.toLowerCase().split('-')[0];
        return hlLangNorm === pageLangNorm;
      });

      for (const hl of matchingHreflangs) {
        const matchesPage = hl.norm === normalizedPage;
        const matchesCanonical = normalizedCanonical && hl.norm === normalizedCanonical;

        if (!matchesPage && !matchesCanonical) {
          // Three-way mismatch: page URL, canonical, and hreflang self-ref are all different
          if (normalizedCanonical && normalizedCanonical !== normalizedPage) {
            conflicts.push({
              type: 'hreflang_page_canonical_all_differ',
              severity: 'critical',
              message: `Three-way URL mismatch for "${hl.lang}": page URL, canonical, and hreflang all point to different URLs. Page: ${normalizedPage} | Canonical: ${normalizedCanonical} | Hreflang: ${hl.norm}`,
              lang: hl.lang,
              pageUrl: normalizedPage,
              canonical: normalizedCanonical,
              hreflangUrl: hl.norm
            });
          } else {
            // Canonical is self-referencing or missing, but hreflang for own language points elsewhere
            conflicts.push({
              type: 'hreflang_self_points_to_different_url',
              severity: 'critical',
              message: `Hreflang for page's own language "${hl.lang}" points to ${hl.norm} instead of the page URL (${normalizedPage}). Google sees conflicting signals about which URL represents this language.`,
              lang: hl.lang,
              pageUrl: normalizedPage,
              hreflangUrl: hl.norm
            });
          }
        }
      }
    }

    // 4. Hreflang URL conflicts with canonical (hreflang points to page URL but canonical points elsewhere)
    for (const hl of normalizedHreflangs) {
      if (hl.norm === normalizedPage && normalizedCanonical && normalizedCanonical !== normalizedPage) {
        conflicts.push({
          type: 'hreflang_self_vs_canonical_mismatch',
          severity: 'critical',
          message: `Hreflang for "${hl.lang}" points to ${hl.norm} but canonical points to ${normalizedCanonical}. Google will likely follow the canonical and ignore this hreflang.`,
          lang: hl.lang,
          hreflangUrl: hl.norm,
          canonical: normalizedCanonical
        });
      }
    }

    // 5. Canonical URL not referenced by any hreflang
    // If canonical points to a different URL and that URL isn't in any hreflang, it's orphaned
    if (normalizedCanonical && normalizedCanonical !== normalizedPage) {
      const canonicalInHreflangs = normalizedHreflangs.some(h => h.norm === normalizedCanonical);
      if (!canonicalInHreflangs) {
        conflicts.push({
          type: 'canonical_not_in_hreflangs',
          severity: 'critical',
          message: `Canonical URL (${normalizedCanonical}) is not referenced by any hreflang tag. The canonical target is invisible to hreflang signals.`,
          canonical: normalizedCanonical,
          pageUrl: normalizedPage
        });
      }
    }

    // 6. Hreflang URLs differ from canonical for non-self languages
    // When canonical points elsewhere, check if hreflangs reference the canonical's "family" or are completely inconsistent
    if (normalizedCanonical && normalizedCanonical !== normalizedPage) {
      for (const hl of normalizedHreflangs) {
        if (hl.lang === 'x-default') continue;
        // Skip the page's own language (already covered by check #3)
        if (pageLang) {
          const pageLangNorm = pageLang.toLowerCase().split('-')[0];
          const hlLangNorm = hl.lang.toLowerCase().split('-')[0];
          if (hlLangNorm === pageLangNorm) continue;
        }
        // Hreflang for other language doesn't match page URL or canonical — might be pointing to wrong variant
        if (hl.norm !== normalizedPage && hl.norm !== normalizedCanonical) {
          // Check if the hreflang URL shares the same base path as canonical but with different params
          try {
            const hlUrl = new URL(hl.norm);
            const canonUrl = new URL(normalizedCanonical);
            if (hlUrl.pathname === canonUrl.pathname && hlUrl.search !== canonUrl.search) {
              conflicts.push({
                type: 'hreflang_inconsistent_params',
                severity: 'warning',
                message: `Hreflang for "${hl.lang}" (${hl.norm}) has the same path as canonical but different query parameters. The page URL, canonical, and hreflangs may be using inconsistent parameter values.`,
                lang: hl.lang,
                hreflangUrl: hl.norm,
                canonical: normalizedCanonical,
                pageUrl: normalizedPage
              });
            }
          } catch (e) { /* ignore URL parse errors */ }
        }
      }
    }

    // 7. Multiple hreflangs for different languages sharing identical query parameters
    // e.g. hreflang[en] = /en/product/?color=seafoam-en&size=90-x-200-cm-en
    //      hreflang[de] = /de/produkt/?color=seafoam-en&size=90-x-200-cm-en  ← same params, wrong!
    //      hreflang[fr] = /fr/produit/?color=seafoam-en&size=90-x-200-cm-en  ← same params, wrong!
    const nonDefaultHreflangs = normalizedHreflangs.filter(h => h.lang !== 'x-default');
    if (nonDefaultHreflangs.length > 1) {
      const paramsByLang = {};
      for (const hl of nonDefaultHreflangs) {
        try {
          const u = new URL(hl.norm);
          paramsByLang[hl.lang] = u.search;
        } catch (e) { /* ignore */ }
      }
      const paramEntries = Object.entries(paramsByLang);
      if (paramEntries.length > 1) {
        // Group by params
        const byParams = {};
        for (const [lang, params] of paramEntries) {
          if (!byParams[params]) byParams[params] = [];
          byParams[params].push(lang);
        }
        for (const [params, langs] of Object.entries(byParams)) {
          // Skip empty params — all hreflangs pointing to base URLs without query strings is normal
          if (!params) continue;
          if (langs.length > 1 && langs.length === paramEntries.length) {
            // ALL hreflangs share the same non-empty query params — likely a template bug
            conflicts.push({
              type: 'hreflang_all_same_params',
              severity: 'critical',
              message: `All hreflang URLs (${langs.join(', ')}) use identical query parameters (${params}). Each language version should point to its own localized URL with correct parameters.`,
              langs,
              params
            });
            break; // only report once
          } else if (langs.length > 1) {
            conflicts.push({
              type: 'hreflang_shared_params',
              severity: 'warning',
              message: `Hreflangs for ${langs.join(', ')} share the same query parameters (${params}). Each language version should have its own localized parameters.`,
              langs,
              params
            });
          }
        }
      }
    }

    // 8. Duplicate language codes
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

    // 8. Invalid language codes
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

  _detectPageLanguage(pageUrl, htmlLang) {
    // 1. Try htmlLang attribute (most reliable)
    if (htmlLang) {
      return htmlLang.toLowerCase().split('-')[0]; // "en-US" -> "en", "de" -> "de"
    }

    // 2. Try URL path pattern like /en/, /de/, /fr/, /en-us/
    try {
      const pathname = new URL(pageUrl).pathname;
      const langMatch = pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//i);
      if (langMatch) {
        return langMatch[1].toLowerCase().split('-')[0];
      }
    } catch (e) { /* ignore */ }

    return null;
  }

  _detectContentLanguage(bodyText) {
    if (!bodyText || bodyText.length < 200) return null;

    // Use ONLY highly distinctive function words that almost never appear in other languages.
    // Avoid short words (2-3 chars) that overlap across languages in e-commerce contexts.
    // Each list: words that are strong signals for THAT language and rare in others.
    const langWords = {
      en: ['the', 'and', 'have', 'this', 'that', 'with', 'from', 'they', 'your', 'which', 'their', 'would', 'there', 'about', 'been', 'were', 'could', 'should', 'these', 'those', 'than', 'them', 'then', 'each', 'other', 'into', 'only', 'very', 'when', 'where'],
      fr: ['dans', 'pour', 'avec', 'sont', 'cette', 'nous', 'vous', 'mais', 'tout', 'elle', 'votre', 'notre', 'entre', 'leurs', 'comme', 'aussi', 'chez', 'fait', 'avant', 'depuis', 'encore', 'avoir', 'tous', 'autre', 'sans', 'moins', 'sous'],
      de: ['und', 'der', 'die', 'das', 'ein', 'eine', 'nicht', 'sich', 'auch', 'nach', 'oder', 'sind', 'wird', 'wenn', 'aber', 'noch', 'kann', 'mehr', 'schon', 'sehr', 'diese', 'diesem', 'dieser', 'einem', 'einer', 'haben', 'hatte', 'seine', 'durch', 'alle', 'dann', 'muss', 'hier', 'gibt', 'nur', 'zum', 'zur', 'vom', 'beim', 'dass'],
      it: ['sono', 'della', 'delle', 'dalla', 'questo', 'quella', 'anche', 'ogni', 'loro', 'essere', 'stato', 'come', 'suoi', 'nelle', 'degli', 'questa', 'ancora', 'molto', 'sempre', 'quando', 'tutto', 'dove', 'dopo', 'prima', 'senza'],
      es: ['para', 'como', 'pero', 'tiene', 'entre', 'desde', 'todo', 'cuando', 'muy', 'sobre', 'puede', 'otros', 'este', 'esta', 'estos', 'estas', 'donde', 'cada', 'tambien', 'siempre', 'mejor', 'mismo', 'otro', 'toda', 'todos'],
      nl: ['het', 'een', 'van', 'dat', 'met', 'zijn', 'voor', 'niet', 'ook', 'maar', 'aan', 'dit', 'nog', 'wel', 'kan', 'naar', 'hun', 'meer', 'dan', 'over', 'werd', 'zou', 'deze', 'haar', 'hoe', 'want', 'door', 'waar', 'geen']
    };

    // Tokenize: all words 2+ chars
    const words = bodyText.toLowerCase().match(/\b[a-zà-ÿ]{2,}\b/g);
    if (!words || words.length < 30) return null;

    const wordSet = {};
    for (const w of words) {
      wordSet[w] = (wordSet[w] || 0) + 1;
    }

    const scores = {};
    for (const [lang, keywords] of Object.entries(langWords)) {
      scores[lang] = 0;
      for (const kw of keywords) {
        if (wordSet[kw]) scores[lang] += wordSet[kw];
      }
    }

    // Find top two
    let bestLang = null;
    let bestScore = 0;
    let secondScore = 0;
    for (const [lang, score] of Object.entries(scores)) {
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestLang = lang;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }

    // Need minimum 5 hits AND 2x the runner-up to be confident
    // (we analyze main content only without nav, so there's less text but cleaner signal)
    if (bestScore < 5) return null;
    if (secondScore > 0 && bestScore / secondScore < 2.0) return null;

    return bestLang;
  }

  _detectLanguageMismatch(pageUrl, htmlLang, ogLocale, detectedContentLang) {
    // Extract language from URL path
    let urlLang = null;
    try {
      const pathname = new URL(pageUrl).pathname;
      const match = pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//i);
      if (match) urlLang = match[1].toLowerCase().split('-')[0];
    } catch (e) { /* ignore */ }

    if (!urlLang) return null; // No language in URL path, can't detect mismatch

    const htmlLangNorm = htmlLang ? htmlLang.toLowerCase().split('-')[0] : null;
    const ogLocaleNorm = ogLocale ? ogLocale.toLowerCase().split('_')[0] : null;

    const mismatches = [];

    // URL lang vs htmlLang
    if (htmlLangNorm && htmlLangNorm !== urlLang) {
      mismatches.push({
        type: 'url_vs_html_lang',
        message: `URL language "/${urlLang}/" does not match html lang="${htmlLang}"`,
        urlLang,
        htmlLang: htmlLangNorm
      });
    }

    // URL lang vs og:locale
    if (ogLocaleNorm && ogLocaleNorm !== urlLang) {
      mismatches.push({
        type: 'url_vs_og_locale',
        message: `URL language "/${urlLang}/" does not match og:locale="${ogLocale}"`,
        urlLang,
        ogLocale: ogLocaleNorm
      });
    }

    // Content language vs metadata — only flag when content contradicts BOTH URL lang and html lang
    // (if URL and html lang agree, content detection must disagree with both to be a real issue)
    if (detectedContentLang) {
      const contentDiffersFromUrl = detectedContentLang !== urlLang;
      const contentDiffersFromHtml = !htmlLangNorm || detectedContentLang !== htmlLangNorm;
      // Only flag when content disagrees with ALL available metadata signals
      if (contentDiffersFromUrl && contentDiffersFromHtml) {
        mismatches.push({
          type: 'content_lang_mismatch',
          message: `Content appears to be in ${detectedContentLang.toUpperCase()} but URL uses "/${urlLang}/"${htmlLangNorm ? ` and html lang="${htmlLang}"` : ''}`,
          urlLang,
          htmlLang: htmlLangNorm,
          contentLang: detectedContentLang
        });
      }
    }

    return mismatches.length > 0 ? mismatches : null;
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
