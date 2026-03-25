/**
 * SEO Issue Analyzer - Detects all common SEO issues from crawl data
 */
class Analyzer {
  constructor(results, options = {}) {
    this.results = results.filter(r => r.isHtml !== false);
    this.allResults = results;
    this.robotsTxt = options.robotsTxt || null;
    this.sitemapData = options.sitemapData || null;
  }

  analyze() {
    return {
      overview: this._overview(),
      issues: this._detectAllIssues(),
      hreflangReport: this._hreflangReport(),
      canonicalReport: this._canonicalReport(),
      hreflangCanonicalConflicts: this._hreflangCanonicalConflicts(),
      duplicates: this._detectDuplicates(),
      redirectChains: this._redirectChainReport(),
      statusCodeBreakdown: this._statusCodeBreakdown(),
      contentAnalysis: this._contentAnalysis(),
      imageAnalysis: this._imageAnalysis(),
      structuredDataReport: this._structuredDataReport(),
      securityReport: this._securityReport(),
      internalLinkAnalysis: this._internalLinkAnalysis(),
      aiBotsReport: this._aiBotsReport(),
      sitemapReport: this._sitemapReport(),
      anchorsReport: this._anchorsReport(),
      statusCodesReport: this._statusCodesReport()
    };
  }

  _overview() {
    const html = this.results;
    const all = this.allResults;
    return {
      totalUrlsCrawled: all.length,
      htmlPages: html.length,
      avgResponseTime: Math.round(all.reduce((s, r) => s + (r.responseTime || 0), 0) / (all.length || 1)),
      avgWordCount: Math.round(html.reduce((s, r) => s + (r.wordCount || 0), 0) / (html.length || 1)),
      avgTitleLength: Math.round(html.reduce((s, r) => s + (r.titleLength || 0), 0) / (html.length || 1)),
      avgMetaDescLength: Math.round(html.filter(r => r.metaDescriptionLength).reduce((s, r) => s + r.metaDescriptionLength, 0) / (html.filter(r => r.metaDescriptionLength).length || 1)),
      pagesWithHreflangs: html.filter(r => r.hreflangs && r.hreflangs.length > 0).length,
      pagesWithCanonical: html.filter(r => r.canonical).length,
      pagesWithStructuredData: html.filter(r => r.hasStructuredData).length,
      pagesInSitemap: html.filter(r => r.inSitemap).length,
      pagesNotInSitemap: html.filter(r => !r.inSitemap && r.statusCode >= 200 && r.statusCode < 300).length,
      totalImages: html.reduce((s, r) => s + (r.totalImages || 0), 0),
      imagesWithoutAlt: html.reduce((s, r) => s + (r.imagesWithoutAlt || 0), 0),
      status2xx: all.filter(r => r.statusCode >= 200 && r.statusCode < 300).length,
      status3xx: all.filter(r => r.statusCode >= 300 && r.statusCode < 400).length,
      status4xx: all.filter(r => r.statusCode >= 400 && r.statusCode < 500).length,
      status5xx: all.filter(r => r.statusCode >= 500).length,
      errors: all.filter(r => r.error).length,
      blockedByRobots: all.filter(r => r.blockedByRobots).length
    };
  }

  _detectAllIssues() {
    const issues = [];

    for (const page of this.results) {
      if (page.statusCode >= 300) continue; // Skip redirects and error pages

      // Title issues
      if (!page.title) {
        issues.push({ url: page.url, type: 'missing_title', severity: 'critical', category: 'Title', message: 'Missing title tag' });
      } else {
        if (page.titleLength < 30) issues.push({ url: page.url, type: 'title_too_short', severity: 'warning', category: 'Title', message: `Title too short (${page.titleLength} chars, recommend 30-60)` });
        if (page.titleLength > 60) issues.push({ url: page.url, type: 'title_too_long', severity: 'warning', category: 'Title', message: `Title too long (${page.titleLength} chars, recommend 30-60)` });
      }

      // Meta description issues
      if (!page.metaDescription) {
        issues.push({ url: page.url, type: 'missing_meta_description', severity: 'warning', category: 'Meta', message: 'Missing meta description' });
      } else {
        if (page.metaDescriptionLength < 70) issues.push({ url: page.url, type: 'meta_desc_too_short', severity: 'info', category: 'Meta', message: `Meta description too short (${page.metaDescriptionLength} chars, recommend 70-160)` });
        if (page.metaDescriptionLength > 160) issues.push({ url: page.url, type: 'meta_desc_too_long', severity: 'warning', category: 'Meta', message: `Meta description too long (${page.metaDescriptionLength} chars, recommend 70-160)` });
      }

      // H1 issues
      if (page.h1Count === 0) issues.push({ url: page.url, type: 'missing_h1', severity: 'critical', category: 'Headings', message: 'Missing H1 tag' });
      if (page.h1Count > 1) issues.push({ url: page.url, type: 'multiple_h1', severity: 'warning', category: 'Headings', message: `Multiple H1 tags (${page.h1Count})` });

      // Canonical issues
      if (!page.canonical) {
        issues.push({ url: page.url, type: 'missing_canonical', severity: 'warning', category: 'Canonical', message: 'Missing canonical tag' });
      }

      // Hreflang/canonical conflicts
      if (page.hreflangCanonicalConflicts && page.hreflangCanonicalConflicts.length > 0) {
        for (const conflict of page.hreflangCanonicalConflicts) {
          issues.push({
            url: page.url,
            type: conflict.type,
            severity: conflict.severity,
            category: 'Hreflang/Canonical',
            message: conflict.message
          });
        }
      }

      // Image issues
      if (page.imagesWithoutAlt > 0) {
        issues.push({ url: page.url, type: 'images_missing_alt', severity: 'warning', category: 'Images', message: `${page.imagesWithoutAlt} image(s) missing alt text` });
      }

      // Content issues
      if (page.wordCount < 100 && page.statusCode === 200) {
        issues.push({ url: page.url, type: 'thin_content', severity: 'warning', category: 'Content', message: `Thin content (${page.wordCount} words)` });
      }

      // Viewport
      if (!page.hasViewport) {
        issues.push({ url: page.url, type: 'missing_viewport', severity: 'warning', category: 'Mobile', message: 'Missing viewport meta tag' });
      }

      // html lang
      if (!page.htmlLang) {
        issues.push({ url: page.url, type: 'missing_html_lang', severity: 'info', category: 'Accessibility', message: 'Missing html lang attribute' });
      }

      // Open Graph
      if (!page.ogTitle) {
        issues.push({ url: page.url, type: 'missing_og_title', severity: 'info', category: 'Social', message: 'Missing Open Graph title' });
      }
      if (!page.ogDescription) {
        issues.push({ url: page.url, type: 'missing_og_description', severity: 'info', category: 'Social', message: 'Missing Open Graph description' });
      }
      if (!page.ogImage) {
        issues.push({ url: page.url, type: 'missing_og_image', severity: 'info', category: 'Social', message: 'Missing Open Graph image' });
      }

      // Performance
      if (page.responseTime > 3000) {
        issues.push({ url: page.url, type: 'slow_response', severity: 'warning', category: 'Performance', message: `Slow response time (${page.responseTime}ms)` });
      }
      if (page.contentLength > 2000000) {
        issues.push({ url: page.url, type: 'large_page', severity: 'warning', category: 'Performance', message: `Large page size (${(page.contentLength / 1024).toFixed(0)}KB)` });
      }

      // Noindex with follow
      if (page.metaRobots && page.metaRobots.includes('noindex') && page.inSitemap) {
        issues.push({ url: page.url, type: 'noindex_in_sitemap', severity: 'critical', category: 'Indexability', message: 'Noindex page found in sitemap' });
      }

      // Not in sitemap (indexable pages)
      if (!page.inSitemap && page.statusCode === 200 && (!page.metaRobots || !page.metaRobots.includes('noindex'))) {
        issues.push({ url: page.url, type: 'not_in_sitemap', severity: 'info', category: 'Sitemap', message: 'Indexable page not found in sitemap' });
      }

      // Structured data missing
      if (!page.hasStructuredData) {
        issues.push({ url: page.url, type: 'no_structured_data', severity: 'info', category: 'Structured Data', message: 'No structured data (JSON-LD) found' });
      }
    }

    return issues;
  }

  _hreflangReport() {
    const pages = this.results.filter(r => r.hreflangs && r.hreflangs.length > 0);
    const allLangs = new Set();
    const langMap = {};

    for (const page of pages) {
      for (const hl of page.hreflangs) {
        allLangs.add(hl.lang);
        if (!langMap[hl.lang]) langMap[hl.lang] = [];
        langMap[hl.lang].push({ pageUrl: page.url, hreflangUrl: hl.href });
      }
    }

    // Return-link validation
    const returnLinkIssues = [];
    for (const page of pages) {
      for (const hl of page.hreflangs) {
        if (hl.href === page.url) continue; // skip self
        const targetPage = pages.find(p => p.url === hl.href);
        if (targetPage) {
          const returnLink = targetPage.hreflangs.find(h => h.href === page.url);
          if (!returnLink) {
            returnLinkIssues.push({
              from: page.url,
              to: hl.href,
              lang: hl.lang,
              message: `${hl.href} does not have a return hreflang link back to ${page.url}`
            });
          }
        }
      }
    }

    return {
      pagesWithHreflangs: pages.length,
      languages: [...allLangs],
      languageDistribution: langMap,
      returnLinkIssues,
      totalReturnLinkIssues: returnLinkIssues.length
    };
  }

  _canonicalReport() {
    const pages = this.results.filter(r => r.statusCode >= 200 && r.statusCode < 300);
    const withCanonical = pages.filter(r => r.canonical);
    const selfCanonical = pages.filter(r => r.canonicalIsSelf);
    const otherCanonical = withCanonical.filter(r => !r.canonicalIsSelf);
    const missingCanonical = pages.filter(r => !r.canonical);

    return {
      total: pages.length,
      withCanonical: withCanonical.length,
      selfReferencing: selfCanonical.length,
      canonicalized: otherCanonical.length,
      missing: missingCanonical.length,
      canonicalizedPages: otherCanonical.map(p => ({ url: p.url, canonical: p.canonical })),
      missingPages: missingCanonical.map(p => p.url)
    };
  }

  _hreflangCanonicalConflicts() {
    const conflicts = [];
    for (const page of this.results) {
      if (page.hreflangCanonicalConflicts && page.hreflangCanonicalConflicts.length > 0) {
        conflicts.push({
          url: page.url,
          canonical: page.canonical,
          hreflangs: page.hreflangs,
          conflicts: page.hreflangCanonicalConflicts
        });
      }
    }
    return {
      totalPagesWithConflicts: conflicts.length,
      totalConflicts: conflicts.reduce((s, c) => s + c.conflicts.length, 0),
      pages: conflicts
    };
  }

  _detectDuplicates() {
    const titleGroups = {};
    const contentGroups = {};
    const descGroups = {};

    for (const page of this.results) {
      if (page.statusCode !== 200) continue;

      if (page.titleHash) {
        if (!titleGroups[page.titleHash]) titleGroups[page.titleHash] = [];
        titleGroups[page.titleHash].push({ url: page.url, title: page.title });
      }
      if (page.contentHash) {
        if (!contentGroups[page.contentHash]) contentGroups[page.contentHash] = [];
        contentGroups[page.contentHash].push({ url: page.url, wordCount: page.wordCount });
      }
      if (page.metaDescription) {
        const descHash = page.metaDescription.toLowerCase().trim();
        if (!descGroups[descHash]) descGroups[descHash] = [];
        descGroups[descHash].push({ url: page.url, description: page.metaDescription });
      }
    }

    return {
      duplicateTitles: Object.values(titleGroups).filter(g => g.length > 1),
      duplicateContent: Object.values(contentGroups).filter(g => g.length > 1),
      duplicateDescriptions: Object.values(descGroups).filter(g => g.length > 1)
    };
  }

  _redirectChainReport() {
    const chains = [];
    for (const page of this.allResults) {
      if (page.redirectChain && page.redirectChain.length > 0) {
        chains.push({
          originalUrl: page.url,
          chain: page.redirectChain,
          finalUrl: page.finalUrl,
          hops: page.redirectChain.length,
          isLong: page.redirectChain.length > 2
        });
      }
    }
    return {
      total: chains.length,
      longChains: chains.filter(c => c.isLong).length,
      chains
    };
  }

  _statusCodeBreakdown() {
    const codes = {};
    for (const page of this.allResults) {
      const code = page.statusCode || 'error';
      if (!codes[code]) codes[code] = [];
      codes[code].push(page.url);
    }
    return codes;
  }

  _contentAnalysis() {
    const pages = this.results.filter(r => r.statusCode === 200);
    return {
      avgWordCount: Math.round(pages.reduce((s, r) => s + (r.wordCount || 0), 0) / (pages.length || 1)),
      thinPages: pages.filter(r => r.wordCount < 300).map(r => ({ url: r.url, wordCount: r.wordCount })),
      avgTextRatio: (pages.reduce((s, r) => s + parseFloat(r.textRatio || 0), 0) / (pages.length || 1)).toFixed(1)
    };
  }

  _imageAnalysis() {
    const all = [];
    let totalImages = 0;
    let missingAltCount = 0;
    let emptyAltCount = 0;

    for (const page of this.results) {
      if (!page.images || page.statusCode >= 300) continue;
      for (const img of page.images) {
        totalImages++;
        if (!img.hasAlt) missingAltCount++;
        if (img.altEmpty) emptyAltCount++;
        all.push({ ...img, pageUrl: page.url });
      }
    }

    // Deduplicate images with issues by image src — show only one origin page per image
    const issueMap = new Map();
    for (const img of all) {
      if (!img.hasAlt || img.altEmpty) {
        const key = img.src || img.pageUrl + ':nosrc';
        if (!issueMap.has(key)) {
          issueMap.set(key, {
            src: img.src,
            alt: img.alt,
            hasAlt: img.hasAlt,
            altEmpty: img.altEmpty,
            issue: !img.hasAlt ? 'Missing alt attribute' : 'Empty alt text',
            pageUrl: img.pageUrl,
            occurrences: 1
          });
        } else {
          issueMap.get(key).occurrences++;
        }
      }
    }

    return {
      totalImages,
      missingAlt: missingAltCount,
      emptyAlt: emptyAltCount,
      uniqueIssueImages: issueMap.size,
      issueImages: [...issueMap.values()],
      images: all
    };
  }

  _structuredDataReport() {
    const types = {};
    for (const page of this.results) {
      if (!page.structuredData) continue;
      for (const t of page.structuredData) {
        if (!types[t]) types[t] = 0;
        types[t]++;
      }
    }
    return {
      typeCounts: types,
      pagesWithSD: this.results.filter(r => r.hasStructuredData).length,
      pagesWithoutSD: this.results.filter(r => !r.hasStructuredData && r.statusCode === 200).length
    };
  }

  _securityReport() {
    const pages = this.results.filter(r => r.securityHeaders);
    if (pages.length === 0) return { checked: 0 };

    const headers = ['strictTransportSecurity', 'contentSecurityPolicy', 'xContentTypeOptions', 'xFrameOptions', 'xXssProtection', 'referrerPolicy'];
    const report = {};

    for (const h of headers) {
      report[h] = {
        present: pages.filter(p => p.securityHeaders[h]).length,
        missing: pages.filter(p => !p.securityHeaders[h]).length
      };
    }

    const isHttps = this.results.every(r => r.url && r.url.startsWith('https'));

    return { checked: pages.length, headers: report, isHttps };
  }

  _internalLinkAnalysis() {
    const inboundCounts = {};

    for (const page of this.results) {
      if (!page.links) continue;
      for (const link of page.links) {
        if (link.isInternal) {
          if (!inboundCounts[link.href]) inboundCounts[link.href] = 0;
          inboundCounts[link.href]++;
        }
      }
    }

    const orphanPages = this.results
      .filter(r => r.statusCode === 200 && (!inboundCounts[r.url] || inboundCounts[r.url] === 0) && r.url !== this.results[0]?.url)
      .map(r => r.url);

    const sortedByInbound = Object.entries(inboundCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([url, count]) => ({ url, inboundLinks: count }));

    return {
      orphanPages,
      orphanCount: orphanPages.length,
      topLinkedPages: sortedByInbound,
      avgInternalLinks: Math.round(this.results.reduce((s, r) => s + (r.internalLinks || 0), 0) / (this.results.length || 1))
    };
  }

  _anchorsReport() {
    const emptyAnchors = [];
    for (const page of this.results) {
      if (!page.links || page.statusCode >= 300) continue;
      for (const link of page.links) {
        if (link.isInternal && (!link.anchor || link.anchor.trim() === '')) {
          emptyAnchors.push({
            from: page.url,
            to: link.href,
            isNofollow: link.isNofollow
          });
        }
      }
    }
    return {
      totalEmptyAnchors: emptyAnchors.length,
      emptyAnchors
    };
  }

  _statusCodesReport() {
    const groups = {
      '2xx': { label: '2xx (Success)', color: '#22c55e', urls: [] },
      '3xx': { label: '3xx (Redirect)', color: '#f59e0b', urls: [] },
      '4xx': { label: '4xx (Client Error)', color: '#ef4444', urls: [] },
      '5xx': { label: '5xx (Server Error)', color: '#dc2626', urls: [] },
      'error': { label: 'Connection Error', color: '#6b7280', urls: [] }
    };

    for (const page of this.allResults) {
      const code = page.statusCode || 0;
      if (code >= 200 && code < 300) groups['2xx'].urls.push({ url: page.url, statusCode: code });
      else if (code >= 300 && code < 400) groups['3xx'].urls.push({ url: page.url, statusCode: code, finalUrl: page.finalUrl });
      else if (code >= 400 && code < 500) groups['4xx'].urls.push({ url: page.url, statusCode: code });
      else if (code >= 500) groups['5xx'].urls.push({ url: page.url, statusCode: code });
      else groups['error'].urls.push({ url: page.url, error: page.error });
    }

    const total = this.allResults.length;
    const pieChart = Object.values(groups)
      .filter(g => g.urls.length > 0)
      .map(g => ({
        label: g.label,
        count: g.urls.length,
        percentage: ((g.urls.length / total) * 100).toFixed(1),
        color: g.color
      }));

    return { groups, pieChart, total };
  }

  _sitemapReport() {
    const sm = this.sitemapData;

    // Build a URL→statusCode lookup from crawled pages
    const crawledMap = {};
    for (const page of this.allResults) {
      if (page.url) crawledMap[page.url] = page.statusCode || 0;
      // Also map without/with trailing slash
      if (page.url && page.url.endsWith('/')) {
        crawledMap[page.url.slice(0, -1)] = page.statusCode || 0;
      } else if (page.url) {
        crawledMap[page.url + '/'] = page.statusCode || 0;
      }
    }

    if (!sm || !sm.files || sm.files.length === 0) {
      // No sitemaps found at all
      const crawledNotInSitemap = this.results
        .filter(r => r.statusCode === 200 && !r.inSitemap && (!r.metaRobots || !r.metaRobots.includes('noindex')))
        .map(r => r.url);

      return {
        found: false,
        fromRobots: false,
        message: 'No sitemap.xml found. Checked robots.txt and common sitemap URL patterns (sitemap.xml, sitemaps.xml, sitemap_index.xml, wp-sitemap.xml, etc.)',
        files: [],
        totalSitemapUrls: 0,
        statusBreakdown: {},
        statusPieChart: [],
        crawledNotInSitemap,
        crawledNotInSitemapCount: crawledNotInSitemap.length,
        inSitemapNotCrawled: [],
        inSitemapNotCrawledCount: 0
      };
    }

    // Sitemap found
    const sitemapUrlList = sm.urls || [];
    const sitemapUrlSet = new Set(sitemapUrlList.map(u => u.url));

    // Status code breakdown for sitemap URLs
    const statusBreakdown = {};
    const sitemapUrlStatuses = [];
    for (const entry of sitemapUrlList) {
      const code = crawledMap[entry.url] || 'not_crawled';
      const bucket = code === 'not_crawled' ? 'Not Crawled'
        : code >= 200 && code < 300 ? '2xx (OK)'
        : code >= 300 && code < 400 ? '3xx (Redirect)'
        : code >= 400 && code < 500 ? '4xx (Client Error)'
        : code >= 500 ? '5xx (Server Error)'
        : 'Error';
      if (!statusBreakdown[bucket]) statusBreakdown[bucket] = [];
      statusBreakdown[bucket].push({ url: entry.url, statusCode: code, sitemap: entry.sitemap });
      sitemapUrlStatuses.push({ url: entry.url, statusCode: code, sitemap: entry.sitemap, lastmod: entry.lastmod });
    }

    // Pie chart data
    const colors = {
      '2xx (OK)': '#22c55e',
      '3xx (Redirect)': '#f59e0b',
      '4xx (Client Error)': '#ef4444',
      '5xx (Server Error)': '#dc2626',
      'Not Crawled': '#8b8fa3',
      'Error': '#6b7280'
    };
    const statusPieChart = Object.entries(statusBreakdown).map(([label, urls]) => ({
      label,
      count: urls.length,
      percentage: ((urls.length / sitemapUrlList.length) * 100).toFixed(1),
      color: colors[label] || '#6366f1'
    }));

    // Crawled pages NOT in sitemap (indexable 200s only)
    const crawledNotInSitemap = this.results
      .filter(r => {
        if (r.statusCode !== 200) return false;
        if (r.metaRobots && r.metaRobots.includes('noindex')) return false;
        const url = r.url;
        // Check both with and without trailing slash
        return !sitemapUrlSet.has(url) && !sitemapUrlSet.has(url + '/') && !sitemapUrlSet.has(url.replace(/\/$/, ''));
      })
      .map(r => r.url);

    // Sitemap URLs NOT found in crawl (orphan sitemap entries)
    const crawledUrlSet = new Set(this.allResults.map(r => r.url));
    const inSitemapNotCrawled = sitemapUrlList
      .filter(u => !crawledUrlSet.has(u.url) && !crawledUrlSet.has(u.url + '/') && !crawledUrlSet.has(u.url.replace(/\/$/, '')))
      .map(u => u.url);

    return {
      found: true,
      fromRobots: sm.fromRobots,
      message: sm.fromRobots
        ? 'Sitemap(s) declared in robots.txt'
        : 'Sitemap(s) found via auto-discovery (not declared in robots.txt)',
      files: sm.files,
      totalSitemapUrls: sitemapUrlList.length,
      statusBreakdown,
      statusPieChart,
      sitemapUrlStatuses,
      crawledNotInSitemap,
      crawledNotInSitemapCount: crawledNotInSitemap.length,
      inSitemapNotCrawled,
      inSitemapNotCrawledCount: inSitemapNotCrawled.length
    };
  }

  _aiBotsReport() {
    if (!this.robotsTxt) {
      return { hasRobotsTxt: false, bots: [], rawRobotsTxt: null };
    }

    // Known AI bots/crawlers to check
    const AI_BOTS = [
      { name: 'GPTBot', owner: 'OpenAI', description: 'ChatGPT / OpenAI web browsing & training' },
      { name: 'ChatGPT-User', owner: 'OpenAI', description: 'ChatGPT browsing plugin' },
      { name: 'OAI-SearchBot', owner: 'OpenAI', description: 'OpenAI SearchGPT / search features' },
      { name: 'Google-Extended', owner: 'Google', description: 'Gemini / Bard AI training data' },
      { name: 'Googlebot', owner: 'Google', description: 'Google Search indexing (not AI-specific)' },
      { name: 'Anthropic-ai', owner: 'Anthropic', description: 'Claude AI training data' },
      { name: 'ClaudeBot', owner: 'Anthropic', description: 'Claude AI web access' },
      { name: 'Claude-Web', owner: 'Anthropic', description: 'Claude web browsing' },
      { name: 'CCBot', owner: 'Common Crawl', description: 'Common Crawl (used by many AI companies)' },
      { name: 'Bytespider', owner: 'ByteDance', description: 'TikTok / ByteDance AI training' },
      { name: 'Diffbot', owner: 'Diffbot', description: 'Diffbot web scraping / knowledge graph' },
      { name: 'FacebookBot', owner: 'Meta', description: 'Meta AI training data' },
      { name: 'Meta-ExternalAgent', owner: 'Meta', description: 'Meta AI external data collection' },
      { name: 'Meta-ExternalFetcher', owner: 'Meta', description: 'Meta AI external fetcher' },
      { name: 'PerplexityBot', owner: 'Perplexity', description: 'Perplexity AI search engine' },
      { name: 'YouBot', owner: 'You.com', description: 'You.com AI search' },
      { name: 'Applebot-Extended', owner: 'Apple', description: 'Apple AI / Siri training data' },
      { name: 'Applebot', owner: 'Apple', description: 'Apple Search / Siri (general)' },
      { name: 'cohere-ai', owner: 'Cohere', description: 'Cohere AI training data' },
      { name: 'Amazonbot', owner: 'Amazon', description: 'Amazon Alexa / AI assistant' },
      { name: 'AI2Bot', owner: 'Allen AI', description: 'Allen Institute for AI' },
      { name: 'Scrapy', owner: 'Various', description: 'Scrapy framework (common scraper)' },
      { name: 'Timpibot', owner: 'Timpi', description: 'Timpi decentralized search' },
      { name: 'Omgilibot', owner: 'Webz.io', description: 'Webz.io data collection' },
      { name: 'img2dataset', owner: 'Various', description: 'Image dataset collection for AI training' },
      { name: 'Kangaroo Bot', owner: 'Various', description: 'AI content scraper' },
      { name: 'Sidetrade', owner: 'Sidetrade', description: 'Sidetrade AI data collection' },
    ];

    const lines = this.robotsTxt.split('\n').map(l => l.trim());
    const bots = [];

    for (const bot of AI_BOTS) {
      const status = this._checkBotStatus(lines, bot.name);
      bots.push({
        ...bot,
        ...status
      });
    }

    // Count blocked vs allowed
    const blocked = bots.filter(b => b.status === 'blocked');
    const allowed = bots.filter(b => b.status === 'allowed');
    const partiallyBlocked = bots.filter(b => b.status === 'partial');
    const notMentioned = bots.filter(b => b.status === 'not_mentioned');

    return {
      hasRobotsTxt: true,
      totalBots: bots.length,
      blockedCount: blocked.length,
      allowedCount: allowed.length + notMentioned.length,
      partialCount: partiallyBlocked.length,
      bots,
      rawRobotsTxt: this.robotsTxt
    };
  }

  _checkBotStatus(lines, botName) {
    let inBlock = false;
    let hasDisallowAll = false;
    let hasAllow = false;
    let hasDisallow = false;
    const rules = [];
    const botNameLower = botName.toLowerCase();

    // Also check wildcard (*) rules
    let inWildcard = false;
    let wildcardDisallowAll = false;

    for (const line of lines) {
      const lower = line.toLowerCase();

      // Detect User-agent blocks
      if (lower.startsWith('user-agent:')) {
        const agent = lower.replace('user-agent:', '').trim();
        if (agent === botNameLower) {
          inBlock = true;
          inWildcard = false;
        } else if (agent === '*') {
          inWildcard = true;
          inBlock = false;
        } else {
          if (inBlock || inWildcard) {
            // End of relevant block only if we hit another user-agent
          }
          inBlock = false;
          inWildcard = false;
        }
        continue;
      }

      if (inBlock) {
        if (lower.startsWith('disallow:')) {
          const path = line.replace(/^disallow:/i, '').trim();
          rules.push({ type: 'disallow', path });
          if (path === '/' || path === '/*') hasDisallowAll = true;
          hasDisallow = true;
        } else if (lower.startsWith('allow:')) {
          const path = line.replace(/^allow:/i, '').trim();
          rules.push({ type: 'allow', path });
          hasAllow = true;
        }
      }

      if (inWildcard) {
        if (lower.startsWith('disallow:')) {
          const path = line.replace(/^disallow:/i, '').trim();
          if (path === '/' || path === '/*') wildcardDisallowAll = true;
        }
      }
    }

    // Determine status
    if (hasDisallowAll && !hasAllow) {
      return { status: 'blocked', statusLabel: 'Blocked', rules };
    }
    if (hasDisallowAll && hasAllow) {
      return { status: 'partial', statusLabel: 'Partially Blocked', rules };
    }
    if (hasDisallow && !hasDisallowAll) {
      return { status: 'partial', statusLabel: 'Partially Blocked', rules };
    }
    if (inBlock || hasAllow) {
      return { status: 'allowed', statusLabel: 'Explicitly Allowed', rules };
    }
    // Not mentioned specifically — falls back to wildcard
    if (wildcardDisallowAll) {
      return { status: 'blocked', statusLabel: 'Blocked (via *)', rules: [{ type: 'disallow', path: '/ (wildcard)' }] };
    }
    return { status: 'not_mentioned', statusLabel: 'Not Mentioned (Allowed)', rules: [] };
  }
}

module.exports = Analyzer;
