const XLSX = require('xlsx');

class Exporter {
  static toCSV(pages) {
    const headers = [
      'URL', 'Status Code', 'Title', 'Title Length', 'Meta Description', 'Meta Desc Length',
      'H1', 'H1 Count', 'H2 Count', 'Canonical', 'Canonical Is Self',
      'Word Count', 'Response Time (ms)', 'Content Length', 'Depth',
      'Internal Links', 'External Links', 'Images', 'Images Missing Alt',
      'Has Structured Data', 'Structured Data Types', 'Meta Robots',
      'HTML Lang', 'Has Viewport', 'In Sitemap',
      'OG Title', 'OG Description', 'OG Image',
      'Hreflangs Count', 'Hreflang/Canonical Conflicts',
      'Error', 'Blocked By Robots'
    ];

    const rows = pages.map(p => [
      p.url,
      p.status_code || p.statusCode,
      (p.title || '').replace(/"/g, '""'),
      p.title_length || p.titleLength || 0,
      (p.meta_description || p.metaDescription || '').replace(/"/g, '""'),
      p.meta_description_length || p.metaDescriptionLength || 0,
      JSON.parse(p.h1 || '[]').join(' | '),
      p.h1_count || p.h1Count || 0,
      p.h2_count || p.h2Count || 0,
      p.canonical || '',
      p.canonical_is_self || p.canonicalIsSelf ? 'Yes' : 'No',
      p.word_count || p.wordCount || 0,
      p.response_time || p.responseTime || 0,
      p.content_length || p.contentLength || 0,
      p.depth || 0,
      p.internal_links || p.internalLinks || 0,
      p.external_links || p.externalLinks || 0,
      p.images_total || p.totalImages || 0,
      p.images_without_alt || p.imagesWithoutAlt || 0,
      (p.has_structured_data || p.hasStructuredData) ? 'Yes' : 'No',
      JSON.parse(p.structured_data_types || p.structuredData || '[]').join(', '),
      p.meta_robots || p.metaRobots || '',
      p.html_lang || p.htmlLang || '',
      (p.has_viewport || p.hasViewport) ? 'Yes' : 'No',
      (p.in_sitemap || p.inSitemap) ? 'Yes' : 'No',
      p.og_title || p.ogTitle || '',
      p.og_description || p.ogDescription || '',
      p.og_image || p.ogImage || '',
      JSON.parse(p.hreflangs || '[]').length,
      JSON.parse(p.hreflang_canonical_conflicts || p.hreflangCanonicalConflicts || '[]').length,
      p.error || '',
      (p.blocked_by_robots || p.blockedByRobots) ? 'Yes' : 'No'
    ]);

    const csvRows = [headers.join(',')];
    for (const row of rows) {
      csvRows.push(row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    return csvRows.join('\n');
  }

  static toXLSX(pages, analysis) {
    const wb = XLSX.utils.book_new();

    // All Pages sheet
    const pagesData = pages.map(p => ({
      'URL': p.url,
      'Status': p.status_code || p.statusCode,
      'Title': p.title || '',
      'Title Len': p.title_length || p.titleLength || 0,
      'Meta Description': p.meta_description || p.metaDescription || '',
      'Meta Desc Len': p.meta_description_length || p.metaDescriptionLength || 0,
      'H1': JSON.parse(p.h1 || '[]').join(' | '),
      'H1 Count': p.h1_count || p.h1Count || 0,
      'Canonical': p.canonical || '',
      'Self Canonical': (p.canonical_is_self || p.canonicalIsSelf) ? 'Yes' : 'No',
      'Words': p.word_count || p.wordCount || 0,
      'Response (ms)': p.response_time || p.responseTime || 0,
      'Internal Links': p.internal_links || p.internalLinks || 0,
      'External Links': p.external_links || p.externalLinks || 0,
      'Images': p.images_total || p.totalImages || 0,
      'Missing Alt': p.images_without_alt || p.imagesWithoutAlt || 0,
      'Structured Data': (p.has_structured_data || p.hasStructuredData) ? 'Yes' : 'No',
      'Meta Robots': p.meta_robots || p.metaRobots || '',
      'In Sitemap': (p.in_sitemap || p.inSitemap) ? 'Yes' : 'No',
      'Depth': p.depth || 0,
      'HTML Lang': p.html_lang || p.htmlLang || '',
      'Hreflangs': JSON.parse(p.hreflangs || '[]').length,
      'Hreflang Conflicts': JSON.parse(p.hreflang_canonical_conflicts || '[]').length
    }));
    const ws1 = XLSX.utils.json_to_sheet(pagesData);
    XLSX.utils.book_append_sheet(wb, ws1, 'All Pages');

    // Issues sheet
    if (analysis && analysis.issues) {
      const issuesData = analysis.issues.map(i => ({
        'URL': i.url,
        'Issue': i.message,
        'Category': i.category,
        'Severity': i.severity,
        'Type': i.type
      }));
      const ws2 = XLSX.utils.json_to_sheet(issuesData);
      XLSX.utils.book_append_sheet(wb, ws2, 'Issues');
    }

    // Hreflang/Canonical conflicts sheet
    if (analysis && analysis.hreflangCanonicalConflicts) {
      const conflictsData = [];
      for (const page of analysis.hreflangCanonicalConflicts.pages || []) {
        for (const c of page.conflicts) {
          conflictsData.push({
            'Page URL': page.url,
            'Canonical': page.canonical || '',
            'Conflict Type': c.type,
            'Severity': c.severity,
            'Message': c.message,
            'Lang': c.lang || '',
            'Hreflang URL': c.hreflangUrl || ''
          });
        }
      }
      if (conflictsData.length > 0) {
        const ws3 = XLSX.utils.json_to_sheet(conflictsData);
        XLSX.utils.book_append_sheet(wb, ws3, 'Hreflang-Canonical Conflicts');
      }
    }

    // Redirects sheet
    if (analysis && analysis.redirectChains) {
      const redirectData = (analysis.redirectChains.chains || []).map(r => ({
        'Original URL': r.originalUrl,
        'Final URL': r.finalUrl,
        'Hops': r.hops,
        'Chain': r.chain.map(c => `${c.statusCode}: ${c.url}`).join(' -> ')
      }));
      if (redirectData.length > 0) {
        const ws4 = XLSX.utils.json_to_sheet(redirectData);
        XLSX.utils.book_append_sheet(wb, ws4, 'Redirects');
      }
    }

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  static toJSON(pages, analysis) {
    return JSON.stringify({ pages, analysis }, null, 2);
  }
}

module.exports = Exporter;
