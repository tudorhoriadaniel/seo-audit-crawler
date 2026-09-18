// Server access-log analyzer — who is really crawling the site?
// Takes a raw Apache/Nginx access log (combined format, optionally gzipped),
// classifies every request's user-agent into families (search engine bots,
// AI/LLM bots, SEO tools, social previews, feed readers, monitoring,
// scrapers/HTTP libraries, browser-like humans) and returns compact
// aggregates ready to chart: category shares, a daily timeline, and a
// per-bot breakdown with the paths each bot actually fetched.
const zlib = require('zlib');

// Offline MaxMind GeoLite2 country lookup — no IP ever leaves the server.
// Optional: if the module is missing the analysis simply omits countries.
let geoip = null;
try { geoip = require('geoip-lite'); } catch { /* countries disabled */ }

// Combined Log Format:
// IP ident user [time] "METHOD path PROTO" status bytes "referrer" "user-agent"
// The referrer/UA pair is optional (Common Log Format lacks it).
const LINE_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+)\s?(\S*)[^"]*" (\d{3}) (\S+)(?: "([^"]*)" "([^"]*)")?/;

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

const CATEGORIES = {
  search:   { label: 'Search engine bots', color: '#4285f4' },
  ai:       { label: 'AI / LLM bots',      color: '#a855f7' },
  seo:      { label: 'SEO tools',          color: '#f59e0b' },
  social:   { label: 'Social previews',    color: '#ec4899' },
  feed:     { label: 'Feed readers',       color: '#14b8a6' },
  monitor:  { label: 'Monitoring',         color: '#64748b' },
  scraper:  { label: 'Scrapers / HTTP libs', color: '#ef4444' },
  otherbot: { label: 'Other bots',         color: '#a16207' },
  human:    { label: 'Browser visitors',   color: '#22c55e' },
  unknown:  { label: 'Unknown / empty UA', color: '#9ca3af' }
};

// Ordered matchers — first hit wins, so the specific AI variants must come
// before their broader search-engine siblings (Applebot-Extended vs Applebot,
// DuckAssistBot vs DuckDuckBot, meta-externalagent vs facebookexternalhit).
const BOT_RULES = [
  // ── AI / LLM bots ──
  { re: /GPTBot/i,                    name: 'GPTBot (OpenAI training)',        cat: 'ai' },
  { re: /ChatGPT-User/i,              name: 'ChatGPT-User (on-demand)',        cat: 'ai' },
  { re: /OAI-SearchBot/i,             name: 'OAI-SearchBot (ChatGPT Search)',  cat: 'ai' },
  { re: /Claude-SearchBot/i,          name: 'Claude-SearchBot (Anthropic)',    cat: 'ai' },
  { re: /Claude-User/i,               name: 'Claude-User (on-demand)',         cat: 'ai' },
  { re: /ClaudeBot|Claude-Web|anthropic-ai/i, name: 'ClaudeBot (Anthropic)',   cat: 'ai' },
  { re: /Perplexity-User/i,           name: 'Perplexity-User (on-demand)',     cat: 'ai' },
  { re: /PerplexityBot/i,             name: 'PerplexityBot',                   cat: 'ai' },
  { re: /Google-Extended/i,           name: 'Google-Extended (Gemini)',        cat: 'ai' },
  { re: /Google-CloudVertexBot/i,     name: 'Google-CloudVertexBot',           cat: 'ai' },
  { re: /Applebot-Extended/i,         name: 'Applebot-Extended (Apple AI)',    cat: 'ai' },
  { re: /Bytespider/i,                name: 'Bytespider (ByteDance)',          cat: 'ai' },
  { re: /CCBot/i,                     name: 'CCBot (Common Crawl)',            cat: 'ai' },
  { re: /meta-externalagent/i,        name: 'Meta-ExternalAgent (AI training)', cat: 'ai' },
  { re: /meta-externalfetcher/i,      name: 'Meta-ExternalFetcher',            cat: 'ai' },
  { re: /FacebookBot/i,               name: 'FacebookBot (Meta AI)',           cat: 'ai' },
  { re: /Amazonbot/i,                 name: 'Amazonbot',                       cat: 'ai' },
  { re: /cohere/i,                    name: 'Cohere crawler',                  cat: 'ai' },
  { re: /MistralAI/i,                 name: 'MistralAI-User',                  cat: 'ai' },
  { re: /DuckAssistBot/i,             name: 'DuckAssistBot',                   cat: 'ai' },
  { re: /YouBot/i,                    name: 'YouBot (You.com)',                cat: 'ai' },
  { re: /AI2Bot/i,                    name: 'AI2Bot (Allen Institute)',        cat: 'ai' },
  { re: /Diffbot/i,                   name: 'Diffbot',                         cat: 'ai' },
  { re: /Timpibot/i,                  name: 'Timpibot',                        cat: 'ai' },
  { re: /omgili/i,                    name: 'Omgili (Webz.io)',                cat: 'ai' },
  { re: /PanguBot/i,                  name: 'PanguBot (Huawei AI)',            cat: 'ai' },
  { re: /DeepSeek/i,                  name: 'DeepSeek',                        cat: 'ai' },
  { re: /Grok|xAI-/i,                 name: 'xAI / Grok',                      cat: 'ai' },
  { re: /ImagesiftBot/i,              name: 'ImagesiftBot',                    cat: 'ai' },

  // ── Search engine bots ──
  { re: /Google-InspectionTool/i,     name: 'Google-InspectionTool',           cat: 'search' },
  { re: /Googlebot-Image/i,           name: 'Googlebot-Image',                 cat: 'search' },
  { re: /Googlebot-Video/i,           name: 'Googlebot-Video',                 cat: 'search' },
  { re: /Googlebot-News/i,            name: 'Googlebot-News',                  cat: 'search' },
  { re: /Googlebot/i,                 name: 'Googlebot',                       cat: 'search' },
  { re: /GoogleOther/i,               name: 'GoogleOther',                     cat: 'search' },
  { re: /Storebot-Google/i,           name: 'Storebot-Google',                 cat: 'search' },
  { re: /AdsBot-Google|Mediapartners-Google|APIs-Google/i, name: 'Google Ads bots', cat: 'search' },
  { re: /FeedFetcher-Google|Google-Read-Aloud|Google Favicon|Google-Site-Verification/i, name: 'Google (other services)', cat: 'search' },
  { re: /adidxbot|BingPreview|MicrosoftPreview/i, name: 'Bing (preview/ads)',  cat: 'search' },
  { re: /bingbot|msnbot/i,            name: 'Bingbot',                         cat: 'search' },
  { re: /DuckDuckBot|DuckDuckGo/i,    name: 'DuckDuckBot',                     cat: 'search' },
  { re: /Slurp/i,                     name: 'Yahoo Slurp',                     cat: 'search' },
  { re: /Yandex/i,                    name: 'YandexBot',                       cat: 'search' },
  { re: /Baiduspider/i,               name: 'Baiduspider',                     cat: 'search' },
  { re: /Applebot/i,                  name: 'Applebot',                        cat: 'search' },
  { re: /SeznamBot/i,                 name: 'SeznamBot',                       cat: 'search' },
  { re: /Sogou/i,                     name: 'Sogou',                           cat: 'search' },
  { re: /PetalBot/i,                  name: 'PetalBot (Huawei)',               cat: 'search' },
  { re: /Yeti\/|NaverBot/i,           name: 'Naver Yeti',                      cat: 'search' },
  { re: /Qwant/i,                     name: 'Qwantbot',                        cat: 'search' },
  { re: /coccocbot/i,                 name: 'CocCoc Bot',                      cat: 'search' },
  { re: /MojeekBot/i,                 name: 'MojeekBot',                       cat: 'search' },

  // ── SEO tools ──
  { re: /AhrefsBot|AhrefsSiteAudit/i, name: 'AhrefsBot',                       cat: 'seo' },
  { re: /SemrushBot|SiteAuditBot|SplitSignalBot/i, name: 'SemrushBot',         cat: 'seo' },
  { re: /MJ12bot/i,                   name: 'MJ12bot (Majestic)',              cat: 'seo' },
  { re: /DotBot|rogerbot/i,           name: 'Moz (DotBot/Rogerbot)',           cat: 'seo' },
  { re: /Screaming Frog/i,            name: 'Screaming Frog',                  cat: 'seo' },
  { re: /DataForSeoBot/i,             name: 'DataForSeoBot',                   cat: 'seo' },
  { re: /BLEXBot/i,                   name: 'BLEXBot (WebMeUp)',               cat: 'seo' },
  { re: /serpstatbot/i,               name: 'SerpstatBot',                     cat: 'seo' },
  { re: /SEOkicks/i,                  name: 'SEOkicks',                        cat: 'seo' },
  { re: /sistrix/i,                   name: 'SISTRIX',                         cat: 'seo' },
  { re: /Barkrowler/i,                name: 'Barkrowler (Babbar)',             cat: 'seo' },
  { re: /seobility/i,                 name: 'Seobility',                       cat: 'seo' },
  { re: /MegaIndex/i,                 name: 'MegaIndex',                       cat: 'seo' },

  // ── Social link previews ──
  { re: /facebookexternalhit|facebookcatalog/i, name: 'Facebook preview',      cat: 'social' },
  { re: /Twitterbot/i,                name: 'Twitterbot (X)',                  cat: 'social' },
  { re: /LinkedInBot/i,               name: 'LinkedInBot',                     cat: 'social' },
  { re: /Pinterest/i,                 name: 'Pinterestbot',                    cat: 'social' },
  { re: /Slackbot|Slack-ImgProxy/i,   name: 'Slackbot',                        cat: 'social' },
  { re: /WhatsApp/i,                  name: 'WhatsApp preview',                cat: 'social' },
  { re: /TelegramBot/i,               name: 'TelegramBot',                     cat: 'social' },
  { re: /Discordbot/i,                name: 'Discordbot',                      cat: 'social' },
  { re: /SkypeUriPreview/i,           name: 'Skype preview',                   cat: 'social' },
  { re: /redditbot/i,                 name: 'Redditbot',                       cat: 'social' },
  { re: /Snap URL Preview|Snapchat/i, name: 'Snapchat preview',                cat: 'social' },
  { re: /Iframely/i,                  name: 'Iframely',                        cat: 'social' },
  { re: /vkShare/i,                   name: 'VK preview',                      cat: 'social' },

  // ── Feed readers ──
  { re: /Feedly/i,                    name: 'Feedly',                          cat: 'feed' },
  { re: /Feedbin/i,                   name: 'Feedbin',                         cat: 'feed' },
  { re: /Inoreader/i,                 name: 'Inoreader',                       cat: 'feed' },
  { re: /NewsBlur/i,                  name: 'NewsBlur',                        cat: 'feed' },
  { re: /Miniflux/i,                  name: 'Miniflux',                        cat: 'feed' },
  { re: /FreshRSS|Tiny Tiny RSS|theoldreader|BazQux|SimplePie|feedparser/i, name: 'RSS readers (other)', cat: 'feed' },

  // ── Monitoring / performance ──
  { re: /UptimeRobot/i,               name: 'UptimeRobot',                     cat: 'monitor' },
  { re: /Pingdom/i,                   name: 'Pingdom',                         cat: 'monitor' },
  { re: /StatusCake/i,                name: 'StatusCake',                      cat: 'monitor' },
  { re: /Site24x7/i,                  name: 'Site24x7',                        cat: 'monitor' },
  { re: /GTmetrix/i,                  name: 'GTmetrix',                        cat: 'monitor' },
  { re: /Chrome-Lighthouse|PageSpeed/i, name: 'Lighthouse / PageSpeed',        cat: 'monitor' },
  { re: /Uptime-Kuma|HetrixTools|Better Uptime|betteruptime|checkly/i, name: 'Uptime checkers (other)', cat: 'monitor' },

  // ── Scrapers & HTTP libraries ──
  { re: /python-requests|Python-urllib|aiohttp|httpx/i, name: 'Python scripts', cat: 'scraper' },
  { re: /Scrapy/i,                    name: 'Scrapy',                          cat: 'scraper' },
  { re: /^curl\/|[ (]curl\//i,        name: 'curl',                            cat: 'scraper' },
  { re: /^Wget|[ (]Wget/i,            name: 'Wget',                            cat: 'scraper' },
  { re: /Go-http-client/i,            name: 'Go HTTP client',                  cat: 'scraper' },
  { re: /okhttp/i,                    name: 'okhttp (Java/Android)',           cat: 'scraper' },
  { re: /Apache-HttpClient|^Java\//i, name: 'Java HTTP client',                cat: 'scraper' },
  { re: /libwww-perl/i,               name: 'Perl libwww',                     cat: 'scraper' },
  { re: /GuzzleHttp|^PHP\//i,         name: 'PHP scripts',                     cat: 'scraper' },
  { re: /node-fetch|axios\/|undici/i, name: 'Node.js scripts',                 cat: 'scraper' },
  { re: /HTTPie/i,                    name: 'HTTPie',                          cat: 'scraper' },
  { re: /Nutch/i,                     name: 'Apache Nutch',                    cat: 'scraper' }
];

// Anything with bot-ish words that no specific rule caught.
const GENERIC_BOT_RE = /bot|crawler|spider|crawl(?:er)?|slurp|archiver|indexer|fetcher|scanner|scraper|probe|WordPress\//i;

function classify(ua) {
  if (!ua || ua === '-') return { name: null, cat: 'unknown' };
  for (const rule of BOT_RULES) {
    if (rule.re.test(ua)) return { name: rule.name, cat: rule.cat };
  }
  if (GENERIC_BOT_RE.test(ua)) {
    // Pull a readable name out of the UA: prefer the token containing
    // bot/crawler/spider, else the first product token.
    const m = ua.match(/([A-Za-z0-9._ -]{2,40}?(?:bot|Bot|crawler|Crawler|spider|Spider))/);
    const name = m ? m[1].trim().replace(/^[;,+ ]+/, '') : ua.split(/[\/ (]/)[0];
    return { name: (name || 'Unnamed bot').slice(0, 60), cat: 'otherbot' };
  }
  if (/^Mozilla/i.test(ua)) return { name: null, cat: 'human' };
  return { name: null, cat: 'unknown' };
}

const STATIC_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf|zip|gz|map)(\?|$)/i;

// Discovery files worth tracking individually — llms.txt tells whether AI
// bots even look for the LLM-facing site summary; robots.txt/sitemap show
// which crawlers behave and how often they re-check.
function specialFileKey(path) {
  const p = path.split('?')[0].toLowerCase();
  if (p === '/llms.txt') return 'llms.txt';
  if (p === '/llms-full.txt') return 'llms-full.txt';
  if (p === '/robots.txt') return 'robots.txt';
  if (p === '/sitemap.xml' || p === '/sitemap_index.xml' || /^\/sitemap[^\/]*\.xml$/.test(p)) return 'sitemaps';
  return null;
}

function toBuffer(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  // gzip magic bytes — gunzipSync also handles concatenated members, so
  // multiple .gz files uploaded as one body decompress fine.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf);
  }
  return buf;
}

function parseTimestamp(ts) {
  // "31/Aug/2026:15:10:15 +0300" → { date: "2026-08-31", iso }
  const m = ts.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  return { date: `${m[3]}-${mon}-${m[1]}`, time: `${m[3]}-${mon}-${m[1]} ${m[4]}:${m[5]}:${m[6]}` };
}

function analyzeLog(body) {
  const text = toBuffer(body).toString('utf8');
  const lines = text.split('\n');

  const catStats = {};   // cat → { hits, bytes, ips:Set }
  const botStats = new Map(); // key → per-bot aggregate
  const timeline = new Map(); // date → { total, byCat: {} }
  const allIps = new Set();
  const specialFiles = {}; // key → Map(botLabel → {cat, hits, lastSeen, lastStatus})
  const ipCountry = new Map(); // ip → ISO code or '' (cache: ~20k uniques vs ~100k+ hits)
  const countryStats = new Map(); // code → { hits, ips:Set, byCat: {} }
  let parsed = 0, skipped = 0, totalBytes = 0;
  let firstTime = null, lastTime = null;

  for (const cat of Object.keys(CATEGORIES)) {
    catStats[cat] = { hits: 0, bytes: 0, ips: new Set() };
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(LINE_RE);
    if (!m) { skipped++; continue; }
    parsed++;
    const ip = m[1];
    const ts = parseTimestamp(m[2]);
    const path = m[4] || '';
    const status = parseInt(m[5], 10);
    const bytes = m[6] === '-' ? 0 : (parseInt(m[6], 10) || 0);
    const ua = m[8] || '';

    const { name, cat } = classify(ua);

    allIps.add(ip);
    totalBytes += bytes;
    catStats[cat].hits++;
    catStats[cat].bytes += bytes;
    catStats[cat].ips.add(ip);

    if (ts) {
      if (!firstTime || ts.time < firstTime) firstTime = ts.time;
      if (!lastTime || ts.time > lastTime) lastTime = ts.time;
      let day = timeline.get(ts.date);
      if (!day) { day = { total: 0, byCat: {} }; timeline.set(ts.date, day); }
      day.total++;
      day.byCat[cat] = (day.byCat[cat] || 0) + 1;
    }

    if (geoip) {
      let cc = ipCountry.get(ip);
      if (cc === undefined) {
        const g = geoip.lookup(ip);
        cc = (g && g.country) || '';
        ipCountry.set(ip, cc);
      }
      const key = cc || '??';
      let cs = countryStats.get(key);
      if (!cs) { cs = { hits: 0, ips: new Set(), byCat: {} }; countryStats.set(key, cs); }
      cs.hits++;
      cs.ips.add(ip);
      cs.byCat[cat] = (cs.byCat[cat] || 0) + 1;
    }

    const sfKey = specialFileKey(path);
    if (sfKey) {
      const label = name || (cat === 'human' ? 'Browser visitors' : CATEGORIES[cat].label);
      let sf = specialFiles[sfKey];
      if (!sf) { sf = new Map(); specialFiles[sfKey] = sf; }
      let rec = sf.get(label);
      if (!rec) { rec = { cat, hits: 0, lastSeen: null, lastStatus: status }; sf.set(label, rec); }
      rec.hits++;
      rec.lastStatus = status;
      if (ts && (!rec.lastSeen || ts.time > rec.lastSeen)) rec.lastSeen = ts.time;
    }

    // Per-bot detail only for named bots (humans/unknown stay aggregate).
    if (name) {
      let b = botStats.get(name);
      if (!b) {
        b = { name, cat, hits: 0, bytes: 0, ips: new Set(), urls: new Set(),
              firstSeen: null, lastSeen: null, ua,
              status: { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, other: 0 },
              paths: new Map(), assetHits: 0 };
        botStats.set(name, b);
      }
      b.hits++;
      b.bytes += bytes;
      b.ips.add(ip);
      b.urls.add(path);
      if (ts) {
        if (!b.firstSeen || ts.time < b.firstSeen) b.firstSeen = ts.time;
        if (!b.lastSeen || ts.time > b.lastSeen) b.lastSeen = ts.time;
      }
      if (status >= 200 && status < 300) b.status.s2xx++;
      else if (status < 400) b.status.s3xx++;
      else if (status < 500) b.status.s4xx++;
      else if (status < 600) b.status.s5xx++;
      else b.status.other++;
      if (STATIC_EXT_RE.test(path)) b.assetHits++;
      else b.paths.set(path, (b.paths.get(path) || 0) + 1);
    }
  }

  if (parsed === 0) {
    throw new Error('No log lines recognized — expected Apache/Nginx access log format (combined or common), optionally gzipped');
  }

  const categories = Object.entries(catStats)
    .filter(([, s]) => s.hits > 0)
    .map(([key, s]) => ({
      key, label: CATEGORIES[key].label, color: CATEGORIES[key].color,
      hits: s.hits, pct: +(s.hits / parsed * 100).toFixed(2),
      uniqueIps: s.ips.size, bytes: s.bytes
    }))
    .sort((a, b) => b.hits - a.hits);

  const bots = [...botStats.values()]
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 60)
    .map(b => ({
      name: b.name, cat: b.cat, hits: b.hits, bytes: b.bytes,
      uniqueIps: b.ips.size, uniqueUrls: b.urls.size,
      firstSeen: b.firstSeen, lastSeen: b.lastSeen, ua: b.ua.slice(0, 200),
      status: b.status, assetHits: b.assetHits,
      topPaths: [...b.paths.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15)
        .map(([path, hits]) => ({ path: path.slice(0, 300), hits }))
    }));

  const days = [...timeline.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([date, d]) => ({ date, total: d.total, byCat: d.byCat }));

  const special = {};
  for (const [key, map] of Object.entries(specialFiles)) {
    special[key] = [...map.entries()]
      .map(([label, r]) => ({ label, cat: r.cat, hits: r.hits, lastSeen: r.lastSeen, lastStatus: r.lastStatus }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 30);
  }

  const countries = [...countryStats.entries()]
    .map(([code, s]) => ({
      code, hits: s.hits, pct: +(s.hits / parsed * 100).toFixed(2),
      uniqueIps: s.ips.size, byCat: s.byCat
    }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 40);

  return {
    totals: { hits: parsed, skipped, bytes: totalBytes, uniqueIps: allIps.size },
    dateRange: { from: firstTime, to: lastTime },
    categories, bots, timeline: days, specialFiles: special, countries
  };
}

module.exports = { analyzeLog, CATEGORIES };
