// Keyword coverage analyser: given a URL and a set of queries the page
// ranks for, fetch the live HTML and compute where (and how often) each
// query actually appears in the page. Used by the Content Strategy tab
// to surface "this page ranks for X but X is nowhere on the page" gaps.

const axios = require('axios');
const cheerio = require('cheerio');

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024;     // 5 MB
const CACHE_TTL_MS = 10 * 60 * 1000;   // 10 minutes

const cache = new Map();   // url → { at, data }

function normaliseText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystackNorm, needleNorm) {
  if (!needleNorm) return 0;
  const re = new RegExp(escapeRegex(needleNorm), 'g');
  let n = 0;
  while (re.exec(haystackNorm)) {
    n++;
    if (re.lastIndex === re.lastIndex - 0) re.lastIndex++;   // safety
  }
  return n;
}

// True if every word in `needle` (as a separate token) appears in `haystack`.
function allWordsPresent(haystackNorm, needleNorm) {
  const words = needleNorm.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every(w => new RegExp('\\b' + escapeRegex(w) + '\\b').test(haystackNorm));
}

async function fetchPage(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const res = await axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    responseType: 'text',
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ContentStrategyBot/1.0; +https://seo.converta.ro)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const data = {
    status: res.status,
    finalUrl: res.request?.res?.responseUrl || url,
    contentType: res.headers['content-type'] || '',
    html: typeof res.data === 'string' ? res.data : ''
  };
  cache.set(url, { at: Date.now(), data });
  return data;
}

function extractSections(html) {
  const $ = cheerio.load(html);

  // Remove non-content noise so word counts and body matches aren't polluted.
  $('script, style, noscript, template, svg').remove();

  const title = ($('title').first().text() || '').trim();
  const metaDescription = ($('meta[name="description"]').attr('content') || '').trim();
  const h1 = [];
  $('h1').each((_, el) => h1.push($(el).text().trim()));
  const headings = [];
  $('h2, h3, h4, h5, h6').each((_, el) => headings.push($(el).text().trim()));

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  return { title, metaDescription, h1, headings, bodyText, wordCount };
}

function analyseQuery(query, sections) {
  const q = normaliseText(query);
  if (!q) return null;
  const titleN = normaliseText(sections.title);
  const metaN = normaliseText(sections.metaDescription);
  const h1N = sections.h1.map(normaliseText).join(' ');
  const headingsN = sections.headings.map(normaliseText).join(' ');
  const bodyN = normaliseText(sections.bodyText);

  const phrase = {
    inTitle: titleN.includes(q),
    inMetaDescription: metaN.includes(q),
    inH1: h1N.includes(q),
    inHeadings: headingsN.includes(q),
    bodyOccurrences: countOccurrences(bodyN, q)
  };
  const looseMatch = {
    titleAllWords: allWordsPresent(titleN, q),
    metaAllWords: allWordsPresent(metaN, q),
    h1AllWords: allWordsPresent(h1N, q),
    bodyAllWords: allWordsPresent(bodyN, q)
  };

  // Density: share of body words that are part of phrase matches.
  const phraseWords = q.split(/\s+/).filter(Boolean).length;
  const density = sections.wordCount > 0
    ? (phrase.bodyOccurrences * phraseWords / sections.wordCount) * 100
    : 0;

  return {
    query,
    phrase,
    looseMatch,
    density: Number(density.toFixed(3)),
    presentSomewhere: phrase.inTitle || phrase.inMetaDescription || phrase.inH1 || phrase.inHeadings || phrase.bodyOccurrences > 0 || looseMatch.bodyAllWords
  };
}

async function analyse(url, queries) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Invalid URL');
  const page = await fetchPage(url);
  if (page.status >= 400) {
    return { url, status: page.status, error: `HTTP ${page.status}` };
  }
  if (!/text\/html/i.test(page.contentType)) {
    return { url, status: page.status, error: 'Page is not HTML (' + (page.contentType || 'unknown content-type') + ')' };
  }
  const sections = extractSections(page.html);
  const analysed = (queries || []).map(q => analyseQuery(q, sections)).filter(Boolean);

  return {
    url,
    finalUrl: page.finalUrl,
    status: page.status,
    title: sections.title,
    metaDescription: sections.metaDescription,
    metaDescriptionLength: (sections.metaDescription || '').length,
    h1: sections.h1,
    wordCount: sections.wordCount,
    queries: analysed
  };
}

module.exports = { analyse };
