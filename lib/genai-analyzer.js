// GenAI Performance — parse Google Search Console's "Generative AI features"
// export (pages + impressions in AI Overviews / AI Mode; GSC hides the
// queries), then predict likely queries and generate content-improvement
// suggestions for low-impression pages using Claude + crawl data + the page's
// regular-search GSC queries.
const Anthropic = require('@anthropic-ai/sdk');

// ── Report parsing ───────────────────────────────────────────────────────────

// Split one CSV line honoring double quotes ("12,065" stays one cell).
function splitCsvLine(line) {
  const cells = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// "12,065" / "12'065" / "12 065" / 12065 → 12065
function parseCount(v) {
  const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function rowsFromTable(rows) {
  // rows: array of arrays. Find URL column (values starting with http) and
  // impressions column (header matching /impression/i, else first numeric col
  // that isn't the URL col).
  if (!rows.length) return [];
  const header = rows[0].map(c => String(c).trim().toLowerCase());
  let urlIdx = header.findIndex(h => /^(top pages|pages?|url|address)$/.test(h));
  let impIdx = header.findIndex(h => /impression/.test(h));
  let body = rows;
  if (urlIdx >= 0 || impIdx >= 0) body = rows.slice(1);
  if (urlIdx < 0) {
    const probe = body.find(r => r.some(c => /^https?:\/\//i.test(String(c))));
    urlIdx = probe ? probe.findIndex(c => /^https?:\/\//i.test(String(c))) : 0;
  }
  if (impIdx < 0) {
    const probe = body.find(r => r.length > 1);
    if (probe) impIdx = probe.findIndex((c, i) => i !== urlIdx && parseCount(c) != null);
  }
  const out = [];
  for (const r of body) {
    const url = String(r[urlIdx] || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ url, impressions: impIdx >= 0 ? (parseCount(r[impIdx]) ?? 0) : 0 });
  }
  return out;
}

// Parse an uploaded GSC export (xlsx: pick the sheet that has URLs; csv: single
// table). Returns [{url, impressions}] sorted by impressions desc.
function parseReportFile(buf, type) {
  let rows = [];
  if (type === 'xlsx' || type === 'xls') {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    // Prefer a sheet named like "Pages"; else first sheet containing URLs
    const names = [...wb.SheetNames].sort((a, b) => (/page/i.test(b) ? 1 : 0) - (/page/i.test(a) ? 1 : 0));
    for (const name of names) {
      const table = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      rows = rowsFromTable(table);
      if (rows.length) break;
    }
  } else {
    const text = buf.toString('utf8');
    const table = text.split(/\r?\n/).filter(l => l.trim()).map(splitCsvLine);
    rows = rowsFromTable(table);
  }
  return dedupeRows(rows);
}

// Parse pasted text: any line containing a URL; impressions = last number on
// the line (handles "https://a.com/x    12,065" copied straight from GSC).
function parsePastedReport(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const urlMatch = line.match(/https?:\/\/[^\s"',;]+/);
    if (!urlMatch) continue;
    const rest = line.replace(urlMatch[0], ' ');
    const nums = rest.match(/[\d][\d.,'’  ]*/g);
    const imp = nums ? parseCount(nums[nums.length - 1]) : null;
    rows.push({ url: urlMatch[0], impressions: imp ?? 0 });
  }
  return dedupeRows(rows);
}

function dedupeRows(rows) {
  const byUrl = new Map();
  for (const r of rows) {
    if (!byUrl.has(r.url) || byUrl.get(r.url).impressions < r.impressions) byUrl.set(r.url, r);
  }
  return [...byUrl.values()].sort((a, b) => b.impressions - a.impressions);
}

// ── Claude analysis ──────────────────────────────────────────────────────────

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pages', 'winnersInsight', 'overallRecommendations'],
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'predictedQueries', 'whyLowVisibility', 'suggestions'],
        properties: {
          url: { type: 'string' },
          predictedQueries: { type: 'array', items: { type: 'string' } },
          whyLowVisibility: { type: 'string' },
          suggestions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'detail'],
              properties: { title: { type: 'string' }, detail: { type: 'string' } }
            }
          }
        }
      }
    },
    winnersInsight: { type: 'string' },
    overallRecommendations: { type: 'array', items: { type: 'string' } }
  }
};

function pageBrief(p) {
  const g = p.geoSignals || {};
  return {
    url: p.url,
    impressions: p.impressions,
    title: p.title || null,
    h1: p.h1 || null,
    metaDescription: p.metaDescription || null,
    language: p.htmlLang || null,
    wordCount: p.wordCount ?? null,
    headings: (p.headings || []).slice(0, 15),
    contentSignals: p.geoSignals ? {
      questionHeadings: g.questionHeadings,
      firstParagraphWords: g.firstParagraphWords,
      lists: g.lists, tables: g.tables, blockquotes: g.blockquotes,
      longParagraphs: g.longParagraphs, paragraphs: g.paragraphs,
      statsPer1000Words: g.numbersPer1000Words,
      hasDates: !!(g.schema && (g.schema.datePublished || g.schema.dateModified)),
      hasAuthorSchema: !!(g.schema && g.schema.hasAuthor)
    } : null,
    topSearchQueries: (p.gscQueries || []).slice(0, 12)
  };
}

// One Claude call for the whole batch. `lowPages`/`topPages` carry crawl data
// merged in by the caller; anything missing is passed as null and Claude works
// from the URL alone.
async function analyzeWithClaude(apiKey, domain, topPages, lowPages) {
  const client = new Anthropic({ apiKey, timeout: 600000 });

  const prompt = `You are an expert in Generative Engine Optimization (GEO) — getting pages shown and cited in Google AI Overviews / AI Mode.

Google Search Console's "Generative AI features" report shows which pages of ${domain} got impressions inside Google's generative AI experiences, but hides the queries. Below are the site's TOP performers and its LOW performers from that report, with each page's crawled content signals and (when available) its regular Google Search queries — the strongest hint at what the page can appear for in AI answers.

TOP PERFORMERS (high impressions in generative AI):
${JSON.stringify(topPages.map(pageBrief), null, 1)}

LOW PERFORMERS (little generative-AI visibility — analyze each of these):
${JSON.stringify(lowPages.map(pageBrief), null, 1)}

For EACH low performer produce:
1. "predictedQueries": 4-8 realistic queries/questions users likely ask Google's AI where this page could or should appear. Write them in the page's own language (infer from URL path and title — e.g. /fr/ pages get French queries, /de/ pages German). Ground them in the page's real GSC queries when provided.
2. "whyLowVisibility": 1-3 sentences on the most likely reason this page underperforms in generative AI compared to the top performers (content structure? no direct answers? topic intent? cannibalization by a stronger page?).
3. "suggestions": 3-6 concrete, actionable content edits to make the page more citable by generative AI — e.g. add a 40-70 word direct-answer paragraph under the H1 answering a specific predicted query, add question-phrased H2s, add a comparison table or step list, add concrete statistics with sources, add FAQ schema. Each suggestion: short "title" + specific "detail" that references THIS page's actual content and predicted queries (not generic advice).

Also produce:
- "winnersInsight": 2-4 sentences on what the top performers have in common that the low performers lack.
- "overallRecommendations": 3-5 site-wide actions for ${domain} to grow generative-AI visibility.

Write all analysis text (whyLowVisibility, suggestions, insights) in English; only predictedQueries follow the page language.`;

  const req = {
    model: 'claude-opus-5',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }]
  };

  let resp;
  try {
    resp = await client.messages.create({
      ...req,
      output_config: { format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } }
    });
  } catch (e) {
    // Structured outputs unavailable (older API surface / validation issue) —
    // fall back to plain JSON prompting.
    if (e.status !== 400) throw e;
    resp = await client.messages.create({
      ...req,
      messages: [{ role: 'user', content: prompt + '\n\nRespond with ONLY a valid JSON object matching this schema, no markdown fences:\n' + JSON.stringify(ANALYSIS_SCHEMA) }]
    });
  }

  if (resp.stop_reason === 'refusal') throw new Error('Claude declined to analyze this content');
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Could not parse analysis response');
  }
}

module.exports = { parseReportFile, parsePastedReport, analyzeWithClaude };
