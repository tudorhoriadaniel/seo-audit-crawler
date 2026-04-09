const PDFDocument = require('pdfkit');

const C = {
  primary: '#4f46e5', success: '#16a34a', warning: '#d97706', danger: '#dc2626',
  info: '#2563eb', text: '#1f2937', muted: '#6b7280', light: '#f1f5f9',
  white: '#ffffff', border: '#e2e8f0', headerBg: '#eef2ff'
};

function generatePDFReport(res, analysis, siteUrl) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="SEO-Audit-${siteUrl.replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`);
  doc.pipe(res);

  const PW = 495, LM = 50;
  let y = 50;
  let pageNum = 1;

  // Disable auto-pagination for footer writes
  function addFooter() {
    const origAutoPage = doc.options.autoFirstPage;
    doc._pageBufferStart = doc.bufferedPageRange?.start;
    // Draw thin line
    doc.save();
    doc.moveTo(LM, 790).lineTo(LM + PW, 790).lineWidth(0.3).strokeColor(C.border).stroke();
    doc.fill(C.muted).fontSize(6).font('Helvetica');
    // Write at fixed position using x,y coordinates - keep lineBreak false and height tiny
    doc.text(siteUrl, LM, 794, { width: 250, lineBreak: false, ellipsis: true, height: 8 });
    doc.text('Page ' + pageNum, LM + 250, 794, { width: PW - 250, align: 'right', lineBreak: false, height: 8 });
    doc.restore();
  }

  // ── Gather data ──
  const sc = analysis.statusCodesReport || {};
  const mt = analysis.metaTitlesReport || {};
  const md = analysis.metaDescriptionsReport || {};
  const hrf = analysis.hreflangReport || {};
  const can = analysis.canonicalReport || {};
  const sm = analysis.sitemapReport || {};
  const cnt = analysis.contentAnalysis || {};
  const img = analysis.imageAnalysis || {};
  const lnk = analysis.internalLinkAnalysis || {};
  const anch = analysis.anchorsReport || {};
  const sec = analysis.securityReport || {};
  const sd = analysis.structuredDataReport || {};
  const hdg = analysis.headingsReport || {};
  const aib = analysis.aiBotsReport || {};
  const iss = analysis.issues || [];

  const criticals = iss.filter(i => i.severity === 'critical').length;
  const warnings = iss.filter(i => i.severity === 'warning').length;
  const totalPages = sc.total || 0;

  let deductions = Math.min(30, criticals * 2) + Math.min(20, warnings * 0.5);
  if ((mt.missing?.length || 0) > 0) deductions += 10;
  if ((md.missing?.length || 0) > 0) deductions += 5;
  if ((sc.groups?.['4xx']?.urls?.length || 0) > 0) deductions += 10;
  if ((sc.groups?.['5xx']?.urls?.length || 0) > 0) deductions += 15;
  if (!sm.found) deductions += 5;
  const score = Math.max(0, Math.min(100, Math.round(100 - deductions)));
  const scoreColor = score >= 80 ? C.success : score >= 50 ? C.warning : C.danger;
  const scoreLabel = score >= 80 ? 'Good' : score >= 50 ? 'Needs Work' : 'Critical Issues';

  // ── Helpers ──
  function ensureSpace(need) {
    if (y + need > 760) {
      addFooter();
      doc.addPage();
      pageNum++;
      y = 50;
    }
  }

  let _isFirstHeading = true;
  function heading(text) {
    if (_isFirstHeading) {
      // First heading after cover page - just ensure some space
      _isFirstHeading = false;
      ensureSpace(130);
    } else {
      // Every subsequent chapter starts on a fresh page
      addFooter();
      doc.addPage();
      pageNum++;
      y = 50;
    }
    // Decorative left accent bar + background
    doc.rect(LM, y, 4, 32).fill(C.primary);
    doc.rect(LM + 4, y, PW - 4, 32).fill('#eef2ff');
    doc.fill(C.primary).fontSize(14).font('Helvetica-Bold').text(text, LM + 16, y + 8, { width: PW - 28, lineBreak: false, height: 18 });
    y += 42;
    doc.fill(C.text);
  }

  function subheading(text) {
    ensureSpace(24);
    doc.fill(C.primary).fontSize(11).font('Helvetica-Bold').text(text, LM, y);
    y += 18;
    doc.fill(C.text);
  }

  function para(text, opts) {
    ensureSpace(20);
    doc.fill(opts?.color || C.text).fontSize(opts?.size || 9).font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica');
    const h = doc.heightOfString(text, { width: PW });
    doc.text(text, LM, y, { width: PW });
    y += h + 6;
    doc.fill(C.text);
  }

  function tip(label, text, bg) {
    ensureSpace(40);
    const h = doc.fontSize(8).font('Helvetica').heightOfString(text, { width: PW - 24 });
    const boxH = Math.max(h + 22, 34);
    const accentColor = bg === '#fee2e2' ? C.danger : bg === '#fef3c7' ? C.warning : C.info;
    doc.roundedRect(LM, y, PW, boxH, 4).fill(bg || '#dbeafe');
    doc.rect(LM, y, 4, boxH).fill(accentColor);
    doc.fill(accentColor).fontSize(8).font('Helvetica-Bold').text(label, LM + 12, y + 6);
    doc.fill(C.text).font('Helvetica').text(text, LM + 12, y + 18, { width: PW - 24 });
    y += boxH + 8;
    doc.fill(C.text);
  }

  function statRow(items) {
    ensureSpace(60);
    const w = (PW - (items.length - 1) * 8) / items.length;
    items.forEach((item, i) => {
      const x = LM + i * (w + 8);
      // Card with colored top border
      doc.roundedRect(x, y, w, 52, 4).fill('#fafbfc');
      doc.rect(x, y, w, 4).fill(item.color || C.primary);
      doc.fill(item.color || C.primary).fontSize(20).font('Helvetica-Bold').text(String(item.value), x, y + 12, { width: w, align: 'center' });
      doc.fill(C.muted).fontSize(7).font('Helvetica').text(item.label, x, y + 36, { width: w, align: 'center' });
    });
    y += 62;
    doc.fill(C.text);
  }

  function table(headers, rows, widths) {
    ensureSpace(28);
    // Header with darker background
    let x = LM;
    doc.rect(LM, y, PW, 20).fill(C.primary);
    headers.forEach((h, i) => {
      doc.fill(C.white).fontSize(7.5).font('Helvetica-Bold').text(h, x + 4, y + 5, { width: widths[i] - 8, lineBreak: false });
      x += widths[i];
    });
    y += 20;

    // Rows - measure actual height needed for wrapping
    rows.forEach((row, ri) => {
      doc.fontSize(6.5).font('Helvetica');
      let rowH = 16;
      row.forEach((cell, i) => {
        const txt = String(cell || '-').substring(0, 300);
        const h = doc.heightOfString(txt, { width: widths[i] - 8 });
        rowH = Math.max(rowH, h + 8);
      });
      rowH = Math.min(rowH, 80); // cap at 80px for very long content

      if (y + rowH > 740) { addFooter(); doc.addPage(); pageNum++; y = 50; }
      if (ri % 2 === 0) doc.rect(LM, y, PW, rowH).fill('#f8fafc');
      // Bottom border
      doc.moveTo(LM, y + rowH).lineTo(LM + PW, y + rowH).lineWidth(0.3).strokeColor('#e2e8f0').stroke();
      x = LM;
      row.forEach((cell, i) => {
        doc.fill(C.text).fontSize(6.5).font('Helvetica').text(String(cell || '-').substring(0, 300), x + 4, y + 4, { width: widths[i] - 8, height: rowH - 6, ellipsis: true });
        x += widths[i];
      });
      y += rowH;
    });
    y += 6;
    doc.fill(C.text);
  }

  function drawPie(data, cx, cy, r) {
    let angle = -Math.PI / 2;
    const total = data.reduce((s, d) => s + d.value, 0);
    if (!total) return;
    data.forEach(d => {
      if (!d.value) return;
      const sweep = (d.value / total) * Math.PI * 2;
      const end = angle + sweep;
      const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
      const large = sweep > Math.PI ? 1 : 0;
      doc.path(`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`).fill(d.color);
      angle = end;
    });
  }

  // ══════════════════════════════════════════
  // COVER PAGE
  // ══════════════════════════════════════════
  // Full-height gradient-style cover
  doc.rect(0, 0, 595, 842).fill(C.primary);
  // Decorative diagonal accent
  doc.save();
  doc.path('M 0 500 L 595 350 L 595 842 L 0 842 Z').fill('#3730a3');
  doc.restore();

  // Title block
  doc.fill(C.white).fontSize(36).font('Helvetica-Bold').text('SEO Audit Report', LM, 140, { width: PW });
  doc.moveTo(LM, 190).lineTo(LM + 80, 190).lineWidth(3).strokeColor('#fbbf24').stroke();
  doc.fill('#c7d2fe').fontSize(14).font('Helvetica').text(siteUrl, LM, 205, { width: PW });
  doc.fill('#c7d2fe').fontSize(11).text('Generated: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), LM, 230);

  // Large score circle
  const scoreCx = 297, scoreCy = 400;
  doc.circle(scoreCx, scoreCy, 70).fill(scoreColor);
  doc.circle(scoreCx, scoreCy, 58).fill(C.white);
  doc.fill(scoreColor).fontSize(42).font('Helvetica-Bold').text(String(score), scoreCx - 40, scoreCy - 22, { width: 80, align: 'center' });
  doc.fill(C.muted).fontSize(10).font('Helvetica').text(scoreLabel, scoreCx - 60, scoreCy + 26, { width: 120, align: 'center' });
  doc.fill('#c7d2fe').fontSize(9).text('SEO Health Score', scoreCx - 60, scoreCy + 80, { width: 120, align: 'center' });

  // Quick stats on cover
  const coverStats = [
    { label: 'Pages', value: totalPages },
    { label: 'Critical', value: criticals },
    { label: 'Warnings', value: warnings },
  ];
  const csW = 100, csGap = 20, csStartX = scoreCx - ((coverStats.length * csW + (coverStats.length - 1) * csGap) / 2);
  coverStats.forEach((s, i) => {
    const cx = csStartX + i * (csW + csGap);
    doc.roundedRect(cx, scoreCy + 110, csW, 50, 6).fill('rgba(255,255,255,0.15)');
    doc.fill(C.white).fontSize(20).font('Helvetica-Bold').text(String(s.value), cx, scoreCy + 118, { width: csW, align: 'center' });
    doc.fill('#c7d2fe').fontSize(8).font('Helvetica').text(s.label, cx, scoreCy + 142, { width: csW, align: 'center' });
  });

  // New page for content
  addFooter();
  doc.addPage();
  pageNum++;
  y = 50;

  // ══════════════════════════════════════════
  // OVERVIEW
  // ══════════════════════════════════════════
  heading('Executive Summary');
  statRow([
    { label: 'Pages Crawled', value: totalPages, color: C.primary },
    { label: '2xx Pages', value: sc.groups?.['2xx']?.urls?.length || 0, color: C.success },
    { label: '3xx Redirects', value: sc.groups?.['3xx']?.urls?.length || 0, color: C.warning },
    { label: '4xx/5xx Errors', value: (sc.groups?.['4xx']?.urls?.length || 0) + (sc.groups?.['5xx']?.urls?.length || 0), color: C.danger }
  ]);
  statRow([
    { label: 'Missing Titles', value: mt.missing?.length || 0, color: (mt.missing?.length || 0) > 0 ? C.danger : C.success },
    { label: 'Missing Meta Desc', value: md.missing?.length || 0, color: (md.missing?.length || 0) > 0 ? C.danger : C.success },
    { label: 'Missing H1', value: hdg.missingH1?.length || 0, color: (hdg.missingH1?.length || 0) > 0 ? C.warning : C.success },
    { label: 'Images No Alt', value: img.missingAlt || 0, color: (img.missingAlt || 0) > 0 ? C.warning : C.success }
  ]);

  // ══════════════════════════════════════════
  // STATUS CODES
  // ══════════════════════════════════════════
  heading('Status Codes');

  const pieData = [
    { label: '2xx Success', value: sc.groups?.['2xx']?.urls?.length || 0, color: C.success },
    { label: '3xx Redirect', value: sc.groups?.['3xx']?.urls?.length || 0, color: C.warning },
    { label: '4xx Error', value: sc.groups?.['4xx']?.urls?.length || 0, color: C.danger },
    { label: '5xx Error', value: sc.groups?.['5xx']?.urls?.length || 0, color: '#991b1b' }
  ];

  ensureSpace(110);
  const pieCx = LM + 60, pieCy = y + 45;
  drawPie(pieData, pieCx, pieCy, 40);

  // Legend next to pie
  let ly = y + 10;
  pieData.forEach(d => {
    doc.rect(LM + 130, ly, 8, 8).fill(d.color);
    doc.fill(C.text).fontSize(8).font('Helvetica').text(`${d.label}: ${d.value} (${totalPages ? ((d.value / totalPages) * 100).toFixed(1) : 0}%)`, LM + 143, ly);
    ly += 15;
  });
  y += 100;

  if ((sc.groups?.['4xx']?.urls?.length || 0) > 0) {
    tip('ISSUE', `${sc.groups['4xx'].urls.length} broken pages found. Fix or redirect these URLs and update internal links.`, '#fee2e2');
    const rows = sc.groups['4xx'].urls.slice(0, 15).map(u => [u.url, u.statusCode]);
    table(['Broken URL', 'Status'], rows, [PW - 60, 60]);
  }
  if ((sc.groups?.['3xx']?.urls?.length || 0) > 0) {
    tip('NOTE', 'Minimize redirect chains. Update internal links to point directly to the final destination URL.', '#fef3c7');
  }

  // ══════════════════════════════════════════
  // META TITLES
  // ══════════════════════════════════════════
  heading('Meta Titles');
  statRow([
    { label: 'Total Pages', value: mt.total || 0, color: C.primary },
    { label: 'Missing', value: mt.missing?.length || 0, color: (mt.missing?.length || 0) > 0 ? C.danger : C.success },
    { label: 'Too Short (<30)', value: mt.tooShort?.length || 0, color: (mt.tooShort?.length || 0) > 0 ? C.warning : C.success },
    { label: 'Too Long (>60)', value: mt.tooLong?.length || 0, color: (mt.tooLong?.length || 0) > 0 ? C.warning : C.success }
  ]);

  if ((mt.missing?.length || 0) > 0) {
    tip('ISSUE', `${mt.missing.length} pages have no title tag. Add a unique, descriptive title (30-60 chars) to each page.`, '#fee2e2');
    table(['URL (Missing Title)'], mt.missing.slice(0, 15).map(p => [p.url]), [PW]);
  }
  if ((mt.duplicates?.length || 0) > 0) {
    tip('WARNING', `${mt.duplicates.length} groups of duplicate titles. Each page needs a unique title to avoid cannibalization.`, '#fef3c7');
    table(['Duplicate Title', 'Count', 'URLs'], mt.duplicates.slice(0, 10).map(d => [d.title, d.count + 'x', d.urls.slice(0, 3).join('\n')]), [PW * 0.4, 35, PW * 0.6 - 35]);
  }
  if ((mt.tooShort?.length || 0) > 0) {
    subheading(`Too Short Titles (${mt.tooShort.length})`);
    table(['URL', 'Title', 'Len'], mt.tooShort.slice(0, 10).map(p => [p.url, p.title, p.length]), [200, PW - 240, 40]);
  }
  if ((mt.tooLong?.length || 0) > 0) {
    subheading(`Too Long Titles (${mt.tooLong.length})`);
    table(['URL', 'Title', 'Len'], mt.tooLong.slice(0, 10).map(p => [p.url, p.title, p.length]), [200, PW - 240, 40]);
  }

  // ══════════════════════════════════════════
  // META DESCRIPTIONS
  // ══════════════════════════════════════════
  heading('Meta Descriptions');
  statRow([
    { label: 'Total', value: md.total || 0, color: C.primary },
    { label: 'Missing', value: md.missing?.length || 0, color: (md.missing?.length || 0) > 0 ? C.danger : C.success },
    { label: 'Too Short (<70)', value: md.tooShort?.length || 0, color: (md.tooShort?.length || 0) > 0 ? C.warning : C.success },
    { label: 'Too Long (>160)', value: md.tooLong?.length || 0, color: (md.tooLong?.length || 0) > 0 ? C.warning : C.success }
  ]);

  if ((md.missing?.length || 0) > 0) {
    tip('ISSUE', `${md.missing.length} pages lack meta descriptions. Add compelling 70-160 char descriptions to improve CTR.`, '#fee2e2');
    table(['URL (Missing Description)'], md.missing.slice(0, 15).map(p => [p.url]), [PW]);
  }
  if ((md.duplicates?.length || 0) > 0) {
    tip('WARNING', `${md.duplicates.length} groups of duplicate meta descriptions found. Each page should have a unique description to avoid cannibalization.`, '#fef3c7');
    table(['Duplicate Description', 'Count', 'URLs'], md.duplicates.slice(0, 10).map(d => [d.description, d.count + 'x', d.urls.slice(0, 3).join('\n')]), [PW * 0.45, 35, PW * 0.55 - 35]);
  }
  if ((md.tooShort?.length || 0) > 0) {
    subheading(`Too Short Descriptions (${md.tooShort.length})`);
    table(['URL', 'Description', 'Len'], md.tooShort.slice(0, 10).map(p => [p.url, p.metaDescription, p.length]), [180, PW - 220, 40]);
  }
  if ((md.tooLong?.length || 0) > 0) {
    subheading(`Too Long Descriptions (${md.tooLong.length})`);
    table(['URL', 'Description', 'Len'], md.tooLong.slice(0, 10).map(p => [p.url, p.metaDescription, p.length]), [180, PW - 220, 40]);
  }

  // ══════════════════════════════════════════
  // HEADINGS
  // ══════════════════════════════════════════
  heading('Heading Structure');
  statRow([
    { label: 'Missing H1', value: hdg.missingH1?.length || 0, color: (hdg.missingH1?.length || 0) > 0 ? C.danger : C.success },
    { label: 'Multiple H1s', value: hdg.multipleH1?.length || 0, color: (hdg.multipleH1?.length || 0) > 0 ? C.warning : C.success },
    { label: 'Missing H2', value: hdg.missingH2?.length || 0, color: (hdg.missingH2?.length || 0) > 0 ? C.warning : C.success }
  ]);

  if ((hdg.missingH1?.length || 0) > 0) {
    tip('ISSUE', `${hdg.missingH1.length} pages have no H1 tag. Every page needs one H1 with the primary keyword.`, '#fee2e2');
    table(['URL (Missing H1)'], hdg.missingH1.slice(0, 10).map(p => [p.url]), [PW]);
  }
  if ((hdg.multipleH1?.length || 0) > 0) {
    tip('WARNING', `${hdg.multipleH1.length} pages have multiple H1 tags. Use only one H1 per page for clear topic focus.`, '#fef3c7');
    table(['URL', 'H1 Count'], hdg.multipleH1.slice(0, 10).map(p => [p.url, p.h1Count]), [PW - 60, 60]);
  }

  // ══════════════════════════════════════════
  // CONTENT
  // ══════════════════════════════════════════
  if (cnt) {
    heading('Content Analysis');
    const thinCount = (cnt.thinPages || []).length;
    statRow([
      { label: 'Avg Word Count', value: cnt.avgWordCount || 0, color: C.primary },
      { label: 'Thin Content (<300w)', value: thinCount, color: thinCount > 0 ? C.warning : C.success },
      { label: 'Avg Text Ratio', value: (cnt.avgTextRatio || 0) + '%', color: C.info }
    ]);
    if (thinCount > 0) {
      tip('WARNING', `${thinCount} pages have fewer than 300 words. Consider expanding thin content with relevant, valuable information.`, '#fef3c7');
      table(['URL', 'Word Count'], (cnt.thinPages || []).slice(0, 15).map(p => [p.url, p.wordCount]), [PW - 70, 70]);
    }
  }

  // ══════════════════════════════════════════
  // IMAGES
  // ══════════════════════════════════════════
  heading('Images');
  statRow([
    { label: 'Total Images', value: img.totalImages || 0, color: C.primary },
    { label: 'Missing Alt', value: img.missingAlt || 0, color: (img.missingAlt || 0) > 0 ? C.danger : C.success },
    { label: 'Empty Alt Text', value: img.emptyAlt || 0, color: (img.emptyAlt || 0) > 0 ? C.warning : C.success }
  ]);
  if ((img.missingAlt || 0) > 0 || (img.emptyAlt || 0) > 0) {
    tip('WARNING', 'Images without alt attributes hurt accessibility and SEO. Describe each image in 5-15 words naturally including keywords.', '#fef3c7');
    const issueImgs = (img.issueImages || []).slice(0, 5);
    if (issueImgs.length > 0) {
      subheading('Examples of Images with Issues');
      table(['Image URL', 'Found On', 'Issue', 'Occurrences'],
        issueImgs.map(i => [i.src || '(no src)', i.pageUrl, i.issue, i.occurrences]),
        [180, 160, 90, PW - 430]);
    }
  }

  // ══════════════════════════════════════════
  // CANONICALS
  // ══════════════════════════════════════════
  heading('Canonical Tags');
  statRow([
    { label: 'Total Pages', value: can.total || 0, color: C.primary },
    { label: 'With Canonical', value: can.withCanonical || 0, color: C.info },
    { label: 'Self-Referencing', value: can.selfReferencing || 0, color: C.success },
    { label: 'Missing Canonical', value: can.missing || 0, color: (can.missing || 0) > 0 ? C.danger : C.success }
  ]);
  if ((can.missing || 0) > 0) {
    tip('ISSUE', `${can.missing} pages are missing canonical tags. Every indexable page should have a self-referencing canonical to prevent duplicate content issues.`, '#fee2e2');
    table(['URL (Missing Canonical)'], (can.missingPages || []).slice(0, 15).map(u => [u]), [PW]);
  }
  if ((can.canonicalized || 0) > 0) {
    tip('NOTE', `${can.canonicalized} pages point their canonical to a different URL. Verify these are intentional.`, '#fef3c7');
    table(['Page URL', 'Canonical Points To'], (can.canonicalizedPages || []).slice(0, 10).map(p => [p.url, p.canonical]), [PW / 2, PW / 2]);
  }

  // ══════════════════════════════════════════
  // INTERNAL LINKS
  // ══════════════════════════════════════════
  heading('Internal Links');
  statRow([
    { label: 'Orphan Pages', value: lnk.orphanCount || 0, color: (lnk.orphanCount || 0) > 0 ? C.warning : C.success },
    { label: 'Links Without Anchor', value: anch.totalEmptyAnchors || 0, color: (anch.totalEmptyAnchors || 0) > 0 ? C.warning : C.success }
  ]);
  if ((lnk.orphanCount || 0) > 0) {
    tip('WARNING', `${lnk.orphanCount} orphan pages have no internal links pointing to them. Add links from relevant content.`, '#fef3c7');
  }

  // ══════════════════════════════════════════
  // HREFLANG (only if site uses multiple languages)
  // ══════════════════════════════════════════
  if ((hrf.pagesWithHreflangs || 0) > 0 && (hrf.languages?.length || 0) > 1) {
    heading('Hreflang & International SEO');
    statRow([
      { label: 'Pages with Hreflang', value: hrf.pagesWithHreflangs || 0, color: C.primary },
      { label: 'Languages', value: hrf.languages?.length || 0, color: C.info },
      { label: 'Missing Return Links', value: hrf.totalReturnLinkIssues || 0, color: (hrf.totalReturnLinkIssues || 0) > 0 ? C.danger : C.success }
    ]);
    if (hrf.languages?.length > 0) {
      para('Languages detected: ' + hrf.languages.join(', '), { size: 8 });
    }
    if ((hrf.totalReturnLinkIssues || 0) > 0) {
      tip('ISSUE', `${hrf.totalReturnLinkIssues} hreflang return link issues found. Every page with hreflang must be reciprocally linked from the target language version.`, '#fee2e2');
      const rlIssues = (hrf.returnLinkIssues || []).slice(0, 10);
      if (rlIssues.length > 0) {
        table(['From', 'To', 'Lang', 'Issue'],
          rlIssues.map(r => [r.from, r.to, r.lang, 'Missing return link']),
          [160, 160, 40, PW - 360]);
      }
    }
  }

  // ══════════════════════════════════════════
  // SITEMAPS
  // ══════════════════════════════════════════
  heading('Sitemaps');
  if (sm.found) {
    para('Sitemap found: Yes', { color: C.success, bold: true });
    para(`Source: ${sm.fromRobots ? 'Declared in robots.txt' : 'Auto-discovered (not in robots.txt)'}`, { size: 8 });
    // List sitemap files
    const smFiles = (sm.files || []).filter(f => f.urlCount > 0 || f.type === 'urlset');
    if (smFiles.length > 0) {
      table(['Sitemap URL', 'Source', 'Type', 'URLs'], smFiles.slice(0, 10).map(f => [f.url, f.source || '-', f.type, f.urlCount || 0]), [220, 80, 60, PW - 360]);
    }
    statRow([
      { label: 'URLs in Sitemap', value: sm.totalSitemapUrls || 0, color: C.primary },
      { label: 'Crawled NOT in Sitemap', value: sm.crawledNotInSitemapCount || 0, color: (sm.crawledNotInSitemapCount || 0) > 0 ? C.warning : C.success },
      { label: 'In Sitemap NOT Crawled', value: sm.inSitemapNotCrawledCount || 0, color: (sm.inSitemapNotCrawledCount || 0) > 0 ? C.warning : C.success }
    ]);
    if ((sm.crawledNotInSitemapCount || 0) > 0) {
      tip('WARNING', `${sm.crawledNotInSitemapCount} crawled pages are not in your sitemap. Add them for better indexing.`, '#fef3c7');
    }
  } else {
    para('No sitemap.xml found', { color: C.danger, bold: true });
    tip('ISSUE', 'Create a sitemap.xml and submit it to Google Search Console. This helps search engines discover all pages.', '#fee2e2');
  }

  // ══════════════════════════════════════════
  // STRUCTURED DATA
  // ══════════════════════════════════════════
  heading('Structured Data');
  const sdTypes = Object.entries(sd.typeCounts || {});
  if (sdTypes.length > 0) {
    statRow([
      { label: 'Pages with Schema', value: sd.pagesWithSD || 0, color: C.success },
      { label: 'Schema Types', value: sdTypes.length, color: C.info }
    ]);
    table(['Schema Type', 'Pages'], sdTypes.slice(0, 10).map(([t, c]) => [t, c]), [PW - 80, 80]);
  } else {
    para('No structured data found.');
    tip('TIP', 'Add Schema.org JSON-LD markup to enable rich snippets in search results (FAQ, How-To, Product, etc).', '#dbeafe');
  }

  // ══════════════════════════════════════════
  // SECURITY
  // ══════════════════════════════════════════
  heading('Security');
  para(sec.isHttps ? 'HTTPS: Enabled' : 'HTTPS: NOT enabled', { color: sec.isHttps ? C.success : C.danger, bold: true });

  const secH = sec.headers || {};
  table(['Security Header', 'Present', 'Missing'], [
    ['HSTS', secH.strictTransportSecurity?.present || 0, secH.strictTransportSecurity?.missing || 0],
    ['Content-Security-Policy', secH.contentSecurityPolicy?.present || 0, secH.contentSecurityPolicy?.missing || 0],
    ['X-Frame-Options', secH.xFrameOptions?.present || 0, secH.xFrameOptions?.missing || 0],
    ['X-Content-Type-Options', secH.xContentTypeOptions?.present || 0, secH.xContentTypeOptions?.missing || 0],
  ], [250, 120, PW - 370]);

  // ══════════════════════════════════════════
  // AI BOTS
  // ══════════════════════════════════════════
  if (aib.bots && aib.bots.length > 0) {
    heading('AI Bot Access (robots.txt)');
    const blocked = (aib.bots || []).filter(b => b.status === 'blocked');
    const allowed = (aib.bots || []).filter(b => b.status === 'allowed');
    const notMentioned = (aib.bots || []).filter(b => b.status === 'not_mentioned');
    const partial = (aib.bots || []).filter(b => b.status === 'partial');

    statRow([
      { label: 'Blocked', value: blocked.length, color: blocked.length > 0 ? C.danger : C.success },
      { label: 'Partially Blocked', value: partial.length, color: partial.length > 0 ? C.warning : C.success },
      { label: 'Allowed', value: allowed.length + notMentioned.length, color: C.success }
    ]);

    if (blocked.length > 0) {
      subheading('Blocked AI Bots');
      table(['Bot', 'Owner', 'Description'], blocked.map(b => [b.name, b.owner, b.description]), [120, 80, PW - 200]);
    }
    if (partial.length > 0) {
      subheading('Partially Blocked AI Bots');
      table(['Bot', 'Owner', 'Description'], partial.map(b => [b.name, b.owner, b.description]), [120, 80, PW - 200]);
    }
    if (allowed.length > 0) {
      subheading('Explicitly Allowed AI Bots');
      table(['Bot', 'Owner', 'Description'], allowed.map(b => [b.name, b.owner, b.description]), [120, 80, PW - 200]);
    }
    if (notMentioned.length > 0) {
      para(`${notMentioned.length} AI bots not mentioned in robots.txt (allowed by default): ${notMentioned.slice(0, 8).map(b => b.name).join(', ')}${notMentioned.length > 8 ? '...' : ''}`, { size: 8, color: C.muted });
    }
    if (!aib.hasRobotsTxt) {
      tip('NOTE', 'No robots.txt found. All AI bots are allowed by default. Consider adding rules if you want to block AI training crawlers.', '#fef3c7');
    }
  }

  // ══════════════════════════════════════════
  // RECOMMENDATIONS
  // ══════════════════════════════════════════
  heading('Key Recommendations');

  const recs = [];
  if ((mt.missing?.length || 0) > 0) recs.push({ p: 'High', t: `Add title tags to ${mt.missing.length} pages. Each should be 30-60 characters with primary keyword.` });
  if ((md.missing?.length || 0) > 0) recs.push({ p: 'High', t: `Add meta descriptions to ${md.missing.length} pages. 70-160 chars, compelling for users.` });
  if ((hdg.missingH1?.length || 0) > 0) recs.push({ p: 'High', t: `Add H1 tags to ${hdg.missingH1.length} pages. One H1 per page with target keyword.` });
  if ((sc.groups?.['4xx']?.urls?.length || 0) > 0) recs.push({ p: 'High', t: `Fix ${sc.groups['4xx'].urls.length} broken pages. Set up 301 redirects or fix linking.` });
  if ((img.missingAlt || 0) > 0) recs.push({ p: 'Medium', t: `Add alt text to ${img.missingAlt} images for accessibility and SEO.` });
  if ((hrf.totalReturnLinkIssues || 0) > 0) recs.push({ p: 'Medium', t: `Fix ${hrf.totalReturnLinkIssues} hreflang return link issues.` });
  if ((mt.duplicates?.length || 0) > 0) recs.push({ p: 'Medium', t: `Resolve ${mt.duplicates.length} duplicate title groups. Each page needs a unique title.` });
  if ((md.duplicates?.length || 0) > 0) recs.push({ p: 'Medium', t: `Fix ${md.duplicates.length} groups of duplicate meta descriptions. Unique descriptions improve CTR.` });
  if ((md.tooShort?.length || 0) > 0) recs.push({ p: 'Medium', t: `Expand ${md.tooShort.length} too-short meta descriptions to 70-160 characters.` });
  if ((mt.tooLong?.length || 0) > 0) recs.push({ p: 'Low', t: `Shorten ${mt.tooLong.length} titles exceeding 60 characters to avoid truncation in SERPs.` });
  if ((md.tooLong?.length || 0) > 0) recs.push({ p: 'Low', t: `Trim ${md.tooLong.length} meta descriptions exceeding 160 characters.` });
  if ((lnk.orphanCount || 0) > 0) recs.push({ p: 'Medium', t: `Link to ${lnk.orphanCount} orphan pages from relevant content.` });
  if (!sm.found) recs.push({ p: 'Medium', t: 'Create and submit a sitemap.xml.' });
  if (sdTypes.length === 0) recs.push({ p: 'Low', t: 'Add Schema.org structured data for rich snippets.' });
  if (recs.length === 0) recs.push({ p: '-', t: 'No critical issues. Keep maintaining your SEO health.' });

  const pColors = { High: C.danger, Medium: C.warning, Low: C.info, '-': C.success };
  const pBg = { High: '#fef2f2', Medium: '#fffbeb', Low: '#eff6ff', '-': '#f0fdf4' };
  recs.forEach((r, i) => {
    doc.fontSize(8).font('Helvetica');
    const h = doc.heightOfString(r.t, { width: PW - 72 });
    const rowH = Math.max(h + 12, 26);
    ensureSpace(rowH + 4);
    doc.roundedRect(LM, y, PW, rowH, 4).fill(pBg[r.p] || '#fafafa');
    doc.rect(LM, y, 4, rowH).fill(pColors[r.p] || C.muted);
    doc.roundedRect(LM + 10, y + (rowH - 16) / 2, 50, 16, 3).fill(pColors[r.p] || C.muted);
    doc.fill(C.white).fontSize(7).font('Helvetica-Bold').text(r.p, LM + 10, y + (rowH - 16) / 2 + 3, { width: 50, align: 'center' });
    doc.fill(C.text).fontSize(8).font('Helvetica').text(r.t, LM + 68, y + 6, { width: PW - 76 });
    y += rowH + 4;
  });

  // Add footer to last page
  addFooter();
  doc.end();
}

module.exports = { generatePDFReport };
