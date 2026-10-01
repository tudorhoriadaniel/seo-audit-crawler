// Markdown-request log analyzer — which bots ask for (and receive) the
// Markdown version of a page instead of HTML?
// Input is the tab-separated log written by the site's "Markdown for AI
// agents" layer (ai-agent-requests.log), one request per line:
//   time \t served (MD|HTML) \t bot label \t Accept header \t URL \t IP \t user-agent
// A normal access log can't answer this question: it records neither the
// Accept header nor the content type that was sent back.
const { classify, toBuffer, CATEGORIES } = require('./log-analyzer');

// Offline MaxMind GeoLite2 country lookup — no IP ever leaves the server.
let geoip = null;
try { geoip = require('geoip-lite'); } catch { /* countries disabled */ }

const TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

function servedFormat(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'md' || s === 'markdown' || s === 'text/markdown') return 'md';
  if (s === 'html' || s === 'text/html') return 'html';
  return null;
}

// How does the Accept header treat Markdown?
//   'preferred' — text/markdown has the highest q-value (ties count)
//   'fallback'  — listed, but another concrete type outranks it
//   'none'      — not mentioned at all
function acceptMode(accept) {
  let mdQ = null, bestOther = 0;
  for (const part of String(accept || '').split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    if (!type) continue;
    const qp = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const q = qp ? (parseFloat(qp.slice(2)) || 0) : 1;
    if (type === 'text/markdown' || type === 'text/x-markdown') mdQ = Math.max(mdQ || 0, q);
    else if (!type.includes('*')) bestOther = Math.max(bestOther, q);
  }
  if (mdQ === null) return 'none';
  return mdQ >= bestOther ? 'preferred' : 'fallback';
}

// Name the requester from the user-agent; where no UA rule matches, trust the
// logger's own label unless it is the catch-all. A browser UA that still asks
// for Markdown is an agent hiding behind a browser string — real browsers
// never send text/markdown.
function identify(ua, label, mode) {
  const c = classify(ua);
  if (c.name) return c;
  if (label && !/^(other|unknown|-)$/i.test(label)) {
    return { name: label, cat: c.cat === 'human' ? 'otherbot' : c.cat };
  }
  if (c.cat === 'human') {
    return mode === 'none'
      ? { name: 'Browser user-agent', cat: 'human' }
      : { name: 'Undeclared agent (browser user-agent)', cat: 'otherbot' };
  }
  return { name: 'Unknown / empty UA', cat: 'unknown' };
}

function bump(map, key, extra) {
  let rec = map.get(key);
  if (!rec) { rec = { hits: 0, md: 0, ...extra }; map.set(key, rec); }
  return rec;
}

function topN(map, n, shape) {
  return [...map.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, n).map(([k, v]) => shape(k, v));
}

function analyzeMarkdownLog(body) {
  const lines = toBuffer(body).toString('utf8').split('\n');

  const bots = new Map();      // name → aggregate
  const accepts = new Map();   // accept header → { hits, md, mode, bots:Set }
  const pages = new Map();     // url → { hits, md, bots:Set }
  const buckets = new Map();   // "YYYY-MM-DD HH" → { md, html }
  const hosts = new Set();
  const allIps = new Set();
  const ipCountry = new Map();
  const mdRequests = [];
  let parsed = 0, skipped = 0, md = 0;
  let preferredGotHtml = 0, mdUnrequested = 0;
  let firstTime = null, lastTime = null;

  const countryOf = ip => {
    if (!geoip) return '';
    let cc = ipCountry.get(ip);
    if (cc === undefined) {
      const g = geoip.lookup(ip);
      cc = (g && g.country) || '';
      ipCountry.set(ip, cc);
    }
    return cc;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const f = line.split('\t');
    const tm = f.length >= 7 ? f[0].match(TIME_RE) : null;
    const served = f.length >= 7 ? servedFormat(f[1]) : null;
    if (!tm || !served) { skipped++; continue; }
    parsed++;

    const time = `${tm[1]} ${tm[2]}:${tm[3]}:${tm[4]}`;
    const accept = f[3].trim();
    const url = f[4].trim();
    const ip = f[5].trim();
    const ua = f.slice(6).join('\t').trim();
    const mode = acceptMode(accept);
    const isMd = served === 'md';
    const { name, cat } = identify(ua, f[2].trim(), mode);

    if (isMd) md++;
    if (!isMd && mode === 'preferred') preferredGotHtml++;
    if (isMd && mode === 'none') mdUnrequested++;
    if (!firstTime || time < firstTime) firstTime = time;
    if (!lastTime || time > lastTime) lastTime = time;
    allIps.add(ip);
    try { hosts.add(new URL(url).host); } catch { /* relative or malformed URL */ }

    const hour = time.slice(0, 13);
    let bk = buckets.get(hour);
    if (!bk) { bk = { md: 0, html: 0 }; buckets.set(hour, bk); }
    bk[served]++;

    let b = bots.get(name);
    if (!b) {
      b = { name, cat, hits: 0, md: 0, preferred: 0, fallback: 0, preferredGotHtml: 0,
            firstSeen: time, lastSeen: time, lastMd: null,
            ips: new Map(), uas: new Map(), accepts: new Map(),
            urls: new Set(), mdUrls: new Map(), htmlUrls: new Map() };
      bots.set(name, b);
    }
    b.hits++;
    if (isMd) { b.md++; if (!b.lastMd || time > b.lastMd) b.lastMd = time; }
    if (mode === 'preferred') b.preferred++;
    if (mode === 'fallback') b.fallback++;
    if (!isMd && mode === 'preferred') b.preferredGotHtml++;
    if (time < b.firstSeen) b.firstSeen = time;
    if (time > b.lastSeen) b.lastSeen = time;
    b.urls.add(url);
    bump(b.ips, ip).hits++;
    bump(b.uas, ua).hits++;
    const ba = bump(b.accepts, accept, { mode });
    ba.hits++;
    if (isMd) ba.md++;
    bump(isMd ? b.mdUrls : b.htmlUrls, url).hits++;

    const a = bump(accepts, accept, { mode, bots: new Set() });
    a.hits++;
    if (isMd) a.md++;
    a.bots.add(name);

    const p = bump(pages, url, { bots: new Set() });
    p.hits++;
    if (isMd) { p.md++; p.bots.add(name); }

    if (isMd) mdRequests.push({ time, bot: name, cat, url, ip, country: countryOf(ip), mode });
  }

  if (parsed === 0) {
    throw new Error('No lines recognized — expected the tab-separated Markdown request log (time, MD/HTML, bot, Accept header, URL, IP, user-agent)');
  }

  const botList = [...bots.values()]
    .sort((x, y) => y.md - x.md || y.hits - x.hits)
    .slice(0, 100)
    .map(b => ({
      name: b.name, cat: b.cat, hits: b.hits, md: b.md, html: b.hits - b.md,
      mdPct: +(b.md / b.hits * 100).toFixed(1),
      preferred: b.preferred, fallback: b.fallback, preferredGotHtml: b.preferredGotHtml,
      uniqueUrls: b.urls.size, uniqueIps: b.ips.size,
      firstSeen: b.firstSeen, lastSeen: b.lastSeen, lastMd: b.lastMd,
      ips: topN(b.ips, 8, (ip, v) => ({ ip, hits: v.hits, country: countryOf(ip) })),
      uas: topN(b.uas, 3, (ua, v) => ({ ua: ua.slice(0, 300), hits: v.hits })),
      accepts: topN(b.accepts, 4, (accept, v) => ({ accept: accept.slice(0, 300), hits: v.hits, md: v.md, mode: v.mode })),
      mdUrls: topN(b.mdUrls, 15, (url, v) => ({ url: url.slice(0, 400), hits: v.hits })),
      htmlUrls: topN(b.htmlUrls, 10, (url, v) => ({ url: url.slice(0, 400), hits: v.hits }))
    }));

  // Hourly bars for short logs, daily once the log spans more than 3 days.
  const hourly = new Set([...buckets.keys()].map(h => h.slice(0, 10))).size <= 3;
  const timelineMap = new Map();
  for (const [hour, v] of buckets) {
    const key = hourly ? hour + ':00' : hour.slice(0, 10);
    const t = timelineMap.get(key) || { md: 0, html: 0 };
    t.md += v.md; t.html += v.html;
    timelineMap.set(key, t);
  }
  const timeline = [...timelineMap.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([label, v]) => ({ label, md: v.md, html: v.html }));

  const categories = Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, { label: c.label, color: c.color }]));

  return {
    totals: {
      hits: parsed, skipped, md, html: parsed - md,
      mdPct: +(md / parsed * 100).toFixed(1),
      mdBots: botList.filter(b => b.md > 0).length,
      preferredGotHtml, mdUnrequested, uniqueIps: allIps.size
    },
    dateRange: { from: firstTime, to: lastTime },
    hosts: [...hosts].slice(0, 10),
    categories,
    bots: botList,
    timeline: { unit: hourly ? 'hour' : 'day', points: timeline },
    accepts: topN(accepts, 25, (accept, v) => ({
      accept: accept.slice(0, 300), mode: v.mode, hits: v.hits, md: v.md, bots: [...v.bots].slice(0, 8)
    })),
    mdPages: [...pages.entries()].filter(([, v]) => v.md > 0)
      .sort((a, b) => b[1].md - a[1].md || b[1].hits - a[1].hits).slice(0, 50)
      .map(([url, v]) => ({ url: url.slice(0, 400), md: v.md, html: v.hits - v.md, bots: [...v.bots].slice(0, 8) })),
    recentMd: mdRequests.sort((a, b) => a.time < b.time ? 1 : -1).slice(0, 300)
      .map(r => ({ ...r, url: r.url.slice(0, 400) }))
  };
}

module.exports = { analyzeMarkdownLog };
