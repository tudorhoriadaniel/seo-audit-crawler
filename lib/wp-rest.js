// AI Content Visibility — what a machine reading a WordPress site through its
// REST API actually gets.
//
// AI crawlers, scrapers and any tool that reads /wp-json/wp/v2/{type}/{id}
// see `content.rendered`, which is built from post_content. Page builders
// (Elementor, Divi, Bricks, theme builders) keep their content in postmeta and
// leave post_content EMPTY — so those pages look rich to a human in a browser
// and completely blank to anything reading the API.
//
// This module probes the REST API, discovers every public post type, and
// measures how many characters of body text each item actually returns.
const axios = require('axios');
const he = require('he');
const pLimit = require('p-limit');

const HTTP_TIMEOUT = 20000;
const PER_PAGE = 100;

// A normal desktop Chrome — bot-protection layers (Cloudflare, Wordfence,
// SiteGround, hosting WAFs) commonly let this through untouched.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// OpenAI's crawler — the realistic "can an AI actually read this" test.
const AI_BOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';

// Post types that exist in REST but are not page content — skip them so the
// table stays about things a user (or an AI) would actually read.
const SKIP_TYPES = new Set([
  'attachment', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part',
  'wp_navigation', 'wp_global_styles', 'wp_font_family', 'wp_font_face',
  'revision', 'custom_css', 'customize_changeset', 'oembed_cache',
  'user_request', 'wp_area', 'patterns_ai_data'
]);

// Thin — not empty, but nowhere near enough for an AI to summarise or cite.
const THIN_TEXT_CHARS = 500;

function normalizeSite(input) {
  let v = String(input || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

// Strip HTML to the text a reader would actually see, then count it. Script and
// style bodies are removed outright — they are never readable content, and
// counting them would hide a genuinely empty page behind inline CSS.
function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  try { s = he.decode(s); } catch { /* keep raw on malformed entities */ }
  return s.replace(/\s+/g, ' ').trim();
}

// Bot-protection layers answer with an HTML interstitial and HTTP 200, so the
// status code alone never tells you the API is blocked — the body does. Match
// only explicit challenge wording: a plain HTML 404 is a missing endpoint, not
// a challenge, and conflating the two sends people hunting a WAF that is not there.
const CHALLENGE_RE = /one moment, please|just a moment|checking your (browser|connection)|enable javascript and cookies|attention required|ddos protection|cf-browser-verification|verifying you are human|please wait while we verify/i;

function readBody(res) {
  return typeof res.data === 'string' ? res.data.slice(0, 4000) : '';
}

function looksLikeChallenge(res) {
  const ct = String(res.headers?.['content-type'] || '');
  if (ct.includes('application/json')) return false;
  const body = readBody(res);
  if (CHALLENGE_RE.test(body)) return true;
  // HTML served with a success status where JSON was expected — a silent
  // interstitial or a catch-all route swallowing the endpoint.
  const status = res.status || 0;
  return status >= 200 && status < 300 && /<html/i.test(body);
}

async function getJson(url, ua) {
  const res = await axios.get(url, {
    timeout: HTTP_TIMEOUT,
    maxRedirects: 5,
    responseType: 'text',           // parse ourselves, so we can inspect HTML bodies
    transformResponse: [(d) => d],
    validateStatus: () => true,
    headers: { 'User-Agent': ua, Accept: 'application/json, */*' }
  });
  const challenged = looksLikeChallenge(res);
  let json = null;
  if (!challenged && typeof res.data === 'string') {
    try { json = JSON.parse(res.data); } catch { /* not JSON */ }
  }
  return { status: res.status, headers: res.headers, json, challenged, raw: typeof res.data === 'string' ? res.data : '' };
}

// Find the REST root the way WordPress advertises it: a Link header (or <link>
// tag) with rel="https://api.w.org/". This handles subdirectory installs and
// sites that have moved wp-json off the default path. Falls back to /wp-json/.
async function discoverRestRoot(site, ua) {
  const fallback = site.replace(/\/+$/, '') + '/wp-json/';
  try {
    const res = await axios.get(site, {
      timeout: HTTP_TIMEOUT,
      maxRedirects: 5,
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: () => true,
      headers: { 'User-Agent': ua }
    });
    const link = String(res.headers?.link || '');
    let m = link.match(/<([^>]+)>\s*;\s*rel="https:\/\/api\.w\.org\/"/i);
    if (!m && typeof res.data === 'string') {
      m = res.data.match(/<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]*href=["']([^"']+)["']/i)
        || res.data.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']https:\/\/api\.w\.org\/["']/i);
    }
    if (m && m[1]) return m[1].endsWith('/') ? m[1] : m[1] + '/';
  } catch { /* fall through */ }
  return fallback;
}

// Probe the REST root with two identities. The gap between them is the point:
// a site that answers a browser but challenges GPTBot is invisible to AI even
// though it looks perfectly open when you test it by hand.
//
// The two probes run sequentially with a pause, and a 429 is retried once —
// firing them together would share one rate-limit bucket and make any
// throttled site look like it singles out AI crawlers.
async function probeApi(restRoot) {
  const attempt = async (ua) => {
    let r = await getJson(restRoot, ua).catch(e => ({ status: 0, json: null, challenged: false, error: e.message }));
    if (r.status === 429) {
      await new Promise(res => setTimeout(res, 3000));
      r = await getJson(restRoot, ua).catch(e => ({ status: 0, json: null, challenged: false, error: e.message }));
    }
    return r;
  };

  const browser = await attempt(BROWSER_UA);
  await new Promise(res => setTimeout(res, 1200));
  const aiBot = await attempt(AI_BOT_UA);

  const describe = (r) => ({
    status: r.status,
    ok: !!(r.json && r.status >= 200 && r.status < 300),
    challenged: !!r.challenged,
    error: r.error || null
  });
  return {
    browser: describe(browser),
    aiBot: describe(aiBot),
    namespaces: browser.json?.namespaces || [],
    siteName: browser.json?.name || null
  };
}

// Every post type WordPress exposes to unauthenticated REST clients. The
// endpoint itself only lists types registered with show_in_rest, so this is
// already the public set — we just drop the structural ones.
async function discoverTypes(restRoot, ua) {
  const { json } = await getJson(restRoot + 'wp/v2/types', ua);
  const types = [];
  for (const [slug, t] of Object.entries(json || {})) {
    if (SKIP_TYPES.has(slug)) continue;
    const restBase = t?.rest_base || slug;
    const restNamespace = t?.rest_namespace || 'wp/v2';
    if (restNamespace !== 'wp/v2') continue;   // custom namespaces need their own auth story
    types.push({ slug, restBase, label: t?.name || slug });
  }
  return types;
}

// Pull every item of one post type. `_fields` keeps the payload small — on a
// content-heavy site the full response is megabytes per page of results.
async function fetchType(restRoot, type, ua, budget) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  let error = null;

  while (page <= totalPages && budget.left > 0) {
    const url = `${restRoot}wp/v2/${type.restBase}?per_page=${PER_PAGE}&page=${page}&_fields=id,slug,link,type,date,status,title,content,excerpt`;
    const { status, headers, json, challenged } = await getJson(url, ua);

    if (challenged) { error = 'blocked by bot protection'; break; }
    if (status === 400 && page > 1) break;             // ran past the last page
    if (!Array.isArray(json)) {
      error = json?.message || `HTTP ${status}`;
      break;
    }
    if (json.length === 0) break;

    for (const it of json) {
      // Claim the slot before building the row: types are fetched concurrently
      // and a check placed after the push lets two of them both overshoot.
      if (budget.left <= 0) break;
      budget.left--;
      const rendered = it?.content?.rendered || '';
      const text = htmlToText(rendered);
      items.push({
        id: it.id,
        type: type.slug,
        typeLabel: type.label,
        slug: it.slug || '',
        link: it.link || '',
        title: htmlToText(it?.title?.rendered || ''),
        status: it.status || 'publish',
        date: it.date || null,
        protected: !!it?.content?.protected,
        rawChars: rendered.length,
        textChars: text.length,
        excerptChars: htmlToText(it?.excerpt?.rendered || '').length
      });
    }

    totalPages = parseInt(headers?.['x-wp-totalpages'], 10) || 1;
    page++;
  }

  return { items, error };
}

function classify(item) {
  if (item.protected) return 'protected';
  if (item.textChars === 0) return 'empty';
  if (item.textChars < THIN_TEXT_CHARS) return 'thin';
  return 'ok';
}

// Full scan: probe → discover types → count characters per item.
async function scanSite(siteInput, options = {}) {
  const site = normalizeSite(siteInput);
  if (!site) throw new Error('Enter a valid site URL');
  const maxItems = Math.min(Math.max(parseInt(options.maxItems, 10) || 500, 1), 2000);

  const restRoot = await discoverRestRoot(site, BROWSER_UA);
  const api = await probeApi(restRoot);

  if (!api.browser.ok) {
    const st = api.browser.status;
    let error;
    if (api.browser.challenged) {
      error = 'The REST API is behind a bot-protection challenge even for a normal browser — nothing can read it programmatically.';
    } else if (st === 404) {
      error = 'No REST API at this address (HTTP 404) — this is either not a WordPress site, or the REST API has been disabled or moved.';
    } else if (st === 401 || st === 403) {
      error = `The REST API is closed to unauthenticated clients (HTTP ${st}) — a plugin or security rule is restricting it.`;
    } else if (st === 429) {
      error = 'The REST API rate-limited this scan (HTTP 429). Wait a minute and try again.';
    } else if (!st) {
      error = `Could not reach the site${api.browser.error ? ' — ' + api.browser.error : ''}. Check the URL.`;
    } else {
      error = `The REST API did not return JSON (HTTP ${st}). It may be disabled, restricted, or this is not a WordPress site.`;
    }
    return { site, restRoot, api, types: [], items: [], totals: null, error };
  }

  const types = await discoverTypes(restRoot, BROWSER_UA);
  if (types.length === 0) {
    return { site, restRoot, api, types: [], items: [], totals: null, error: 'No public post types are exposed via wp/v2.' };
  }

  // Types in parallel (a handful at most), pages within a type sequential —
  // pagination is inherently ordered and this keeps load on the site modest.
  const limit = pLimit(3);
  const budget = { left: maxItems };
  const results = await Promise.all(types.map(t => limit(async () => {
    try {
      return { type: t, ...(await fetchType(restRoot, t, BROWSER_UA, budget)) };
    } catch (e) {
      return { type: t, items: [], error: e.message };
    }
  })));

  const items = [];
  const typeSummaries = [];
  for (const r of results) {
    items.push(...r.items);
    typeSummaries.push({
      slug: r.type.slug,
      label: r.type.label,
      restBase: r.type.restBase,
      count: r.items.length,
      empty: r.items.filter(i => classify(i) === 'empty').length,
      error: r.error || null
    });
  }

  items.sort((a, b) => a.textChars - b.textChars || a.type.localeCompare(b.type) || a.id - b.id);

  const totals = {
    items: items.length,
    empty: items.filter(i => classify(i) === 'empty').length,
    thin: items.filter(i => classify(i) === 'thin').length,
    ok: items.filter(i => classify(i) === 'ok').length,
    protected: items.filter(i => classify(i) === 'protected').length,
    totalTextChars: items.reduce((s, i) => s + i.textChars, 0),
    truncated: budget.left <= 0
  };

  return {
    site, restRoot, api, types: typeSummaries,
    items: items.map(i => ({ ...i, flag: classify(i) })),
    totals, error: null
  };
}

module.exports = { scanSite, normalizeSite, htmlToText, THIN_TEXT_CHARS, BROWSER_UA, AI_BOT_UA };
