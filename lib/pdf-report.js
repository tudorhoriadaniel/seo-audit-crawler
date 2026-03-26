const PDFDocument = require('pdfkit');

// Colors
const C = {
  primary: '#6366f1',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#3b82f6',
  dark: '#1e1e2e',
  text: '#333333',
  muted: '#6b7280',
  lightBg: '#f8fafc',
  white: '#ffffff',
  border: '#e2e8f0'
};

function generatePDFReport(res, analysis, siteUrl) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });

  // Pipe to response
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="SEO-Audit-${siteUrl.replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`);
  doc.pipe(res);

  const pw = 495; // page width minus margins
  const leftM = 50;

  // ── Helper functions ──
  function addPage() {
    doc.addPage();
    addFooter();
  }

  function addFooter() {
    // Will be added at the end via bufferPages
  }

  function checkSpace(needed) {
    if (doc.y + needed > 750) addPage();
  }

  function sectionTitle(title, icon) {
    checkSpace(50);
    doc.moveDown(0.5);
    doc.roundedRect(leftM, doc.y, pw, 32, 4).fill(C.primary);
    doc.fill(C.white).fontSize(14).font('Helvetica-Bold').text(icon + '  ' + title, leftM + 12, doc.y - 28, { width: pw - 24 });
    doc.fill(C.text);
    doc.moveDown(0.8);
  }

  function statBox(x, y, w, label, value, color) {
    doc.roundedRect(x, y, w, 52, 4).lineWidth(1).strokeColor(C.border).stroke();
    doc.fill(color || C.primary).fontSize(20).font('Helvetica-Bold').text(String(value), x + 8, y + 6, { width: w - 16, align: 'center' });
    doc.fill(C.muted).fontSize(8).font('Helvetica').text(label, x + 4, y + 32, { width: w - 8, align: 'center' });
    doc.fill(C.text);
  }

  function drawTable(headers, rows, colWidths) {
    checkSpace(30 + rows.length * 22);
    const startX = leftM;
    let y = doc.y;

    // Header
    doc.rect(startX, y, pw, 20).fill('#eef2ff');
    let x = startX;
    headers.forEach((h, i) => {
      doc.fill(C.primary).fontSize(8).font('Helvetica-Bold').text(h, x + 4, y + 5, { width: colWidths[i] - 8 });
      x += colWidths[i];
    });
    y += 20;

    // Rows
    rows.forEach((row, ri) => {
      if (y > 740) {
        addPage();
        y = doc.y;
        // Re-draw header
        doc.rect(startX, y, pw, 20).fill('#eef2ff');
        let hx = startX;
        headers.forEach((h, i) => {
          doc.fill(C.primary).fontSize(8).font('Helvetica-Bold').text(h, hx + 4, y + 5, { width: colWidths[i] - 8 });
          hx += colWidths[i];
        });
        y += 20;
      }

      if (ri % 2 === 1) doc.rect(startX, y, pw, 20).fill('#f8fafc');
      x = startX;
      row.forEach((cell, i) => {
        doc.fill(C.text).fontSize(7).font('Helvetica').text(String(cell || '-'), x + 4, y + 5, { width: colWidths[i] - 8, lineBreak: false });
        x += colWidths[i];
      });
      y += 20;
    });

    doc.y = y;
    doc.fill(C.text);
  }

  function drawPieChart(cx, cy, radius, data) {
    let startAngle = -Math.PI / 2;
    const total = data.reduce((s, d) => s + d.value, 0);
    if (total === 0) return;

    data.forEach(d => {
      if (d.value === 0) return;
      const sliceAngle = (d.value / total) * 2 * Math.PI;
      const endAngle = startAngle + sliceAngle;
      const largeArc = sliceAngle > Math.PI ? 1 : 0;

      const x1 = cx + radius * Math.cos(startAngle);
      const y1 = cy + radius * Math.sin(startAngle);
      const x2 = cx + radius * Math.cos(endAngle);
      const y2 = cy + radius * Math.sin(endAngle);

      doc.path(`M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`).fill(d.color);
      startAngle = endAngle;
    });
  }

  function infoBox(text, type) {
    checkSpace(40);
    const colors = { tip: '#dbeafe', warn: '#fef3c7', error: '#fee2e2' };
    const icons = { tip: 'TIP:', warn: 'NOTE:', error: 'ISSUE:' };
    const bg = colors[type] || colors.tip;
    doc.roundedRect(leftM, doc.y, pw, 35, 3).fill(bg);
    doc.fill(C.text).fontSize(8).font('Helvetica-Bold').text(icons[type] || 'TIP:', leftM + 10, doc.y - 30);
    doc.font('Helvetica').fontSize(7).text(text, leftM + 10, doc.y + 2, { width: pw - 20 });
    doc.fill(C.text);
    doc.moveDown(0.5);
  }

  // ══════════════════════════════════════════════════════════
  // PAGE 1: Cover
  // ══════════════════════════════════════════════════════════

  // Background stripe
  doc.rect(0, 0, 595, 280).fill(C.primary);

  // Title
  doc.fill(C.white).fontSize(32).font('Helvetica-Bold').text('SEO Audit Report', leftM, 80, { width: pw });
  doc.fontSize(16).font('Helvetica').text(siteUrl, leftM, 120, { width: pw });

  // Date
  const now = new Date();
  doc.fontSize(11).text(`Generated: ${now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, leftM, 150);

  // Score circle
  const sc = analysis.statusCodesReport || {};
  const mt = analysis.metaTitlesReport || {};
  const md = analysis.metaDescriptionsReport || {};
  const hrf = analysis.hreflangReport || {};
  const sm = analysis.sitemapReport || {};
  const cnt = analysis.contentAnalysis || {};
  const img = analysis.imageAnalysis || {};
  const lnk = analysis.internalLinkAnalysis || {};
  const anch = analysis.anchorsReport || {};
  const sec = analysis.securityReport || {};
  const sd = analysis.structuredDataReport || {};
  const hdg = analysis.headingsReport || {};
  const dir = analysis.directivesReport || {};
  const iss = analysis.issues || [];

  const criticals = iss.filter(i => i.severity === 'critical').length;
  const warnings = iss.filter(i => i.severity === 'warning').length;
  const totalPages = sc.total || 0;

  let deductions = 0;
  deductions += Math.min(30, criticals * 2);
  deductions += Math.min(20, warnings * 0.5);
  if ((mt.missing?.length || 0) > 0) deductions += 10;
  if ((md.missing?.length || 0) > 0) deductions += 5;
  if ((sc.groups?.['4xx']?.urls?.length || 0) > 0) deductions += 10;
  if ((sc.groups?.['5xx']?.urls?.length || 0) > 0) deductions += 15;
  if (!sm.found) deductions += 5;
  const score = Math.max(0, Math.min(100, Math.round(100 - deductions)));
  const scoreColor = score >= 80 ? C.success : score >= 50 ? C.warning : C.danger;
  const scoreLabel = score >= 80 ? 'Good' : score >= 50 ? 'Needs Work' : 'Critical Issues';

  // Score display on cover
  doc.fill(C.white).fontSize(10).text('SEO Health Score', leftM, 200);
  doc.roundedRect(leftM, 218, 100, 50, 6).fill(scoreColor);
  doc.fill(C.white).fontSize(28).font('Helvetica-Bold').text(String(score), leftM, 226, { width: 100, align: 'center' });
  doc.fill(C.white).fontSize(9).font('Helvetica').text(scoreLabel, leftM + 110, 236);

  // Overview stats below cover
  doc.fill(C.text);
  doc.y = 310;

  doc.fontSize(18).font('Helvetica-Bold').text('Overview', leftM, doc.y);
  doc.moveDown(0.5);

  const boxW = (pw - 24) / 4;
  const boxY = doc.y;
  statBox(leftM, boxY, boxW, 'Pages Crawled', totalPages, C.primary);
  statBox(leftM + boxW + 8, boxY, boxW, '2xx Pages', sc.groups?.['2xx']?.urls?.length || 0, C.success);
  statBox(leftM + (boxW + 8) * 2, boxY, boxW, '3xx Redirects', sc.groups?.['3xx']?.urls?.length || 0, C.warning);
  statBox(leftM + (boxW + 8) * 3, boxY, boxW, '4xx/5xx Errors', (sc.groups?.['4xx']?.urls?.length || 0) + (sc.groups?.['5xx']?.urls?.length || 0), C.danger);
  doc.y = boxY + 65;

  // Second row
  const boxY2 = doc.y;
  statBox(leftM, boxY2, boxW, 'Missing Titles', mt.missing?.length || 0, C.danger);
  statBox(leftM + boxW + 8, boxY2, boxW, 'Missing Desc', md.missing?.length || 0, C.danger);
  statBox(leftM + (boxW + 8) * 2, boxY2, boxW, 'Missing H1', hdg.missingH1?.length || 0, C.warning);
  statBox(leftM + (boxW + 8) * 3, boxY2, boxW, 'Images No Alt', img.missingAlt || 0, C.warning);
  doc.y = boxY2 + 65;

  // ══════════════════════════════════════════════════════════
  // Status Codes Pie Chart
  // ══════════════════════════════════════════════════════════
  sectionTitle('Status Codes Distribution', '📊');

  const pieData = [
    { label: '2xx Success', value: sc.groups?.['2xx']?.urls?.length || 0, color: C.success },
    { label: '3xx Redirect', value: sc.groups?.['3xx']?.urls?.length || 0, color: C.warning },
    { label: '4xx Error', value: sc.groups?.['4xx']?.urls?.length || 0, color: C.danger },
    { label: '5xx Error', value: sc.groups?.['5xx']?.urls?.length || 0, color: '#dc2626' }
  ];

  const pieCx = leftM + 70;
  const pieCy = doc.y + 55;
  drawPieChart(pieCx, pieCy, 50, pieData);

  // Legend
  let legendY = doc.y + 15;
  pieData.forEach(d => {
    doc.rect(leftM + 160, legendY, 10, 10).fill(d.color);
    doc.fill(C.text).fontSize(9).font('Helvetica').text(`${d.label}: ${d.value} (${totalPages ? ((d.value / totalPages) * 100).toFixed(1) : 0}%)`, leftM + 176, legendY + 1);
    legendY += 16;
  });

  doc.y = pieCy + 65;

  if ((sc.groups?.['4xx']?.urls?.length || 0) > 0) {
    infoBox('4xx errors indicate broken pages. Check internal links pointing to these URLs and fix or redirect them.', 'error');
  }
  if ((sc.groups?.['3xx']?.urls?.length || 0) > 0) {
    infoBox('Redirect chains should be minimized. Update internal links to point directly to the final destination URL.', 'warn');
  }

  // ══════════════════════════════════════════════════════════
  // Meta Titles
  // ══════════════════════════════════════════════════════════
  sectionTitle('Meta Titles', '📝');

  const mtBoxY = doc.y;
  const mtBoxW = (pw - 16) / 3;
  statBox(leftM, mtBoxY, mtBoxW, 'Missing', mt.missing?.length || 0, (mt.missing?.length || 0) > 0 ? C.danger : C.success);
  statBox(leftM + mtBoxW + 8, mtBoxY, mtBoxW, 'Too Short (<30)', mt.tooShort?.length || 0, (mt.tooShort?.length || 0) > 0 ? C.warning : C.success);
  statBox(leftM + (mtBoxW + 8) * 2, mtBoxY, mtBoxW, 'Too Long (>60)', mt.tooLong?.length || 0, (mt.tooLong?.length || 0) > 0 ? C.warning : C.success);
  doc.y = mtBoxY + 60;

  const mtRow2Y = doc.y;
  statBox(leftM, mtRow2Y, mtBoxW, 'Duplicates', mt.duplicates?.length || 0, (mt.duplicates?.length || 0) > 0 ? C.danger : C.success);
  statBox(leftM + mtBoxW + 8, mtRow2Y, mtBoxW, 'Total Pages', mt.total || 0, C.primary);
  doc.y = mtRow2Y + 60;

  if ((mt.missing?.length || 0) > 0) {
    infoBox(`${mt.missing.length} pages have no title tag. Every page needs a unique, descriptive title between 30-60 characters for optimal search visibility.`, 'error');
    const missingRows = (mt.missing || []).slice(0, 15).map(p => [p.url]);
    drawTable(['URL (Missing Title)'], missingRows, [pw]);
  }

  if ((mt.duplicates?.length || 0) > 0) {
    infoBox(`${mt.duplicates.length} groups of duplicate titles found. Each page should have a unique title to avoid keyword cannibalization.`, 'warn');
    const dupRows = (mt.duplicates || []).slice(0, 10).map(d => [d.title, d.count + 'x', d.urls.slice(0, 2).join(', ')]);
    drawTable(['Duplicate Title', 'Count', 'Example URLs'], dupRows, [200, 40, pw - 240]);
  }

  // ══════════════════════════════════════════════════════════
  // Meta Descriptions
  // ══════════════════════════════════════════════════════════
  sectionTitle('Meta Descriptions', '📄');

  const mdBoxY = doc.y;
  statBox(leftM, mdBoxY, mtBoxW, 'Missing', md.missing?.length || 0, (md.missing?.length || 0) > 0 ? C.danger : C.success);
  statBox(leftM + mtBoxW + 8, mdBoxY, mtBoxW, 'Too Short (<70)', md.tooShort?.length || 0, (md.tooShort?.length || 0) > 0 ? C.warning : C.success);
  statBox(leftM + (mtBoxW + 8) * 2, mdBoxY, mtBoxW, 'Too Long (>160)', md.tooLong?.length || 0, (md.tooLong?.length || 0) > 0 ? C.warning : C.success);
  doc.y = mdBoxY + 60;

  if ((md.missing?.length || 0) > 0) {
    infoBox(`${md.missing.length} pages lack meta descriptions. While not a direct ranking factor, compelling descriptions improve click-through rates from search results.`, 'error');
    const mdRows = (md.missing || []).slice(0, 15).map(p => [p.url]);
    drawTable(['URL (Missing Meta Description)'], mdRows, [pw]);
  }

  // ══════════════════════════════════════════════════════════
  // Headings
  // ══════════════════════════════════════════════════════════
  sectionTitle('Heading Structure', '🔤');

  const hBoxY = doc.y;
  statBox(leftM, hBoxY, mtBoxW, 'Missing H1', hdg.missingH1?.length || 0, (hdg.missingH1?.length || 0) > 0 ? C.danger : C.success);
  statBox(leftM + mtBoxW + 8, hBoxY, mtBoxW, 'Multiple H1s', hdg.multipleH1?.length || 0, (hdg.multipleH1?.length || 0) > 0 ? C.warning : C.success);
  statBox(leftM + (mtBoxW + 8) * 2, hBoxY, mtBoxW, 'Missing H2', hdg.missingH2?.length || 0, (hdg.missingH2?.length || 0) > 0 ? C.warning : C.success);
  doc.y = hBoxY + 60;

  if ((hdg.missingH1?.length || 0) > 0) {
    infoBox(`${hdg.missingH1.length} pages have no H1 tag. The H1 is the main heading and should contain your target keyword for that page.`, 'error');
    const h1Rows = (hdg.missingH1 || []).slice(0, 10).map(p => [p.url]);
    drawTable(['URL (Missing H1)'], h1Rows, [pw]);
  }

  // ══════════════════════════════════════════════════════════
  // Images
  // ══════════════════════════════════════════════════════════
  sectionTitle('Image Optimization', '🖼️');

  const imgBoxY = doc.y;
  statBox(leftM, imgBoxY, mtBoxW, 'Total Images', img.totalImages || 0, C.primary);
  statBox(leftM + mtBoxW + 8, imgBoxY, mtBoxW, 'Missing Alt', img.missingAlt || 0, (img.missingAlt || 0) > 0 ? C.danger : C.success);
  statBox(leftM + (mtBoxW + 8) * 2, imgBoxY, mtBoxW, 'Empty Alt Text', img.emptyAlt || 0, (img.emptyAlt || 0) > 0 ? C.warning : C.success);
  doc.y = imgBoxY + 60;

  if ((img.missingAlt || 0) > 0) {
    infoBox('Images without alt attributes hurt accessibility and SEO. Alt text should describe the image content and include relevant keywords naturally.', 'warn');
  }

  // ══════════════════════════════════════════════════════════
  // Internal Links
  // ══════════════════════════════════════════════════════════
  sectionTitle('Internal Links', '🔗');

  const ilBoxY = doc.y;
  const ilBoxW = (pw - 8) / 2;
  statBox(leftM, ilBoxY, ilBoxW, 'Orphan Pages', lnk.orphanCount || 0, (lnk.orphanCount || 0) > 0 ? C.warning : C.success);
  statBox(leftM + ilBoxW + 8, ilBoxY, ilBoxW, 'Links Without Anchor', anch.totalEmptyAnchors || 0, (anch.totalEmptyAnchors || 0) > 0 ? C.warning : C.success);
  doc.y = ilBoxY + 60;

  if ((lnk.orphanCount || 0) > 0) {
    infoBox(`${lnk.orphanCount} pages have no internal links pointing to them. Orphan pages are hard to discover and may not get indexed.`, 'warn');
  }

  // ══════════════════════════════════════════════════════════
  // Hreflang
  // ══════════════════════════════════════════════════════════
  if ((hrf.pagesWithHreflangs || 0) > 0) {
    sectionTitle('Hreflang & International SEO', '🌍');

    const hrBoxY = doc.y;
    statBox(leftM, hrBoxY, mtBoxW, 'Pages with Hreflang', hrf.pagesWithHreflangs || 0, C.primary);
    statBox(leftM + mtBoxW + 8, hrBoxY, mtBoxW, 'Languages', hrf.languages?.length || 0, C.info);
    statBox(leftM + (mtBoxW + 8) * 2, hrBoxY, mtBoxW, 'Missing Return Links', hrf.totalReturnLinkIssues || 0, (hrf.totalReturnLinkIssues || 0) > 0 ? C.danger : C.success);
    doc.y = hrBoxY + 60;

    if ((hrf.totalReturnLinkIssues || 0) > 0) {
      infoBox(`${hrf.totalReturnLinkIssues} hreflang return link issues. Every page with hreflang tags should be reciprocally linked from the target language page.`, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════
  // Sitemaps
  // ══════════════════════════════════════════════════════════
  sectionTitle('Sitemap Status', '🗺️');

  checkSpace(80);
  if (sm.found) {
    doc.fill(C.success).fontSize(10).font('Helvetica-Bold').text('✓ Sitemap found', leftM, doc.y);
    doc.fill(C.text).fontSize(8).font('Helvetica');
    doc.moveDown(0.3);
    doc.text(`URLs in sitemap: ${sm.totalSitemapUrls || 0}`);
    doc.text(`Crawled but NOT in sitemap: ${sm.crawledNotInSitemapCount || 0}`);
    doc.text(`In sitemap but NOT crawled: ${sm.inSitemapNotCrawledCount || 0}`);
    doc.moveDown(0.5);

    if ((sm.crawledNotInSitemapCount || 0) > 0) {
      infoBox('Pages discovered during crawl but not in your sitemap should be added. This helps search engines find and index all important pages.', 'warn');
    }
  } else {
    doc.fill(C.danger).fontSize(10).font('Helvetica-Bold').text('✗ No sitemap found', leftM, doc.y);
    doc.fill(C.text);
    doc.moveDown(0.3);
    infoBox('A sitemap.xml helps search engines discover all pages on your site. Create one and submit it in Google Search Console.', 'error');
  }

  // ══════════════════════════════════════════════════════════
  // Structured Data
  // ══════════════════════════════════════════════════════════
  sectionTitle('Structured Data (Schema)', '📊');

  const sdTypes = Object.entries(sd.typeCounts || {});
  if (sdTypes.length > 0) {
    const sdBoxY = doc.y;
    statBox(leftM, sdBoxY, ilBoxW, 'Pages with Schema', sd.pagesWithSchema || 0, C.success);
    statBox(leftM + ilBoxW + 8, sdBoxY, ilBoxW, 'Schema Types', sdTypes.length, C.info);
    doc.y = sdBoxY + 60;

    drawTable(['Schema Type', 'Pages Using It'], sdTypes.slice(0, 10).map(([t, c]) => [t, c]), [300, pw - 300]);
  } else {
    doc.fill(C.muted).fontSize(9).font('Helvetica').text('No structured data found on this website.', leftM, doc.y);
    doc.moveDown(0.5);
    infoBox('Adding Schema.org structured data (JSON-LD) can enable rich snippets in search results, improving click-through rates.', 'tip');
  }

  // ══════════════════════════════════════════════════════════
  // Security
  // ══════════════════════════════════════════════════════════
  sectionTitle('Security', '🔒');

  checkSpace(60);
  doc.fontSize(9).font('Helvetica');
  doc.fill(sec.isHttps ? C.success : C.danger).text(sec.isHttps ? '✓ HTTPS enabled' : '✗ Not using HTTPS', leftM, doc.y);
  doc.fill(C.text);
  doc.moveDown(0.3);

  const secHeaders = sec.headers || {};
  const secRows = [
    ['HSTS (Strict-Transport-Security)', secHeaders.strictTransportSecurity?.present || 0, secHeaders.strictTransportSecurity?.missing || 0],
    ['Content-Security-Policy', secHeaders.contentSecurityPolicy?.present || 0, secHeaders.contentSecurityPolicy?.missing || 0],
    ['X-Frame-Options', secHeaders.xFrameOptions?.present || 0, secHeaders.xFrameOptions?.missing || 0],
    ['X-Content-Type-Options', secHeaders.xContentTypeOptions?.present || 0, secHeaders.xContentTypeOptions?.missing || 0],
  ];
  drawTable(['Security Header', 'Present', 'Missing'], secRows, [250, 120, pw - 370]);

  // ══════════════════════════════════════════════════════════
  // Final: Recommendations Summary
  // ══════════════════════════════════════════════════════════
  sectionTitle('Key Recommendations', '⭐');

  checkSpace(200);
  doc.fontSize(9).font('Helvetica').fill(C.text);
  const recs = [];

  if ((mt.missing?.length || 0) > 0) recs.push({ priority: 'High', text: `Add title tags to ${mt.missing.length} pages. Each title should be 30-60 characters and include the primary keyword.` });
  if ((md.missing?.length || 0) > 0) recs.push({ priority: 'High', text: `Add meta descriptions to ${md.missing.length} pages. Descriptions should be 70-160 characters and compelling for users.` });
  if ((hdg.missingH1?.length || 0) > 0) recs.push({ priority: 'High', text: `Add H1 tags to ${hdg.missingH1.length} pages. Each page should have exactly one H1 containing the target keyword.` });
  if ((sc.groups?.['4xx']?.urls?.length || 0) > 0) recs.push({ priority: 'High', text: `Fix ${sc.groups['4xx'].urls.length} broken pages (4xx errors). Set up 301 redirects or fix internal links pointing to these URLs.` });
  if ((img.missingAlt || 0) > 0) recs.push({ priority: 'Medium', text: `Add alt text to ${img.missingAlt} images. Describe each image in 5-15 words, naturally including keywords.` });
  if ((hrf.totalReturnLinkIssues || 0) > 0) recs.push({ priority: 'Medium', text: `Fix ${hrf.totalReturnLinkIssues} hreflang return link issues to prevent international SEO confusion.` });
  if ((mt.duplicates?.length || 0) > 0) recs.push({ priority: 'Medium', text: `Resolve ${mt.duplicates.length} duplicate title groups. Each page needs a unique title.` });
  if ((lnk.orphanCount || 0) > 0) recs.push({ priority: 'Medium', text: `Link to ${lnk.orphanCount} orphan pages from relevant content to improve discoverability.` });
  if (!sm.found) recs.push({ priority: 'Medium', text: 'Create and submit a sitemap.xml to help search engines discover all pages.' });
  if ((sm.crawledNotInSitemapCount || 0) > 0) recs.push({ priority: 'Low', text: `Add ${sm.crawledNotInSitemapCount} crawled pages to your sitemap.xml.` });
  if (sdTypes.length === 0) recs.push({ priority: 'Low', text: 'Implement Schema.org structured data (JSON-LD) to enable rich snippets in search results.' });

  if (recs.length === 0) recs.push({ priority: '-', text: 'No critical issues found. Keep monitoring and maintaining your SEO health.' });

  const priorityColors = { High: C.danger, Medium: C.warning, Low: C.info, '-': C.success };
  const recRows = recs.map(r => [r.priority, r.text]);
  // Custom table with priority coloring
  recs.forEach((r, i) => {
    checkSpace(30);
    const y = doc.y;
    doc.roundedRect(leftM, y, pw, 24, 2).fill(i % 2 === 0 ? '#fafafa' : C.white);
    doc.roundedRect(leftM + 4, y + 4, 50, 16, 2).fill(priorityColors[r.priority] || C.muted);
    doc.fill(C.white).fontSize(7).font('Helvetica-Bold').text(r.priority, leftM + 4, y + 7, { width: 50, align: 'center' });
    doc.fill(C.text).fontSize(8).font('Helvetica').text(r.text, leftM + 62, y + 7, { width: pw - 70 });
    doc.y = y + 26;
  });

  // ══════════════════════════════════════════════════════════
  // Page numbers
  // ══════════════════════════════════════════════════════════
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.fill(C.muted).fontSize(7).font('Helvetica');
    doc.text(`Page ${i + 1} of ${pageCount}`, leftM, 810, { width: pw, align: 'center' });
    if (i > 0) {
      doc.text(siteUrl + ' — SEO Audit Report', leftM, 810, { width: pw, align: 'left' });
    }
  }

  doc.end();
}

module.exports = { generatePDFReport };
