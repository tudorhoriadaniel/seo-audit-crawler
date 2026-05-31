// Google Search Console integration: OAuth2 + Search Console API client.
// Uses axios (already a dependency) so we don't pull in the heavy googleapis SDK.

const axios = require('axios');
const crypto = require('crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
].join(' ');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';

function getClientConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  return { clientId, clientSecret, redirectUri };
}

function isConfigured() {
  const { clientId, clientSecret, redirectUri } = getClientConfig();
  return !!(clientId && clientSecret && redirectUri);
}

function generateState() {
  return crypto.randomBytes(24).toString('hex');
}

function buildAuthUrl(state) {
  const { clientId, redirectUri } = getClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = getClientConfig();
  const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return normaliseTokenResponse(data);
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getClientConfig();
  try {
    const { data } = await axios.post(TOKEN_URL, new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true });
    // Google returns 400 with body { error: "invalid_grant" } when the
    // refresh token is revoked or expired (test-mode tokens expire after
    // 7 days, prod tokens after 6 months of inactivity or if the user
    // revokes access at myaccount.google.com). Surface a distinct
    // error so callers can clear the stored creds and prompt re-auth.
    if (data && data.error) {
      const err = new Error(data.error_description || data.error);
      err.code = 'OAUTH_' + String(data.error).toUpperCase();
      err.oauthInvalid = data.error === 'invalid_grant' || data.error === 'invalid_token';
      throw err;
    }
    // Google usually doesn't re-issue refresh_token on refresh; keep old one.
    const normalised = normaliseTokenResponse(data);
    if (!normalised.refresh_token) normalised.refresh_token = refreshToken;
    return normalised;
  } catch (e) {
    if (e && e.code && e.code.startsWith('OAUTH_')) throw e;
    // Network error or anything else — wrap so caller can decide.
    const err = new Error(e.message || 'token refresh failed');
    err.code = 'OAUTH_NETWORK';
    throw err;
  }
}

function normaliseTokenResponse(data) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: now + (data.expires_in || 3600) - 60,
    scope: data.scope || SCOPES,
    token_type: data.token_type || 'Bearer'
  };
}

async function fetchUserEmail(accessToken) {
  try {
    const { data } = await axios.get(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    return data.email || null;
  } catch {
    return null;
  }
}

async function getValidAccessToken(tokens, onRefresh) {
  const now = Math.floor(Date.now() / 1000);
  if (tokens.access_token && tokens.expires_at > now) return tokens;
  if (!tokens.refresh_token) {
    throw new Error('Access token expired and no refresh token available. Please re-authenticate.');
  }
  const fresh = await refreshAccessToken(tokens.refresh_token);
  const merged = { ...tokens, ...fresh };
  if (onRefresh) await onRefresh(merged);
  return merged;
}

async function revokeToken(token) {
  if (!token) return;
  try {
    await axios.post(REVOKE_URL, new URLSearchParams({ token }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  } catch { /* best-effort */ }
}

// ── Search Console API ──

async function listSites(accessToken) {
  const { data } = await axios.get(`${GSC_BASE}/sites`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return data.siteEntry || [];
}

async function searchAnalyticsQuery(accessToken, siteUrl, body) {
  const encoded = encodeURIComponent(siteUrl);
  const { data } = await axios.post(
    `${GSC_BASE}/sites/${encoded}/searchAnalytics/query`,
    body,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return data;
}

async function listSitemaps(accessToken, siteUrl) {
  const encoded = encodeURIComponent(siteUrl);
  const { data } = await axios.get(`${GSC_BASE}/sites/${encoded}/sitemaps`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return data.sitemap || [];
}

module.exports = {
  isConfigured,
  getClientConfig,
  generateState,
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getValidAccessToken,
  fetchUserEmail,
  revokeToken,
  listSites,
  searchAnalyticsQuery,
  listSitemaps
};
