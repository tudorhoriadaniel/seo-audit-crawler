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
    this.maxDepth = options.maxDepth || 30;
    this.concurrency = options.concurrency || 5;
    this.timeout = options.timeout || 30000;
    this.respectRobots = options.respectRobots !== false;
    this.followExternalLinks = options.followExternalLinks || false;
    // Default to a real Chrome UA. Many sites behind Cloudflare / WP Rocket
    // serve a stripped-down HTML to anything that doesn't look like a browser
    // (pagers, related-posts blocks, lazy-loaded markup get dropped), which
    // hides perfectly valid internal links from the crawl. Screaming Frog
    // defaults to a Chrome UA for the same reason.
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    // Token used for robots.txt group matching. robots-parser does NOT match a
    // full browser UA string against "User-agent: Googlebot" groups, so bot
    // presets pass their bare token (e.g. "Googlebot") separately.
    this.robotsUserAgent = options.robotsUserAgent || this.userAgent;
    // Cloaking check: after the crawl, a sample of pages is re-fetched with
    // this UA and diffed against the crawl (see _checkBotParity)
    this.parityUa = options.parityUa || null;
    this.parityLabel = options.parityLabel || null;
    this.botLabel = options.botLabel || null;
    this.botParity = null;
    this.crawlJS = options.crawlJS || false;
    this.customHeaders = options.customHeaders || {};

    this.visited = new Set();
    this.queue = [];
    // Dedupe set for every URL ever ENQUEUED, so the same URL is never
    // pushed twice and discovery is bounded by unique URLs, not push
    // events. Lets us safely lift the old queue cap that silently
    // dropped links on link-dense sites.
    this.queued = new Set();
    this.results = [];
    this.resources = [];
    this.redirectChains = [];
    this.paramCheck = null;
    this.sitemapUrls = new Set();
    this.robotsRules = null;
    // Per-crawl cookie jar (origin -> Map(name -> value)). Many sites set a
    // consent / session cookie on the first hit and then serve a richer HTML
    // (full pager, related blocks, lazy markup) to "returning" visitors.
    // Without this, every request is a "first visit" and we get the stripped
    // version. A real browser persists cookies for the duration of a session,
    // so we do too.
    this.cookieJar = new Map();
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
    // List mode: when true, the crawler only fetches URLs that were seeded
    // (via startList) and does NOT enqueue links it discovers in the HTML.
    // Mirrors Screaming Frog's "List mode" — audit exactly these N URLs.
    this.discoveryDisabled = false;
  }

  /**
   * List-mode entrypoint: crawl exactly the URLs the user provided, no link
   * discovery. baseUrl is taken from the first URL so origin/excluded-path
   * checks still work for sanity (mixed hostnames in the list are allowed
   * because each one is explicitly seeded with `force: true`).
   */
  async startList(urls) {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error('startList requires a non-empty array of URLs');
    }
    // Normalise + dedupe at the boundary so we don't fetch the same page twice
    // and so the maxPages cap reflects unique URLs.
    const seen = new Set();
    const cleaned = [];
    for (const raw of urls) {
      if (!raw || typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
      try {
        const u = new URL(withScheme);
        u.hash = '';
        const key = u.href.toLowerCase().replace(/\/$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(u.href);
      } catch { /* skip malformed line */ }
    }
    if (cleaned.length === 0) throw new Error('No valid URLs in the list');

    this.discoveryDisabled = true;
    this.startUrl = cleaned[0];
    this.baseUrl = new URL(cleaned[0]).origin;
    this.running = true;
    this.aborted = false;
    this.stats.startTime = Date.now();

    // Skip the redirect-resolution step (only meaningful for a single-seed
    // spider) and the sitemap/robots fetch — neither is relevant when the
    // user is auditing a specific URL list. Robots.txt is still parsed
    // lazily inside _isAllowedByRobots if needed; setting respectRobots=false
    // for list mode would be a separate opt-out.

    // Seed every URL with force=true so robots checks don't drop them — the
    // user explicitly asked for them. Cap at maxPages to match spider mode.
    const limit = Math.min(cleaned.length, this.maxPages);
    for (let i = 0; i < limit; i++) {
      this.queue.push({ url: cleaned[i], depth: 0, parent: null, force: true });
    }
    this.stats.totalUrls = limit;

    await this._processQueue();

    // Same post-crawl checks as spider mode
    await this._checkRedirectParamPreservation();
    await this._checkBotParity();

    this.stats.endTime = Date.now();
    this.running = false;
    if (this.onComplete) this.onComplete(this._getSummary());
    return this._getSummary();
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

    // llms.txt — emerging standard AI assistants read for site orientation
    await this._fetchLlmsTxt();

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
      if (!this.visited.has(key) && this._isSameOrigin(smUrl) && !this._isExcludedPath(smUrl)) {
        this.queue.push({ url: smUrl, depth: 1, parent: 'sitemap' });
        this.stats.totalUrls++;
      }
    }

    // Crawl with concurrency
    await this._processQueue();

    // Test whether marketing params (utm_*, gclid, fbclid…) survive redirects
    await this._checkRedirectParamPreservation();

    // Cloaking check: re-fetch a sample of pages with the comparison UA
    await this._checkBotParity();

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

  // Fetch /llms.txt and /llms-full.txt. Guard against soft-404s: many servers
  // answer 200 with an HTML error page for any path, which is NOT an llms.txt.
  async _fetchLlmsTxt() {
    this.llmsTxt = { found: false, url: null, size: 0, content: null, fullFound: false, fullUrl: null, fullSize: 0 };
    const tryFetch = async (file) => {
      try {
        const res = await axios.get(`${this.baseUrl}/${file}`, {
          timeout: 10000,
          headers: { 'User-Agent': this.userAgent },
          maxRedirects: 5,
          responseType: 'text',
          validateStatus: (s) => s < 400
        });
        const txt = typeof res.data === 'string' ? res.data : String(res.data || '');
        const trimmed = txt.trim();
        if (res.status !== 200 || !trimmed) return null;
        if (/^<!doctype|^<html|^<\?xml/i.test(trimmed)) return null; // soft-404 HTML page
        return { url: `${this.baseUrl}/${file}`, size: txt.length, content: txt };
      } catch { return null; }
    };
    const main = await tryFetch('llms.txt');
    if (main) {
      this.llmsTxt.found = true;
      this.llmsTxt.url = main.url;
      this.llmsTxt.size = main.size;
      this.llmsTxt.content = main.content.slice(0, 20000); // cap stored blob
    }
    const full = await tryFetch('llms-full.txt');
    if (full) {
      this.llmsTxt.fullFound = true;
      this.llmsTxt.fullUrl = full.url;
      this.llmsTxt.fullSize = full.size;
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

    // Pre-initialise the parsed-sitemaps set so the parallel probes below
    // don't race each other on lazy init.
    this._parsedSitemaps = this._parsedSitemaps || new Set();

    // Probe all candidate sitemaps in parallel. A 404 returns in milliseconds
    // so serial probing was wasted latency; more importantly, with a long
    // per-fetch timeout (needed below) a hung host would otherwise block the
    // whole sequence for `paths × timeout` seconds.
    await Promise.all([...toTry].map(smUrl => this._parseSitemap(smUrl, 0)));

    this.sitemapFromRobots = robotsSitemaps.length > 0;
  }

  async _parseSitemap(url, depth) {
    if (depth > 3) return;
    // Skip if already parsed this sitemap
    if (this._parsedSitemaps.has(url)) return;
    this._parsedSitemaps.add(url);
    try {
      const res = await axios.get(url, {
        // Some sitemaps are huge (50 MB+) and can take a minute or more to
        // generate / stream on the first uncached hit (CDN cold cache, big
        // dynamic WP sitemaps, etc.). The default 15s was cutting these off
        // entirely. 180s here is generous; 404s on non-existent paths still
        // return in milliseconds so this doesn't slow non-existent sitemaps.
        timeout: 180000,
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'application/xml, text/xml, application/rss+xml;q=0.9, */*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        maxRedirects: 5,
        // Don't let axios's default 10 MB cap silently truncate large
        // sitemaps — the cut tail is exactly where the most recent URLs are.
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        decompress: true,
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
    return this.robotsRules.isAllowed(url, this.robotsUserAgent);
  }

  _isSameOrigin(url) {
    // Same-site by protocol + host (with www↔apex equivalence). Strict
    // origin matching loses any link that uses the apex variant of a
    // www-baseline crawl (or vice versa), even though Google treats both
    // as the same site and ~every site redirects one to the other.
    try {
      const u = new URL(url);
      const b = new URL(this.baseUrl);
      if (u.protocol !== b.protocol) return false;
      const stripWww = (h) => h.replace(/^www\./i, '').toLowerCase();
      return stripWww(u.hostname) === stripWww(b.hostname);
    } catch { return false; }
  }

  /**
   * WordPress (and other CMS) admin/login/system endpoints that are not meaningful
   * SEO targets. Skip them at queue time so they never appear in content/meta/etc.
   * reports and don't burn crawl budget.
   */
  _isExcludedPath(url) {
    try {
      const u = new URL(url);
      const p = u.pathname.toLowerCase();
      // WordPress system paths — these are admin/system endpoints, not SEO content
      if (p.includes('/wp-login.php') || p.endsWith('/wp-login')) return true;
      if (p.includes('/wp-admin')) return true;
      if (p.includes('/wp-cron.php')) return true;
      if (p.includes('/xmlrpc.php')) return true;
      if (p.includes('/wp-json')) return true;
      if (p.includes('/wp-trackback.php') || p.includes('/trackback')) return true;
      // Query-param variants, e.g. any-page?redirect_to=…/wp-login.php
      if (u.search && /[?&]redirect_to=[^&]*wp-login/i.test(u.search)) return true;
      return false;
    } catch {
      return false;
    }
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

  // Minimal cookie handling. We only need name=value pairs scoped to the
  // request's origin — that's enough for a server to recognise us as a
  // returning visitor and serve the full HTML (pagers, related blocks,
  // lazy markup) instead of the first-visit stripped version.
  _cookieHeaderFor(url) {
    try {
      const origin = new URL(url).origin;
      const jar = this.cookieJar.get(origin);
      if (!jar || jar.size === 0) return null;
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    } catch { return null; }
  }

  _absorbSetCookies(url, setCookieHeader) {
    if (!setCookieHeader) return;
    try {
      const origin = new URL(url).origin;
      if (!this.cookieJar.has(origin)) this.cookieJar.set(origin, new Map());
      const jar = this.cookieJar.get(origin);
      const lines = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const line of lines) {
        const first = String(line).split(';')[0];
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (name) jar.set(name, value);
      }
    } catch { /* ignore */ }
  }

  /**
   * Single choke point for ALL link discovery (anchors, canonical,
   * hreflang, rel=next/prev) so the same same-origin / excluded / dedupe
   * rules apply everywhere. Dedupes on a per-URL key (this.queued) instead
   * of counting push events, and only refuses at a very high safety bound.
   *
   * The old code gated every push on `totalUrls < maxPages * 2` while
   * bumping totalUrls on every push (and the same not-yet-crawled URL could
   * be pushed many times). On link-dense sites (this one has thousands of
   * malformed /adresses/.../www.x.ch/ links) the counter blew past the cap
   * early and the crawler SILENTLY stopped queueing everything found
   * afterwards - including deep /page/N/ pager links. Actual fetches stay
   * bounded by maxPages, so lifting the queue cap cannot run away. No URL
   * synthesis - we still only follow real declared links.
   */
  _enqueue(href, depth, parent, base) {
    if (!href) return;
    // List mode: never enqueue links discovered from page HTML. The user
    // wants to audit exactly the URLs they uploaded; following internal
    // links would defeat the purpose. Seeds are pushed directly in
    // startList(), bypassing this method, so they're not affected.
    if (this.discoveryDisabled) return;
    let abs = href;
    try { abs = new URL(href, base || this.baseUrl).href; } catch { /* malformed: keep as-is */ }
    const key = this._dedupeKey(abs);
    if (this.visited.has(key) || this.queued.has(key)) return;
    if (!this._isSameOrigin(abs)) return;
    if (this._isExcludedPath(abs)) return;
    // Safety bound against pathological link-bomb pages; far above any real
    // site and well above maxPages (which limits fetches anyway).
    if (this.queued.size >= this.maxPages * 50 + 5000) return;
    this.queued.add(key);
    this.queue.push({ url: abs, depth, parent });
    this.stats.totalUrls++;
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

      // Dispatch up to `concurrency` pages, but never start more than will
      // keep us at/under maxPages. `crawled` only increments AFTER a page
      // finishes, so gating on it alone lets `concurrency-1` extra pages slip
      // through while requests are in flight (e.g. stopping at 10004 for a
      // 10000 limit). Counting the in-flight requests (active.size) makes the
      // cap exact: crawled + in-flight never exceeds maxPages.
      while (this.queue.length > 0 && active.size < this.concurrency && (this.stats.crawled + active.size) < this.maxPages) {
        const item = this.queue.shift();
        const dedupeKey = this._dedupeKey(item.url);
        if (this.visited.has(dedupeKey)) continue;
        // Backstop: never process CMS admin/system endpoints even if they slipped in
        if (!item.force && this._isExcludedPath(item.url)) { this.visited.add(dedupeKey); continue; }
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
      // Browser-like request fingerprint. Cloudflare / WAF / WP-Rocket setups
      // routinely serve a stripped HTML (no pager, no related blocks, lazy
      // markup dropped) to anything that doesn't look like a real browser.
      // Matching Chrome's headers here is what makes deep archive pagination
      // links actually appear in the response, the same way Screaming Frog
      // gets them.
      const cookieHeader = this._cookieHeaderFor(url);
      const browserHeaders = {
        'User-Agent': this.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
        ...this.customHeaders
      };

      response = await axios.get(url, {
        timeout: this.timeout,
        headers: browserHeaders,
        maxRedirects: 10,
        // Read the full response body. axios defaults to a 10 MB cap and
        // SILENTLY TRUNCATES anything bigger, which on long archive pages
        // (lots of card thumbnails before the pager) chops off the
        // pagination at the bottom — so the crawler never sees the
        // <a href=".../page/N/"> links and the chain breaks.
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        decompress: true,
        validateStatus: () => true,
        // Track redirects
        beforeRedirect: (options, { headers, statusCode }) => {
          redirectChain.push({ url: options.href || url, statusCode });
        }
      });

      // Persist any Set-Cookie the server hands us, so the next request to
      // this origin looks like a returning visitor.
      this._absorbSetCookies(url, response.headers['set-cookie']);

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
      if (!this.visited.has(finalKey) && this._isSameOrigin(actualFinalUrl) && !this._isExcludedPath(actualFinalUrl)) {
        this.visited.add(finalKey);
        this.queue.push({ url: actualFinalUrl, depth, parent: url });
      }
      return;
    }

    const botChallenge = this._detectBotChallenge(response, html);
    if (botChallenge) {
      this.stats.challenged = (this.stats.challenged || 0) + 1;

      // If the WAF is challenging essentially every request, continuing just
      // burns the remaining queue on challenge pages and further damages this
      // IP's reputation with the WAF vendor. Stop early and let the report
      // explain — the user can wait for the flag to decay or allowlist the
      // crawler, then re-crawl.
      const crawledSoFar = this.stats.crawled + 1;
      if (!this.stats.challengeAborted && crawledSoFar >= 20 && this.stats.challenged / crawledSoFar >= 0.9) {
        this.stats.challengeAborted = true;
        this.stats.challengeAbortVendor = botChallenge;
        this.stats.challengeAbortAfter = crawledSoFar;
        this.aborted = true; // drains the queue; post-crawl checks also skip on aborted
      }
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
      botChallenge,
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

      // Queue discovered internal links. Malformed (scheme-less) links are
      // still queued so we record their real status (usually 404) and they
      // show in All Pages / Status Codes like Screaming Frog, while also
      // being flagged in the Malformed Links report.
      if (extracted.links) {
        for (const link of extracted.links) {
          if (link.isInternal) this._enqueue(link.href, depth + 1, url, url);
        }
      }

      // Also queue canonical URL if internal and different from current page
      if (extracted.canonical && !extracted.canonicalIsSelf) {
        this._enqueue(extracted.canonical, depth + 1, url, url);
      }

      // Also queue hreflang URLs if internal
      if (extracted.hreflangs) {
        for (const hl of extracted.hreflangs) this._enqueue(hl.href, depth + 1, url, url);
      }

      // Follow rel="next" / rel="prev" pagination links (Yoast/RankMath emit
      // these for archive pagination; they chain through every listing page).
      for (const rel of [extracted.relNext, extracted.relPrev]) {
        this._enqueue(rel, depth + 1, url, url);
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

      // Malformed link: the author wrote a bare domain without a scheme
      // (e.g. href="www.example.ch" or "example.ch/page"). The browser
      // resolves it as a RELATIVE path under the current page, producing a
      // broken internal URL like /adresses/foo/www.example.ch. Detect on
      // the raw href before resolution.
      const isMalformed = !/^(https?:)?\/\//i.test(href)
        && !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('?')
        && /^(www\.)?[a-z0-9][a-z0-9-]*\.(ch|com|org|net|fr|de|it|info|io|eu|co|uk|biz|name)(\/|$)/i.test(href);

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
        rawHref: isMalformed ? href : undefined,
        anchor,
        hasVisibleContent,
        isInternal,
        isNofollow,
        isMalformed,
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

    // GEO / AI-readiness signals (snippet directives, answerability,
    // citation-worthiness, E-E-A-T schema) — one JSON blob per page
    data.geoSignals = this._extractGeoSignals($, data, mainContentText, bodyText);

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

  // Signals that drive inclusion/citation in AI answers (Google AI Overviews,
  // ChatGPT, Perplexity, Claude). Everything here is computable from the raw
  // HTML, so it works with the existing non-rendering crawler.
  _extractGeoSignals($, data, mainContentText, bodyText) {
    const g = {};

    // ── Snippet restrictions ──
    // nosnippet / max-snippet:0 excludes the page from Google AI Overviews
    // (which are built from snippets); small max-snippet caps what AI can use.
    const robotsContent = [data.metaRobots, data.metaGooglebot].filter(Boolean).join(',').toLowerCase();
    const maxSnippetMatch = robotsContent.match(/max-snippet\s*:\s*(-?\d+)/);
    g.snippet = {
      nosnippet: /(^|[,\s])nosnippet([,\s]|$)/.test(robotsContent),
      maxSnippet: maxSnippetMatch ? parseInt(maxSnippetMatch[1], 10) : null,
      dataNosnippetCount: $('[data-nosnippet]').length
    };

    // ── Answerability ──
    // Question-phrased headings map 1:1 to AI queries; a concise paragraph
    // right after the H1 is the classic "citable direct answer".
    const QUESTION_RE = /\?\s*$|^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b/i;
    const headings = data.headingStructure || [];
    g.questionHeadings = headings.filter(h => h.text && QUESTION_RE.test(h.text)).length;
    g.totalHeadings = headings.length;

    let firstPara = '';
    const h1Node = $('h1').first().get(0);
    const flow = $('h1, p').toArray();
    const startIdx = h1Node ? flow.indexOf(h1Node) + 1 : 0;
    for (let i = startIdx; i < flow.length; i++) {
      if ((flow[i].tagName || '').toLowerCase() !== 'p') continue;
      const t = $(flow[i]).text().replace(/\s+/g, ' ').trim();
      if (t.length > 40) { firstPara = t; break; }
    }
    g.firstParagraphWords = firstPara ? firstPara.split(/\s+/).length : 0;

    // ── Extractability / chunk structure ──
    // LLMs cite passages: short paragraphs, lists and tables extract cleanly;
    // 100+-word text walls don't.
    let paragraphs = 0, longParagraphs = 0, paraWordSum = 0;
    $('p').each((_, el) => {
      const w = $(el).text().replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean).length;
      if (w < 5) return; // skip decorative/empty paragraphs
      paragraphs++;
      paraWordSum += w;
      if (w > 100) longParagraphs++;
    });
    g.paragraphs = paragraphs;
    g.longParagraphs = longParagraphs;
    g.avgParagraphWords = paragraphs ? Math.round(paraWordSum / paragraphs) : 0;
    g.lists = $('ul, ol').length;
    g.tables = $('table').length;
    g.blockquotes = $('blockquote, q').length;

    // ── Citation-worthiness (Princeton GEO findings: statistics, sources,
    // quotations lift generative-engine visibility) ──
    const contentWords = mainContentText ? mainContentText.split(/\s+/).length : 0;
    const numberTokens = (mainContentText.match(/(?<![\w.])\d[\d.,]*\s?%?/g) || []).length;
    g.contentWords = contentWords;
    g.numbersPer1000Words = contentWords >= 100 ? Math.round((numberTokens / contentWords) * 1000) : 0;
    g.timeTagCount = $('time[datetime]').length;

    // ── Schema deep-dive (JSON-LD objects incl. @graph) ──
    const ldObjects = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          ldObjects.push(item);
          if (Array.isArray(item['@graph'])) ldObjects.push(...item['@graph'].filter(o => o && typeof o === 'object'));
        }
      } catch { /* invalid JSON-LD already reported via structuredData */ }
    });
    const typeOf = (o) => [].concat(o['@type'] || []).map(String);
    const schema = { datePublished: null, dateModified: null, orgSameAsCount: 0, orgHasLogo: false, hasAuthor: false, authorNames: [] };
    for (const o of ldObjects) {
      const types = typeOf(o);
      if (o.datePublished && !schema.datePublished) schema.datePublished = String(o.datePublished);
      if (o.dateModified && !schema.dateModified) schema.dateModified = String(o.dateModified);
      if (types.some(t => /Organization|LocalBusiness/i.test(t))) {
        const sameAs = [].concat(o.sameAs || []);
        schema.orgSameAsCount = Math.max(schema.orgSameAsCount, sameAs.length);
        if (o.logo) schema.orgHasLogo = true;
      }
      if (o.author) {
        schema.hasAuthor = true;
        for (const a of [].concat(o.author)) {
          const name = typeof a === 'string' ? a : a?.name;
          if (name && schema.authorNames.length < 5 && !schema.authorNames.includes(name)) schema.authorNames.push(String(name));
        }
      }
    }
    g.schema = schema;

    return g;
  }

  _detectHreflangCanonicalConflicts(pageUrl, canonical, hreflangs, htmlLang) {
    const conflicts = [];
    const normalizedPage = this._normalizeUrl(pageUrl, pageUrl);
    const normalizedCanonical = canonical ? this._normalizeUrl(canonical, pageUrl) : null;

    if (!hreflangs || hreflangs.length === 0) return conflicts;

    // Hreflang-comparison key. Treat encoding (unicode vs %xx), trailing
    // slash (non-root) and host case as equivalent — Google does, and not
    // doing so produced false "no self-referencing hreflang" / missing-
    // return-link issues when the <link rel=alternate> spelling differed
    // from the recorded page URL in any of these ways.
    const hreflangKey = (u) => {
      if (!u) return '';
      try {
        const x = new URL(u, pageUrl);
        x.hash = '';
        let h = x.href;
        if (x.pathname !== '/' && h.endsWith('/')) h = h.slice(0, -1);
        return h.toLowerCase();
      } catch { return String(u).toLowerCase(); }
    };
    const pageKey = hreflangKey(normalizedPage);
    const canonicalKey = normalizedCanonical ? hreflangKey(normalizedCanonical) : null;

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

    // Normalize all hreflang hrefs for comparison. `norm` is the raw WHATWG
    // canonical href (preserves trailing slash, case) for places that need
    // exact match; `key` is the loose hreflang-equivalence key used for
    // self-ref / canonical-in-hreflangs checks.
    const normalizedHreflangs = hreflangs.map(h => ({
      lang: h.lang,
      href: h.href,
      norm: this._normalizeUrl(h.href, pageUrl),
      key: hreflangKey(h.href)
    }));

    // 2. Self-referencing hreflang missing
    const selfRef = normalizedHreflangs.find(h => h.key === pageKey || (canonicalKey && h.key === canonicalKey));
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
        const matchesPage = hl.key === pageKey;
        const matchesCanonical = canonicalKey && hl.key === canonicalKey;

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
      const canonicalInHreflangs = normalizedHreflangs.some(h => h.key === canonicalKey);
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
    // NOTE: og:locale is intentionally ignored here. It's an Open Graph /
    // social-sharing hint (Facebook, LinkedIn) and is often left at a single
    // site-wide default ("en_US") while the actual content is localized —
    // using it as a language signal produces a flood of false positives. The
    // real signals for content-language mismatch are the URL path language,
    // the <html lang> attribute, and what the page text is actually in.

    // Extract language from URL path
    let urlLang = null;
    try {
      const pathname = new URL(pageUrl).pathname;
      const match = pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//i);
      if (match) urlLang = match[1].toLowerCase().split('-')[0];
    } catch (e) { /* ignore */ }

    if (!urlLang) return null; // No language in URL path, can't detect mismatch

    const htmlLangNorm = htmlLang ? htmlLang.toLowerCase().split('-')[0] : null;

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

  /**
   * Detect bot-protection / WAF challenge responses. Returns the vendor name
   * or null. A challenge means the WAF intercepted the request because of the
   * crawler's user agent / IP — the real page was never served, so its status
   * and content must not be read as site issues. Detection is signature-based
   * (vendor headers + challenge-page markers), never bare 403/429/503, to
   * avoid mislabeling genuine errors.
   */
  _detectBotChallenge(response, html) {
    const status = response.status;
    const h = response.headers || {};
    const body = (typeof html === 'string' ? html : '').slice(0, 30000);
    const server = String(h['server'] || '').toLowerCase();

    // Cloudflare managed challenge / JS challenge / "Attention Required"
    if (String(h['cf-mitigated'] || '').toLowerCase() === 'challenge') return 'Cloudflare';
    if (server.includes('cloudflare') && (status === 403 || status === 429 || status === 503) &&
        /just a moment|attention required|__cf_chl|cf-browser-verification|challenge-platform|cf_chl_opt/i.test(body)) {
      return 'Cloudflare';
    }
    // Akamai Bot Manager denial page
    if (status === 403 && (server.includes('akamaighost') || /access denied[\s\S]{0,2000}reference #[\d.]/i.test(body))) {
      return 'Akamai';
    }
    // Imperva / Incapsula
    if (h['x-iinfo'] || /_incapsula_resource|incident id[:#][^<]{0,60}visid_incap/i.test(body) ||
        (/incapsula/i.test(body) && (status === 403 || status === 503))) {
      return 'Imperva';
    }
    // DataDome
    if (h['x-datadome'] || h['x-dd-b'] || /captcha-delivery\.com|geo\.captcha-delivery/i.test(body)) {
      return 'DataDome';
    }
    // PerimeterX / HUMAN
    if (/px-captcha|_pxhd|perimeterx|human challenge/i.test(body) && (status === 403 || status === 429)) {
      return 'PerimeterX';
    }
    return null;
  }

  /**
   * Crawl-as-bot presets: official user-agent strings of the major crawlers.
   * `ua` is sent on every request; `robotsToken` is the bare product token used
   * for robots.txt group matching (robots-parser needs the token, not the full
   * UA — see robotsUserAgent above). `default` = the tool's own browser UA;
   * `custom` = free-text UA supplied by the user.
   */
  static get BOT_PRESETS() {
    return [
      { id: 'default', label: 'SEO Tool (default browser UA)', ua: null, robotsToken: null },
      { id: 'seo-audit-bot', label: 'SEO Audit Bot', ua: 'Mozilla/5.0 (compatible; SEOAuditCrawler/2.0; +https://seo.converta.ro)', robotsToken: 'SEOAuditCrawler' },
      { id: 'googlebot-smartphone', label: 'Googlebot (Smartphone)', ua: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.60 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', robotsToken: 'Googlebot' },
      { id: 'googlebot-desktop', label: 'Googlebot (Desktop)', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/125.0.6422.60 Safari/537.36', robotsToken: 'Googlebot' },
      { id: 'bingbot', label: 'Bingbot', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36', robotsToken: 'bingbot' },
      { id: 'duckduckbot', label: 'DuckDuckBot', ua: 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)', robotsToken: 'DuckDuckBot' },
      { id: 'yandexbot', label: 'YandexBot', ua: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', robotsToken: 'YandexBot' },
      { id: 'baiduspider', label: 'Baiduspider', ua: 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', robotsToken: 'Baiduspider' },
      { id: 'gptbot', label: 'GPTBot (OpenAI)', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot', robotsToken: 'GPTBot' },
      { id: 'claudebot', label: 'ClaudeBot (Anthropic)', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', robotsToken: 'ClaudeBot' },
      { id: 'perplexitybot', label: 'PerplexityBot', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', robotsToken: 'PerplexityBot' },
      { id: 'custom', label: 'Custom user agent…', ua: null, robotsToken: null }
    ];
  }

  /**
   * Marketing/attribution parameters injected to test redirect preservation.
   * UTM params plus the official click IDs of the major ad platforms.
   */
  static get MARKETING_TEST_PARAMS() {
    return {
      utm_source: 'seo_audit',          // GA4 / universal
      utm_medium: 'redirect_test',
      utm_campaign: 'param_check',
      utm_term: 'audit_term',
      utm_content: 'audit_content',
      gclid: 'AuditTestGclid123',       // Google Ads
      gbraid: 'AuditTestGbraid123',     // Google Ads (iOS app-to-web)
      wbraid: 'AuditTestWbraid123',     // Google Ads (iOS web-to-app)
      fbclid: 'AuditTestFbclid123',     // Meta (Facebook/Instagram)
      msclkid: 'AuditTestMsclkid123',   // Microsoft Ads
      ttclid: 'AuditTestTtclid123',     // TikTok Ads
      li_fat_id: 'AuditTestLiFatId1',   // LinkedIn Ads
      twclid: 'AuditTestTwclid123'      // X (Twitter) Ads
    };
  }

  /**
   * After the crawl, re-request redirecting URLs (plus the resolved homepage)
   * with test marketing parameters appended and check whether they survive to
   * the final URL. Redirects that strip utm_ params or gclid/fbclid… break
   * campaign attribution in GA4, Google Ads and other platforms.
   *
   * The homepage is always tested even though it returns 200 in the crawl:
   * many CMS/CDN canonical-redirect rules only fire when a query string is
   * present, 301-ing ?utm_… URLs to the clean URL and silently dropping params.
   */
  async _checkRedirectParamPreservation() {
    if (this.aborted) return;
    const testParams = CrawlerEngine.MARKETING_TEST_PARAMS;
    const paramKeys = Object.keys(testParams);

    const candidates = [];
    const seen = new Set();
    const addCandidate = (url, wasRedirect) => {
      const key = this._dedupeKey(url);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ url, wasRedirect });
    };

    const hasQuery = (u) => {
      try { return new URL(u).search.length > 0; } catch (e) { return true; }
    };

    addCandidate(this.startUrl, false);
    const redirecting = this.results.filter(r =>
      r.redirectChain && r.redirectChain.length > 0 &&
      r.statusCode >= 300 && r.statusCode < 400 &&
      // Only test URLs without their own query string, so injected params are unambiguous
      !hasQuery(r.url)
    );
    for (const r of redirecting.slice(0, 25)) addCandidate(r.url, true);

    const results = [];
    const batchSize = Math.min(this.concurrency, 5);
    for (let i = 0; i < candidates.length; i += batchSize) {
      if (this.aborted) break;
      const batch = candidates.slice(i, i + batchSize);
      const settled = await Promise.all(batch.map(c => this._testParamPreservation(c, testParams, paramKeys)));
      results.push(...settled.filter(Boolean));
    }

    this.paramCheck = {
      testedCount: results.length,
      droppingCount: results.filter(r => r.dropsParams).length,
      params: paramKeys,
      results
    };
  }

  async _testParamPreservation({ url, wasRedirect }, testParams, paramKeys) {
    let testUrl;
    try {
      const u = new URL(url);
      for (const [k, v] of Object.entries(testParams)) u.searchParams.set(k, v);
      testUrl = u.href;
    } catch (e) {
      return null;
    }

    const redirectChain = [];
    try {
      const response = await axios.get(testUrl, {
        timeout: this.timeout,
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...this.customHeaders
        },
        maxRedirects: 10,
        validateStatus: () => true,
        // Headers are enough — don't download response bodies
        responseType: 'stream',
        beforeRedirect: (options, { statusCode }) => {
          redirectChain.push({ url: options.href || testUrl, statusCode });
        }
      });

      const finalUrl = response.request?.res?.responseUrl || testUrl;
      if (response.data && typeof response.data.destroy === 'function') response.data.destroy();

      if (redirectChain.length === 0) {
        return {
          url, testedUrl: testUrl, finalUrl, finalStatus: response.status,
          hops: 0, redirected: false, wasRedirect,
          preserved: paramKeys, dropped: [], dropsParams: false
        };
      }

      const finalParams = new URL(finalUrl).searchParams;
      const preserved = [], dropped = [];
      for (const k of paramKeys) {
        (finalParams.get(k) === testParams[k] ? preserved : dropped).push(k);
      }

      return {
        url, testedUrl: testUrl, finalUrl, finalStatus: response.status,
        hops: redirectChain.length, chain: redirectChain.map(c => c.statusCode),
        redirected: true, wasRedirect,
        preserved, dropped, dropsParams: dropped.length > 0
      };
    } catch (err) {
      return { url, testedUrl: testUrl, error: err.code || err.message, wasRedirect, dropsParams: false };
    }
  }

  /**
   * Cloaking / UA-parity check. Re-fetch a sample of successfully crawled
   * pages with the comparison UA (options.parityUa — the server picks the
   * "opposite" of the crawl UA: bot crawl → browser UA, browser crawl →
   * Googlebot) and diff what the two user agents were served: status code,
   * title, canonical, noindex. Differences indicate cloaking or bot-specific
   * serving; WAF challenges on either side are reported as challenges, not
   * content diffs.
   */
  async _checkBotParity() {
    if (this.aborted || !this.parityUa) return;

    // Sample: homepage first, then shallow 200 HTML pages
    const candidates = [];
    const seen = new Set();
    const eligible = this.results
      .filter(r => r.statusCode === 200 && r.isHtml !== false && !r.blockedByRobots && (!r.redirectChain || r.redirectChain.length === 0))
      .sort((a, b) => (a.depth || 0) - (b.depth || 0));
    for (const r of eligible) {
      const key = this._dedupeKey(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(r);
      if (candidates.length >= 12) break;
    }
    if (candidates.length === 0) return;

    const results = [];
    const batchSize = Math.min(this.concurrency, 4);
    for (let i = 0; i < candidates.length; i += batchSize) {
      if (this.aborted) break;
      const batch = candidates.slice(i, i + batchSize);
      const settled = await Promise.all(batch.map(page => this._fetchParityPage(page)));
      results.push(...settled.filter(Boolean));
    }

    this.botParity = {
      crawledAs: this.botLabel || 'SEO Tool (default browser UA)',
      comparedWith: this.parityLabel || 'comparison user agent',
      testedCount: results.length,
      differingCount: results.filter(r => r.differs).length,
      challengedCount: results.filter(r => r.challenge).length,
      results
    };
  }

  async _fetchParityPage(page) {
    try {
      const response = await axios.get(page.url, {
        timeout: this.timeout,
        headers: {
          'User-Agent': this.parityUa,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...this.customHeaders
        },
        maxRedirects: 10,
        validateStatus: () => true
      });
      const html = typeof response.data === 'string' ? response.data : '';
      const challenge = this._detectBotChallenge(response, html);

      // Extract the compared fields with the same rules as the main crawl
      let cmp = { title: null, canonical: null, noindex: false };
      if (html) {
        const $ = cheerio.load(html);
        cmp.title = $('title').first().text().trim() || null;
        const canonicalHref = $('link[rel="canonical"]').attr('href')?.trim() || null;
        cmp.canonical = canonicalHref ? this._normalizeUrl(canonicalHref, page.url) : null;
        const metaRobots = $('meta[name="robots"]').attr('content')?.trim() || '';
        cmp.noindex = /noindex/i.test(metaRobots) || /noindex/i.test(String(response.headers['x-robots-tag'] || ''));
      }

      const crawledNoindex = /noindex/i.test(String(page.metaRobots || '')) || /noindex/i.test(String(page.xRobotsTag || ''));
      const diffs = [];
      if (challenge) {
        // The comparison UA was challenged — that IS the finding; content
        // fields would just be the challenge page.
        diffs.push({ field: 'access', crawled: `200 OK`, compared: `${response.status} (${challenge} challenge)` });
      } else {
        if (response.status !== page.statusCode) diffs.push({ field: 'status', crawled: String(page.statusCode), compared: String(response.status) });
        if ((cmp.title || '') !== (page.title || '')) diffs.push({ field: 'title', crawled: page.title || '—', compared: cmp.title || '—' });
        if ((cmp.canonical || '') !== (page.canonical || '')) diffs.push({ field: 'canonical', crawled: page.canonical || '—', compared: cmp.canonical || '—' });
        if (cmp.noindex !== crawledNoindex) diffs.push({ field: 'noindex', crawled: crawledNoindex ? 'noindex' : 'indexable', compared: cmp.noindex ? 'noindex' : 'indexable' });
      }

      return {
        url: page.url,
        crawledStatus: page.statusCode,
        comparedStatus: response.status,
        challenge,
        differs: diffs.length > 0,
        diffs
      };
    } catch (err) {
      return { url: page.url, crawledStatus: page.statusCode, comparedStatus: null, challenge: null, differs: false, error: err.code || err.message, diffs: [] };
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
      paramCheck: this.paramCheck,
      botParity: this.botParity,
      botLabel: this.botLabel,
      sitemapUrlCount: this.sitemapUrls.size,
      robotsTxt: this.robotsTxt || null,
      llmsTxt: this.llmsTxt || null,
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
