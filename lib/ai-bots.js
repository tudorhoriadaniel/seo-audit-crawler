/**
 * AI crawler catalogue + live server-access probe.
 *
 * robots.txt only tells half the story: a site can leave a bot unmentioned in
 * robots.txt and still turn it away at the server / WAF / hosting firewall by
 * matching its user agent (very common with ClaudeBot, Bytespider, etc. on
 * shared hosting and security plugins). probeAiBotAccess() requests the page
 * once per bot with that bot's user agent and compares the answer with what a
 * normal browser gets.
 *
 * `ua: null` marks robots.txt-only tokens (no HTTP crawler of their own) and
 * crawlers that sites authenticate by IP / reverse DNS — a simulated request
 * from this server would be rejected as a fake and prove nothing.
 */
const axios = require('axios');

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const AI_BOTS = [
  { name: 'GPTBot', owner: 'OpenAI', description: 'ChatGPT / OpenAI web browsing & training', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot' },
  { name: 'ChatGPT-User', owner: 'OpenAI', description: 'ChatGPT fetching a page on a user\'s request', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
  { name: 'OAI-SearchBot', owner: 'OpenAI', description: 'ChatGPT search index', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot' },
  { name: 'Google-Extended', owner: 'Google', description: 'Gemini AI training data', ua: null, noProbeReason: 'robots.txt token only — no crawler of its own' },
  { name: 'Googlebot', owner: 'Google', description: 'Google Search indexing (not AI-specific)', ua: null, noProbeReason: 'sites verify Googlebot by IP — a simulated request proves nothing' },
  { name: 'ClaudeBot', owner: 'Anthropic', description: 'Claude AI training crawler', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
  { name: 'Claude-User', owner: 'Anthropic', description: 'Claude fetching a page on a user\'s request', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)' },
  { name: 'Claude-SearchBot', owner: 'Anthropic', description: 'Claude search index', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)' },
  { name: 'Anthropic-ai', owner: 'Anthropic', description: 'Claude AI training data (legacy token)', ua: 'Mozilla/5.0 (compatible; anthropic-ai/1.0; +http://www.anthropic.com/bot.html)' },
  { name: 'Claude-Web', owner: 'Anthropic', description: 'Claude web browsing (legacy token)', ua: 'Mozilla/5.0 (compatible; Claude-Web/1.0; +http://www.anthropic.com/bot.html)' },
  { name: 'PerplexityBot', owner: 'Perplexity', description: 'Perplexity AI search index', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
  { name: 'Perplexity-User', owner: 'Perplexity', description: 'Perplexity fetching a page on a user\'s request', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)' },
  { name: 'MistralAI-User', owner: 'Mistral', description: 'Le Chat fetching a page on a user\'s request', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)' },
  { name: 'DuckAssistBot', owner: 'DuckDuckGo', description: 'DuckDuckGo AI-assisted answers', ua: 'DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)' },
  { name: 'CCBot', owner: 'Common Crawl', description: 'Common Crawl (used by many AI companies)', ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
  { name: 'Bytespider', owner: 'ByteDance', description: 'TikTok / ByteDance AI training', ua: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)' },
  { name: 'Diffbot', owner: 'Diffbot', description: 'Diffbot web scraping / knowledge graph', ua: 'Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)' },
  { name: 'FacebookBot', owner: 'Meta', description: 'Meta AI training data', ua: 'Mozilla/5.0 (compatible; FacebookBot/1.0; +https://developers.facebook.com/docs/sharing/webmasters/facebookbot/)' },
  { name: 'Meta-ExternalAgent', owner: 'Meta', description: 'Meta AI external data collection', ua: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)' },
  { name: 'Meta-ExternalFetcher', owner: 'Meta', description: 'Meta AI external fetcher', ua: 'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)' },
  { name: 'YouBot', owner: 'You.com', description: 'You.com AI search', ua: 'Mozilla/5.0 (compatible; YouBot/1.0; +https://about.you.com/youbot/)' },
  { name: 'Applebot-Extended', owner: 'Apple', description: 'Apple AI training data', ua: null, noProbeReason: 'robots.txt token only — no crawler of its own' },
  { name: 'Applebot', owner: 'Apple', description: 'Apple Search / Siri (general)', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)' },
  { name: 'cohere-ai', owner: 'Cohere', description: 'Cohere AI training data', ua: 'Mozilla/5.0 (compatible; cohere-ai/1.0)' },
  { name: 'Amazonbot', owner: 'Amazon', description: 'Amazon Alexa / AI assistant', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36' },
  { name: 'AI2Bot', owner: 'Allen AI', description: 'Allen Institute for AI', ua: 'Mozilla/5.0 (compatible; AI2Bot/1.0; +https://www.allenai.org/crawler)' },
  { name: 'Scrapy', owner: 'Various', description: 'Scrapy framework (common scraper)', ua: 'Scrapy/2.11.2 (+https://scrapy.org)' },
  { name: 'Timpibot', owner: 'Timpi', description: 'Timpi decentralized search', ua: 'Mozilla/5.0 (compatible; Timpibot/0.9; +http://www.timpi.io)' },
  { name: 'Omgilibot', owner: 'Webz.io', description: 'Webz.io data collection', ua: 'Mozilla/5.0 (compatible; omgilibot/0.4; +http://omgili.com/omgili.html)' },
  { name: 'img2dataset', owner: 'Various', description: 'Image dataset collection for AI training', ua: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:72.0) Gecko/20100101 Firefox/72.0 (compatible; img2dataset; +https://github.com/rom1504/img2dataset)' },
  { name: 'Kangaroo Bot', owner: 'Various', description: 'AI content scraper', ua: 'Mozilla/5.0 (compatible; Kangaroo Bot/1.0)' },
  { name: 'Sidetrade', owner: 'Sidetrade', description: 'Sidetrade AI data collection', ua: 'Mozilla/5.0 (compatible; Sidetrade indexer bot)' },
];

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

async function fetchAs(url, ua, timeout) {
  const started = Date.now();
  try {
    const res = await axios.get(url, {
      timeout,
      headers: { 'User-Agent': ua, 'Accept': ACCEPT, 'Accept-Language': 'en-US,en;q=0.9' },
      maxRedirects: 8,
      responseType: 'text',
      transformResponse: [d => d],
      validateStatus: () => true
    });
    const body = typeof res.data === 'string' ? res.data : '';
    const finalUrl = res.request?.res?.responseUrl || url;
    return { status: res.status, size: body.length, body, headers: res.headers || {}, finalUrl, ms: Date.now() - started, error: null };
  } catch (err) {
    return { status: null, size: 0, body: '', headers: {}, finalUrl: url, ms: Date.now() - started, error: err.code || err.message || 'request failed' };
  }
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch (e) { return ''; } };

/**
 * Probe `url` with a browser UA (baseline), then once per AI bot UA. Requests
 * are strictly sequential and spaced — bot user agents are exactly what
 * rate-limiting firewalls watch for.
 *
 * Firewalls such as Imunify360 answer a blocked bot UA with a 403 AND, after a
 * few of those, greylist the requesting IP: from then on every request from
 * this server (browser UA included) gets a JS challenge. So whenever a bot is
 * not served normally the browser baseline is re-checked straight away:
 *   - browser still fine  → the refusal is specific to that bot's user agent
 *   - browser now refused → this server's IP was flagged; the test stops (more
 *     bot requests would only deepen the flag) and the rest is "not tested".
 *
 * options:
 *   timeout          per-request timeout in ms (default 15000)
 *   delayMs          pause between requests when no `throttle` is given (default 1000)
 *   throttle         async fn awaited before every request (crawler's own pacing)
 *   isAborted        fn → true to stop early
 *   detectChallenge  fn(response, html) → WAF vendor name or null
 *
 * Per-bot verdicts:
 *   allowed       same kind of answer as the browser got
 *   blocked       HTTP error (403/429/…) or dropped connection, browser was fine
 *   challenged    WAF challenge / captcha page instead of the content
 *   different     2xx but another site or a far smaller page (possible soft block)
 *   inconclusive  the browser request is refused too — nothing to compare against
 *   not_tested    test stopped before reaching this bot
 */
async function probeAiBotAccess(url, options = {}) {
  const timeout = options.timeout || 15000;
  const delayMs = options.delayMs == null ? 1000 : options.delayMs;
  const isAborted = options.isAborted || (() => false);
  const detectChallenge = options.detectChallenge || (() => null);
  const pace = options.throttle || (() => new Promise(r => setTimeout(r, delayMs)));

  // Classify one response on its own: ok | error | challenge | http
  const kindOf = (r) => {
    if (r.error) return { kind: 'error', label: `connection failed (${r.error})` };
    const ch = detectChallenge(r, r.body);
    if (ch) return { kind: 'challenge', vendor: ch, label: `${ch} challenge page (HTTP ${r.status})` };
    if (r.status >= 400) return { kind: 'http', label: `HTTP ${r.status}` };
    return { kind: 'ok', label: `HTTP ${r.status}` };
  };
  const summarize = (r, k) => ({ status: r.status, size: r.size, finalUrl: r.finalUrl, error: r.error, ok: k.kind === 'ok', label: k.label, challenge: k.vendor || null });

  let baseline = await fetchAs(url, BROWSER_UA, timeout);
  let baseKind = kindOf(baseline);

  const out = {
    url,
    testedAt: new Date().toISOString(),
    baseline: summarize(baseline, baseKind),
    ipFlaggedDuringTest: false,
    stoppedReason: null,
    results: []
  };
  const probeable = AI_BOTS.filter(b => b.ua);
  const push = (bot, verdict, detail, r, k) => out.results.push({
    name: bot.name, verdict, detail,
    httpStatus: r ? r.status : null, size: r ? r.size : null, error: r ? r.error : null,
    challenge: (k && k.vendor) || null, ms: r ? r.ms : null
  });

  if (baseKind.kind !== 'ok') {
    out.stoppedReason = `A normal browser request from this server is refused (${baseKind.label}), so bot user agents cannot be compared. The site's firewall is blocking or challenging this server's IP.`;
    for (const bot of probeable) push(bot, 'inconclusive', `Browser request refused too: ${baseKind.label}`, null, null);
    return out;
  }

  // Softer signals than an outright refusal: landed on another host, or a
  // page far smaller than the browser's.
  const softDiff = (r) => {
    if (hostOf(r.finalUrl) !== hostOf(baseline.finalUrl)) return `Redirected to ${r.finalUrl} (a browser lands on ${baseline.finalUrl})`;
    if (baseline.size > 2000 && r.size < baseline.size * 0.3) return `HTTP ${r.status} but only ${r.size} bytes vs ${baseline.size} for a browser — possible soft block`;
    return null;
  };

  for (let i = 0; i < probeable.length; i++) {
    const bot = probeable[i];
    if (isAborted()) { out.stoppedReason = 'Test stopped.'; break; }
    await pace();
    let r = await fetchAs(url, bot.ua, timeout);
    let k = kindOf(r);
    if (k.kind === 'ok' && !softDiff(r)) { push(bot, 'allowed', k.label, r, k); continue; }

    // Not served normally — is it this bot's UA, or has our IP been flagged?
    await pace();
    const chk = await fetchAs(url, BROWSER_UA, timeout);
    const chkKind = kindOf(chk);

    if (chkKind.kind === 'ok') {
      baseline = chk; baseKind = chkKind;
      if (k.kind === 'error') {
        // One retry so a single network hiccup isn't read as a block
        await pace();
        r = await fetchAs(url, bot.ua, timeout);
        k = kindOf(r);
      }
      const soft = k.kind === 'ok' ? softDiff(r) : null;
      if (k.kind === 'ok' && !soft) push(bot, 'allowed', k.label, r, k);
      else if (k.kind === 'ok') push(bot, 'different', soft, r, k);
      else if (k.kind === 'challenge') push(bot, 'challenged', `${k.label} — a browser gets HTTP ${chk.status}`, r, k);
      else push(bot, 'blocked', `${k.label.replace(/^c/, 'C')} — a browser gets HTTP ${chk.status}`, r, k);
      continue;
    }

    // Browser refused now as well → this server's IP got flagged.
    out.ipFlaggedDuringTest = true;
    const sameAsBrowser = k.kind === chkKind.kind && r.status === chk.status;
    if (sameAsBrowser || k.kind === 'ok') {
      push(bot, 'inconclusive', `${k.label} — but a browser request from this server now gets the same, so it is not specific to this bot`, r, k);
    } else {
      // e.g. bot → 403, browser → JS challenge: the 403 was for the bot's UA
      push(bot, k.kind === 'challenge' ? 'challenged' : 'blocked', `${k.label.replace(/^c/, 'C')} — a browser got HTTP ${out.baseline.status} just before`, r, k);
    }
    out.stoppedReason = `The site's firewall started refusing this server entirely (${chkKind.label} for a browser user agent) after the ${bot.name} request — typical of Imunify360-style IP greylisting triggered by blocked bot user agents. Remaining bots were not tested.`;
    for (const rest of probeable.slice(i + 1)) push(rest, 'not_tested', 'Test stopped — this server\'s IP was flagged by the site\'s firewall', null, null);
    break;
  }
  return out;
}

module.exports = { AI_BOTS, BROWSER_UA, probeAiBotAccess };
