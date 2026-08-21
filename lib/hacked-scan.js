// Hacked — detect SEO-spam content injection on a (WordPress) site and try to
// name where it came from.
//
// The classic compromise this hunts: a vulnerable plugin lets an attacker plant
// "casino in las vegas" / pharma / replica-goods content, hidden links, cloaked
// doorway pages or malware <script>s into an otherwise normal business site.
// The owner rarely sees it — the spam is often hidden via CSS, served only to
// Googlebot, or buried in hundreds of machine-generated posts.
//
// Reliability model (a blog legitimately covering many topics must NOT trip it):
//   1. A weighted, phrase-first multilingual spam lexicon. Single ambiguous
//      words ("casino" in a Las Vegas travel post) score low; commercial spam
//      phrases ("online casino bonus", "buy viagra without prescription")
//      score high. A page is only flagged past a threshold or when the text
//      signal combines with a structural one (spam outlink, hidden markup).
//   2. Structural signals that legit content never produces: CSS-hidden link
//      blocks, content served to Googlebot but not to browsers (cloaking),
//      obfuscated injected scripts, bursts of gibberish-slug posts, CJK spam
//      titles on a non-CJK site.
//   3. Optional semantic adjudication: when an Anthropic key is configured,
//      every heuristic hit is shown to Claude together with a profile of what
//      the site is actually about, and Claude rules "injected" vs "legitimate
//      content". This is what separates a marketing blog writing ABOUT
//      gambling ads from a hacked page STUFFED with gambling links.
//
// Origin attribution is inference, clearly labelled as such: we enumerate the
// plugins/theme the site exposes (REST namespaces + asset URLs), cross-check a
// curated list of plugins with documented content-injection exploitation, and
// work out WHICH LAYER the spam lives in — the database (REST API returns it),
// render-time PHP (HTML has it, REST doesn't), or a cloaking layer (only bots
// get it). Layer + plugin evidence together produce ranked origin candidates.

const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const { normalizeSite, htmlToText, BROWSER_UA } = require('./wp-rest');

const HTTP_TIMEOUT = 20000;
const GOOGLEBOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/124.0.0.0 Safari/537.36';

// ── Spam lexicon ────────────────────────────────────────────────────────────
// Phrases (weight 3) are near-unambiguous commercial spam. Words (weight 1)
// are only supporting evidence — they never flag a page on their own.
const SPAM_CATEGORIES = [
  {
    id: 'gambling', label: 'Gambling / casino',
    phrases: [
      'online casino', 'casino online', 'casino bonus', 'free spins', 'no deposit bonus',
      'best casino sites', 'casino games online', 'play slots online', 'slot machines online',
      'sports betting site', 'betting sites', 'live casino', 'real money casino',
      'judi online', 'situs judi', 'slot gacor', 'slot online', 'poker online',
      'bandar togel', 'togel online', 'agen bola',
      'オンラインカジノ', 'カジノ ボーナス', '온라인카지노', '카지노사이트', '바카라사이트',
      'онлайн казино', 'казино бонус', 'casino en ligne', 'casino en línea', 'mejores casinos'
    ],
    words: ['casino', 'blackjack', 'roulette', 'jackpot', 'bookmaker', 'baccarat', 'sportsbook']
  },
  {
    id: 'pharma', label: 'Pharma',
    phrases: [
      'buy viagra', 'viagra online', 'cheap viagra', 'buy cialis', 'cialis online',
      'without prescription', 'no prescription needed', 'canadian pharmacy', 'online pharmacy cheap',
      'buy pills online', 'viagra generique', 'comprar viagra', 'viagra kaufen'
    ],
    words: ['viagra', 'cialis', 'levitra', 'tadalafil', 'sildenafil', 'kamagra', 'tramadol', 'xanax', 'ambien']
  },
  {
    id: 'adult', label: 'Adult / escort',
    phrases: ['escort service', 'escort girls', 'call girls', 'sex cam', 'live sex', 'porn videos', 'xxx videos', 'onlyfans leaked'],
    words: ['escorts', 'porn', 'xxx']
  },
  {
    id: 'replica', label: 'Replica / counterfeit goods',
    phrases: [
      'replica watches', 'replica handbags', 'replica bags', 'fake rolex',
      'louis vuitton outlet', 'michael kors outlet', 'ray ban outlet', 'gucci outlet online',
      'cheap jerseys', 'nfl jerseys cheap', 'cheap nfl jerseys', 'ugg boots sale', 'cheap jordans'
    ],
    words: []
  },
  {
    id: 'essay', label: 'Essay mills',
    phrases: ['essay writing service', 'buy essay', 'write my essay', 'write my paper', 'custom essay', 'dissertation writing service', 'term paper writing'],
    words: []
  },
  {
    id: 'loans', label: 'Payday loans',
    phrases: ['payday loan', 'payday loans', 'cash advance online', 'instant loan approval', 'quick cash loans', 'bad credit loans guaranteed'],
    words: []
  },
  {
    id: 'piracy', label: 'Piracy / cracks',
    phrases: ['free download crack', 'serial keygen', 'nulled plugin', 'nulled theme', 'license key generator', 'activation key free'],
    words: ['keygen']
  },
  {
    id: 'linkspam', label: 'Link-scheme spam',
    phrases: ['buy backlinks', 'cheap backlinks', 'high pr backlinks', 'dofollow backlinks cheap'],
    words: []
  }
];

// Precompile per-category matchers. \b works for latin; CJK/Cyrillic phrases
// are matched as plain substrings (no word boundaries in those scripts).
const NEEDS_BOUNDARY = /^[\x00-\x7F]+$/;
function compileTerm(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return NEEDS_BOUNDARY.test(term)
    ? new RegExp(`\\b${escaped.replace(/\s+/g, '\\s+')}\\b`, 'gi')
    : new RegExp(escaped, 'gi');
}
const MATCHERS = SPAM_CATEGORIES.map(c => ({
  id: c.id, label: c.label,
  phrases: c.phrases.map(p => ({ term: p, re: compileTerm(p) })),
  words: c.words.map(w => ({ term: w, re: compileTerm(w) }))
}));

// Score a chunk of text. Returns { score, hits:[{category,term,count,weight}] }.
// Repeats count (spam is stuffed), but with diminishing returns so one page
// can't blow up the numbers into the thousands.
function spamScore(text) {
  if (!text) return { score: 0, hits: [] };
  const hits = [];
  let score = 0;
  for (const cat of MATCHERS) {
    for (const { term, re } of cat.phrases) {
      re.lastIndex = 0;
      const count = (text.match(re) || []).length;
      if (count) {
        const s = 3 + Math.min(count - 1, 5);        // 3 for first, +1 per repeat up to 8
        hits.push({ category: cat.id, categoryLabel: cat.label, term, count, weight: s });
        score += s;
      }
    }
    for (const { term, re } of cat.words) {
      re.lastIndex = 0;
      const count = (text.match(re) || []).length;
      if (count) {
        const s = 1 + Math.min(Math.floor(count / 3), 2); // words need repetition to matter
        hits.push({ category: cat.id, categoryLabel: cat.label, term, count, weight: s });
        score += s;
      }
    }
  }
  return { score, hits };
}

function hitCategories(hits) {
  return [...new Set(hits.map(h => h.categoryLabel))];
}

// A short excerpt around the first strong hit — the evidence a human needs to
// see to believe the finding.
function excerptAround(text, hits, len = 240) {
  if (!hits.length) return '';
  const best = [...hits].sort((a, b) => b.weight - a.weight)[0];
  const idx = text.toLowerCase().indexOf(best.term.toLowerCase());
  if (idx < 0) return text.slice(0, len);
  const start = Math.max(0, idx - Math.floor(len / 3));
  return (start > 0 ? '…' : '') + text.slice(start, start + len).trim() + '…';
}

// ── Structural detectors ────────────────────────────────────────────────────

const HIDDEN_STYLE_RE = /display\s*:\s*none|visibility\s*:\s*hidden|text-indent\s*:\s*-\d{3,}|position\s*:\s*(absolute|fixed)\s*;[^"']*(left|top)\s*:\s*-\d{3,}|height\s*:\s*0(px)?\s*;[^"']*overflow\s*:\s*hidden|opacity\s*:\s*0(\.0+)?\s*[;"']|font-size\s*:\s*0/i;

// Elements page builders/themes legitimately hide (menus, modals, sliders).
// A hidden block only matters when it holds outbound links or spam text.
function findHiddenSpam($, pageHost) {
  const findings = [];
  $('[style]').each((_, el) => {
    const style = String($(el).attr('style') || '');
    if (!HIDDEN_STYLE_RE.test(style)) return;
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    const links = $el.find('a[href^="http"]').toArray()
      .map(a => { try { return new URL($(a).attr('href')); } catch { return null; } })
      .filter(u => u && u.host !== pageHost);
    if (!text && links.length === 0) return;
    const { score, hits } = spamScore(text + ' ' + links.map(u => u.href).join(' '));
    if (score >= 3 || (links.length >= 3 && text.length > 40)) {
      findings.push({
        style: style.slice(0, 120),
        text: text.slice(0, 300),
        externalLinks: links.slice(0, 10).map(u => u.href),
        spam: { score, categories: hitCategories(hits) }
      });
    }
  });
  return findings;
}

// External links whose target URL or anchor text is spammy. Legit sites link
// out constantly — only the combination (external + spam terms) is a signal.
function findSpamLinks($, pageHost) {
  const out = [];
  $('a[href^="http"]').each((_, a) => {
    let u;
    try { u = new URL($(a).attr('href')); } catch { return; }
    if (u.host === pageHost || u.host.endsWith('.' + pageHost)) return;
    const anchor = $(a).text().replace(/\s+/g, ' ').trim();
    const { score, hits } = spamScore(anchor + ' ' + decodeURIComponent(u.pathname + u.search).replace(/[-_/+]/g, ' ') + ' ' + u.host.replace(/[-.]/g, ' '));
    if (score >= 3) out.push({ href: u.href.slice(0, 200), anchor: anchor.slice(0, 120), categories: hitCategories(hits), score });
  });
  return out;
}

// Script analysis: obfuscated inline payloads and third-party sources on
// throwaway TLDs. Both are heuristics — reported as "suspicious", not proof.
const OBFUSCATION_RE = /eval\s*\(\s*(atob|unescape|window\.atob)|document\.write\s*\(\s*unescape|String\.fromCharCode\s*\((?:\s*\d+\s*,){30,}|(?:\\x[0-9a-f]{2}){40,}/i;
const THROWAWAY_TLD_RE = /\.(top|icu|pw|click|gq|tk|ga|cf|cam|rest|su|sbs|cfd|bond|lat)$/i;

function findSuspiciousScripts($, pageHost) {
  const findings = [];
  $('script').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      let u;
      try { u = new URL(src, `https://${pageHost}`); } catch { return; }
      if (u.host === pageHost || u.host.endsWith('.' + pageHost)) return;
      const known = /googleapis|gstatic|googletagmanager|google-analytics|googleadservices|doubleclick|facebook|fbcdn|cloudflare|cloudfront|jsdelivr|unpkg|cdnjs|jquery|wp\.com|wordpress|stripe|hotjar|clarity|linkedin|twitter|x\.com|youtube|vimeo|hubspot|mailchimp|klaviyo|stape|tiktok|pinterest|recaptcha|hcaptcha|matomo|plausible|usercentrics|cookiebot|elfsight|typekit|fontawesome/i;
      if (known.test(u.host)) return;
      if (THROWAWAY_TLD_RE.test(u.host) || /^[a-z0-9]{12,}\./i.test(u.host)) {
        findings.push({ kind: 'external', src: u.href.slice(0, 200), reason: THROWAWAY_TLD_RE.test(u.host) ? `third-party script on a disposable TLD (${u.host})` : `third-party script on a random-looking host (${u.host})` });
      }
    } else {
      const body = $(el).html() || '';
      if (body.length > 20 && OBFUSCATION_RE.test(body)) {
        findings.push({ kind: 'inline', src: null, reason: 'obfuscated inline script (eval/atob/charcode payload)', sample: body.slice(0, 160) });
      }
    }
  });
  return findings;
}

// Gibberish slug: long latin token with almost no vowels, or heavy digit-letter
// interleaving. Spam campaigns machine-generate these by the hundreds.
function looksGibberish(slug) {
  const s = String(slug || '').replace(/\.(html?|php)$/i, '');
  if (s.length < 8 || !/^[a-z0-9-]+$/i.test(s)) return false;
  const tokens = s.split('-').filter(t => t.length >= 6);
  return tokens.some(t => {
    if (/\d/.test(t) && /[a-z]/i.test(t) && t.replace(/[a-z]/gi, '').length >= 3) return true;
    const vowels = (t.match(/[aeiouy]/gi) || []).length;
    return vowels / t.length < 0.15;
  });
}

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchHtml(url, ua) {
  const res = await axios.get(url, {
    timeout: HTTP_TIMEOUT, maxRedirects: 5, responseType: 'text',
    transformResponse: [(d) => d], validateStatus: () => true,
    headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,*/*' }
  });
  return { status: res.status, html: typeof res.data === 'string' ? res.data : '', finalUrl: res.request?.res?.responseUrl || url };
}

async function getJson(url, ua) {
  try {
    const res = await axios.get(url, {
      timeout: HTTP_TIMEOUT, maxRedirects: 5, responseType: 'text',
      transformResponse: [(d) => d], validateStatus: () => true,
      headers: { 'User-Agent': ua, Accept: 'application/json, */*' }
    });
    if (typeof res.data !== 'string') return { status: res.status, json: null, headers: res.headers };
    try { return { status: res.status, json: JSON.parse(res.data), headers: res.headers }; }
    catch { return { status: res.status, json: null, headers: res.headers }; }
  } catch (e) {
    return { status: 0, json: null, headers: {}, error: e.message };
  }
}

// ── REST content collection ─────────────────────────────────────────────────
// Unlike the AI-visibility scan we keep the TEXT of each item, because the
// whole point is reading what's inside. Budgeted the same way.
async function collectRestItems(restRoot, maxItems, onProgress) {
  const { json: typesJson } = await getJson(restRoot + 'wp/v2/types', BROWSER_UA);
  if (!typesJson || typeof typesJson !== 'object') return { available: false, items: [], types: [] };

  const SKIP = new Set(['attachment', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part', 'wp_navigation', 'wp_global_styles', 'wp_font_family', 'wp_font_face']);
  const types = Object.entries(typesJson)
    .filter(([slug, t]) => !SKIP.has(slug) && (t?.rest_namespace || 'wp/v2') === 'wp/v2')
    .map(([slug, t]) => ({ slug, restBase: t?.rest_base || slug, label: t?.name || slug }));

  const items = [];
  const budget = { left: maxItems };
  const limit = pLimit(3);
  await Promise.all(types.map(t => limit(async () => {
    let page = 1, totalPages = 1;
    while (page <= totalPages && budget.left > 0) {
      const url = `${restRoot}wp/v2/${t.restBase}?per_page=100&page=${page}&_fields=id,slug,link,type,date,modified,title,content,excerpt`;
      const { status, json, headers } = await getJson(url, BROWSER_UA);
      if (!Array.isArray(json)) break;
      if (json.length === 0) break;
      for (const it of json) {
        if (budget.left <= 0) break;
        budget.left--;
        const text = htmlToText(it?.content?.rendered || '');
        items.push({
          id: it.id, type: t.slug, slug: it.slug || '', link: it.link || '',
          date: it.date || null, modified: it.modified || null,
          title: htmlToText(it?.title?.rendered || ''),
          text, rawHtml: String(it?.content?.rendered || '').slice(0, 400000)
        });
      }
      totalPages = parseInt(headers?.['x-wp-totalpages'], 10) || 1;
      page++;
      onProgress?.(`Reading REST content… ${items.length} items`);
    }
  })));
  return { available: true, items, types };
}

async function discoverRestRoot(site) {
  const fallback = site.replace(/\/+$/, '') + '/wp-json/';
  try {
    const { html, status } = await fetchHtml(site, BROWSER_UA);
    if (status >= 200 && status < 400) {
      const m = html.match(/<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]*href=["']([^"']+)["']/i)
        || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']https:\/\/api\.w\.org\/["']/i);
      if (m && m[1]) return m[1].endsWith('/') ? m[1] : m[1] + '/';
    }
  } catch { /* fall through */ }
  return fallback;
}

// Sitemap fallback for sites whose REST API is closed.
async function collectSitemapUrls(site, cap = 300) {
  const roots = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];
  const urls = new Set();
  for (const p of roots) {
    if (urls.size >= cap) break;
    try {
      const { status, html } = await fetchHtml(site + p, BROWSER_UA);
      if (status !== 200 || !/<(urlset|sitemapindex)/i.test(html)) continue;
      const locs = [...html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
      const childMaps = /<sitemapindex/i.test(html) ? locs.slice(0, 10) : [];
      for (const u of (childMaps.length ? [] : locs)) urls.add(u);
      for (const child of childMaps) {
        if (urls.size >= cap) break;
        try {
          const c = await fetchHtml(child, BROWSER_UA);
          for (const m of c.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
            urls.add(m[1]);
            if (urls.size >= cap) break;
          }
        } catch { /* skip child */ }
      }
      if (urls.size) break;
    } catch { /* try next root */ }
  }
  return [...urls];
}

// ── Origin attribution ──────────────────────────────────────────────────────
// Plugins with well-documented exploitation used for spam/content injection.
// This is a curated shortlist, not a CVE database — presence of one of these
// plus matching injection evidence raises it to a named origin CANDIDATE.
const ABUSED_PLUGINS = [
  { slug: 'popup-builder', name: 'Popup Builder', note: 'CVE-2023-6000 — mass-exploited by the Balada Injector campaign to inject scripts and spam into pages.' },
  { slug: 'wp-automatic', name: 'WP Automatic', note: 'CVE-2024-27956 — SQL injection used to create admin users and publish spam posts in bulk.' },
  { slug: 'wp-file-manager', name: 'File Manager', note: 'CVE-2020-25213 — unauthenticated file upload/RCE, widely used to drop spam-injecting backdoors.' },
  { slug: 'tatsu', name: 'Tatsu Builder', note: 'CVE-2021-25094 — unauthenticated RCE exploited to plant malware and spam.' },
  { slug: 'kaswara', name: 'Kaswara Modern VC Addons', note: 'CVE-2021-24284 — abandoned plugin, unauthenticated upload, heavily abused for redirects/spam.' },
  { slug: 'wp-gdpr-compliance', name: 'WP GDPR Compliance', note: '2018 privilege-escalation wave used to create rogue admins and inject content.' },
  { slug: 'essential-addons-for-elementor-lite', name: 'Essential Addons for Elementor', note: 'CVE-2023-32243 — password-reset flaw enabling account takeover.' },
  { slug: 'royal-elementor-addons', name: 'Royal Elementor Addons', note: 'CVE-2023-5360 — unauthenticated upload, mass-exploited late 2023.' },
  { slug: 'litespeed-cache', name: 'LiteSpeed Cache', note: 'CVE-2024-28000 — privilege escalation allowing rogue admin creation (patched in 6.4).' },
  { slug: 'wp-fastest-cache', name: 'WP Fastest Cache', note: 'CVE-2023-6063 — SQL injection.' },
  { slug: 'td-composer', name: 'tagDiv Composer (Newspaper theme)', note: 'XSS exploited by Balada Injector to inject scripts sitewide.' },
  { slug: 'ultimate-member', name: 'Ultimate Member', note: 'CVE-2023-3460 — privilege escalation used to register rogue admins.' },
  { slug: 'wp-statistics', name: 'WP Statistics', note: 'Multiple SQL injections (e.g. CVE-2022-4230) usable for data access and takeover chains.' },
  { slug: 'freemius', name: 'Freemius SDK (bundled)', note: 'Old bundled SDK versions carried takeover flaws across many plugins.' },
  { slug: 'contact-form-7', name: 'Contact Form 7 (very old versions)', note: 'CVE-2020-35489 — unrestricted upload in ≤5.3.1.' }
];

function detectAssets(htmlPages) {
  const plugins = new Map();
  const themes = new Map();
  for (const p of htmlPages) {
    if (!p.html) continue;
    for (const m of p.html.matchAll(/wp-content\/plugins\/([a-z0-9][a-z0-9._-]*)/gi)) {
      const slug = m[1].toLowerCase();
      plugins.set(slug, (plugins.get(slug) || 0) + 1);
    }
    for (const m of p.html.matchAll(/wp-content\/themes\/([a-z0-9][a-z0-9._-]*)/gi)) {
      const slug = m[1].toLowerCase();
      themes.set(slug, (themes.get(slug) || 0) + 1);
    }
  }
  return {
    plugins: [...plugins.keys()].sort(),
    theme: [...themes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  };
}

// ── Claude adjudication ─────────────────────────────────────────────────────
// The heuristics catch candidates; Claude decides which are truly foreign to
// this site. Fed the site's own profile so "gambling content on a gambling
// blog" is ruled legitimate while "casino links on a Swiss web agency" is not.
async function adjudicate(anthropic, siteProfile, candidates) {
  if (!anthropic || candidates.length === 0) return null;
  const batch = candidates.slice(0, 25).map((c, i) => ({
    i, url: c.url, title: c.title || '', excerpt: (c.evidence || '').slice(0, 600), signals: c.signalSummary
  }));
  const prompt = `You are auditing a website for HACKED / INJECTED spam content (SEO spam injected via a compromised plugin: casino, pharma, replica goods, essay mills, hidden links, doorway pages).

SITE PROFILE (what this site is legitimately about):
${siteProfile}

Below are pages our heuristics flagged. For each, decide: is this INJECTED spam (foreign to the site, commercial spam intent, hidden or stuffed), or LEGITIMATE content (the site's own editorial content that merely mentions these topics — e.g. a marketing blog writing about gambling advertising)?

${JSON.stringify(batch, null, 1)}

Answer with ONLY a JSON array, one object per item: {"i": <index>, "verdict": "injected" | "legitimate" | "unsure", "reason": "<one short sentence>"}`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-opus-5', max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = resp.content?.map(b => b.text || '').join('') || '';
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    const map = new Map();
    for (const v of arr) if (typeof v.i === 'number') map.set(v.i, { verdict: v.verdict, reason: String(v.reason || '').slice(0, 300) });
    return { map, batchSize: batch.length };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Main scan ───────────────────────────────────────────────────────────────

async function scanForHack(siteInput, options = {}) {
  const site = normalizeSite(siteInput);
  if (!site) throw new Error('Enter a valid site URL');
  const siteHost = new URL(site).host;
  const maxItems = Math.min(Math.max(parseInt(options.maxItems, 10) || 400, 10), 2000);
  const htmlSampleSize = Math.min(Math.max(parseInt(options.htmlSample, 10) || 12, 3), 40);
  const onProgress = options.onProgress || (() => {});
  const anthropic = options.anthropic || null;

  // 1. REST content (the database layer)
  onProgress('Discovering REST API…');
  const restRoot = await discoverRestRoot(site);
  const rest = await collectRestItems(restRoot, maxItems, onProgress);

  // 2. Choose HTML sample: homepage always; then REST-suspicious pages; then
  //    newest posts; then sitemap URLs if REST is closed.
  const restFindings = [];
  for (const it of rest.items) {
    const { score, hits } = spamScore(it.title + ' ' + it.text);
    const gib = looksGibberish(it.slug);
    if (score >= 3 || (score >= 1 && gib)) {
      restFindings.push({ item: it, score, hits, gibberish: gib });
    }
  }
  restFindings.sort((a, b) => b.score - a.score);

  const sampleUrls = new Map();   // url -> why sampled
  sampleUrls.set(site, 'homepage');
  for (const f of restFindings.slice(0, Math.floor(htmlSampleSize / 2))) {
    if (f.item.link) sampleUrls.set(f.item.link, 'flagged in REST content');
  }
  const newest = [...rest.items].filter(i => i.link).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  for (const it of newest) {
    if (sampleUrls.size >= htmlSampleSize) break;
    sampleUrls.set(it.link, 'recent content');
  }
  if (sampleUrls.size < 4) {
    onProgress('REST closed — reading sitemap…');
    const smUrls = await collectSitemapUrls(site);
    for (const u of smUrls) {
      if (sampleUrls.size >= htmlSampleSize) break;
      try { if (new URL(u).host === siteHost) sampleUrls.set(u, 'sitemap'); } catch { /* skip */ }
    }
  }

  // 3. Fetch each sampled page as a browser AND as Googlebot (cloak check).
  const limit = pLimit(3);
  let fetched = 0;
  const htmlPages = (await Promise.all([...sampleUrls.entries()].map(([url, why]) => limit(async () => {
    const browser = await fetchHtml(url, BROWSER_UA).catch(e => ({ status: 0, html: '', error: e.message }));
    await new Promise(r => setTimeout(r, 300));
    const bot = await fetchHtml(url, GOOGLEBOT_UA).catch(e => ({ status: 0, html: '', error: e.message }));
    fetched++;
    onProgress(`Fetching pages… ${fetched}/${sampleUrls.size}`);
    return { url, why, status: browser.status, html: browser.html || '', botHtml: bot.html || '', botStatus: bot.status };
  })))).filter(p => p.status >= 200 && p.status < 400 && p.html);

  // 4. Analyze
  onProgress('Analyzing content…');
  const findings = [];   // each: { signal, severity, title, pages: [...], explanation }
  const layers = new Set();

  // 4a. Spam in REST content → database layer
  const dbCandidates = restFindings.filter(f => f.score >= 4 || (f.score >= 2 && f.gibberish));
  if (dbCandidates.length) {
    layers.add('database');
    findings.push({
      signal: 'spam-content', severity: 'high',
      title: `Spam content stored in the WordPress database (${dbCandidates.length} item${dbCandidates.length > 1 ? 's' : ''})`,
      explanation: 'The REST API returns this from post_content — the spam is IN the database, written there by whoever had write access (rogue admin user, exploited plugin that creates posts, or direct DB access).',
      pages: dbCandidates.slice(0, 50).map(f => ({
        url: f.item.link, title: f.item.title, date: f.item.date,
        categories: hitCategories(f.hits), score: f.score,
        gibberishSlug: f.gibberish ? f.item.slug : null,
        evidence: excerptAround(f.item.title + ' — ' + f.item.text, f.hits)
      }))
    });
  }

  // 4b. Burst of machine-generated posts (many items, same day, spam or gibberish)
  const byDay = new Map();
  for (const f of restFindings) {
    const day = String(f.item.date || '').slice(0, 10);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(f);
  }
  const bursts = [...byDay.entries()].filter(([, arr]) => arr.length >= 8);
  for (const [day, arr] of bursts) {
    layers.add('database');
    findings.push({
      signal: 'spam-posts', severity: 'high',
      title: `${arr.length} suspicious items all created on ${day}`,
      explanation: 'Bulk publication on a single day is the signature of automated spam-post injection (compromised admin account or a plugin flaw that allows post creation).',
      pages: arr.slice(0, 30).map(f => ({ url: f.item.link, title: f.item.title, categories: hitCategories(f.hits), evidence: excerptAround(f.item.text, f.hits) }))
    });
  }

  // 4c. CJK titles on a non-CJK site (Japanese keyword hack pattern)
  const homeLang = (htmlPages.find(p => p.why === 'homepage')?.html.match(/<html[^>]+lang=["']?([a-z]{2})/i) || [])[1] || '';
  if (!['ja', 'zh', 'ko'].includes(homeLang.toLowerCase())) {
    const cjk = rest.items.filter(i => CJK_RE.test(i.title));
    if (cjk.length >= 3) {
      layers.add('database');
      findings.push({
        signal: 'cjk-titles', severity: 'high',
        title: `${cjk.length} items with Japanese/Chinese/Korean titles on a "${homeLang || '??'}" site`,
        explanation: 'The classic "Japanese keyword hack": thousands of CJK spam pages are generated on a non-CJK site to hijack its rankings.',
        pages: cjk.slice(0, 30).map(i => ({ url: i.link, title: i.title, evidence: i.title }))
      });
    }
  }

  // 4d. Per-page HTML analysis: hidden spam, spam links, scripts, cloaking
  const hiddenAgg = [], linkAgg = [], scriptAgg = [], cloakAgg = [];
  for (const p of htmlPages) {
    let $;
    try { $ = cheerio.load(p.html); } catch { continue; }
    const hidden = findHiddenSpam($, siteHost);
    if (hidden.length) hiddenAgg.push({ url: p.url, hidden });
    const links = findSpamLinks($, siteHost);
    if (links.length >= 2 || links.some(l => l.score >= 5)) linkAgg.push({ url: p.url, links: links.slice(0, 15) });
    const scripts = findSuspiciousScripts($, siteHost);
    if (scripts.length) scriptAgg.push({ url: p.url, scripts });

    // Cloaking: spam served to Googlebot that a browser doesn't get
    if (p.botHtml && p.botStatus >= 200 && p.botStatus < 400) {
      const browserText = htmlToText(p.html);
      const botText = htmlToText(p.botHtml);
      const sBrowser = spamScore(browserText);
      const sBot = spamScore(botText);
      if (sBot.score - sBrowser.score >= 5) {
        cloakAgg.push({
          url: p.url, browserScore: sBrowser.score, botScore: sBot.score,
          categories: hitCategories(sBot.hits),
          evidence: excerptAround(botText, sBot.hits)
        });
      }
    }

    // Render-layer inference: spam visible in HTML but absent from this page's
    // REST content ⇒ injected by PHP at render time, not stored in the post.
    const restMatch = rest.items.find(i => i.link && (i.link === p.url || i.link.replace(/\/$/, '') === p.url.replace(/\/$/, '')));
    if (restMatch) {
      const pageText = htmlToText(p.html);
      const sPage = spamScore(pageText);
      const sRest = spamScore(restMatch.title + ' ' + restMatch.text);
      if (sPage.score >= 6 && sRest.score <= 1) layers.add('render');
    }
  }

  if (hiddenAgg.length) {
    layers.add('render');
    findings.push({
      signal: 'hidden-text', severity: 'high',
      title: `CSS-hidden spam blocks on ${hiddenAgg.length} page${hiddenAgg.length > 1 ? 's' : ''}`,
      explanation: 'Content hidden with display:none / off-screen positioning that contains spam terms or external links. Humans never see it; search engines index it. There is no legitimate reason for it to exist.',
      pages: hiddenAgg.map(h => ({
        url: h.url,
        evidence: h.hidden.map(x => `[${x.style}] "${x.text.slice(0, 120)}" → ${x.externalLinks.slice(0, 3).join(', ')}`).join(' | ').slice(0, 600),
        categories: [...new Set(h.hidden.flatMap(x => x.spam.categories))]
      }))
    });
  }
  if (cloakAgg.length) {
    layers.add('cloak');
    findings.push({
      signal: 'cloaking', severity: 'high',
      title: `Cloaked spam served to Googlebot on ${cloakAgg.length} page${cloakAgg.length > 1 ? 's' : ''}`,
      explanation: 'These pages return substantially more spam content when fetched as Googlebot than as a normal browser. Cloaking is done by malware at the PHP/.htaccess level — the site is compromised.',
      pages: cloakAgg.map(c => ({ url: c.url, categories: c.categories, evidence: `browser spam score ${c.browserScore} vs Googlebot ${c.botScore} — ${c.evidence}` }))
    });
  }
  if (linkAgg.length) {
    layers.add('render');
    findings.push({
      signal: 'spam-links', severity: 'medium',
      title: `Outbound spam links on ${linkAgg.length} page${linkAgg.length > 1 ? 's' : ''}`,
      explanation: 'External links whose URL or anchor text matches commercial spam (casino, pharma, replica…). Injected link spam is usually placed sitewide by a compromised theme/plugin hook.',
      pages: linkAgg.map(l => ({ url: l.url, evidence: l.links.map(x => `"${x.anchor || x.href}" → ${x.href}`).join(' | ').slice(0, 600), categories: [...new Set(l.links.flatMap(x => x.categories))] }))
    });
  }
  if (scriptAgg.length) {
    layers.add('script');
    findings.push({
      signal: 'suspicious-scripts', severity: scriptAgg.some(s => s.scripts.some(x => x.kind === 'inline')) ? 'high' : 'medium',
      title: `Suspicious scripts on ${scriptAgg.length} page${scriptAgg.length > 1 ? 's' : ''}`,
      explanation: 'Obfuscated inline scripts (eval/atob payloads) or third-party scripts loaded from disposable/random domains. Injected scripts are how campaigns like Balada Injector monetize hacked sites (redirects, pop-ups, SEO spam).',
      pages: scriptAgg.map(s => ({ url: s.url, evidence: s.scripts.map(x => x.src || x.reason + (x.sample ? `: ${x.sample}` : '')).join(' | ').slice(0, 600) }))
    });
  }

  // 5. Optional Claude adjudication of content findings (the semantic layer).
  let ai = null;
  const adjudicable = findings.filter(f => ['spam-content', 'spam-posts'].includes(f.signal));
  if (anthropic && adjudicable.length) {
    onProgress('Asking Claude to separate injected spam from legitimate content…');
    const home = htmlPages.find(p => p.why === 'homepage');
    let profile = `Host: ${siteHost}.`;
    if (home) {
      const $h = cheerio.load(home.html);
      profile += ` Title: "${$h('title').first().text().trim()}". Description: "${$h('meta[name="description"]').attr('content') || ''}".`;
    }
    const sampleTitles = rest.items.slice(0, 40).map(i => i.title).filter(Boolean).slice(0, 25);
    if (sampleTitles.length) profile += ` Sample of the site's page titles: ${sampleTitles.join(' | ')}`;

    const candidates = [];
    for (const f of adjudicable) {
      for (const pg of f.pages) {
        candidates.push({ url: pg.url, title: pg.title, evidence: pg.evidence, signalSummary: f.signal, _f: f, _pg: pg });
      }
    }
    const result = await adjudicate(anthropic, profile, candidates);
    if (result?.map) {
      let overturned = 0;
      candidates.forEach((c, i) => {
        const v = result.map.get(i);
        if (!v) return;
        c._pg.aiVerdict = v.verdict;
        c._pg.aiReason = v.reason;
        if (v.verdict === 'legitimate') overturned++;
      });
      // Drop pages Claude ruled legitimate; drop findings left with no pages.
      for (const f of adjudicable) {
        f.pages = f.pages.filter(p => p.aiVerdict !== 'legitimate');
        f.aiChecked = true;
      }
      for (let i = findings.length - 1; i >= 0; i--) {
        if (adjudicable.includes(findings[i]) && findings[i].pages.length === 0) findings.splice(i, 1);
      }
      ai = { used: true, adjudicated: result.batchSize, ruledLegitimate: overturned };
    } else {
      ai = { used: false, error: result?.error || 'no parseable verdict' };
    }
  } else {
    ai = { used: false, error: anthropic ? null : 'no ANTHROPIC_API_KEY configured — heuristic verdicts only' };
  }

  // 6. Origin attribution
  const assets = detectAssets(htmlPages);
  const restNs = (await getJson(restRoot, BROWSER_UA)).json?.namespaces || [];
  const pluginSet = new Set(assets.plugins);
  // Namespaces reveal plugins that register REST routes even when their assets
  // aren't on the sampled pages (e.g. contact-form-7/v1 → contact-form-7).
  for (const ns of restNs) {
    const slug = String(ns).split('/')[0].toLowerCase();
    if (slug && !['wp', 'oembed', 'wp-site-health', 'wp-block-editor'].includes(slug)) pluginSet.add(slug);
  }
  const vulnerable = ABUSED_PLUGINS.filter(p => pluginSet.has(p.slug));

  const hasFindings = findings.length > 0;
  const candidatesOut = [];
  if (hasFindings) {
    for (const v of vulnerable) {
      candidatesOut.push({
        name: v.name, slug: v.slug, confidence: 'medium',
        reasons: [`Installed plugin with documented exploitation for content injection: ${v.note}`,
          'Version could not be verified remotely — if the site runs a patched version this plugin may be innocent.']
      });
    }
    if (layers.has('render') || layers.has('script')) {
      candidatesOut.push({
        name: 'Theme / plugin PHP hook (render-time injection)', slug: null,
        confidence: layers.has('render') && !layers.has('database') ? 'high' : 'medium',
        reasons: ['Spam appears in the rendered HTML but not in the stored post content — it is being added by PHP while the page renders.',
          `Check: the active theme's functions.php and header/footer templates${assets.theme ? ` (theme: ${assets.theme})` : ''}, files in wp-content/mu-plugins/, and any plugin file modified recently.`]
      });
    }
    if (layers.has('cloak')) {
      candidatesOut.push({
        name: 'Server-level malware (.htaccess / index.php cloaking)', slug: null, confidence: 'high',
        reasons: ['Different content is served to Googlebot than to browsers — that requires code inspecting the User-Agent before WordPress renders.',
          'Check: .htaccess rules, modified index.php / wp-config.php, and rogue files in the site root.']
      });
    }
    if (layers.has('database')) {
      candidatesOut.push({
        name: 'Compromised account or post-creating exploit (database injection)', slug: null,
        confidence: vulnerable.length ? 'medium' : 'low',
        reasons: ['Spam is stored in post_content itself — someone or something with write access created/edited it.',
          'Check: Users list for unknown admins, and plugins that can create posts (importers, automation, form-to-post).']
      });
    }
    // Confidence bump: a known-abused plugin whose campaign matches the evidence.
    if (vulnerable.some(v => v.slug === 'popup-builder' || v.slug === 'td-composer') && layers.has('script')) {
      const c = candidatesOut.find(c => c.slug === 'popup-builder' || c.slug === 'td-composer');
      if (c) { c.confidence = 'high'; c.reasons.unshift('Injected scripts + this plugin is the Balada Injector campaign\'s signature combination.'); }
    }
    if (vulnerable.some(v => v.slug === 'wp-automatic') && (findings.some(f => f.signal === 'spam-posts'))) {
      const c = candidatesOut.find(c => c.slug === 'wp-automatic');
      if (c) { c.confidence = 'high'; c.reasons.unshift('Bulk spam-post creation + WP Automatic matches CVE-2024-27956 exploitation exactly.'); }
    }
    const rank = { high: 0, medium: 1, low: 2 };
    candidatesOut.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  }

  // 7. Verdict
  const high = findings.filter(f => f.severity === 'high').length;
  const medium = findings.filter(f => f.severity === 'medium').length;
  const verdict = high > 0 ? 'hacked' : medium > 0 ? 'suspicious' : 'clean';

  return {
    site, restRoot, scannedAt: new Date().toISOString(),
    coverage: {
      restAvailable: rest.available, restItems: rest.items.length,
      htmlPages: htmlPages.length, cloakChecked: htmlPages.filter(p => p.botHtml).length,
      sampledUrls: [...sampleUrls.keys()].length
    },
    verdict, findings, ai,
    origin: {
      plugins: [...pluginSet].sort().map(slug => ({ slug, vulnerable: ABUSED_PLUGINS.find(p => p.slug === slug)?.note || null })),
      theme: assets.theme,
      layers: [...layers],
      candidates: candidatesOut,
      guidance: hasFindings ? [
        'Remote scanning cannot prove which component was exploited — the candidates above are ranked by evidence. Confirm on the server:',
        'List files changed recently: find . -type f -mtime -30 -not -path "./wp-content/uploads/*" | sort',
        'Check wp-content/mu-plugins/ — malware loves this auto-loading directory.',
        'Check Users → Administrators for accounts you did not create.',
        'Update/remove every plugin flagged above, change all admin + database passwords, then run a server-side scanner (e.g. wp-cli + a malware scanner) since injected DB content and PHP backdoors survive plugin updates.'
      ] : []
    }
  };
}

module.exports = { scanForHack, spamScore, looksGibberish, ABUSED_PLUGINS };
