// AI Visibility — ask real AI answer engines (Claude, ChatGPT, Perplexity) a
// query with web search enabled, and check whether a given domain is among the
// cited sources. This is the "rank tracker" equivalent for AI answers.
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const HTTP_TIMEOUT = 120000;

function normalizeDomain(d) {
  return String(d || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

function urlMatchesDomain(url, domain) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return h === domain || h.endsWith('.' + domain);
  } catch { return false; }
}

// Dedupe citations by URL, preserving first-seen order (= citation position).
function dedupeCitations(citations) {
  const seen = new Set();
  const out = [];
  for (const c of citations) {
    if (!c || !c.url) continue;
    const key = c.url.replace(/[#?].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: c.url, title: c.title || null });
  }
  return out;
}

// ── Engines ──────────────────────────────────────────────────────────────────

// Anthropic Claude with the server-side web search tool. Citations come from
// web_search_tool_result blocks (the pages found) and from url citations
// attached to the answer's text blocks (the pages actually cited — put first).
async function queryAnthropic(apiKey, query) {
  const client = new Anthropic({ apiKey, timeout: HTTP_TIMEOUT });
  // Server-side fallback: if Claude Opus 5's safety classifiers decline the
  // query (rare for SEO queries, but possible), the API retries it on the
  // recommended fallback model instead of returning an empty refusal.
  // Streamed, not a plain create: a web-search turn can run for minutes, and a
  // non-streaming request that long sits silent until it either returns or trips
  // an HTTP timeout somewhere in the chain.
  const stream = client.beta.messages.stream({
    model: 'claude-opus-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: query }]
  });
  const resp = await stream.finalMessage();

  if (resp.stop_reason === 'refusal') {
    return { answer: '', citations: [], error: 'Claude declined to answer this query' };
  }

  const cited = [];
  const found = [];
  let answer = '';
  for (const block of resp.content || []) {
    if (block.type === 'text') {
      answer += block.text;
      for (const c of block.citations || []) {
        if (c.url) cited.push({ url: c.url, title: c.title });
      }
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      // error results have an object content instead of an array — skip those
      for (const r of block.content) {
        if (r.type === 'web_search_result' && r.url) found.push({ url: r.url, title: r.title });
      }
    }
  }
  // Cited-in-answer sources rank ahead of merely-found ones
  return { answer, citations: dedupeCitations([...cited, ...found]) };
}

// OpenAI Responses API with web search. Citations come from url_citation
// annotations on the output text.
async function queryOpenAI(apiKey, query) {
  const resp = await axios.post('https://api.openai.com/v1/responses', {
    model: 'gpt-4o-mini',
    tools: [{ type: 'web_search_preview' }],
    input: query
  }, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: HTTP_TIMEOUT
  });

  const citations = [];
  let answer = '';
  for (const item of resp.data.output || []) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) {
      if (c.type !== 'output_text') continue;
      answer += c.text || '';
      for (const a of c.annotations || []) {
        if (a.type === 'url_citation' && a.url) citations.push({ url: a.url, title: a.title });
      }
    }
  }
  return { answer, citations: dedupeCitations(citations) };
}

// Perplexity (sonar) — returns search_results / citations arrays directly.
async function queryPerplexity(apiKey, query) {
  const resp = await axios.post('https://api.perplexity.ai/chat/completions', {
    model: 'sonar',
    messages: [{ role: 'user', content: query }]
  }, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: HTTP_TIMEOUT
  });

  const citations = [];
  for (const r of resp.data.search_results || []) {
    if (r.url) citations.push({ url: r.url, title: r.title });
  }
  for (const u of resp.data.citations || []) {
    if (typeof u === 'string') citations.push({ url: u });
  }
  const answer = resp.data.choices?.[0]?.message?.content || '';
  return { answer, citations: dedupeCitations(citations) };
}

const ENGINES = {
  anthropic: { label: 'Claude', run: queryAnthropic },
  openai: { label: 'ChatGPT', run: queryOpenAI },
  perplexity: { label: 'Perplexity', run: queryPerplexity }
};

// Run one query against one engine and report whether `domain` was cited.
async function checkVisibility(engine, apiKey, query, domain) {
  const eng = ENGINES[engine];
  if (!eng) throw new Error(`Unknown engine: ${engine}`);
  const dom = normalizeDomain(domain);
  const { answer, citations, error } = await eng.run(apiKey, query);
  const idx = citations.findIndex(c => urlMatchesDomain(c.url, dom));
  return {
    engine,
    engineLabel: eng.label,
    query,
    domain: dom,
    cited: idx >= 0,
    position: idx >= 0 ? idx + 1 : null,
    totalCitations: citations.length,
    citations: citations.slice(0, 10),
    matchedUrl: idx >= 0 ? citations[idx].url : null,
    answerExcerpt: (answer || '').slice(0, 500),
    error: error || null
  };
}

module.exports = { checkVisibility, normalizeDomain, ENGINES };
