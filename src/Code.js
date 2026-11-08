/**
 * ga4-gas: GA4 Data API bridge.
 *
 * Runs as a Web app under the owner's Google account and returns GA4
 * Data API runReport results as JSON.
 *
 * Query parameters:
 *   start      (default "28daysAgo") - GA4 date expression or YYYY-MM-DD
 *   end        (default "today")
 *   metrics    (default "screenPageViews,activeUsers,sessions") - comma separated
 *   dimensions (default "pagePath") - comma separated; empty means totals only
 *   limit      (default 25)
 *   offset     (default 0) - row offset for paging together with limit
 *   filter     - dimension filter clauses separated by ";", each clause is
 *                "<dimension>:<matchType>:<value>", matchType is one of
 *                exact / contains / beginsWith / endsWith / regexp.
 *                Multiple clauses are combined with AND. Example:
 *                filter=pagePath:contains:/blog/;sessionDefaultChannelGroup:exact:Organic Search
 *
 * Actions:
 *   action=music_count - a public action: returns only the
 *                cumulative music_play event count and its timestamp
 *                (cached for about an hour).
 *   action=top_articles - a public action: returns only the top
 *                few blog articles of the last 28 days (article id
 *                and view count, cached for about an hour). Every
 *                other request, including the default report,
 *                requires authentication once it is configured
 *                (see below).
 *
 * The GA4 property ID comes from the Script Property GA4_PROPERTY_ID,
 * so it is never written in the source (see README "Setup").
 */

const GA4_API_BASE = 'https://analyticsdata.googleapis.com/v1beta/properties/';
const FRONTEND_URL = 'https://freddiefujiwara.com/ga/';
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

// --- Public music play count (action=music_count) ---
// The one deliberately unauthenticated action: the site header on
// every page shows the cumulative music_play count, and a public
// page cannot hold a credential. It returns exactly two values —
// the total eventCount of the music_play event since the event was
// introduced (2026-11-08) and when that total was produced — and
// nothing else. Results are cached in CacheService so the GA4 Data
// API is hit at most about once an hour no matter how often the
// action is called.
const MUSIC_COUNT_CACHE_KEY = 'music_count_v1';
const MUSIC_COUNT_CACHE_SECONDS = 60 * 60;
const MUSIC_PLAY_START_DATE = '2026-11-08';

function fetchMusicCount_(propertyId) {
  const cache =
    typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null;
  if (cache) {
    const cached = cache.get(MUSIC_COUNT_CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && Number.isFinite(parsed.count) && parsed.updated_at) {
          return parsed;
        }
      } catch (error) {
        // A corrupt cache entry is ignored; a fresh value is fetched.
      }
    }
  }
  const body = buildReportRequest_({
    startDate: MUSIC_PLAY_START_DATE,
    endDate: 'today',
    metrics: ['eventCount'],
    dimensions: [],
    limit: 1,
    offset: 0,
    filters: parseFilterClauses_('eventName:exact:music_play'),
  });
  const result = fetchReport_(propertyId, body);
  if (result.status !== 200) {
    throw new Error('GA4 API request failed with status ' + result.status);
  }
  let count = 0;
  const rows = (result.data && result.data.rows) || [];
  if (rows.length > 0) {
    const metricValues = rows[0].metricValues || [];
    const value = Number(metricValues[0] && metricValues[0].value);
    count = Number.isFinite(value) ? value : 0;
  }
  const payload = { count, updated_at: new Date().toISOString() };
  if (cache) {
    cache.put(
      MUSIC_COUNT_CACHE_KEY,
      JSON.stringify(payload),
      MUSIC_COUNT_CACHE_SECONDS
    );
  }
  return payload;
}

// --- Public top articles (action=top_articles) ---
// The second deliberately unauthenticated action: the top page's
// "よく読まれている記事" section is baked at build time from this
// ranking, and a public page cannot hold a credential. It returns
// exactly the top few blog articles of the last 28 days — article
// id and view count, nothing else. Results are cached in
// CacheService so the GA4 Data API is hit at most about once an
// hour no matter how often the action is called.
//
// Article paths are recorded both as /<id> (the SPA's
// base-relative route) and as /blog/<id> (the real URL); the two
// forms are merged before ranking, the same rule the /ga screen
// applies in its page ranking.
const TOP_ARTICLES_CACHE_KEY = 'top_articles_v1';
const TOP_ARTICLES_CACHE_SECONDS = 60 * 60;
const TOP_ARTICLES_DAYS = 28;
const TOP_ARTICLES_LIMIT = 10;
const TOP_ARTICLES_FETCH_LIMIT = 1000;
const ARTICLE_ID_PATTERN = /^[0-9][A-Za-z0-9_-]{24,}$/;

// The blog article id a pagePath belongs to, or '' when the path
// is not a blog article. Article ids are the long URL-safe
// document tokens (they start with a digit); app pages such as
// /list-of-stuff/ are not articles.
function articleIdFromPath_(path) {
  const id = String(path || '')
    .replace(/^\/(blog\/)?/, '')
    .replace(/\/$/, '');
  return ARTICLE_ID_PATTERN.test(id) ? id : '';
}

// Merge GA report rows (pagePath x screenPageViews) into the
// article ranking: split paths summed per article, sorted by
// views descending, cut to the top `limit`.
function rankTopArticles_(rows, limit) {
  const merged = new Map();
  (rows || []).forEach((row) => {
    const dimensionValues = row.dimensionValues || [];
    const metricValues = row.metricValues || [];
    const id = articleIdFromPath_(
      dimensionValues[0] && dimensionValues[0].value
    );
    if (!id) return;
    const views = Number(metricValues[0] && metricValues[0].value) || 0;
    merged.set(id, (merged.get(id) || 0) + views);
  });
  return Array.from(merged.entries())
    .map(([id, views]) => ({ id, views }))
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}

function fetchTopArticles_(propertyId) {
  const cache =
    typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null;
  if (cache) {
    const cached = cache.get(TOP_ARTICLES_CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.articles) && parsed.updated_at) {
          return parsed;
        }
      } catch (error) {
        // A corrupt cache entry is ignored; a fresh value is fetched.
      }
    }
  }
  const body = buildReportRequest_({
    startDate: '28daysAgo',
    endDate: 'today',
    metrics: ['screenPageViews'],
    dimensions: ['pagePath'],
    limit: TOP_ARTICLES_FETCH_LIMIT,
    offset: 0,
    filters: [],
  });
  const result = fetchReport_(propertyId, body);
  if (result.status !== 200) {
    throw new Error('GA4 API request failed with status ' + result.status);
  }
  const payload = {
    days: TOP_ARTICLES_DAYS,
    articles: rankTopArticles_(
      (result.data && result.data.rows) || [],
      TOP_ARTICLES_LIMIT
    ),
    updated_at: new Date().toISOString(),
  };
  if (cache) {
    cache.put(
      TOP_ARTICLES_CACHE_KEY,
      JSON.stringify(payload),
      TOP_ARTICLES_CACHE_SECONDS
    );
  }
  return payload;
}

// --- Authentication (same scheme as the other apps: health / asset / tweet) ---
// Script Properties:
//   GOOGLE_OAUTH_CLIENT_ID: OAuth client ID used to verify ID tokens
//   AVAILABLE_GMAILS: comma-separated emails allowed to read the data
// Data requests accept either a verified Google ID token (id_token
// parameter or Authorization: Bearer header) or a temporary share token
// (share_token parameter). The share token travels in the frontend URL
// hash fragment (#share=...), so it never reaches servers or referrers.
// issue_share / revoke_share actions require an ID token.
// While the two properties above are unset, authentication is skipped
// (migration period only; production runs with them set).

function getScriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function isAuthConfigured_() {
  return Boolean(getScriptProperty_('GOOGLE_OAUTH_CLIENT_ID')) &&
    getAllowedEmails_().length > 0;
}

function extractIdToken_(e) {
  const headers = (e && e.headers) || {};
  const auth = headers.Authorization || headers.authorization || '';
  const bearerMatch = String(auth).match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1];
  }
  return (e && e.parameter && e.parameter.id_token) || '';
}

function getAllowedEmails_() {
  return getScriptProperty_('AVAILABLE_GMAILS')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function verifyGoogleIdTokenOrThrow_(idToken) {
  if (!idToken) {
    throw new Error('missing id token');
  }
  const oauthClientId = getScriptProperty_('GOOGLE_OAUTH_CLIENT_ID');
  if (!oauthClientId) {
    throw new Error('missing GOOGLE_OAUTH_CLIENT_ID');
  }
  const response = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) {
    throw new Error('token verification failed');
  }
  const payload = JSON.parse(response.getContentText());
  const validIssuer =
    payload.iss === 'accounts.google.com' || payload.iss === 'https://accounts.google.com';
  if (!validIssuer) {
    throw new Error('invalid iss');
  }
  if (payload.aud !== oauthClientId) {
    throw new Error('invalid aud');
  }
  const expSeconds = Number(payload.exp || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expSeconds) || expSeconds <= nowSeconds) {
    throw new Error('token expired');
  }
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!emailVerified) {
    throw new Error('email not verified');
  }
  const email = String(payload.email || '').toLowerCase();
  if (!email) {
    throw new Error('missing email');
  }
  if (!getAllowedEmails_().includes(email)) {
    throw new Error('forbidden email');
  }
  return { email, sub: payload.sub };
}

// --- Temporary share sessions ---
// Only the SHA-256 hash and the expiry are stored, in Script Properties.
// Issuing a new token overwrites the old one, which invalidates old links.

function hashShareToken_(token) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token))
    .map((byte) => ((byte % 256) + 256) % 256)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function issueShareSession_() {
  const now = new Date();
  const expires = new Date(now.getTime() + SHARE_TTL_SECONDS * 1000);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SHARE_TOKEN_HASH', hashShareToken_(token));
  props.setProperty('SHARE_EXPIRES_AT', expires.toISOString());
  return {
    share_token: token,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
    ttl_seconds: SHARE_TTL_SECONDS,
  };
}

function revokeShareSession_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('SHARE_TOKEN_HASH');
  props.deleteProperty('SHARE_EXPIRES_AT');
  return { revoked: true };
}

function validateShareToken_(token) {
  if (!token) {
    return null;
  }
  const props = PropertiesService.getScriptProperties();
  const hash = props.getProperty('SHARE_TOKEN_HASH');
  if (!hash || hashShareToken_(token) !== hash) {
    return null;
  }
  const expiresAt = props.getProperty('SHARE_EXPIRES_AT');
  if (!expiresAt || expiresAt <= new Date().toISOString()) {
    return null;
  }
  return { expires_at: expiresAt };
}

// Editor helper: issue a token and log the frontend share URL.
// Useful for bootstrapping before the frontend is deployed.
function issueShareToken() {
  const session = issueShareSession_();
  const url = FRONTEND_URL + '#share=' + session.share_token;
  console.log('Share URL (expires ' + session.expires_at + '): ' + url);
  return url;
}
// --- SNS follower counts (YouTube / Instagram / Threads) ---
// collectSnsCounts() runs on a time-driven trigger (see setupSnsTriggers)
// and stores a snapshot in the Script Property SNS_COUNTS_SNAPSHOT.
// The action=sns_counts endpoint is public by design: it only ever
// returns the public projection of that snapshot (follower counts,
// the Instagram KPIs, collected_at). It never exposes tokens, any
// GA4 data, or the admin-only detail in the snapshot; the full
// snapshot is served by action=sns_detail behind the usual
// authentication gate (see buildSnsDetailResponse_).
//
// Script Properties used here:
//   META_ACCESS_TOKEN: Meta long-lived user token (about 60 days) used
//     for the Instagram accounts through graph.facebook.com.
//   META_APP_ID / META_APP_SECRET: when both are set, the token above is
//     refreshed with fb_exchange_token before it gets close to expiry.
//   META_TOKEN_EXPIRES_AT: ISO timestamp of the token expiry, maintained
//     by refreshMetaTokenIfNeeded_().
//   META_THREADS_ACCESS_TOKEN (optional): Threads long-lived token, used
//     for graph.threads.net when set (Threads tokens are issued per app
//     through the Threads use case, separately from Facebook tokens).
//     Falls back to META_ACCESS_TOKEN when unset. When its expiry is
//     recorded in META_THREADS_TOKEN_EXPIRES_AT, it is refreshed with
//     th_refresh_token in the same way.
//   THREADS_APP_ID / THREADS_APP_SECRET (optional): credentials of the
//     dedicated Threads app (use case "Access the Threads API").
//     THREADS_APP_ID is the Threads app ID shown at the top of the
//     Threads API Settings screen — the OAuth client_id — which is
//     NOT the Meta app ID. When
//     set, the Threads token above can be obtained entirely inside
//     GAS: run threadsAuthorizeUrl() in the editor, open the logged
//     URL, and approve; the OAuth callback lands on this Web App's
//     /exec (see handleThreadsOAuthCallback_) and stores the
//     long-lived token in META_THREADS_ACCESS_TOKEN, the Threads user
//     id in THREADS_USER_ID and the acquisition time in
//     THREADS_TOKEN_AT. refreshThreadsTokenIfNeeded() renews the
//     token with th_refresh_token once it is 50+ days old, so no
//     manual re-authorization is needed while the collections keep
//     running. THREADS_REDIRECT_URI may override the redirect URI
//     (default: this Web App's own /exec URL); the same URI must be
//     registered in the Threads app's settings.
//   SNS_HISTORY_SHEET_ID (optional): spreadsheet that receives one
//     history row per collection (see appendSnsHistory_). Unset means
//     no history is written.
// The Instagram snapshot also carries account KPIs for the main
// account: media_count (post count, available with instagram_basic)
// plus views_30d / non_follower_pct from the account insights, which
// stay null until the token also has instagram_manage_insights.
// When the insights calls fail, instagram.insights_error holds a
// short secret-free summary of the API error (null on success) so the
// failure is visible in the snapshot instead of silently null.

const SNS_SNAPSHOT_PROPERTY = 'SNS_COUNTS_SNAPSHOT';
const SNS_YOUTUBE_CHANNEL_ID = 'UCbiDZXbr391oT_vsRiqwPFg';
const SNS_INSTAGRAM_MAIN_ID = '17841401041540002'; // @freddiefujiwara
const SNS_INSTAGRAM_SUB_ID = '17841434285478967'; // @anemone_cancer
const SNS_THREADS_USER_ID = '17841462976834295'; // @freddiefujiwara
const META_GRAPH_BASE = 'https://graph.facebook.com/v25.0/';
const THREADS_GRAPH_BASE = 'https://graph.threads.net/v1.0/';
const SNS_TOKEN_REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

function getSnsCountsSnapshot_() {
  const raw = getScriptProperty_(SNS_SNAPSHOT_PROPERTY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// The public sns_counts response is a fixed projection of the
// snapshot: only the follower/KPI fields the top page consumes. The
// snapshot itself also carries the admin-only detail collected for
// action=sns_detail (account insights, demographics, per-post and
// per-video numbers); those must never leak into the public action,
// so the snapshot is never returned verbatim here.
function buildSnsCountsResponse_() {
  const snapshot = getSnsCountsSnapshot_();
  if (!snapshot) {
    return {
      ok: true,
      action: 'sns_counts',
      collected_at: null,
      youtube: { subscribers: null },
      instagram: {
        freddiefujiwara: null,
        anemone_cancer: null,
        media_count: null,
        views_30d: null,
        non_follower_pct: null,
        insights_error: null,
      },
      threads: { followers: null },
    };
  }
  const youtube = snapshot.youtube || {};
  const instagram = snapshot.instagram || {};
  const threads = snapshot.threads || {};
  return {
    ok: true,
    action: 'sns_counts',
    collected_at: snapshot.collected_at || null,
    youtube: { subscribers: snsNumberOrNull_(youtube.subscribers) },
    instagram: {
      freddiefujiwara: snsNumberOrNull_(instagram.freddiefujiwara),
      anemone_cancer: snsNumberOrNull_(instagram.anemone_cancer),
      media_count: snsNumberOrNull_(instagram.media_count),
      views_30d: snsNumberOrNull_(instagram.views_30d),
      non_follower_pct: snsNumberOrNull_(instagram.non_follower_pct),
      insights_error:
        instagram.insights_error != null ? instagram.insights_error : null,
    },
    threads: { followers: snsNumberOrNull_(threads.followers) },
  };
}

function snsNumberOrNull_(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Default detail payload served by action=sns_detail before the
// first collection: the full key set with null values, so the /ga
// frontend can rely on the shape.
function buildEmptySnsDetail_() {
  return {
    collected_at: null,
    youtube: {
      subscribers: null,
      total_views: null,
      video_count: null,
      recent_videos: null,
      youtube_error: null,
    },
    instagram: {
      freddiefujiwara: null,
      anemone_cancer: null,
      media_count: null,
      views_30d: null,
      non_follower_pct: null,
      insights_error: null,
      reach_30d: null,
      accounts_engaged_30d: null,
      interactions_30d: {
        total: null,
        likes: null,
        comments: null,
        shares: null,
        saves: null,
      },
      profile_links_taps_30d: null,
      profile_links_taps_source: null,
      follows_30d: null,
      unfollows_30d: null,
      demographics: { age_gender: null, top_cities: null, top_countries: null },
      detail_error: null,
      recent_media: null,
      media_error: null,
    },
    threads: { followers: null, threads_error: null },
  };
}

// action=sns_detail (authenticated): the full stored snapshot for
// the /ga admin screen. Before the first collection it serves the
// empty shape above.
function buildSnsDetailResponse_() {
  const snapshot = getSnsCountsSnapshot_();
  if (!snapshot) {
    return Object.assign({ ok: true, action: 'sns_detail' }, buildEmptySnsDetail_());
  }
  return Object.assign({ ok: true, action: 'sns_detail' }, snapshot);
}

function fetchGraphFollowersCount_(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return null;
    }
    const data = JSON.parse(res.getContentText());
    const count = Number(data && data.followers_count);
    return Number.isFinite(count) ? count : null;
  } catch (err) {
    return null;
  }
}

function fetchInstagramFollowers_(userId) {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return null;
  }
  return fetchGraphFollowersCount_(
    META_GRAPH_BASE +
      userId +
      '?fields=followers_count&access_token=' +
      encodeURIComponent(token)
  );
}

// The one Threads insights request both the production fetch and
// debugThreadsFollowers make: the followers_count metric on the
// user's threads_insights edge. The URL carries no token; callers
// append '&access_token=...' themselves so the diagnostic can print
// the request with the token redacted.
function threadsFollowersInsightsUrl_(userId) {
  return THREADS_GRAPH_BASE + userId + '/threads_insights?metric=followers_count';
}

function fetchThreadsFollowers_() {
  const token =
    getScriptProperty_('META_THREADS_ACCESS_TOKEN') ||
    getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return null;
  }
  // The OAuth flow stores the authorized account's Threads user id in
  // THREADS_USER_ID; the constant is only the pre-OAuth fallback.
  const userId = getScriptProperty_('THREADS_USER_ID') || SNS_THREADS_USER_ID;
  try {
    const res = UrlFetchApp.fetch(
      threadsFollowersInsightsUrl_(userId) +
        '&access_token=' +
        encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      return null;
    }
    return parseThreadsFollowersCount_(JSON.parse(res.getContentText()));
  } catch (err) {
    return null;
  }
}

// Reads the followers count out of a threads_insights response for
// metric=followers_count, or null. followers_count does not exist as
// a field on the Threads user node — the profile request
// ?fields=followers_count fails with HTTP 500 "Tried accessing
// nonexisting field (followers_count)" (THApiException code 100,
// diagnosed in production on 2026-11-09) — so the count only comes
// from this insights edge. The metric is a current total, not a
// per-day flow: total_value.value wins when present, otherwise the
// newest values[] entry is the count. The values are never summed
// the way daily view counts are. Error bodies and any other shape
// read as null.
function parseThreadsFollowersCount_(data) {
  const totalValue = parseInsightsTotalValue_(data);
  if (totalValue !== null) {
    return totalValue;
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const values = entry && Array.isArray(entry.values) ? entry.values : null;
  if (!values) {
    return null;
  }
  for (let i = values.length - 1; i >= 0; i--) {
    const value = Number(values[i] && values[i].value);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function fetchYouTubeSubscribers_() {
  // Kept as the narrow accessor; the channel fetch itself lives in
  // fetchYouTubeChannelDetail_() with the rest of the SNS detail.
  return fetchYouTubeChannelDetail_().subscribers;
}

function isTokenRefreshDue_(expiresAtIso) {
  if (!expiresAtIso) {
    return true;
  }
  const expiresMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresMs)) {
    return true;
  }
  return expiresMs - Date.now() <= SNS_TOKEN_REFRESH_WINDOW_MS;
}

function storeRefreshedToken_(props, tokenKey, expiresKey, data) {
  if (!data || !data.access_token) {
    return false;
  }
  props.setProperty(tokenKey, data.access_token);
  const expiresIn = Number(data.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    props.setProperty(
      expiresKey,
      new Date(Date.now() + expiresIn * 1000).toISOString()
    );
  }
  return true;
}

function refreshMetaTokenIfNeeded_() {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty('META_APP_ID');
  const appSecret = props.getProperty('META_APP_SECRET');
  const token = props.getProperty('META_ACCESS_TOKEN');
  if (!appId || !appSecret || !token) {
    return false;
  }
  if (!isTokenRefreshDue_(props.getProperty('META_TOKEN_EXPIRES_AT'))) {
    return false;
  }
  try {
    const url =
      META_GRAPH_BASE +
      'oauth/access_token?grant_type=fb_exchange_token' +
      '&client_id=' +
      encodeURIComponent(appId) +
      '&client_secret=' +
      encodeURIComponent(appSecret) +
      '&fb_exchange_token=' +
      encodeURIComponent(token);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return false;
    }
    return storeRefreshedToken_(
      props,
      'META_ACCESS_TOKEN',
      'META_TOKEN_EXPIRES_AT',
      JSON.parse(res.getContentText())
    );
  } catch (err) {
    return false;
  }
}

function refreshThreadsTokenIfNeeded_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('META_THREADS_ACCESS_TOKEN');
  if (!token) {
    return false;
  }
  if (!isTokenRefreshDue_(props.getProperty('META_THREADS_TOKEN_EXPIRES_AT'))) {
    return false;
  }
  try {
    const url =
      'https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token' +
      '&access_token=' +
      encodeURIComponent(token);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return false;
    }
    return storeRefreshedToken_(
      props,
      'META_THREADS_ACCESS_TOKEN',
      'META_THREADS_TOKEN_EXPIRES_AT',
      JSON.parse(res.getContentText())
    );
  } catch (err) {
    return false;
  }
}

// --- Threads OAuth (authorization completed inside GAS) ---
// The dedicated Threads app cannot be added to the existing Meta app
// from the developer console, so its long-lived token is obtained
// here instead: the owner runs threadsAuthorizeUrl() in the editor,
// opens the logged URL and approves the threads_basic scope. Threads
// redirects the browser back to this Web App's /exec with a code and
// the state saved below; doGet routes that request to
// handleThreadsOAuthCallback_, which exchanges the code for a
// short-lived token, upgrades it to a long-lived one and stores it
// in META_THREADS_ACCESS_TOKEN (the property fetchThreadsFollowers_
// already reads). refreshThreadsTokenIfNeeded() then keeps the token
// alive with th_refresh_token, so the manual authorization is a
// one-time setup step.

const THREADS_OAUTH_STATE_PROPERTY = 'THREADS_OAUTH_STATE';
const THREADS_AUTHORIZE_URL = 'https://threads.net/oauth/authorize';
const THREADS_TOKEN_EXCHANGE_URL = 'https://graph.threads.net/oauth/access_token';
const THREADS_LONG_LIVED_URL = 'https://graph.threads.net/access_token';
const THREADS_REFRESH_URL = 'https://graph.threads.net/refresh_access_token';
// Long-lived Threads tokens live about 60 days; renew at 50 days so a
// failed attempt still leaves a window to retry before expiry.
const THREADS_TOKEN_REFRESH_AGE_MS = 50 * 24 * 60 * 60 * 1000;

function threadsRedirectUri_() {
  const override = getScriptProperty_('THREADS_REDIRECT_URI');
  if (override) {
    return override;
  }
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }
}

// Editor helper: builds the Threads authorization URL and logs it.
// Open the logged URL in a browser and approve; the callback stores
// the long-lived token in the Script Properties.
function threadsAuthorizeUrl() {
  const appId = getScriptProperty_('THREADS_APP_ID');
  if (!appId) {
    console.log('THREADS_APP_ID is not set in Script Properties');
    return '';
  }
  const redirectUri = threadsRedirectUri_();
  if (!redirectUri) {
    console.log('Could not determine the Web App URL; set THREADS_REDIRECT_URI');
    return '';
  }
  const state = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(
    THREADS_OAUTH_STATE_PROPERTY,
    state
  );
  const url =
    THREADS_AUTHORIZE_URL +
    '?client_id=' +
    encodeURIComponent(appId) +
    '&redirect_uri=' +
    encodeURIComponent(redirectUri) +
    '&scope=threads_basic&response_type=code&state=' +
    encodeURIComponent(state);
  console.log('Threads authorize URL: ' + url);
  return url;
}

// Exchanges an authorization code for the long-lived Threads token
// and stores it. Returns { ok, error } with a secret-free error
// summary on failure (the summaries only reuse API error fields, and
// transport failures are reported without the request URL, which
// carries the app secret in the exchange call).
function handleThreadsOAuthCallback_(code) {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty('THREADS_APP_ID');
  const appSecret = props.getProperty('THREADS_APP_SECRET');
  const redirectUri = threadsRedirectUri_();
  if (!appId || !appSecret) {
    return { ok: false, error: 'THREADS_APP_ID / THREADS_APP_SECRET are not set' };
  }
  if (!redirectUri) {
    return { ok: false, error: 'redirect URI is not available' };
  }
  try {
    const codeRes = UrlFetchApp.fetch(THREADS_TOKEN_EXCHANGE_URL, {
      method: 'post',
      payload: {
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: code,
      },
      muteHttpExceptions: true,
    });
    if (codeRes.getResponseCode() !== 200) {
      return {
        ok: false,
        error:
          'code exchange: ' +
          summarizeInsightsError_(codeRes.getResponseCode(), codeRes.getContentText()),
      };
    }
    const shortLived = JSON.parse(codeRes.getContentText());
    const shortToken = shortLived && shortLived.access_token;
    if (!shortToken) {
      return { ok: false, error: 'code exchange: response had no access_token' };
    }
    const longRes = UrlFetchApp.fetch(
      THREADS_LONG_LIVED_URL +
        '?grant_type=th_exchange_token&client_secret=' +
        encodeURIComponent(appSecret) +
        '&access_token=' +
        encodeURIComponent(shortToken),
      { muteHttpExceptions: true }
    );
    if (longRes.getResponseCode() !== 200) {
      return {
        ok: false,
        error:
          'long-lived exchange: ' +
          summarizeInsightsError_(longRes.getResponseCode(), longRes.getContentText()),
      };
    }
    const longLived = JSON.parse(longRes.getContentText());
    if (!longLived || !longLived.access_token) {
      return { ok: false, error: 'long-lived exchange: response had no access_token' };
    }
    props.setProperty('META_THREADS_ACCESS_TOKEN', longLived.access_token);
    if (shortLived.user_id != null && shortLived.user_id !== '') {
      props.setProperty('THREADS_USER_ID', String(shortLived.user_id));
    }
    props.setProperty('THREADS_TOKEN_AT', new Date().toISOString());
    const expiresIn = Number(longLived.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      props.setProperty(
        'META_THREADS_TOKEN_EXPIRES_AT',
        new Date(Date.now() + expiresIn * 1000).toISOString()
      );
    }
    props.deleteProperty(THREADS_OAUTH_STATE_PROPERTY);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: 'network error while contacting graph.threads.net' };
  }
}

// Renews the OAuth-obtained Threads token once it is 50+ days old.
// Tokens recorded without THREADS_TOKEN_AT (registered manually) are
// left to refreshThreadsTokenIfNeeded_(), which works off the
// recorded expiry instead. Returns a secret-free error summary on
// failure and null otherwise, so collectSnsCounts can surface it as
// the snapshot's threads_error.
function refreshThreadsTokenIfNeeded() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('META_THREADS_ACCESS_TOKEN');
  if (!token) {
    return null;
  }
  const acquiredAt = props.getProperty('THREADS_TOKEN_AT');
  if (!acquiredAt) {
    return null;
  }
  const acquiredMs = Date.parse(acquiredAt);
  if (!Number.isFinite(acquiredMs)) {
    return null;
  }
  if (Date.now() - acquiredMs < THREADS_TOKEN_REFRESH_AGE_MS) {
    return null;
  }
  try {
    const res = UrlFetchApp.fetch(
      THREADS_REFRESH_URL +
        '?grant_type=th_refresh_token&access_token=' +
        encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      const summary =
        'refresh: ' +
        summarizeInsightsError_(res.getResponseCode(), res.getContentText());
      console.log('Threads token refresh failed: ' + summary);
      return summary;
    }
    const data = JSON.parse(res.getContentText());
    if (!data || !data.access_token) {
      const summary = 'refresh: response had no access_token';
      console.log('Threads token refresh failed: ' + summary);
      return summary;
    }
    props.setProperty('META_THREADS_ACCESS_TOKEN', data.access_token);
    props.setProperty('THREADS_TOKEN_AT', new Date().toISOString());
    const expiresIn = Number(data.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      props.setProperty(
        'META_THREADS_TOKEN_EXPIRES_AT',
        new Date(Date.now() + expiresIn * 1000).toISOString()
      );
    }
    console.log('Threads token refreshed');
    return null;
  } catch (err) {
    const summary = 'refresh: network error while contacting graph.threads.net';
    console.log('Threads token refresh failed: ' + summary);
    return summary;
  }
}

function fetchInstagramMediaCount_() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return null;
  }
  try {
    const res = UrlFetchApp.fetch(
      META_GRAPH_BASE +
        SNS_INSTAGRAM_MAIN_ID +
        '?fields=media_count&access_token=' +
        encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      return null;
    }
    const data = JSON.parse(res.getContentText());
    const count = Number(data && data.media_count);
    return Number.isFinite(count) ? count : null;
  } catch (err) {
    return null;
  }
}

// Instagram KPI from the account insights (last 30 days):
//   views_30d: total Views across the whole account
//   non_follower_pct: share of those Views from non-followers (%), 1 decimal
// Insights require the instagram_manage_insights permission. Until the
// token carries it, the insights calls error out and both values stay
// null while every other fetch keeps working; once the permission is
// added they fill in automatically.
//
// Request shape (Meta Graph API, on the IG user node):
//   GET /{ig-id}/insights?metric=views&period=day
//       &metric_type=total_value&breakdown=follow_type
//       &since=<unix>&until=<unix>&access_token=...
// The total_value response carries the breakdown as
// total_value.breakdowns[].results[] with dimension_values like
// ["FOLLOWER"] / ["NON_FOLLOWER"]. If that shape is unavailable, a
// total_value request without the breakdown fills views_30d only —
// its response may carry total_value.value directly, or per-day
// values[].value to sum. (Observed in production on 2026-11-08: the
// breakdown dimension is named follow_type, not follower_type, and
// the views metric requires metric_type=total_value on every call.)
//
// Diagnostics: the result always carries insights_error — null when
// the breakdown request succeeded, otherwise a short summary of what
// the API actually said (or that the daily-totals fallback was used),
// so a failing insights call is observable in the snapshot and the
// execution log instead of silently producing null KPIs. Summaries
// are built only from the response status/body, never from the
// request URL, because the URL carries the access token.
function fetchInstagramViewsInsights_() {
  const result = { views_30d: null, non_follower_pct: null, insights_error: null };
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return result;
  }
  const until = Math.floor(Date.now() / 1000);
  const since = until - 30 * 24 * 60 * 60;
  const base =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=views&period=day&since=' +
    since +
    '&until=' +
    until +
    '&access_token=' +
    encodeURIComponent(token);
  const breakdownRes = fetchInsightsJson_(
    base + '&metric_type=total_value&breakdown=follow_type'
  );
  const breakdown = parseViewsBreakdown_(breakdownRes.data);
  if (breakdown) {
    result.views_30d = breakdown.total;
    const partsTotal = breakdown.follower + breakdown.nonFollower;
    if (partsTotal > 0) {
      result.non_follower_pct =
        Math.round((breakdown.nonFollower / partsTotal) * 1000) / 10;
    }
    return result;
  }
  const dailyRes = fetchInsightsJson_(base + '&metric_type=total_value');
  const total = parseViewsDailyTotal_(dailyRes.data);
  if (total !== null) {
    result.views_30d = total;
    result.insights_error =
      'follow_type breakdown unavailable' +
      (breakdownRes.error ? ' (' + breakdownRes.error + ')' : '') +
      '; used daily totals fallback';
    return result;
  }
  const notes = [];
  notes.push(
    breakdownRes.error
      ? 'breakdown: ' + breakdownRes.error
      : 'breakdown: response had no follow_type breakdown'
  );
  notes.push(
    dailyRes.error
      ? 'daily: ' + dailyRes.error
      : 'daily: response had no daily values'
  );
  result.insights_error = notes.join('; ');
  return result;
}

// Fetches an insights URL and returns { data, error }: data is the
// parsed JSON body on HTTP 200 (otherwise null) and error is a short
// secret-free summary of what went wrong (otherwise null). Exception
// messages are reduced to the error name because UrlFetchApp messages
// can embed the failing URL, which carries the access token.
function fetchInsightsJson_(url) {
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    return {
      data: null,
      error: 'fetch exception (' + ((err && err.name) || 'Error') + ')',
    };
  }
  const status = res.getResponseCode();
  const bodyText = res.getContentText();
  if (status !== 200) {
    return { data: null, error: summarizeInsightsError_(status, bodyText) };
  }
  try {
    return { data: JSON.parse(bodyText), error: null };
  } catch (err) {
    return { data: null, error: 'HTTP 200 with unparseable JSON body' };
  }
}

// Builds a compact summary of a Graph API error response, e.g.
// "HTTP 400 code=10 subcode=1234567: <error.message>". Only fields
// from the response body are used, and the message is truncated, so
// no token or other secret can leak into the snapshot or the log.
function summarizeInsightsError_(status, bodyText) {
  let summary = 'HTTP ' + status;
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    parsed = null;
  }
  const error = parsed && parsed.error;
  if (error) {
    if (error.code !== undefined && error.code !== null) {
      summary += ' code=' + error.code;
    }
    if (error.error_subcode !== undefined && error.error_subcode !== null) {
      summary += ' subcode=' + error.error_subcode;
    }
    if (error.message) {
      summary += ': ' + String(error.message).slice(0, 200);
    }
  }
  return summary;
}

// Returns { total, follower, nonFollower } in views, or null when the
// total_value + follow_type breakdown shape is not present.
function parseViewsBreakdown_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const totalValue = entry && entry.total_value;
  if (!totalValue) {
    return null;
  }
  const breakdowns = Array.isArray(totalValue.breakdowns)
    ? totalValue.breakdowns
    : [];
  let follower = null;
  let nonFollower = null;
  breakdowns.forEach((breakdown) => {
    const keys = (breakdown && breakdown.dimension_keys) || [];
    if (!keys.includes('follow_type')) {
      return;
    }
    ((breakdown && breakdown.results) || []).forEach((row) => {
      const dims = (row && row.dimension_values) || [];
      const value = Number(row && row.value);
      if (!Number.isFinite(value)) {
        return;
      }
      if (dims.includes('NON_FOLLOWER')) {
        nonFollower = value;
      } else if (dims.includes('FOLLOWER')) {
        follower = value;
      }
    });
  });
  if (follower === null && nonFollower === null) {
    return null;
  }
  const partsTotal = (follower || 0) + (nonFollower || 0);
  const reported = Number(totalValue.value);
  return {
    total: Number.isFinite(reported) ? reported : partsTotal,
    follower: follower || 0,
    nonFollower: nonFollower || 0,
  };
}

// Reads the total views out of a no-breakdown insights response, or
// null. With metric_type=total_value the response may carry
// total_value.value directly; otherwise the per-day values[].value
// are summed.
function parseViewsDailyTotal_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) {
    return null;
  }
  const totalValue = Number(entry.total_value && entry.total_value.value);
  if (Number.isFinite(totalValue)) {
    return totalValue;
  }
  const values = Array.isArray(entry.values) ? entry.values : null;
  if (!values) {
    return null;
  }
  let total = 0;
  let seen = false;
  values.forEach((row) => {
    const value = Number(row && row.value);
    if (Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  });
  return seen ? total : null;
}

// --- SNS detail (for the /ga admin screen, action=sns_detail) ---
// collectSnsCounts() also gathers the numbers the public snapshot
// does not need: Instagram account-level insights for the last 30
// days, follower demographics, per-post insights for the newest
// media, and YouTube channel totals plus the newest videos. They
// are stored in the same snapshot and served only through the
// authenticated action=sns_detail; action=sns_counts keeps returning
// the small public projection built above.
//
// Every fetch below fails independently: an unobtainable value stays
// null and the rest of the snapshot is unaffected. Failures are
// summarised per section — instagram.detail_error for the account
// insights and demographics, instagram.media_error for per-post
// insights, youtube.youtube_error for YouTube — using the same
// secret-free style as instagram.insights_error: summaries are built
// from response status/body or exception names only, never from a
// request URL (URLs carry the access token).

const SNS_RECENT_MEDIA_LIMIT = 30;
const SNS_RECENT_VIDEO_LIMIT = 10;
const SNS_DEMOGRAPHICS_TOP_LIMIT = 10;

function joinSnsErrors_(parts) {
  const list = (parts || []).filter(Boolean);
  return list.length ? list.join('; ') : null;
}

function snsInsightsWindow_() {
  const until = Math.floor(Date.now() / 1000);
  return { since: until - 30 * 24 * 60 * 60, until };
}

// Fetches one account-level insights metric as a 30-day total_value.
// Returns { value, error, data } and never throws; the total is read
// with parseViewsDailyTotal_, which accepts both the total_value
// form and a per-day values[] list to sum (the logic is
// metric-agnostic). data carries the raw body for callers that need
// the breakdown form (follows_and_unfollows).
function fetchAccountInsightTotal_(metric, extra) {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  const window = snsInsightsWindow_();
  const url =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=' +
    metric +
    '&period=day&metric_type=total_value&since=' +
    window.since +
    '&until=' +
    window.until +
    (extra || '') +
    '&access_token=' +
    encodeURIComponent(token);
  const res = fetchInsightsJson_(url);
  if (res.error) {
    return { value: null, error: metric + ': ' + res.error, data: null };
  }
  return { value: parseViewsDailyTotal_(res.data), error: null, data: res.data };
}

// Reads only the total_value.value out of an insights response, or
// null. Kept separate from parseViewsDailyTotal_ (which also sums
// per-day values) so callers can tell which form a number came from.
function parseInsightsTotalValue_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) {
    return null;
  }
  const value = Number(entry.total_value && entry.total_value.value);
  return Number.isFinite(value) ? value : null;
}

// Sums only the per-day values[].value of an insights response, or
// null when the response carries no daily values.
function parseInsightsDailySum_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry || !Array.isArray(entry.values)) {
    return null;
  }
  let total = 0;
  let seen = false;
  entry.values.forEach((row) => {
    const value = Number(row && row.value);
    if (Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  });
  return seen ? total : null;
}

// Fetches one account-level insights metric in the plain daily form
// (no metric_type) and returns the raw { data, error }. Some metrics
// reject a request without metric_type=total_value (observed for
// views), so on an error the request is retried once in that form;
// either response is only read for its per-day values.
function fetchAccountInsightDaily_(metric) {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  const window = snsInsightsWindow_();
  const base =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=' +
    metric +
    '&period=day&since=' +
    window.since +
    '&until=' +
    window.until;
  let res = fetchInsightsJson_(base + '&access_token=' + encodeURIComponent(token));
  if (res.error) {
    res = fetchInsightsJson_(
      base + '&metric_type=total_value&access_token=' + encodeURIComponent(token)
    );
  }
  return res;
}

// Profile link taps, in two stages. The total_value form is tried
// first; when it comes back null or 0 — the production snapshot on
// 2026-11-09 showed 0 while the Instagram app and the CLI reported
// dozens of bio link taps for the same account — the per-day values
// are summed instead, from the first response when it already
// carries them and from a dedicated daily request otherwise. The
// adopted form is reported as source ("total_value" / "daily_sum")
// so a wrong-looking number stays diagnosable in the snapshot.
// Returns { value, source, error } and never throws.
function fetchProfileLinksTaps_() {
  const first = fetchAccountInsightTotal_('profile_links_taps');
  if (first.error) {
    return { value: null, source: null, error: first.error };
  }
  const totalValue = parseInsightsTotalValue_(first.data);
  if (totalValue !== null && totalValue > 0) {
    return { value: totalValue, source: 'total_value', error: null };
  }
  let daily = parseInsightsDailySum_(first.data);
  if (daily === null) {
    const second = fetchAccountInsightDaily_('profile_links_taps');
    if (second.error) {
      if (totalValue === null) {
        return {
          value: null,
          source: null,
          error: 'profile_links_taps: ' + second.error,
        };
      }
    } else {
      daily = parseInsightsDailySum_(second.data);
    }
  }
  if (daily !== null) {
    return { value: daily, source: 'daily_sum', error: null };
  }
  if (totalValue !== null) {
    return { value: totalValue, source: 'total_value', error: null };
  }
  return {
    value: null,
    source: null,
    error: 'profile_links_taps: response had neither a total_value nor daily values',
  };
}

// Account-level detail for the main Instagram account (last 30
// days): reach, engaged accounts, the interaction totals, profile
// link taps, and the follows/unfollows split. Each metric is a
// separate request, so one rejected metric nulls only itself.
function fetchInstagramAccountDetail_() {
  const result = {
    reach_30d: null,
    accounts_engaged_30d: null,
    interactions_30d: {
      total: null,
      likes: null,
      comments: null,
      shares: null,
      saves: null,
    },
    profile_links_taps_30d: null,
    profile_links_taps_source: null,
    follows_30d: null,
    unfollows_30d: null,
    detail_error: null,
  };
  if (!getScriptProperty_('META_ACCESS_TOKEN')) {
    return result;
  }
  const errors = [];
  const grab = (metric) => {
    const fetched = fetchAccountInsightTotal_(metric);
    if (fetched.error) {
      errors.push(fetched.error);
    }
    return fetched.value;
  };
  result.reach_30d = grab('reach');
  result.accounts_engaged_30d = grab('accounts_engaged');
  result.interactions_30d = {
    total: grab('total_interactions'),
    likes: grab('likes'),
    comments: grab('comments'),
    shares: grab('shares'),
    saves: grab('saves'),
  };
  const taps = fetchProfileLinksTaps_();
  result.profile_links_taps_30d = taps.value;
  result.profile_links_taps_source = taps.source;
  if (taps.error) {
    errors.push(taps.error);
  }
  const follows = fetchAccountInsightTotal_(
    'follows_and_unfollows',
    '&breakdown=follow_type'
  );
  if (follows.error) {
    errors.push(follows.error);
  } else {
    const parsed = parseFollowsBreakdown_(follows.data);
    if (parsed) {
      result.follows_30d = parsed.follows;
      result.unfollows_30d = parsed.unfollows;
    } else {
      // No label matched: record what the API actually sent so the
      // next adjustment starts from the observed labels, not a guess.
      const labels = followsBreakdownLabels_(follows.data);
      if (labels.length) {
        errors.push('follows_and_unfollows labels: [' + labels.join(', ') + ']');
      }
    }
  }
  result.detail_error = joinSnsErrors_(errors);
  return result;
}

// --- Manual diagnostics: debugSnsInsights -------------------------
// Run by hand from the Apps Script editor when the account-detail
// numbers look wrong (as on 2026-11-09, when its raw responses
// pinned down the follows_and_unfollows follow_type labels —
// FOLLOWER = new follows, NON_FOLLOWER = unfollows — and showed
// profile_links_taps coming back 0 in both the total_value form and
// the daily-sum fallback while the Instagram app showed real bio
// link taps). It logs the raw Graph API responses for six request
// shapes (A–F) so the next fix starts from what the API actually
// returns instead of a guess. It is never called from a trigger or
// from doGet, and it does not touch the snapshot. Access tokens are
// never logged: request URLs are printed with
// access_token=<redacted>, and any token string is scrubbed from
// response bodies before logging.
const SNS_DEBUG_LOG_LIMIT = 3000;

function debugSnsInsights() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set; nothing to diagnose.');
    return;
  }
  const window = snsInsightsWindow_();
  const range = '&since=' + window.since + '&until=' + window.until;
  debugLogInsightsShape_(
    'A follows_and_unfollows breakdown=follow_type',
    'metric=follows_and_unfollows&period=day&metric_type=total_value' +
      range +
      '&breakdown=follow_type',
    token,
    {}
  );
  debugLogInsightsShape_(
    'B follows_and_unfollows metric_type=total_value (no breakdown)',
    'metric=follows_and_unfollows&period=day&metric_type=total_value' + range,
    token,
    {}
  );
  debugLogInsightsShape_(
    'C follows_and_unfollows plain (no metric_type, no breakdown)',
    'metric=follows_and_unfollows&period=day' + range,
    token,
    {}
  );
  debugLogInsightsShape_(
    'D profile_links_taps metric_type=total_value',
    'metric=profile_links_taps&period=day&metric_type=total_value' + range,
    token,
    {}
  );
  debugLogInsightsShape_(
    'E profile_links_taps plain (no metric_type)',
    'metric=profile_links_taps&period=day' + range,
    token,
    { summarizeValues: true }
  );
  debugLogInsightsShape_(
    'F profile_links_taps period=lifetime metric_type=total_value',
    'metric=profile_links_taps&period=lifetime&metric_type=total_value',
    token,
    { errorsOnly: true }
  );
}

// Fetches one insights shape for debugSnsInsights and logs the
// request URL (token redacted), the HTTP status and the raw body,
// truncated to SNS_DEBUG_LOG_LIMIT characters. With errorsOnly, an
// error response is reduced to the summarizeInsightsError_ summary
// (shape F). With summarizeValues, a values[] list in the body also
// gets a count/sum line (shape E). Never throws.
function debugLogInsightsShape_(label, query, token, options) {
  const opts = options || {};
  const base = META_GRAPH_BASE + SNS_INSTAGRAM_MAIN_ID + '/insights?' + query;
  Logger.log('=== ' + label + ' ===');
  Logger.log('GET ' + base + '&access_token=<redacted>');
  let res;
  try {
    res = UrlFetchApp.fetch(
      base + '&access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
  } catch (err) {
    Logger.log('fetch exception (' + ((err && err.name) || 'Error') + ')');
    return;
  }
  const status = res.getResponseCode();
  const bodyText = res.getContentText();
  Logger.log('HTTP ' + status);
  if (status !== 200 && opts.errorsOnly) {
    Logger.log(summarizeInsightsError_(status, bodyText));
    return;
  }
  Logger.log(debugScrubToken_(bodyText, token).slice(0, SNS_DEBUG_LOG_LIMIT));
  if (opts.summarizeValues && status === 200) {
    let data = null;
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      data = null;
    }
    const entry = data && Array.isArray(data.data) ? data.data[0] : null;
    const count = entry && Array.isArray(entry.values) ? entry.values.length : 0;
    const sum = parseInsightsDailySum_(data);
    Logger.log(
      'values: ' +
        count +
        ' entries, sum = ' +
        (sum === null ? '(no numeric values)' : sum)
    );
  }
}

// Removes any occurrence of the access token from text about to be
// logged. Graph API bodies should never contain it; this is a
// belt-and-braces scrub so debugSnsInsights can never leak it.
function debugScrubToken_(text, token) {
  const value = String(text == null ? '' : text);
  if (!token) {
    return value;
  }
  return value.split(token).join('<redacted>');
}

// --- Manual diagnostics: debugThreadsFollowers --------------------
// Run by hand from the Apps Script editor when collectSnsCounts
// keeps storing threads.followers = null after the Threads OAuth
// flow has completed (as on 2026-11-09: authorization finished and
// the long-lived token was saved, yet the followers fetch came back
// null with no error recorded anywhere — the fetch returns null on
// any non-200 response or exception without keeping the status or
// body, so the snapshot cannot say why). Its first production run
// showed why: the profile request ?fields=followers_count fails
// with HTTP 500 "Tried accessing nonexisting field
// (followers_count)", so fetchThreadsFollowers_ now reads the
// followers_count metric from the threads_insights edge instead.
// This diagnostic logs whether META_THREADS_ACCESS_TOKEN is set
// (never its value), which user id the production fetch would use,
// the raw status/body of the very same insights request
// fetchThreadsFollowers_ makes, and the count parsed out of it. If
// the insights edge refuses the token over a missing scope, that
// error message shows up here verbatim. It is never called from a
// trigger or from doGet, and it does not touch the snapshot. The
// request URL is printed with access_token=<redacted> and the body
// is scrubbed the same way as in debugSnsInsights.
function debugThreadsFollowers() {
  const threadsToken = getScriptProperty_('META_THREADS_ACCESS_TOKEN');
  Logger.log(
    'META_THREADS_ACCESS_TOKEN is ' +
      (threadsToken ? 'set.' : 'not set.')
  );
  const token = threadsToken || getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set either; nothing to diagnose.');
    return;
  }
  if (!threadsToken) {
    Logger.log('Falling back to META_ACCESS_TOKEN (the Instagram token).');
  }
  const propertyUserId = getScriptProperty_('THREADS_USER_ID');
  const userId = propertyUserId || SNS_THREADS_USER_ID;
  Logger.log(
    'Threads user id: ' +
      userId +
      (propertyUserId
        ? ' (from THREADS_USER_ID)'
        : ' (THREADS_USER_ID is not set; using the SNS_THREADS_USER_ID fallback)')
  );
  const base = threadsFollowersInsightsUrl_(userId);
  Logger.log('GET ' + base + '&access_token=<redacted>');
  let res;
  try {
    res = UrlFetchApp.fetch(
      base + '&access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
  } catch (err) {
    Logger.log('fetch exception (' + ((err && err.name) || 'Error') + ')');
    return;
  }
  Logger.log('HTTP ' + res.getResponseCode());
  Logger.log(
    debugScrubToken_(res.getContentText(), token).slice(
      0,
      SNS_DEBUG_LOG_LIMIT
    )
  );
  let parsed = null;
  try {
    parsed = parseThreadsFollowersCount_(JSON.parse(res.getContentText()));
  } catch (err) {
    parsed = null;
  }
  Logger.log(
    'parsed followers_count: ' + (parsed === null ? 'null' : parsed)
  );
}

// Reads the follows/unfollows split out of a follows_and_unfollows
// total_value response. Production diagnostics on 2026-11-09
// (debugSnsInsights) pinned down the only shape this metric returns
// numbers in: metric_type=total_value plus breakdown=follow_type,
// and the breakdown's results are labelled by the resulting state —
// FOLLOWER is the number of accounts that started following (they
// end up followers) and NON_FOLLOWER is the number that unfollowed
// (they end up non-followers); without the breakdown the response
// carries neither total_value nor values at all. Matching is
// therefore exact (case-insensitive) on those two labels, which
// take priority over any looser reading. Anything else leaves the
// split null, and the caller records the observed labels via
// followsBreakdownLabels_ so an unexpected labelling stays
// observable instead of being guessed at.
function parseFollowsBreakdown_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const totalValue = entry && entry.total_value;
  if (!totalValue || !Array.isArray(totalValue.breakdowns)) {
    return null;
  }
  let follows = null;
  let unfollows = null;
  totalValue.breakdowns.forEach((breakdown) => {
    const keys = (breakdown && breakdown.dimension_keys) || [];
    if (!keys.includes('follow_type')) {
      return;
    }
    ((breakdown && breakdown.results) || []).forEach((row) => {
      const value = Number(row && row.value);
      if (!Number.isFinite(value)) {
        return;
      }
      const dims = ((row && row.dimension_values) || []).map((dim) =>
        String(dim).toUpperCase()
      );
      dims.forEach((dim) => {
        if (dim === 'FOLLOWER') {
          follows = value;
        } else if (dim === 'NON_FOLLOWER' || dim === 'NON-FOLLOWER') {
          unfollows = value;
        }
      });
    });
  });
  if (follows === null && unfollows === null) {
    return null;
  }
  return { follows, unfollows };
}

// Lists the dimension values a follows_and_unfollows response
// actually carried on its follow_type breakdown (original casing,
// deduplicated, in response order), or an empty list when the
// response has no such breakdown. Used only to make an unmatched
// labelling observable in instagram.detail_error; the values are
// API labels, never secrets or URLs.
function followsBreakdownLabels_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const totalValue = entry && entry.total_value;
  if (!totalValue || !Array.isArray(totalValue.breakdowns)) {
    return [];
  }
  const labels = [];
  totalValue.breakdowns.forEach((breakdown) => {
    const keys = (breakdown && breakdown.dimension_keys) || [];
    if (!keys.includes('follow_type')) {
      return;
    }
    ((breakdown && breakdown.results) || []).forEach((row) => {
      ((row && row.dimension_values) || []).forEach((dim) => {
        const label = String(dim);
        if (!labels.includes(label)) {
          labels.push(label);
        }
      });
    });
  });
  return labels;
}

// Follower demographics (period=lifetime): age/gender pairs, top
// cities and top countries. Returns { demographics, error }; each of
// the three lists fails independently to null.
function fetchInstagramDemographics_() {
  const demographics = { age_gender: null, top_cities: null, top_countries: null };
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return { demographics, error: null };
  }
  const base =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=follower_demographics&period=lifetime' +
    '&metric_type=total_value&access_token=' +
    encodeURIComponent(token);
  const errors = [];
  let ageGender = fetchDemographicBreakdown_(
    base + '&breakdown=age,gender',
    ['age', 'gender']
  );
  if (ageGender.error) {
    // Some API versions accept only one breakdown dimension at a
    // time; fall back to the age-only split before giving up.
    const retry = fetchDemographicBreakdown_(base + '&breakdown=age', ['age']);
    if (retry.error) {
      errors.push('demographics(age_gender): ' + ageGender.error);
    } else {
      ageGender = retry;
    }
  }
  demographics.age_gender = ageGender.rows;
  const cities = fetchDemographicBreakdown_(base + '&breakdown=city', ['city']);
  if (cities.error) {
    errors.push('demographics(top_cities): ' + cities.error);
  } else {
    demographics.top_cities = cities.rows
      ? cities.rows.slice(0, SNS_DEMOGRAPHICS_TOP_LIMIT)
      : null;
  }
  const countries = fetchDemographicBreakdown_(
    base + '&breakdown=country',
    ['country']
  );
  if (countries.error) {
    errors.push('demographics(top_countries): ' + countries.error);
  } else {
    demographics.top_countries = countries.rows
      ? countries.rows.slice(0, SNS_DEMOGRAPHICS_TOP_LIMIT)
      : null;
  }
  return { demographics, error: joinSnsErrors_(errors) };
}

function fetchDemographicBreakdown_(url, dims) {
  const res = fetchInsightsJson_(url);
  if (res.error) {
    return { rows: null, error: res.error };
  }
  return { rows: parseDemographicsBreakdown_(res.data, dims), error: null };
}

// Reads one breakdown of a follower_demographics total_value
// response as [{ key, value }] sorted by value descending, where key
// is the dimension values joined with "/" (e.g. "25-34/F"). Returns
// null when the requested breakdown is not in the response.
function parseDemographicsBreakdown_(data, dims) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const totalValue = entry && entry.total_value;
  if (!totalValue || !Array.isArray(totalValue.breakdowns)) {
    return null;
  }
  let rows = null;
  totalValue.breakdowns.forEach((breakdown) => {
    const keys = (breakdown && breakdown.dimension_keys) || [];
    if (!dims.every((dim) => keys.includes(dim))) {
      return;
    }
    rows = ((breakdown && breakdown.results) || [])
      .map((row) => ({
        key: ((row && row.dimension_values) || []).join('/'),
        value: Number(row && row.value),
      }))
      .filter((row) => Number.isFinite(row.value));
  });
  if (!rows) {
    return null;
  }
  rows.sort((a, b) => b.value - a.value);
  return rows;
}

// Metric sets tried in order for one media's insights. Reels accept
// the watch-time metrics; other media types reject them, and some
// reject views/shares too, so a failure retries with a smaller set
// and keeps whatever could be read.
const MEDIA_INSIGHTS_ATTEMPTS_REEL = [
  'views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time',
  'reach,likes,comments,saved,total_interactions',
  'likes,comments',
];
const MEDIA_INSIGHTS_ATTEMPTS_FEED = [
  'views,reach,likes,comments,shares,saved,total_interactions',
  'reach,likes,comments,saved,total_interactions',
  'likes,comments',
];

// Newest Instagram media (up to SNS_RECENT_MEDIA_LIMIT) with their
// per-post insights. Returns { recent_media, media_error }:
// recent_media is null only when the media list itself could not be
// read; a post whose insights all failed keeps null metrics and is
// counted in media_error.
function fetchInstagramRecentMedia_() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return { recent_media: null, media_error: null };
  }
  const listRes = fetchInsightsJson_(
    META_GRAPH_BASE +
      SNS_INSTAGRAM_MAIN_ID +
      '/media?fields=id,media_type,media_product_type,caption,timestamp,permalink,thumbnail_url&limit=' +
      SNS_RECENT_MEDIA_LIMIT +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (listRes.error) {
    return { recent_media: null, media_error: 'media list: ' + listRes.error };
  }
  const items =
    listRes.data && Array.isArray(listRes.data.data) ? listRes.data.data : null;
  if (!items) {
    return {
      recent_media: null,
      media_error: 'media list: response had no media array',
    };
  }
  const failures = [];
  const recentMedia = items.slice(0, SNS_RECENT_MEDIA_LIMIT).map((media) => {
    const entry = buildRecentMediaEntry_(media);
    const insights = fetchMediaInsights_(media, token);
    if (insights.error) {
      failures.push(insights.error);
    }
    Object.assign(entry, insights.values);
    return entry;
  });
  return {
    recent_media: recentMedia,
    media_error: failures.length
      ? failures.length +
        ' of ' +
        recentMedia.length +
        ' media insights failed (' +
        failures[0] +
        ')'
      : null,
  };
}

// Captions are passed through in full: the /ga screen classifies
// each post into a genre by keyword rules over the whole caption,
// hashtags included, and the old 80-character cut-off hid the tail
// of the caption (where the hashtags live) from that classification
// and misfiled posts. SNS_CAPTION_MAX_LENGTH is only a safety cap
// against pathological inputs, far beyond any real caption.
const SNS_CAPTION_MAX_LENGTH = 2000;

function buildRecentMediaEntry_(media) {
  const caption =
    media && media.caption != null ? String(media.caption) : '';
  return {
    id: media && media.id != null ? String(media.id) : null,
    type: (media && (media.media_product_type || media.media_type)) || null,
    posted_at: (media && media.timestamp) || null,
    caption: caption.slice(0, SNS_CAPTION_MAX_LENGTH),
    permalink: (media && media.permalink) || null,
    views: null,
    reach: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    avg_watch_sec: null,
    total_watch_sec: null,
  };
}

// Per-post insights with shrinking metric sets (see the attempts
// above). Returns { values, error }: error is set only when every
// attempt failed. Watch times arrive in milliseconds and are stored
// as seconds (avg to 0.1s, total to whole seconds).
function fetchMediaInsights_(media, token) {
  const empty = {
    views: null,
    reach: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    avg_watch_sec: null,
    total_watch_sec: null,
  };
  if (!media || media.id == null) {
    return { values: empty, error: null };
  }
  const isReel =
    media.media_product_type === 'REELS' || media.media_type === 'VIDEO';
  const attempts = isReel
    ? MEDIA_INSIGHTS_ATTEMPTS_REEL
    : MEDIA_INSIGHTS_ATTEMPTS_FEED;
  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const res = fetchInsightsJson_(
      META_GRAPH_BASE +
        media.id +
        '/insights?metric=' +
        attempts[i] +
        '&access_token=' +
        encodeURIComponent(token)
    );
    if (!res.error) {
      return { values: Object.assign({}, empty, parseMediaInsights_(res.data)), error: null };
    }
    lastError = res.error;
  }
  return { values: empty, error: String(media.id) + ': ' + lastError };
}

// Maps one media insights response to the snapshot's key names
// (saved -> saves) with watch-time conversion to seconds. Metrics
// absent from the response stay out of the map, so the caller's
// nulls remain for them.
function parseMediaInsights_(data) {
  const values = {};
  const entries = data && Array.isArray(data.data) ? data.data : [];
  entries.forEach((entry) => {
    if (!entry || !entry.name) {
      return;
    }
    let raw = null;
    if (Array.isArray(entry.values) && entry.values.length) {
      raw = entry.values[0] && entry.values[0].value;
    }
    if (raw == null && entry.total_value) {
      raw = entry.total_value.value;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return;
    }
    switch (entry.name) {
      case 'views':
        values.views = num;
        break;
      case 'reach':
        values.reach = num;
        break;
      case 'likes':
        values.likes = num;
        break;
      case 'comments':
        values.comments = num;
        break;
      case 'shares':
        values.shares = num;
        break;
      case 'saved':
        values.saves = num;
        break;
      case 'ig_reels_avg_watch_time':
        values.avg_watch_sec = Math.round(num / 100) / 10;
        break;
      case 'ig_reels_video_view_total_time':
        values.total_watch_sec = Math.round(num / 1000);
        break;
      default:
        break;
    }
  });
  return values;
}

// YouTube advanced-service errors carry API messages (no secrets),
// so a truncated message is safe to keep for diagnosis.
function summarizeYouTubeError_(err) {
  return String((err && err.message) || err || 'unknown error').slice(0, 200);
}

// Channel totals (subscribers, total views, video count) plus the
// newest uploaded videos. Each half fails independently.
function fetchYouTubeChannelDetail_() {
  const result = {
    subscribers: null,
    total_views: null,
    video_count: null,
    recent_videos: null,
    youtube_error: null,
  };
  if (typeof YouTube === 'undefined' || !YouTube.Channels) {
    result.youtube_error = 'YouTube advanced service is unavailable';
    return result;
  }
  const errors = [];
  try {
    const res = YouTube.Channels.list('statistics', { id: SNS_YOUTUBE_CHANNEL_ID });
    const items = (res && res.items) || [];
    const stats = items.length ? items[0].statistics : null;
    if (stats) {
      if (!stats.hiddenSubscriberCount) {
        result.subscribers = snsNumberOrNull_(Number(stats.subscriberCount));
      }
      result.total_views = snsNumberOrNull_(Number(stats.viewCount));
      result.video_count = snsNumberOrNull_(Number(stats.videoCount));
    }
  } catch (err) {
    errors.push('channel statistics: ' + summarizeYouTubeError_(err));
  }
  const videos = fetchYouTubeRecentVideos_();
  result.recent_videos = videos.videos;
  if (videos.error) {
    errors.push(videos.error);
  }
  result.youtube_error = joinSnsErrors_(errors);
  return result;
}

// Newest uploads (up to SNS_RECENT_VIDEO_LIMIT) via the channel's
// uploads playlist, with per-video view/like/comment counts.
function fetchYouTubeRecentVideos_() {
  try {
    const details = YouTube.Channels.list('contentDetails', {
      id: SNS_YOUTUBE_CHANNEL_ID,
    });
    const channelItems = (details && details.items) || [];
    const related =
      (channelItems.length &&
        channelItems[0].contentDetails &&
        channelItems[0].contentDetails.relatedPlaylists) ||
      {};
    if (!related.uploads) {
      return { videos: [], error: null };
    }
    const playlist = YouTube.PlaylistItems.list('snippet', {
      playlistId: related.uploads,
      maxResults: SNS_RECENT_VIDEO_LIMIT,
    });
    const metas = ((playlist && playlist.items) || [])
      .map((item) => {
        const snippet = (item && item.snippet) || {};
        const resource = snippet.resourceId || {};
        return {
          id: resource.videoId || null,
          title: snippet.title || null,
          published_at: snippet.publishedAt || null,
        };
      })
      .filter((meta) => meta.id);
    if (!metas.length) {
      return { videos: [], error: null };
    }
    const statsRes = YouTube.Videos.list('statistics', {
      id: metas.map((meta) => meta.id).join(','),
    });
    const statsById = {};
    ((statsRes && statsRes.items) || []).forEach((item) => {
      if (item && item.id) {
        statsById[item.id] = item.statistics || {};
      }
    });
    const videos = metas.map((meta) => {
      const stats = statsById[meta.id] || {};
      return {
        id: meta.id,
        title: meta.title,
        published_at: meta.published_at,
        views: snsNumberOrNull_(Number(stats.viewCount)),
        likes: snsNumberOrNull_(Number(stats.likeCount)),
        comments: snsNumberOrNull_(Number(stats.commentCount)),
        url: 'https://www.youtube.com/watch?v=' + meta.id,
      };
    });
    return { videos, error: null };
  } catch (err) {
    return { videos: null, error: 'recent videos: ' + summarizeYouTubeError_(err) };
  }
}

// --- SNS snapshot history (Google Sheets) ---
// The snapshot above is overwritten on every collection, so the
// trend would be lost. When the Script Property SNS_HISTORY_SHEET_ID
// names a spreadsheet, collectSnsCounts() also appends the snapshot
// to it: one row per collection on the "account" sheet and one row
// per recent post on the "media" sheet. Both sheets are created when
// missing and get their header row when still empty. The sheet ID is
// only ever read from the Script Property, never written in code.
// Unset (the default) means no history is written at all, and a
// failed append never fails the collection itself: it is logged as
// one secret-free summary line instead.

const SNS_HISTORY_SHEET_ID_PROPERTY = 'SNS_HISTORY_SHEET_ID';
const SNS_HISTORY_ACCOUNT_COLUMNS = [
  'collected_at',
  'ig_followers',
  'ig_anemone_followers',
  'threads_followers',
  'youtube_subscribers',
  'total_followers',
  'media_count',
  'views_30d',
  'non_follower_pct',
  'reach_30d',
  'accounts_engaged_30d',
  'interactions_total',
  'interactions_likes',
  'interactions_comments',
  'interactions_shares',
  'interactions_saves',
  'profile_links_taps_30d',
  'profile_links_taps_source',
  'follows_30d',
  'unfollows_30d',
  'yt_total_views',
  'yt_video_count',
];
const SNS_HISTORY_MEDIA_COLUMNS = [
  'collected_at',
  'media_id',
  'posted_at',
  'type',
  'caption',
  'permalink',
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saves',
  'avg_watch_sec',
  'total_watch_sec',
];

// Numbers are written as numbers; anything else (null, undefined,
// non-finite) becomes an empty cell so the sheet stays sortable.
function snsHistoryNumCell_(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : '';
}

function snsHistoryTextCell_(value) {
  return value === null || value === undefined ? '' : String(value);
}

// One "account" row from a snapshot. total_followers follows the
// top-page definition — main Instagram + Threads + YouTube — summing
// only the values that are numbers, and stays empty when all three
// are null. Null values become empty cells throughout.
function buildSnsHistoryAccountRow_(snapshot) {
  const snap = snapshot || {};
  const youtube = snap.youtube || {};
  const instagram = snap.instagram || {};
  const threads = snap.threads || {};
  const interactions = instagram.interactions_30d || {};
  const totalParts = [
    snsNumberOrNull_(instagram.freddiefujiwara),
    snsNumberOrNull_(threads.followers),
    snsNumberOrNull_(youtube.subscribers),
  ].filter((value) => value !== null);
  return [
    snsHistoryTextCell_(snap.collected_at),
    snsHistoryNumCell_(instagram.freddiefujiwara),
    snsHistoryNumCell_(instagram.anemone_cancer),
    snsHistoryNumCell_(threads.followers),
    snsHistoryNumCell_(youtube.subscribers),
    totalParts.length
      ? totalParts.reduce((sum, value) => sum + value, 0)
      : '',
    snsHistoryNumCell_(instagram.media_count),
    snsHistoryNumCell_(instagram.views_30d),
    snsHistoryNumCell_(instagram.non_follower_pct),
    snsHistoryNumCell_(instagram.reach_30d),
    snsHistoryNumCell_(instagram.accounts_engaged_30d),
    snsHistoryNumCell_(interactions.total),
    snsHistoryNumCell_(interactions.likes),
    snsHistoryNumCell_(interactions.comments),
    snsHistoryNumCell_(interactions.shares),
    snsHistoryNumCell_(interactions.saves),
    snsHistoryNumCell_(instagram.profile_links_taps_30d),
    snsHistoryTextCell_(instagram.profile_links_taps_source),
    snsHistoryNumCell_(instagram.follows_30d),
    snsHistoryNumCell_(instagram.unfollows_30d),
    snsHistoryNumCell_(youtube.total_views),
    snsHistoryNumCell_(youtube.video_count),
  ];
}

// One "media" row per entry of instagram.recent_media (an empty list
// when the media fetch failed and the snapshot carries null), each
// stamped with the snapshot's collected_at so a post's growth can be
// followed across collections.
function buildSnsHistoryMediaRows_(snapshot) {
  const snap = snapshot || {};
  const instagram = snap.instagram || {};
  const media = Array.isArray(instagram.recent_media)
    ? instagram.recent_media
    : [];
  return media.map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(snap.collected_at),
      snsHistoryTextCell_(item.id),
      snsHistoryTextCell_(item.posted_at),
      snsHistoryTextCell_(item.type),
      snsHistoryTextCell_(item.caption),
      snsHistoryTextCell_(item.permalink),
      snsHistoryNumCell_(item.views),
      snsHistoryNumCell_(item.reach),
      snsHistoryNumCell_(item.likes),
      snsHistoryNumCell_(item.comments),
      snsHistoryNumCell_(item.shares),
      snsHistoryNumCell_(item.saves),
      snsHistoryNumCell_(item.avg_watch_sec),
      snsHistoryNumCell_(item.total_watch_sec),
    ];
  });
}

// Returns the named sheet, creating it when missing, and writes the
// header row only when the sheet is still empty (an existing header
// — or any existing data — is left untouched).
function ensureSnsHistorySheet_(spreadsheet, name, columns) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
  }
  return sheet;
}

// Compact, secret-free summary of a Sheets failure for the log. The
// configured sheet ID is scrubbed first, in case a Drive error
// message quotes it.
function summarizeSnsHistoryError_(err, sheetId) {
  let message = String((err && err.message) || err || 'unknown error');
  if (sheetId) {
    message = message.split(sheetId).join('[sheet]');
  }
  return message.slice(0, 200);
}

// Appends the snapshot to the history spreadsheet. No-op unless
// SNS_HISTORY_SHEET_ID is set (SpreadsheetApp is not even touched
// then). Never throws: any failure is logged as one line and the
// collection that produced the snapshot still counts as a success.
function appendSnsHistory_(snapshot) {
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return;
  }
  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    const accountSheet = ensureSnsHistorySheet_(
      spreadsheet,
      'account',
      SNS_HISTORY_ACCOUNT_COLUMNS
    );
    accountSheet.appendRow(buildSnsHistoryAccountRow_(snapshot));
    const mediaSheet = ensureSnsHistorySheet_(
      spreadsheet,
      'media',
      SNS_HISTORY_MEDIA_COLUMNS
    );
    buildSnsHistoryMediaRows_(snapshot).forEach((row) =>
      mediaSheet.appendRow(row)
    );
  } catch (err) {
    console.log(
      'SNS history append failed: ' + summarizeSnsHistoryError_(err, sheetId)
    );
  }
}

// --- SNS snapshot history, read side (action=sns_history) ---
// The authenticated counterpart of the append above: the /ga
// trend charts read the "account" sheet back through this action.
// Only the columns the charts need are served, and the response is
// capped at the newest 400 rows (about 100 days at four collections
// a day). An unset property or a missing/empty sheet is not an
// error: the history simply has not started yet, so rows is [].

const SNS_HISTORY_RESPONSE_COLUMNS = [
  'collected_at',
  'ig_followers',
  'threads_followers',
  'youtube_subscribers',
  'total_followers',
  'media_count',
  'views_30d',
  'non_follower_pct',
  'reach_30d',
  'interactions_total',
  'follows_30d',
  'unfollows_30d',
  'yt_total_views',
];
const SNS_HISTORY_MAX_ROWS = 400;

// Sheets hands date cells back as Date objects and numbers as
// numbers, while untouched cells come back as ''. Normalize to the
// JSON shape the admin screen expects: an ISO string for
// collected_at (null when the cell holds no timestamp at all) and
// numbers-or-null for everything else.
function snsHistoryTimestampCell_(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === 'string' && value !== '' ? value : null;
}

function snsHistoryNumberCell_(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buildSnsHistoryResponse_() {
  const empty = { ok: true, action: 'sns_history', rows: [] };
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return empty;
  }
  const sheet = SpreadsheetApp.openById(sheetId).getSheetByName('account');
  if (!sheet || sheet.getLastRow() < 2) {
    return empty;
  }
  const values = sheet
    .getRange(1, 1, sheet.getLastRow(), SNS_HISTORY_ACCOUNT_COLUMNS.length)
    .getValues();
  const header = values[0].map((cell) => String(cell));
  const columnIndex = {};
  SNS_HISTORY_RESPONSE_COLUMNS.forEach((column) => {
    columnIndex[column] = header.indexOf(column);
  });
  const rows = values
    .slice(1)
    .map((cells) => {
      const row = {};
      SNS_HISTORY_RESPONSE_COLUMNS.forEach((column) => {
        const index = columnIndex[column];
        const cell = index >= 0 ? cells[index] : '';
        row[column] =
          column === 'collected_at'
            ? snsHistoryTimestampCell_(cell)
            : snsHistoryNumberCell_(cell);
      });
      return row;
    })
    // Rows without a timestamp (leftovers of a partial write, say)
    // cannot be placed on a time axis; drop them.
    .filter((row) => row.collected_at !== null)
    .sort((a, b) =>
      a.collected_at < b.collected_at ? -1 : a.collected_at > b.collected_at ? 1 : 0
    );
  return {
    ok: true,
    action: 'sns_history',
    rows: rows.slice(-SNS_HISTORY_MAX_ROWS),
  };
}

// Trigger target: collects the latest follower counts and stores the
// snapshot. Each service fails independently (null), so one broken or
// unconfigured service never blocks the others.
function collectSnsCounts() {
  refreshMetaTokenIfNeeded_();
  refreshThreadsTokenIfNeeded_();
  const threadsRefreshError = refreshThreadsTokenIfNeeded();
  const igViews = fetchInstagramViewsInsights_();
  const igDetail = fetchInstagramAccountDetail_();
  const igDemographics = fetchInstagramDemographics_();
  const igMedia = fetchInstagramRecentMedia_();
  const yt = fetchYouTubeChannelDetail_();
  const snapshot = {
    collected_at: new Date().toISOString(),
    youtube: {
      subscribers: yt.subscribers,
      total_views: yt.total_views,
      video_count: yt.video_count,
      recent_videos: yt.recent_videos,
      youtube_error: yt.youtube_error,
    },
    instagram: {
      freddiefujiwara: fetchInstagramFollowers_(SNS_INSTAGRAM_MAIN_ID),
      anemone_cancer: fetchInstagramFollowers_(SNS_INSTAGRAM_SUB_ID),
      media_count: fetchInstagramMediaCount_(),
      views_30d: igViews.views_30d,
      non_follower_pct: igViews.non_follower_pct,
      insights_error: igViews.insights_error,
      reach_30d: igDetail.reach_30d,
      accounts_engaged_30d: igDetail.accounts_engaged_30d,
      interactions_30d: igDetail.interactions_30d,
      profile_links_taps_30d: igDetail.profile_links_taps_30d,
      profile_links_taps_source: igDetail.profile_links_taps_source,
      follows_30d: igDetail.follows_30d,
      unfollows_30d: igDetail.unfollows_30d,
      demographics: igDemographics.demographics,
      detail_error: joinSnsErrors_([igDetail.detail_error, igDemographics.error]),
      recent_media: igMedia.recent_media,
      media_error: igMedia.media_error,
    },
    threads: {
      followers: fetchThreadsFollowers_(),
      threads_error: threadsRefreshError,
    },
  };
  if (snapshot.threads.threads_error) {
    console.log('Threads refresh error: ' + snapshot.threads.threads_error);
  }
  if (igViews.insights_error) {
    console.log('Instagram insights error: ' + igViews.insights_error);
  }
  if (snapshot.instagram.detail_error) {
    console.log('Instagram detail error: ' + snapshot.instagram.detail_error);
  }
  if (snapshot.instagram.media_error) {
    console.log('Instagram media error: ' + snapshot.instagram.media_error);
  }
  if (snapshot.youtube.youtube_error) {
    console.log('YouTube detail error: ' + snapshot.youtube.youtube_error);
  }
  PropertiesService.getScriptProperties().setProperty(
    SNS_SNAPSHOT_PROPERTY,
    JSON.stringify(snapshot)
  );
  appendSnsHistory_(snapshot);
  console.log('SNS counts collected: ' + JSON.stringify(snapshot));
  return snapshot;
}

// Editor helper: (re)install the 6-hour time-driven trigger for
// collectSnsCounts. Run once from the editor after deployment; triggers
// are not part of the deployed code.
function setupSnsTriggers() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'collectSnsCounts')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('collectSnsCounts').timeBased().everyHours(6).create();
}

const DEFAULT_START = '28daysAgo';
const DEFAULT_END = 'today';
const DEFAULT_METRICS = 'screenPageViews,activeUsers,sessions';
const DEFAULT_DIMENSIONS = 'pagePath';
const DEFAULT_LIMIT = 25;

function parseListParam_(value, fallback) {
  const raw = value == null ? fallback : value;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s);
}

const MATCH_TYPES = {
  exact: 'EXACT',
  contains: 'CONTAINS',
  beginsWith: 'BEGINS_WITH',
  endsWith: 'ENDS_WITH',
  regexp: 'FULL_REGEXP',
};

function parseFilterClauses_(value) {
  if (value == null || value === '') {
    return [];
  }
  return String(value)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s)
    .map((clause) => {
      const first = clause.indexOf(':');
      const second = clause.indexOf(':', first + 1);
      if (first < 1 || second < 0) {
        throw new Error(
          'Invalid filter clause (expected <dimension>:<matchType>:<value>): ' + clause
        );
      }
      const fieldName = clause.slice(0, first).trim();
      const matchType = MATCH_TYPES[clause.slice(first + 1, second).trim()];
      const filterValue = clause.slice(second + 1);
      if (!fieldName || !matchType || filterValue === '') {
        throw new Error(
          'Invalid filter clause (expected <dimension>:<matchType>:<value>): ' + clause
        );
      }
      return { fieldName, matchType, value: filterValue };
    });
}

function buildDimensionFilter_(clauses) {
  const expressions = clauses.map((c) => ({
    filter: {
      fieldName: c.fieldName,
      stringFilter: { matchType: c.matchType, value: c.value, caseSensitive: false },
    },
  }));
  if (expressions.length === 1) {
    return expressions[0];
  }
  return { andGroup: { expressions } };
}

function parseRunParams_(parameter) {
  const p = parameter || {};
  const limit = Number(p.limit);
  const offset = Number(p.offset);
  return {
    startDate: p.start || DEFAULT_START,
    endDate: p.end || DEFAULT_END,
    metrics: parseListParam_(p.metrics, DEFAULT_METRICS),
    dimensions: parseListParam_(
      p.dimensions == null ? DEFAULT_DIMENSIONS : p.dimensions,
      DEFAULT_DIMENSIONS
    ),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
    filters: parseFilterClauses_(p.filter),
  };
}

function buildReportRequest_(params) {
  const body = {
    dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
    metrics: params.metrics.map((name) => ({ name })),
    dimensions: params.dimensions.map((name) => ({ name })),
    limit: String(params.limit),
    offset: String(params.offset || 0),
  };
  if (params.filters && params.filters.length > 0) {
    body.dimensionFilter = buildDimensionFilter_(params.filters);
  }
  if (params.dimensions.length > 0 && params.metrics.length > 0) {
    body.orderBys = [{ metric: { metricName: params.metrics[0] }, desc: true }];
  }
  return body;
}

function fetchReport_(propertyId, body) {
  const res = UrlFetchApp.fetch(GA4_API_BASE + propertyId + ':runReport', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  return { status: res.getResponseCode(), data: JSON.parse(res.getContentText()) };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function htmlOut_(html) {
  return ContentService.createTextOutput(html).setMimeType(
    ContentService.MimeType.HTML
  );
}

function doGet(e) {
  try {
    const parameter = (e && e.parameter) || {};
    // Threads OAuth callback: Threads redirects the owner's browser
    // here with a code after threadsAuthorizeUrl(). The state saved
    // by that helper is the credential for this one request — the
    // redirect carries no ID token — so it is handled before every
    // other route. A code whose state does not match the saved one is
    // never treated as an API action; it just gets a plain page.
    if (parameter.code) {
      const expectedState = getScriptProperty_(THREADS_OAUTH_STATE_PROPERTY);
      if (expectedState && parameter.state && parameter.state === expectedState) {
        const result = handleThreadsOAuthCallback_(parameter.code);
        if (result.ok) {
          return htmlOut_(
            '<!DOCTYPE html><html><body>' +
              '<p>Threads の認可が完了しました。このタブは閉じて構いません。</p>' +
              '</body></html>'
          );
        }
        console.log('Threads OAuth callback failed: ' + result.error);
        return htmlOut_(
          '<!DOCTYPE html><html><body>' +
            '<p>Threads の認可に失敗しました。Apps Script の実行ログを確認してください。</p>' +
            '</body></html>'
        );
      }
      return htmlOut_(
        '<!DOCTYPE html><html><body>' +
          '<p>Threads の認可フローが確認できませんでした。threadsAuthorizeUrl() からやり直してください。</p>' +
          '</body></html>'
      );
    }
    if (parameter.action === 'sns_counts') {
      // Public by design: returns only the stored SNS follower snapshot.
      // Handled before the GA4 property check and before authentication.
      return jsonOut_(buildSnsCountsResponse_());
    }
    const propertyId =
      PropertiesService.getScriptProperties().getProperty('GA4_PROPERTY_ID');
    if (!propertyId) {
      return jsonOut_({
        ok: false,
        error: 'GA4_PROPERTY_ID is not set in Script Properties',
      });
    }
    // The public music play count is served before any
    // authentication: it exposes only the aggregate count.
    if (parameter.action === 'music_count') {
      try {
        const payload = fetchMusicCount_(propertyId);
        return jsonOut_(
          Object.assign({ ok: true, action: 'music_count' }, payload)
        );
      } catch (error) {
        return jsonOut_({
          ok: false,
          status: 502,
          error: String((error && error.message) || error),
        });
      }
    }
    // The public top-articles ranking is served before any
    // authentication, like the music count: it exposes only the
    // top few article ids and their view counts.
    if (parameter.action === 'top_articles') {
      try {
        const payload = fetchTopArticles_(propertyId);
        return jsonOut_(
          Object.assign({ ok: true, action: 'top_articles' }, payload)
        );
      } catch (error) {
        return jsonOut_({
          ok: false,
          status: 502,
          error: String((error && error.message) || error),
        });
      }
    }
    let shareSession = null;
    if (parameter.action === 'issue_share' || parameter.action === 'revoke_share') {
      try {
        verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
      } catch (error) {
        return jsonOut_({ ok: false, status: 401, error: String((error && error.message) || error) });
      }
      const result =
        parameter.action === 'issue_share' ? issueShareSession_() : revokeShareSession_();
      return jsonOut_(Object.assign({ ok: true }, result));
    }
    if (isAuthConfigured_()) {
      if (parameter.share_token) {
        shareSession = validateShareToken_(parameter.share_token);
        if (!shareSession) {
          return jsonOut_({
            ok: false,
            status: 401,
            error: 'share session expired or invalid',
          });
        }
      } else {
        try {
          verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
        } catch (error) {
          const message = String((error && error.message) || error);
          return jsonOut_({
            ok: false,
            status: message === 'forbidden email' ? 403 : 401,
            error: message,
          });
        }
      }
    }
    // The SNS detail snapshot sits behind the same gate as the GA4
    // report (ID token or share token): it carries per-post numbers
    // and follower demographics that the public sns_counts action
    // deliberately never returns.
    if (parameter.action === 'sns_detail') {
      return jsonOut_(buildSnsDetailResponse_());
    }
    // The history rows behind the trend charts sit behind the same
    // gate: they are the same numbers as sns_detail, only older.
    if (parameter.action === 'sns_history') {
      return jsonOut_(buildSnsHistoryResponse_());
    }
    const params = parseRunParams_(parameter);
    const body = buildReportRequest_(params);
    const result = fetchReport_(propertyId, body);
    if (result.status !== 200) {
      return jsonOut_({ ok: false, status: result.status, error: result.data });
    }
    return jsonOut_({
      ok: true,
      property: propertyId,
      startDate: params.startDate,
      endDate: params.endDate,
      metrics: params.metrics,
      dimensions: params.dimensions,
      filters: params.filters,
      offset: params.offset,
      _share: shareSession ? { expires_at: shareSession.expires_at } : undefined,
      data: result.data,
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

if (typeof exports !== 'undefined') {
  exports.doGet = doGet;
  exports.issueShareToken = issueShareToken;
  exports.issueShareSession_ = issueShareSession_;
  exports.revokeShareSession_ = revokeShareSession_;
  exports.validateShareToken_ = validateShareToken_;
  exports.hashShareToken_ = hashShareToken_;
  exports.isAuthConfigured_ = isAuthConfigured_;
  exports.extractIdToken_ = extractIdToken_;
  exports.getAllowedEmails_ = getAllowedEmails_;
  exports.verifyGoogleIdTokenOrThrow_ = verifyGoogleIdTokenOrThrow_;
  exports.parseListParam_ = parseListParam_;
  exports.parseFilterClauses_ = parseFilterClauses_;
  exports.buildDimensionFilter_ = buildDimensionFilter_;
  exports.parseRunParams_ = parseRunParams_;
  exports.buildReportRequest_ = buildReportRequest_;
  exports.fetchReport_ = fetchReport_;
  exports.fetchMusicCount_ = fetchMusicCount_;
  exports.fetchTopArticles_ = fetchTopArticles_;
  exports.articleIdFromPath_ = articleIdFromPath_;
  exports.rankTopArticles_ = rankTopArticles_;
  exports.jsonOut_ = jsonOut_;
  exports.collectSnsCounts = collectSnsCounts;
  exports.setupSnsTriggers = setupSnsTriggers;
  exports.getSnsCountsSnapshot_ = getSnsCountsSnapshot_;
  exports.buildSnsCountsResponse_ = buildSnsCountsResponse_;
  exports.fetchGraphFollowersCount_ = fetchGraphFollowersCount_;
  exports.fetchInstagramFollowers_ = fetchInstagramFollowers_;
  exports.fetchInstagramMediaCount_ = fetchInstagramMediaCount_;
  exports.fetchInstagramViewsInsights_ = fetchInstagramViewsInsights_;
  exports.summarizeInsightsError_ = summarizeInsightsError_;
  exports.parseViewsBreakdown_ = parseViewsBreakdown_;
  exports.parseViewsDailyTotal_ = parseViewsDailyTotal_;
  exports.fetchThreadsFollowers_ = fetchThreadsFollowers_;
  exports.parseThreadsFollowersCount_ = parseThreadsFollowersCount_;
  exports.threadsFollowersInsightsUrl_ = threadsFollowersInsightsUrl_;
  exports.debugThreadsFollowers = debugThreadsFollowers;
  exports.fetchYouTubeSubscribers_ = fetchYouTubeSubscribers_;
  exports.buildSnsDetailResponse_ = buildSnsDetailResponse_;
  exports.buildEmptySnsDetail_ = buildEmptySnsDetail_;
  exports.snsNumberOrNull_ = snsNumberOrNull_;
  exports.joinSnsErrors_ = joinSnsErrors_;
  exports.fetchAccountInsightTotal_ = fetchAccountInsightTotal_;
  exports.fetchInstagramAccountDetail_ = fetchInstagramAccountDetail_;
  exports.parseFollowsBreakdown_ = parseFollowsBreakdown_;
  exports.followsBreakdownLabels_ = followsBreakdownLabels_;
  exports.parseInsightsTotalValue_ = parseInsightsTotalValue_;
  exports.parseInsightsDailySum_ = parseInsightsDailySum_;
  exports.fetchProfileLinksTaps_ = fetchProfileLinksTaps_;
  exports.fetchInstagramDemographics_ = fetchInstagramDemographics_;
  exports.parseDemographicsBreakdown_ = parseDemographicsBreakdown_;
  exports.fetchInstagramRecentMedia_ = fetchInstagramRecentMedia_;
  exports.fetchMediaInsights_ = fetchMediaInsights_;
  exports.parseMediaInsights_ = parseMediaInsights_;
  exports.fetchYouTubeChannelDetail_ = fetchYouTubeChannelDetail_;
  exports.fetchYouTubeRecentVideos_ = fetchYouTubeRecentVideos_;
  exports.summarizeYouTubeError_ = summarizeYouTubeError_;
  exports.isTokenRefreshDue_ = isTokenRefreshDue_;
  exports.refreshMetaTokenIfNeeded_ = refreshMetaTokenIfNeeded_;
  exports.refreshThreadsTokenIfNeeded_ = refreshThreadsTokenIfNeeded_;
  exports.threadsAuthorizeUrl = threadsAuthorizeUrl;
  exports.handleThreadsOAuthCallback_ = handleThreadsOAuthCallback_;
  exports.threadsRedirectUri_ = threadsRedirectUri_;
  exports.refreshThreadsTokenIfNeeded = refreshThreadsTokenIfNeeded;
  exports.htmlOut_ = htmlOut_;
  exports.appendSnsHistory_ = appendSnsHistory_;
  exports.buildSnsHistoryResponse_ = buildSnsHistoryResponse_;
  exports.SNS_HISTORY_RESPONSE_COLUMNS = SNS_HISTORY_RESPONSE_COLUMNS;
  exports.buildSnsHistoryAccountRow_ = buildSnsHistoryAccountRow_;
  exports.buildSnsHistoryMediaRows_ = buildSnsHistoryMediaRows_;
  exports.ensureSnsHistorySheet_ = ensureSnsHistorySheet_;
  exports.summarizeSnsHistoryError_ = summarizeSnsHistoryError_;
  exports.SNS_HISTORY_ACCOUNT_COLUMNS = SNS_HISTORY_ACCOUNT_COLUMNS;
  exports.SNS_HISTORY_MEDIA_COLUMNS = SNS_HISTORY_MEDIA_COLUMNS;
}
