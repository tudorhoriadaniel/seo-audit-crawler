// Keyword clustering for the Content Strategy tab.
//
// Two modes:
//   1. GSC mode — cluster the real Search Console queries semantically and
//      assign each cluster to the URL that should own it.
//   2. Content mode (no GSC) — infer a content strategy from the crawl
//      itself: the top ~50 pages a visitor can actually reach in a few
//      clicks, with target keywords derived from each page's content.
//
// Both prefer Claude (structured output) and fall back to a heuristic
// grouping when no ANTHROPIC_API_KEY is configured or the API call fails.

const MODEL = 'claude-opus-5';
const MAX_GSC_KEYWORDS = 400;    // keep the prompt bounded
const MAX_CONTENT_PAGES = 50;    // "top 50 discoverable pages"
const MAX_PAGE_DEPTH = 3;        // "a few clicks from the homepage"

// ── Shared helpers ───────────────────────────────────────────────────────────

function normaliseUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    let path = url.pathname.replace(/\/+$/, '') || '/';
    return (url.protocol + '//' + url.host.replace(/^www\./, '') + path).toLowerCase();
  } catch { return null; }
}

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}

// Ask Claude for structured JSON; falls back to prompt-embedded schema when
// structured outputs are unavailable (same pattern as genai-analyzer).
async function askClaude(client, prompt, schema, maxTokens) {
  const req = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  };
  let resp;
  try {
    resp = await client.messages.create({
      ...req,
      output_config: { format: { type: 'json_schema', schema } }
    });
  } catch (e) {
    if (e.status !== 400) throw e;
    resp = await client.messages.create({
      ...req,
      messages: [{ role: 'user', content: prompt + '\n\nRespond with ONLY a valid JSON object matching this schema, no markdown fences:\n' + JSON.stringify(schema) }]
    });
  }
  if (resp.stop_reason === 'refusal') throw new Error('Claude declined to analyze this content');
  const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Could not parse cluster response');
  }
}

// ── GSC keyword clustering ───────────────────────────────────────────────────

const GSC_CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short human-readable cluster name in the keywords\' own language' },
          intent: { type: 'string', enum: ['informational', 'transactional', 'navigational', 'local', 'mixed'] },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Exact keyword strings from the input, verbatim' },
          assignedUrl: { type: 'string', description: 'The existing URL best suited to own this cluster, or empty string if a new page is needed' },
          action: { type: 'string', enum: ['optimize', 'expand', 'create-new-page', 'consolidate'] },
          suggestedNewUrl: { type: 'string', description: 'Suggested path for a new landing page when action is create-new-page, else empty string' },
          rationale: { type: 'string', description: '1-2 sentences: why this grouping/URL/action' }
        },
        required: ['name', 'intent', 'keywords', 'assignedUrl', 'action', 'rationale']
      }
    }
  },
  required: ['clusters']
};

// rows: [{ query, page, impressions, clicks, position }]
async function clusterGscKeywords(client, { siteUrl, rows }) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows is required');

  // Aggregate per query (a query can rank with several pages): total
  // impressions/clicks across pages, best position, and the strongest page.
  const byQuery = new Map();
  for (const r of rows) {
    if (!r || !r.query) continue;
    let q = byQuery.get(r.query);
    if (!q) { q = { query: r.query, impressions: 0, clicks: 0, bestPosition: Infinity, pages: [] }; byQuery.set(r.query, q); }
    q.impressions += r.impressions || 0;
    q.clicks += r.clicks || 0;
    if ((r.position || Infinity) < q.bestPosition) q.bestPosition = r.position;
    q.pages.push({ page: r.page, impressions: r.impressions || 0, position: r.position || 0 });
  }
  const queries = [...byQuery.values()]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, MAX_GSC_KEYWORDS);
  for (const q of queries) q.pages.sort((a, b) => b.impressions - a.impressions);

  let raw;
  let source = 'ai';
  if (client) {
    try {
      raw = await askClaude(client, buildGscPrompt(siteUrl, queries), GSC_CLUSTER_SCHEMA, 16000);
    } catch (e) {
      console.error('GSC keyword clustering via Claude failed, using heuristic:', e.message);
    }
  }
  if (!raw) { raw = heuristicGscClusters(queries); source = 'heuristic'; }

  // Enrich clusters with metrics computed from the real data — never trust
  // the model with arithmetic. Unknown keyword strings are dropped.
  const clusters = [];
  const assigned = new Set();
  for (const c of raw.clusters || []) {
    const kws = [];
    for (const k of c.keywords || []) {
      const q = byQuery.get(k);
      if (!q || assigned.has(k)) continue;
      assigned.add(k);
      kws.push({
        query: q.query,
        impressions: q.impressions,
        clicks: q.clicks,
        bestPosition: q.bestPosition === Infinity ? null : Math.round(q.bestPosition * 10) / 10,
        topPage: q.pages[0] ? q.pages[0].page : null
      });
    }
    if (!kws.length) continue;
    kws.sort((a, b) => b.impressions - a.impressions);
    const totalImpr = kws.reduce((s, k) => s + k.impressions, 0);
    clusters.push({
      name: c.name || kws[0].query,
      intent: c.intent || 'mixed',
      keywords: kws,
      assignedUrl: c.assignedUrl || null,
      action: c.action || 'optimize',
      suggestedNewUrl: c.suggestedNewUrl || null,
      rationale: c.rationale || '',
      totalImpressions: totalImpr,
      totalClicks: kws.reduce((s, k) => s + k.clicks, 0)
    });
  }
  // Any keyword the model forgot goes into a catch-all cluster so nothing
  // silently disappears.
  const leftovers = queries.filter(q => !assigned.has(q.query));
  if (leftovers.length) {
    clusters.push({
      name: 'Unclustered',
      intent: 'mixed',
      keywords: leftovers.map(q => ({
        query: q.query, impressions: q.impressions, clicks: q.clicks,
        bestPosition: q.bestPosition === Infinity ? null : Math.round(q.bestPosition * 10) / 10,
        topPage: q.pages[0] ? q.pages[0].page : null
      })),
      assignedUrl: null, action: 'optimize', suggestedNewUrl: null,
      rationale: 'Keywords that did not fit any cluster.',
      totalImpressions: leftovers.reduce((s, q) => s + q.impressions, 0),
      totalClicks: leftovers.reduce((s, q) => s + q.clicks, 0)
    });
  }
  clusters.sort((a, b) => b.totalImpressions - a.totalImpressions);
  return { source, clusters, keywordCount: queries.length, truncated: byQuery.size > queries.length };
}

function buildGscPrompt(siteUrl, queries) {
  const lines = queries.map(q => {
    const top = q.pages[0];
    return `${q.query}\t${q.impressions} impr\tpos ${q.bestPosition === Infinity ? '?' : q.bestPosition.toFixed(1)}\t${top ? top.page : '-'}`;
  }).join('\n');
  return `You are an SEO strategist. Below are real Google Search Console queries for the site ${siteUrl}, one per line as: query <TAB> impressions <TAB> best position <TAB> strongest ranking URL.

Group them into semantic keyword clusters BY TOPIC AND SEARCH INTENT (synonyms, reformulations, and translations of the same need belong together — e.g. "avocat divorce" and "avocat séparation"). Keywords may be in French, German, Italian or English; keep clusters language-consistent when the site has language sections.

For each cluster decide which SINGLE existing URL should own it — normally the URL already ranking strongest for the cluster's highest-volume keywords. Two clusters should only share an assignedUrl if they genuinely belong on the same page.

Choose an action per cluster:
- "optimize": the assigned URL is the right topic match; on-page refinement is enough.
- "expand": the assigned URL only partially covers the cluster; it needs new sections/content.
- "create-new-page": no existing URL is a good match — set assignedUrl to "" and propose suggestedNewUrl (a path following the site's existing URL patterns).
- "consolidate": several URLs compete for this cluster (cannibalization); name the one to keep in assignedUrl and say what to merge in the rationale.

Every input keyword must appear in exactly one cluster, verbatim. Prefer 5-25 focused clusters over 100 tiny ones. Write cluster names in the keywords' own language; rationale in English.

Keywords:
${lines}`;
}

// Fallback: group queries by their strongest ranking URL.
function heuristicGscClusters(queries) {
  const byUrl = new Map();
  for (const q of queries) {
    const url = q.pages[0] ? q.pages[0].page : '(no page)';
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(q.query);
  }
  const clusters = [];
  for (const [url, kws] of byUrl) {
    let name = url;
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      name = parts.length ? decodeURIComponent(parts[parts.length - 1]).replace(/[-_]/g, ' ') : 'Homepage';
    } catch { /* keep url */ }
    clusters.push({
      name, intent: 'mixed', keywords: kws, assignedUrl: url === '(no page)' ? '' : url,
      action: 'optimize', suggestedNewUrl: '',
      rationale: 'Grouped by strongest ranking URL (heuristic — no AI key configured).'
    });
  }
  return { clusters };
}

// ── Content-based strategy (no GSC) ─────────────────────────────────────────

// Pick the top discoverable pages from a crawl: indexable HTML pages within
// MAX_PAGE_DEPTH clicks, ranked by how many other discoverable pages link to
// them (then by shallowness, then by content depth). Deep/orphan URLs that a
// visitor would never find are excluded by construction.
function selectTopPages(pageRows) {
  const candidates = [];
  const inbound = new Map();   // normalised URL → count of internal links to it

  for (const p of pageRows) {
    // Count links FROM every fetched discoverable page, even ones that don't
    // qualify as candidates themselves.
    const links = safeParse(p.links, []);
    if (Array.isArray(links)) {
      const seen = new Set();
      for (const l of links) {
        if (!l || !l.isInternal || !l.href) continue;
        const norm = normaliseUrl(l.href);
        if (!norm || seen.has(norm)) continue;   // count each target once per source page
        seen.add(norm);
        inbound.set(norm, (inbound.get(norm) || 0) + 1);
      }
    }

    if (p.status_code !== 200) continue;
    if (p.error || p.blocked_by_robots) continue;
    if (p.content_type && !/html/i.test(p.content_type)) continue;
    const robots = `${p.meta_robots || ''} ${p.x_robots_tag || ''}`.toLowerCase();
    if (robots.includes('noindex')) continue;
    if (p.depth > MAX_PAGE_DEPTH) continue;
    // A page canonicalised elsewhere shouldn't be a strategy target.
    if (p.canonical && p.canonical_is_self === 0) continue;
    candidates.push(p);
  }

  // Dedupe by normalised URL (http/https + www variants collapse).
  const byNorm = new Map();
  for (const p of candidates) {
    const norm = normaliseUrl(p.final_url || p.url) || p.url;
    const prev = byNorm.get(norm);
    if (!prev || p.depth < prev.depth) byNorm.set(norm, p);
  }

  const ranked = [...byNorm.entries()].map(([norm, p]) => ({
    page: p,
    inbound: inbound.get(norm) || 0
  }));
  ranked.sort((a, b) => {
    if (b.inbound !== a.inbound) return b.inbound - a.inbound;
    if (a.page.depth !== b.page.depth) return a.page.depth - b.page.depth;
    return (b.page.word_count || 0) - (a.page.word_count || 0);
  });

  return ranked.slice(0, MAX_CONTENT_PAGES).map(({ page: p, inbound: n }) => ({
    url: p.final_url || p.url,
    depth: p.depth,
    inboundLinks: n,
    title: p.title || '',
    metaDescription: p.meta_description || '',
    h1: (safeParse(p.h1, []) || []).slice(0, 3),
    headings: (safeParse(p.heading_structure, []) || [])
      .filter(h => h && h.level >= 2 && h.level <= 3 && h.text)
      .slice(0, 12)
      .map(h => `H${h.level}: ${h.text}`),
    wordCount: p.word_count || 0
  }));
}

const CONTENT_STRATEGY_SCHEMA = {
  type: 'object',
  properties: {
    siteSummary: { type: 'string', description: '2-3 sentences: what this site is about and its main content themes' },
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          pageUrls: { type: 'array', items: { type: 'string' } },
          targetKeywords: { type: 'array', items: { type: 'string' } }
        },
        required: ['name', 'description', 'pageUrls', 'targetKeywords']
      }
    },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          cluster: { type: 'string', description: 'Name of the cluster this page belongs to' },
          targetKeywords: { type: 'array', items: { type: 'string' }, description: '2-5 keywords this page should target, in the page\'s own language' },
          action: { type: 'string', enum: ['optimize', 'expand', 'merge', 'keep'] },
          recommendation: { type: 'string', description: '1-2 concrete sentences referencing this page\'s actual title/headings' }
        },
        required: ['url', 'cluster', 'targetKeywords', 'action', 'recommendation']
      }
    },
    contentGaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          suggestedTitle: { type: 'string' },
          suggestedUrl: { type: 'string', description: 'A path following the site\'s existing URL patterns' },
          targetKeywords: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' }
        },
        required: ['topic', 'suggestedTitle', 'suggestedUrl', 'targetKeywords', 'why']
      }
    }
  },
  required: ['siteSummary', 'clusters', 'pages', 'contentGaps']
};

// pages: output of selectTopPages()
async function buildContentStrategy(client, { siteUrl, pages }) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('No eligible pages — run a crawl first');

  let raw;
  let source = 'ai';
  if (client) {
    try {
      raw = await askClaude(client, buildContentPrompt(siteUrl, pages), CONTENT_STRATEGY_SCHEMA, 20000);
    } catch (e) {
      console.error('Content strategy via Claude failed, using heuristic:', e.message);
    }
  }
  if (!raw) { raw = heuristicContentStrategy(pages); source = 'heuristic'; }

  // Join model output back onto the real page list; every selected page gets
  // a row even if the model skipped it.
  const byUrl = new Map();
  for (const pr of raw.pages || []) {
    if (pr && pr.url) byUrl.set(normaliseUrl(pr.url) || pr.url, pr);
  }
  const pageRows = pages.map(p => {
    const norm = normaliseUrl(p.url) || p.url;
    const m = byUrl.get(norm) || {};
    return {
      url: p.url,
      depth: p.depth,
      inboundLinks: p.inboundLinks,
      wordCount: p.wordCount,
      title: p.title,
      cluster: m.cluster || null,
      targetKeywords: Array.isArray(m.targetKeywords) ? m.targetKeywords : [],
      action: m.action || 'keep',
      recommendation: m.recommendation || ''
    };
  });

  return {
    source,
    siteSummary: raw.siteSummary || '',
    clusters: (raw.clusters || []).map(c => ({
      name: c.name, description: c.description || '',
      pageUrls: Array.isArray(c.pageUrls) ? c.pageUrls : [],
      targetKeywords: Array.isArray(c.targetKeywords) ? c.targetKeywords : []
    })),
    pages: pageRows,
    contentGaps: raw.contentGaps || [],
    pageCount: pages.length
  };
}

function buildContentPrompt(siteUrl, pages) {
  const blocks = pages.map((p, i) => {
    const parts = [
      `[${i + 1}] ${p.url}`,
      `depth ${p.depth} · ${p.inboundLinks} internal links in · ${p.wordCount} words`,
      `title: ${p.title || '(none)'}`
    ];
    if (p.h1 && p.h1.length) parts.push(`h1: ${p.h1.join(' | ')}`);
    if (p.metaDescription) parts.push(`meta: ${p.metaDescription.slice(0, 160)}`);
    if (p.headings && p.headings.length) parts.push(p.headings.join('\n'));
    return parts.join('\n');
  }).join('\n\n');

  return `You are an SEO content strategist. No Search Console data is available for ${siteUrl || 'this site'}, so build a content strategy from the site's own structure. Below are its ${pages.length} most discoverable pages (within ${MAX_PAGE_DEPTH} clicks of the homepage, ranked by internal links pointing at them), each with URL, crawl signals, title, H1, meta description, and H2/H3 outline.

Produce:
1. siteSummary — what the site is about.
2. clusters — group these pages into topic clusters (typically 3-10). Each cluster: name (in the site's language), what it covers, its pageUrls (from the list, verbatim), and 3-8 targetKeywords the cluster should collectively own.
3. pages — for EVERY page listed: its cluster, 2-5 targetKeywords in the page's own language (infer language from URL path and title), an action, and a concrete recommendation referencing the page's actual title/headings:
   - "optimize": right topic, weak execution (thin/generic title, missing keyword in H1, shallow outline).
   - "expand": topic deserves substantially more content/sections.
   - "merge": overlaps so much with another listed page that they cannibalize — name the page to merge into.
   - "keep": already well-targeted; no meaningful SEO work needed.
4. contentGaps — 3-8 pages the site should create: topics its clusters imply but no page covers. Follow the site's existing URL patterns for suggestedUrl.

Write cluster names, keywords, and suggested titles in the site's own language; recommendations and descriptions in English.

Pages:
${blocks}`;
}

// Fallback: cluster by first path segment, keywords from title/H1 tokens.
function heuristicContentStrategy(pages) {
  const STOP = new Set(['de','du','le','la','les','un','une','des','et','en','au','aux','the','of','and','or','for','to','in','on','with','at','der','die','das','und','von','zu','bei','mit','im','am','your','our','my']);
  const tokens = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));

  const groups = new Map();
  const pageRows = pages.map(p => {
    let seg = 'general';
    try {
      const parts = new URL(p.url).pathname.split('/').filter(Boolean);
      if (parts.length) seg = parts[0];
    } catch { /* keep general */ }
    if (!groups.has(seg)) groups.set(seg, []);
    groups.get(seg).push(p.url);
    const kw = [...new Set([...tokens(p.title), ...tokens((p.h1 || []).join(' '))])].slice(0, 5);
    return {
      url: p.url, cluster: seg, targetKeywords: kw, action: 'optimize',
      recommendation: 'Heuristic grouping (no AI key configured) — review title and headings against the target keywords.'
    };
  });

  return {
    siteSummary: 'Heuristic strategy — connect an Anthropic API key for AI-powered clustering.',
    clusters: [...groups.entries()].map(([name, urls]) => ({
      name: name.replace(/[-_]/g, ' '), description: 'Pages sharing the /' + name + ' path segment.',
      pageUrls: urls, targetKeywords: []
    })),
    pages: pageRows,
    contentGaps: []
  };
}

module.exports = { clusterGscKeywords, selectTopPages, buildContentStrategy, MAX_CONTENT_PAGES, MAX_PAGE_DEPTH };
