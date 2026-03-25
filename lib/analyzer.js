/**
 * SEO Issue Analyzer - Detects all common SEO issues from crawl data
 */
class Analyzer {
  constructor(results) {
    this.results = results.filter(r => r.isHtml !== false);
    this.allResults = results;
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
      internalLinkAnalysis: this._internalLinkAnalysis()
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
      if (page.statusCode >= 400) continue; // Skip error pages

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
    for (const page of this.results) {
      if (!page.images) continue;
      for (const img of page.images) {
        all.push({ ...img, pageUrl: page.url });
      }
    }
    return {
      totalImages: all.length,
      missingAlt: all.filter(i => !i.hasAlt).length,
      emptyAlt: all.filter(i => i.altEmpty).length,
      missingDimensions: all.filter(i => !i.hasDimensions).length,
      withLazyLoading: all.filter(i => i.loading === 'lazy').length,
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
}

module.exports = Analyzer;
