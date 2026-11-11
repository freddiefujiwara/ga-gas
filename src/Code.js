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
 *                (Filters are parsed and validated, but filtered reports
 *                are not served: see below.)
 *
 * The default report is served from the history spreadsheet the
 * hourly collection writes (stage 2), in the fixed shapes the
 * /social screen uses — totals, daily views, page ranking,
 * channel ranking, per-article display times — and no longer
 * calls the GA4 Data API.
 * Unsupported parameter combinations answer ok:false.
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
const FRONTEND_URL = 'https://freddiefujiwara.com/social/';
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

// Successful ID-token verifications are cached for a few
// minutes: the /social screen fires several authenticated
// requests per load (detail, history, the blog shapes), and
// without the cache every one of them pays a live tokeninfo
// fetch. The cache key is the SHA-256 hash of the token (the
// token itself is never stored), the entry dies with the
// token's own expiry at the latest, and the allowed-email
// list is re-checked on a hit so removing an address takes
// effect immediately. Failed verifications are never cached.
const ID_TOKEN_VERIFY_CACHE_PREFIX = 'id_token_verify_v1_';
const ID_TOKEN_VERIFY_CACHE_MAX_SECONDS = 300;

function verifyGoogleIdTokenOrThrow_(idToken) {
  if (!idToken) {
    throw new Error('missing id token');
  }
  const oauthClientId = getScriptProperty_('GOOGLE_OAUTH_CLIENT_ID');
  if (!oauthClientId) {
    throw new Error('missing GOOGLE_OAUTH_CLIENT_ID');
  }
  const cache = sheetReadCache_();
  let cacheKey = null;
  try {
    cacheKey = cache
      ? ID_TOKEN_VERIFY_CACHE_PREFIX + hashShareToken_(idToken)
      : null;
  } catch (err) {
    cacheKey = null;
  }
  if (cacheKey) {
    let cached = null;
    try {
      cached = JSON.parse(cache.get(cacheKey) || 'null');
    } catch (err) {
      cached = null;
    }
    if (
      cached &&
      cached.email &&
      Number.isFinite(cached.exp) &&
      cached.exp > Math.floor(Date.now() / 1000)
    ) {
      if (!getAllowedEmails_().includes(cached.email)) {
        throw new Error('forbidden email');
      }
      return { email: cached.email, sub: cached.sub };
    }
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
  if (cacheKey) {
    try {
      cache.put(
        cacheKey,
        JSON.stringify({ email, sub: payload.sub, exp: expSeconds }),
        Math.max(
          1,
          Math.min(
            ID_TOKEN_VERIFY_CACHE_MAX_SECONDS,
            expSeconds - Math.floor(Date.now() / 1000)
          )
        )
      );
    } catch (err) {
      // Caching a verification is an optimization only; a
      // cache failure never fails the verification itself.
    }
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

// --- Owner sessions (long-lived sign-in) ---
// Google ID tokens expire after about an hour, which used to drop the
// owner back at the sign-in gate. After a Google sign-in the frontend
// exchanges the ID token for one of these 30-day owner sessions (same
// Script Properties storage as the share session, separate keys) and
// uses it for all later calls. Issuing a new one overwrites the old
// one, and the frontend revokes its session on logout.

function issueOwnerSession_() {
  const now = new Date();
  const expires = new Date(now.getTime() + SHARE_TTL_SECONDS * 1000);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('OWNER_TOKEN_HASH', hashShareToken_(token));
  props.setProperty('OWNER_EXPIRES_AT', expires.toISOString());
  return {
    session_token: token,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
    ttl_seconds: SHARE_TTL_SECONDS,
  };
}

function revokeOwnerSession_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('OWNER_TOKEN_HASH');
  props.deleteProperty('OWNER_EXPIRES_AT');
  return { revoked: true };
}

function validateOwnerToken_(token) {
  if (!token) {
    return null;
  }
  const props = PropertiesService.getScriptProperties();
  const hash = props.getProperty('OWNER_TOKEN_HASH');
  if (!hash || hashShareToken_(token) !== hash) {
    return null;
  }
  const expiresAt = props.getProperty('OWNER_EXPIRES_AT');
  if (!expiresAt || expiresAt <= new Date().toISOString()) {
    return null;
  }
  return { expires_at: expiresAt };
}

// Owner proof for owner-only actions: a valid Google ID token, or a
// live owner session token (the post-sign-in steady state).
function requireOwnerAuth_(e) {
  const sessionToken = (e && e.parameter && e.parameter.session_token) || '';
  if (sessionToken && validateOwnerToken_(sessionToken)) {
    return;
  }
  verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
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
//     through the Threads use case, separately from the token above).
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
//   SNS_HISTORY_SHEET_ID (optional): spreadsheet that receives the
//     history writes of every collection (see appendSnsHistory_):
//     one appended row per collection on "account", one upserted
//     row per post / video / day / segment / metric on the other
//     tabs. The same spreadsheet also receives the blog's GA4
//     history on every collection (see appendBlogHistory_). Unset
//     means no history is written.
// The Instagram snapshot also carries account KPIs for the main
// account: media_count (post count, available with instagram_basic)
// plus views_30d / non_follower_pct from the account insights, which
// stay null until the token also has instagram_manage_insights.
// When the insights calls fail, instagram.insights_error holds a
// short secret-free summary of the API error (null on success) so the
// failure is visible in the snapshot instead of silently null.
// The Threads section likewise carries detail beyond the follower
// count — the account metrics and per-post insights described in
// the Threads detail section below — under the same rule, with
// threads.detail_error / threads.posts_error as the summaries.

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
      x: { followers: null },
    };
  }
  const youtube = snapshot.youtube || {};
  const instagram = snapshot.instagram || {};
  const threads = snapshot.threads || {};
  const x = snapshot.x || {};
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
    x: { followers: snsNumberOrNull_(x.followers) },
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
      daily_follows: null,
      daily_follows_missing_days: null,
      daily_follows_error: null,
      demographics: { age_gender: null, top_cities: null, top_countries: null },
      detail_error: null,
      recent_media: null,
      media_error: null,
    },
    threads: {
      followers: null,
      threads_error: null,
      views_30d: null,
      interactions_30d: {
        total: null,
        likes: null,
        replies: null,
        reposts: null,
        quotes: null,
      },
      detail_error: null,
      recent_posts: null,
      posts_error: null,
    },
    x: {
      followers: null,
      username: null,
      x_error: null,
      recent_posts: null,
      posts_error: null,
    },
  };
}

// action=sns_detail (authenticated): the detail for the
// /social admin screen, assembled from the history spreadsheet
// (stage 2: the screen's reads come from the sheet, never from
// a live API call — see buildSnsDetailFromSheet_ below). The
// stored snapshot is the fallback: when the sheet cannot be
// read (or holds no account row yet), the snapshot is served
// exactly as before, and before the first collection the empty
// shape above is served. The assembled detail is cached for
// an hour — and the hourly collection precomputes it — so
// repeated screen loads do not re-read every tab.
function buildSnsDetailResponse_() {
  const cache = sheetReadCache_();
  if (cache) {
    const hit = getCachedText_(cache, SNS_DETAIL_CACHE_KEY);
    if (hit) {
      try {
        return Object.assign(
          { ok: true, action: 'sns_detail' },
          JSON.parse(hit)
        );
      } catch (err) {
        // A corrupt cache entry is ignored; the detail is rebuilt.
      }
    }
  }
  let detail = null;
  try {
    detail = buildSnsDetailFromSheet_();
  } catch (err) {
    console.log(
      'SNS detail from sheet failed: ' +
        summarizeSnsHistoryError_(
          err,
          getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY)
        )
    );
    detail = null;
  }
  if (!detail) {
    detail = getSnsCountsSnapshot_() || buildEmptySnsDetail_();
  }
  if (cache) {
    // Stored chunked (see putCachedText_): a detail past the
    // per-value cap is cached too, instead of going uncached
    // as it did when the whole JSON had to fit one value.
    putCachedText_(
      cache,
      SNS_DETAIL_CACHE_KEY,
      JSON.stringify(detail),
      SNS_DETAIL_CACHE_SECONDS
    );
  }
  return Object.assign({ ok: true, action: 'sns_detail' }, detail);
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

// The two inputs every Threads fetch needs, resolved the same way
// everywhere: the dedicated Threads token when set (falling back
// to the shared Meta token), and the authorized account's Threads
// user id from the OAuth flow (THREADS_USER_ID), with the constant
// as the pre-OAuth fallback.
function threadsToken_() {
  return (
    getScriptProperty_('META_THREADS_ACCESS_TOKEN') ||
    getScriptProperty_('META_ACCESS_TOKEN')
  );
}

function threadsUserId_() {
  return getScriptProperty_('THREADS_USER_ID') || SNS_THREADS_USER_ID;
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
  const token = threadsToken_();
  if (!token) {
    return null;
  }
  const userId = threadsUserId_();
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

// --- Threads detail (account metrics + per-post, sns_detail only) --
// Threads started as followers-only (the public snapshot). The /ga
// Threads tab now wants the same depth as Instagram, so
// collectSnsCounts() also gathers, into the snapshot's threads
// section (served only through the authenticated action=sns_detail;
// the public projection keeps returning followers only):
//   - account-level totals for the last 30 days from the user's
//     threads_insights edge: views plus the interaction split
//     (likes / replies / reposts / quotes), failures summarised in
//     threads.detail_error;
//   - the newest posts (id, text, timestamp, permalink) from the
//     user's threads edge, each with its media insights (views /
//     likes / replies / reposts / quotes), failures summarised in
//     threads.posts_error.
// Every fetch fails independently, exactly like the Instagram
// detail: an unobtainable value stays null and the rest of the
// snapshot is unaffected, and error summaries are built from
// response status/body only, never from a request URL.

const SNS_THREADS_RECENT_POSTS_LIMIT = 30;
const THREADS_MEDIA_INSIGHT_METRICS = 'views,likes,replies,reposts,quotes';
const THREADS_ACCOUNT_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'];

// One account-level threads_insights request for a single metric
// over the shared 30-day window. The URL carries no token; callers
// append '&access_token=...' themselves.
function threadsAccountInsightsUrl_(userId, metric, window) {
  return (
    THREADS_GRAPH_BASE +
    userId +
    '/threads_insights?metric=' +
    metric +
    '&since=' +
    window.since +
    '&until=' +
    window.until
  );
}

// Fetches one account-level Threads metric as a 30-day total.
// Returns { value, error } and never throws. The total is read with
// parseViewsDailyTotal_ (total_value when the response carries one,
// otherwise the sum of the per-day values): the reading is
// metric-agnostic, and for these flow metrics both forms mean the
// 30-day total — unlike followers_count, which is a current total
// and keeps its own parser above.
function fetchThreadsAccountInsightTotal_(metric) {
  const token = threadsToken_();
  const res = fetchInsightsJson_(
    threadsAccountInsightsUrl_(threadsUserId_(), metric, snsInsightsWindow_()) +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (res.error) {
    return { value: null, error: metric + ': ' + res.error };
  }
  return { value: parseViewsDailyTotal_(res.data), error: null };
}

// Account-level detail for Threads (last 30 days): views and the
// interaction totals. Each metric is a separate request, so one
// rejected metric nulls only itself. interactions_30d.total is the
// sum of the parts that came back, and stays null when none did.
function fetchThreadsAccountDetail_() {
  const result = {
    views_30d: null,
    interactions_30d: {
      total: null,
      likes: null,
      replies: null,
      reposts: null,
      quotes: null,
    },
    detail_error: null,
  };
  if (!threadsToken_()) {
    return result;
  }
  const errors = [];
  const grab = (metric) => {
    const fetched = fetchThreadsAccountInsightTotal_(metric);
    if (fetched.error) {
      errors.push(fetched.error);
    }
    return fetched.value;
  };
  result.views_30d = grab('views');
  const likes = grab('likes');
  const replies = grab('replies');
  const reposts = grab('reposts');
  const quotes = grab('quotes');
  const parts = [likes, replies, reposts, quotes].filter(
    (value) => value !== null
  );
  result.interactions_30d = {
    total: parts.length
      ? parts.reduce((sum, value) => sum + value, 0)
      : null,
    likes,
    replies,
    reposts,
    quotes,
  };
  result.detail_error = joinSnsErrors_(errors);
  return result;
}

// The user's own threads list (newest first). The URL carries no
// token; callers append '&access_token=...' themselves so the
// diagnostic can print the request with the token redacted.
function threadsPostListUrl_(userId, limit) {
  return (
    THREADS_GRAPH_BASE +
    userId +
    '/threads?fields=id,text,timestamp,permalink,media_type&limit=' +
    limit
  );
}

// One snapshot entry for a Threads post, with the insight values
// starting null (filled in by fetchThreadsPostInsights_). The text
// is passed through under the same safety cap as Instagram
// captions.
function buildThreadsPostEntry_(post) {
  const text = post && post.text != null ? String(post.text) : '';
  return {
    id: post && post.id != null ? String(post.id) : null,
    type: (post && post.media_type) || null,
    posted_at: (post && post.timestamp) || null,
    text: text.slice(0, SNS_CAPTION_MAX_LENGTH),
    permalink: (post && post.permalink) || null,
    views: null,
    likes: null,
    replies: null,
    reposts: null,
    quotes: null,
  };
}

// Maps one Threads media insights response to the snapshot's key
// names. Metrics absent from the response (or not numeric) stay out
// of the map, so the caller's nulls remain for them.
function parseThreadsMediaInsights_(data) {
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
    if (THREADS_ACCOUNT_METRICS.indexOf(entry.name) >= 0) {
      values[entry.name] = num;
    }
  });
  return values;
}

// Per-post insights for one Threads post. Returns { values, error };
// a post the insights edge refuses (a repost of someone else's
// post, say) keeps its nulls and contributes one error line.
function fetchThreadsPostInsights_(post, token) {
  const empty = {
    views: null,
    likes: null,
    replies: null,
    reposts: null,
    quotes: null,
  };
  if (!post || post.id == null) {
    return { values: empty, error: null };
  }
  const res = fetchInsightsJson_(
    THREADS_GRAPH_BASE +
      post.id +
      '/insights?metric=' +
      THREADS_MEDIA_INSIGHT_METRICS +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (res.error) {
    return { values: empty, error: String(post.id) + ': ' + res.error };
  }
  return {
    values: Object.assign({}, empty, parseThreadsMediaInsights_(res.data)),
    error: null,
  };
}

// The newest Threads posts with their per-post insights, mirroring
// fetchInstagramRecentMedia_: the list fetch failing nulls the
// whole section, while per-post failures only null that post's
// numbers and are counted into posts_error.
function fetchThreadsRecentPosts_() {
  const token = threadsToken_();
  if (!token) {
    return { recent_posts: null, posts_error: null };
  }
  const listRes = fetchInsightsJson_(
    threadsPostListUrl_(threadsUserId_(), SNS_THREADS_RECENT_POSTS_LIMIT) +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (listRes.error) {
    return { recent_posts: null, posts_error: 'threads list: ' + listRes.error };
  }
  const items =
    listRes.data && Array.isArray(listRes.data.data) ? listRes.data.data : null;
  if (!items) {
    return {
      recent_posts: null,
      posts_error: 'threads list: response had no threads array',
    };
  }
  const failures = [];
  const posts = items.slice(0, SNS_THREADS_RECENT_POSTS_LIMIT).map((post) => {
    const entry = buildThreadsPostEntry_(post);
    const insights = fetchThreadsPostInsights_(post, token);
    if (insights.error) {
      failures.push(insights.error);
    }
    Object.assign(entry, insights.values);
    return entry;
  });
  return {
    recent_posts: posts,
    posts_error: failures.length
      ? failures.length +
        ' of ' +
        posts.length +
        ' post insights failed (' +
        failures[0] +
        ')'
      : null,
  };
}

// Reads one threads_insights entry (a single metric) as a total:
// total_value.value when present, otherwise the sum of the per-day
// values. This is the entry-level twin of parseViewsDailyTotal_,
// shared by the debugThreadsPosts by-name reading below.
function threadsInsightEntryTotal_(entry) {
  if (!entry) {
    return null;
  }
  const totalValue = Number(entry.total_value && entry.total_value.value);
  if (Number.isFinite(totalValue)) {
    return totalValue;
  }
  if (!Array.isArray(entry.values)) {
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

// Maps a multi-metric threads_insights response to { name: total },
// keeping only the metrics that read as numbers. Used by
// debugThreadsPosts to show what the combined account request
// actually carries before the per-metric production fetches are
// trusted.
function parseThreadsInsightsByName_(data) {
  const totals = {};
  const entries = data && Array.isArray(data.data) ? data.data : [];
  entries.forEach((entry) => {
    if (!entry || !entry.name) {
      return;
    }
    const total = threadsInsightEntryTotal_(entry);
    if (total !== null) {
      totals[entry.name] = total;
    }
  });
  return totals;
}

function fetchYouTubeSubscribers_() {
  // Kept as the narrow accessor; the channel fetch itself lives in
  // fetchYouTubeChannelDetail_() with the rest of the SNS detail.
  return fetchYouTubeChannelDetail_().subscribers;
}

// --- X detail (via tweet-gas, GAS-to-GAS sync) ---------------------
// X's API keys live only in tweet-gas (the project that posts to
// X); this project never holds them. The hourly collection POSTs
// { action: 'sns_snapshot', sync_token } to tweet-gas's web app
// and receives the follower count plus the newest posts with
// their public metrics. That is the same machine sync-token
// pattern alarm-gas and time-table-gas use: the caller holds
// TWEET_GAS_EXEC_URL (the other app's /exec URL) and
// TWEET_GAS_SYNC_TOKEN, the same value as tweet-gas's SYNC_TOKEN
// property. While either property is unset the section reads as
// all nulls with no error — X simply is not connected yet. A
// failed call reports the same summary on x_error and
// posts_error (the two halves travel in one call here, unlike
// the per-edge fetches of the other networks), without touching
// the rest of the collection.

const SNS_X_RECENT_POSTS_LIMIT = 50;

// A wire value from the tweet-gas response as a number, or null
// when it did not arrive as one.
function xWireNumberOrNull_(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// One snapshot entry for an X post, normalized from the wire
// entry tweet-gas sends. The text is capped under the same limit
// as Instagram captions and Threads texts; the post URL is not
// on the wire (it is derivable), so it is rebuilt from the post
// id here — the same call the read side makes for YouTube videos.
function buildXPostEntry_(post) {
  const item = post || {};
  const id = item.id != null ? String(item.id) : null;
  const text = item.text != null ? String(item.text) : '';
  return {
    id,
    posted_at: item.posted_at || null,
    text: text.slice(0, SNS_CAPTION_MAX_LENGTH),
    url: id ? 'https://x.com/i/web/status/' + id : null,
    views: xWireNumberOrNull_(item.views),
    likes: xWireNumberOrNull_(item.likes),
    reposts: xWireNumberOrNull_(item.reposts),
    replies: xWireNumberOrNull_(item.replies),
  };
}

// The whole X section from one POST to tweet-gas. Never throws:
// every failure mode (unconfigured, HTTP error, malformed or
// not-ok body) lands in the error fields with the values null.
function fetchXDetail_() {
  const result = {
    followers: null,
    username: null,
    recent_posts: null,
    x_error: null,
    posts_error: null,
  };
  const url = getScriptProperty_('TWEET_GAS_EXEC_URL');
  const token = getScriptProperty_('TWEET_GAS_SYNC_TOKEN');
  if (!url || !token) {
    return result;
  }
  const fail = (message) => {
    result.x_error = message;
    result.posts_error = message;
    return result;
  };
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'text/plain',
      payload: JSON.stringify({ action: 'sns_snapshot', sync_token: token }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    return fail(
      'tweet-gas fetch exception (' + ((err && err.name) || 'Error') + ')'
    );
  }
  if (res.getResponseCode() !== 200) {
    return fail('tweet-gas HTTP ' + res.getResponseCode());
  }
  let data = null;
  try {
    data = JSON.parse(res.getContentText());
  } catch (err) {
    data = null;
  }
  if (!data || data.ok !== true) {
    const reason =
      data && data.error
        ? String(data.error).slice(0, 200)
        : 'response was not ok JSON';
    return fail('tweet-gas: ' + reason);
  }
  const x = data.x || {};
  result.followers = xWireNumberOrNull_(x.followers);
  result.username = x.username != null ? String(x.username) : null;
  result.x_error =
    typeof data.x_error === 'string' && data.x_error ? data.x_error : null;
  result.posts_error =
    typeof data.posts_error === 'string' && data.posts_error
      ? data.posts_error
      : null;
  if (Array.isArray(x.recent_posts)) {
    result.recent_posts = x.recent_posts
      .map(buildXPostEntry_)
      .filter((entry) => entry.id)
      .slice(0, SNS_X_RECENT_POSTS_LIMIT);
  }
  return result;
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
// opens the logged URL and approves the threads_basic and
// threads_manage_insights scopes. threads_basic covers the profile
// reads, and threads_manage_insights is required because the
// follower count comes from the threads_insights edge (the profile
// node has no followers_count field, and insights refuses a
// threads_basic-only token with a permission error). Threads
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
// Scopes requested at authorization time, comma-separated as the
// Threads OAuth endpoint expects. threads_manage_insights is needed
// for the threads_insights follower count; a refreshed token keeps
// the scopes of the original authorization, so widening the scope
// requires one fresh authorization run.
const THREADS_OAUTH_SCOPES = 'threads_basic,threads_manage_insights';
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
    '&scope=' +
    THREADS_OAUTH_SCOPES +
    '&response_type=code&state=' +
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
// media, YouTube channel totals plus the newest videos, and the
// Threads account metrics and per-post insights (see the Threads
// detail section below). They are stored in the same snapshot and
// served only through the authenticated action=sns_detail;
// action=sns_counts keeps returning the small public projection
// built above.
//
// Every fetch below fails independently: an unobtainable value stays
// null and the rest of the snapshot is unaffected. Failures are
// summarised per section — instagram.detail_error for the account
// insights and demographics, instagram.media_error for per-post
// insights, youtube.youtube_error for YouTube, threads.detail_error
// and threads.posts_error for Threads — using the same
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
    daily_follows: null,
    daily_follows_missing_days: null,
    daily_follows_error: null,
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
  // The per-day series fails on its own key, not into detail_error:
  // the /ga chart wants to tell "no data yet" apart from "the
  // totals are broken", and the totals above already report into
  // detail_error.
  const dailyFollows = fetchInstagramDailyFollows_();
  result.daily_follows = dailyFollows.series;
  result.daily_follows_missing_days = dailyFollows.missing_days;
  result.daily_follows_error = dailyFollows.error;
  result.detail_error = joinSnsErrors_(errors);
  return result;
}

// --- Instagram daily follows series --------------------------------
// Per-day follows/unfollows for the last 30 Asia/Tokyo calendar
// days, so the /ga Instagram tab can chart follows and unfollows
// per day and map the day's posts onto the same axis. Meta offers
// no per-post follow attribution, so the day series plus the post
// dates (from recent_media) is the closest honest view; the
// shaping lives here, the mapping lives in the frontend.
//
// How a day is read was settled by production debugging on
// 2026-11-09 (debugInstagramDailyFollows): the plain period=day
// form is rejected (HTTP 400 "(#100) The following metrics
// (follows_and_unfollows) should be specified with parameter
// metric_type=total_value"), and the metric_type=total_value form
// answers only the whole window's split — total_value.breakdowns
// by follow_type, with no per-day values and no end_time — so one
// request can never yield a day series. The series is therefore
// built one day at a time: for each JST calendar day, the same
// total_value + breakdown=follow_type request the totals use is
// narrowed to that day's since/until window (JST 00:00:00 to
// 23:59:59 as unix seconds), and parseFollowsBreakdown_ reads the
// split. A day whose request fails or carries no split stays
// { follows: null, unfollows: null } in the series and is counted
// in missing_days; the fetch only gives up (series null, error
// set) when every day failed. Today's row is a running total —
// the day is still in progress — and later collections overwrite
// it, so the series self-corrects.
const SNS_DAILY_FOLLOWS_DAYS = 30;
const SNS_JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SNS_DAY_MS = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" of an instant read in Asia/Tokyo. Computed by
// shifting the instant by the JST offset and reading UTC fields,
// so the runtime's own timezone never leaks into the key.
function jstDateKey_(ms) {
  const shifted = new Date(ms + SNS_JST_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return shifted.getUTCFullYear() + '-' + month + '-' + day;
}

// One JST calendar day's window as unix seconds: since is the
// day's 00:00:00 JST and until its 23:59:59 JST. Date.parse with
// an explicit +09:00 offset keeps the conversion independent of
// the runtime timezone; JST has no daylight saving, so the day
// is always exactly SNS_DAY_MS long.
function jstDayWindowSec_(dateKey) {
  const startMs = Date.parse(dateKey + 'T00:00:00+09:00');
  if (!Number.isFinite(startMs)) {
    return null;
  }
  const since = Math.floor(startMs / 1000);
  return { since: since, until: since + SNS_DAY_MS / 1000 - 1 };
}

// The SNS_DAILY_FOLLOWS_DAYS JST date keys ending today (JST),
// ascending. nowMs is a parameter so the shape stays testable;
// stepping back in whole days is exact because JST never shifts.
function dailyFollowsDateKeys_(nowMs) {
  const todayStartMs = Date.parse(jstDateKey_(nowMs) + 'T00:00:00+09:00');
  const keys = [];
  for (let i = SNS_DAILY_FOLLOWS_DAYS - 1; i >= 0; i--) {
    keys.push(jstDateKey_(todayStartMs - i * SNS_DAY_MS));
  }
  return keys;
}

// Fetches one JST day's follows/unfollows split. Returns
// { follows, unfollows, error }: on success error is null and a
// side the response did not report stays null (never guessed as
// 0); on failure both sides are null and error summarises why,
// built only from the response status/body or the observed
// breakdown labels, never from the request URL.
function fetchInstagramDailyFollowsDay_(dateKey, token) {
  const dayWindow = jstDayWindowSec_(dateKey);
  if (!dayWindow) {
    return { follows: null, unfollows: null, error: 'invalid date: ' + dateKey };
  }
  const url =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=follows_and_unfollows&period=day' +
    '&metric_type=total_value&since=' +
    dayWindow.since +
    '&until=' +
    dayWindow.until +
    '&breakdown=follow_type&access_token=' +
    encodeURIComponent(token);
  const res = fetchInsightsJson_(url);
  if (res.error) {
    return { follows: null, unfollows: null, error: res.error };
  }
  const parsed = parseFollowsBreakdown_(res.data);
  if (!parsed) {
    const labels = followsBreakdownLabels_(res.data);
    return {
      follows: null,
      unfollows: null,
      error:
        'response had no follow_type breakdown' +
        (labels.length ? ' (labels: [' + labels.join(', ') + '])' : ''),
    };
  }
  return { follows: parsed.follows, unfollows: parsed.unfollows, error: null };
}

// Builds the per-day series by fetching each of the last
// SNS_DAILY_FOLLOWS_DAYS JST days on its own. Returns
// { series, missing_days, error } and never throws: without a
// token the series stays null with no error (the same "not
// configured" silence as the other Instagram fetches); days that
// fail stay in the series as null/null rows counted in
// missing_days, with error still null; only when every day
// failed is the series null and error set (summarising the first
// day's failure).
function fetchInstagramDailyFollows_() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return { series: null, missing_days: 0, error: null };
  }
  const dateKeys = dailyFollowsDateKeys_(Date.now());
  const series = [];
  let missingDays = 0;
  let firstError = null;
  dateKeys.forEach((dateKey) => {
    const day = fetchInstagramDailyFollowsDay_(dateKey, token);
    if (day.error) {
      missingDays += 1;
      if (!firstError) {
        firstError = day.error;
      }
    }
    series.push({
      date: dateKey,
      follows: day.follows,
      unfollows: day.unfollows,
    });
  });
  if (missingDays === dateKeys.length) {
    return {
      series: null,
      missing_days: missingDays,
      error:
        'follows_and_unfollows daily: all ' +
        missingDays +
        ' days failed (first: ' +
        firstError +
        ')',
    };
  }
  return { series: series, missing_days: missingDays, error: null };
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

// --- Manual diagnostics: debugInstagramDailyFollows ---------------
// Run by hand from the Apps Script editor to check the per-day
// follows fetch against the live API. The production run on
// 2026-11-09 settled the request form (see the daily follows
// section above): the plain period=day form is rejected and the
// total_value form only answers whole-window splits, so the
// series is fetched one JST day at a time. This logs the raw
// total_value response for yesterday's JST window (token redacted
// by debugLogInsightsShape_), then the newest few days as the
// per-day fetch reads them, then the full fetch outcome (series
// length, missing days, error) — all without running a
// collection. Never called from a trigger or doGet; does not
// touch the snapshot.
function debugInstagramDailyFollows() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set; nothing to diagnose.');
    return;
  }
  const dateKeys = dailyFollowsDateKeys_(Date.now());
  const yesterday = dateKeys[dateKeys.length - 2];
  const yesterdayWindow = jstDayWindowSec_(yesterday);
  debugLogInsightsShape_(
    'G follows_and_unfollows one JST day (' +
      yesterday +
      ') metric_type=total_value breakdown=follow_type',
    'metric=follows_and_unfollows&period=day&metric_type=total_value' +
      '&since=' +
      yesterdayWindow.since +
      '&until=' +
      yesterdayWindow.until +
      '&breakdown=follow_type',
    token,
    {}
  );
  Logger.log('=== per-day fetch (newest 3 days) ===');
  dateKeys.slice(-3).forEach((dateKey) => {
    const day = fetchInstagramDailyFollowsDay_(dateKey, token);
    Logger.log(
      dateKey +
        ': follows=' +
        day.follows +
        ' unfollows=' +
        day.unfollows +
        (day.error ? ' error: ' + day.error : '')
    );
  });
  const fetched = fetchInstagramDailyFollows_();
  Logger.log('=== full daily_follows fetch ===');
  Logger.log('error: ' + (fetched.error || '(none)'));
  Logger.log('missing_days: ' + fetched.missing_days);
  Logger.log(
    'series: ' +
      (fetched.series
        ? fetched.series.length +
          ' days, ' +
          fetched.series[0].date +
          ' .. ' +
          fetched.series[fetched.series.length - 1].date
        : '(null)')
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

// --- Manual diagnostics: debugThreadsPosts ------------------------
// Run by hand from the Apps Script editor after the Threads detail
// collection (account metrics + per-post insights) is deployed, to
// see the raw shapes the new requests actually return before
// trusting the parsed snapshot — the same debug-first step
// debugThreadsFollowers provided for the follower count. It runs
// the three new request families once each: the combined account
// insights request (metric=views,likes,replies,reposts,quotes over
// the 30-day window), the user's threads list (limit 3, just enough
// to see the entry shape), and the media insights of the first
// listed post. Each stage logs its request URL with
// access_token=<redacted>, the HTTP status and the scrubbed body,
// plus the values the production parsers read out of it. The stages
// are independent: a stage that fails or returns nothing usable
// stops only itself. It is never called from a trigger or from
// doGet, and it does not touch the snapshot.
function debugThreadsPosts() {
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
  const window = snsInsightsWindow_();
  const accountData = debugThreadsGet_(
    'account insights (metric=views,likes,replies,reposts,quotes, last 30 days)',
    THREADS_GRAPH_BASE +
      userId +
      '/threads_insights?metric=' +
      THREADS_ACCOUNT_METRICS.join(',') +
      '&since=' +
      window.since +
      '&until=' +
      window.until,
    token
  );
  if (accountData) {
    Logger.log(
      'parsed account totals: ' +
        JSON.stringify(parseThreadsInsightsByName_(accountData))
    );
  }
  const listData = debugThreadsGet_(
    'threads list (limit 3)',
    threadsPostListUrl_(userId, 3),
    token
  );
  const items =
    listData && Array.isArray(listData.data) ? listData.data : null;
  if (!items || !items.length) {
    Logger.log('no posts in the list response; skipping media insights.');
    return;
  }
  const firstEntry = buildThreadsPostEntry_(items[0]);
  Logger.log('first post entry: ' + JSON.stringify(firstEntry));
  if (firstEntry.id == null) {
    Logger.log('first post has no id; skipping media insights.');
    return;
  }
  const mediaData = debugThreadsGet_(
    'media insights for the first post',
    THREADS_GRAPH_BASE +
      firstEntry.id +
      '/insights?metric=' +
      THREADS_MEDIA_INSIGHT_METRICS,
    token
  );
  if (mediaData) {
    Logger.log(
      'parsed media insights: ' +
        JSON.stringify(parseThreadsMediaInsights_(mediaData))
    );
  }
}

// One GET for debugThreadsPosts: logs the label, the request URL
// with the token redacted, the HTTP status and the scrubbed body
// (truncated like the other diagnostics), and returns the parsed
// body on HTTP 200 — null on any failure, so the calling stage can
// stop without throwing. The token itself is only ever appended to
// the real request, never to the logged one.
function debugThreadsGet_(label, url, token) {
  Logger.log('=== ' + label + ' ===');
  Logger.log('GET ' + url + '&access_token=<redacted>');
  let res;
  try {
    res = UrlFetchApp.fetch(
      url + '&access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
  } catch (err) {
    Logger.log('fetch exception (' + ((err && err.name) || 'Error') + ')');
    return null;
  }
  const status = res.getResponseCode();
  Logger.log('HTTP ' + status);
  const bodyText = res.getContentText();
  Logger.log(
    debugScrubToken_(bodyText, token).slice(0, SNS_DEBUG_LOG_LIMIT)
  );
  if (status !== 200) {
    return null;
  }
  try {
    return JSON.parse(bodyText);
  } catch (err) {
    Logger.log('response body is not JSON; nothing parsed.');
    return null;
  }
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
      '/media?fields=id,media_type,media_product_type,caption,timestamp,permalink,thumbnail_url,media_url&limit=' +
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
    // The still image for the /social post lists: videos and reels
    // carry thumbnail_url, photos carry only media_url (the image
    // itself), so the first non-empty one wins. Both are signed
    // CDN URLs that expire; the hourly collection refreshes them,
    // so a stored value is never older than the collection that
    // wrote it.
    thumbnail_url:
      (media && media.thumbnail_url) || (media && media.media_url) || null,
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
// names a spreadsheet, collectSnsCounts() also writes the snapshot
// to it, in two different shapes:
//   - "account" is the one time series: one appended row per
//     collection, the input of the /ga trend charts.
//   - Every post-shaped tab ("media", "threads_media",
//     "youtube_media"), the "daily" tab, the follower-demographics
//     tab ("ig_demographics") and the Threads account-metrics tab
//     ("threads_account") hold ONE row per key (media_id / post_id /
//     video_id / date / breakdown segment / metric) and are
//     upserted: the whole tab is read back, the fresh rows are
//     merged in by key — a fresh value wins, but a null in the
//     fresh fetch becomes an empty cell and never erases the
//     stored value — and the tab is rewritten as header + one row
//     per key. That also folds duplicates written by earlier
//     append-only collections into a single row per post on the
//     next run.
// The blog's GA4 numbers are written to the same spreadsheet by
// appendBlogHistory_ below ("blog_daily" / "blog_posts").
// All sheets are created when missing and get their header row
// when still empty. The sheet ID is only ever read from the Script
// Property, never written in code. Unset (the default) means no
// history is written at all, and a failed write never fails the
// collection itself: it is logged as one secret-free summary line
// instead.

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
  // Appended last on purpose: the production "account" tab was
  // created with the columns above, and rows are read positionally
  // against this list, so a new column may only ever join at the
  // end. (buildSnsHistoryResponse_ additionally falls back to this
  // canonical position for a column the stored header predates.)
  'x_followers',
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
  // Appended last on purpose, like x_followers on the account tab:
  // rows are read positionally against this list, so a new column
  // may only ever join at the end.
  'thumbnail_url',
];
// The upserted tabs. "daily" is keyed by its first column (date);
// the post tabs are keyed by their second column (the id), right
// after collected_at, mirroring "media".
const SNS_HISTORY_DAILY_COLUMNS = [
  'date',
  'follows',
  'unfollows',
  'collected_at',
];
const SNS_HISTORY_THREADS_MEDIA_COLUMNS = [
  'collected_at',
  'post_id',
  'posted_at',
  'type',
  'text',
  'permalink',
  'views',
  'likes',
  'replies',
  'reposts',
  'quotes',
];
const SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS = [
  'collected_at',
  'video_id',
  'published_at',
  'title',
  'views',
  'likes',
  'comments',
];
// "x_media" mirrors the other post tabs (collected_at first, the
// post id as the upsert key). The post URL is not stored — it is
// derived from the id on the read side, like youtube_media.
const SNS_HISTORY_X_MEDIA_COLUMNS = [
  'collected_at',
  'post_id',
  'posted_at',
  'text',
  'views',
  'likes',
  'reposts',
  'replies',
];
// "ig_demographics" is keyed by its first column, the breakdown
// and segment joined ("age_gender|25-34/F", "city|Kawaguchi",
// "country|JP"), so the three follower_demographics breakdowns
// share one tab in the same 1-key-1-row shape.
const SNS_HISTORY_DEMOGRAPHICS_COLUMNS = [
  'breakdown_key',
  'breakdown',
  'key',
  'value',
  'collected_at',
];
// "threads_account" is keyed by metric name: the Threads account
// totals (30-day views and the interaction parts) that the
// "account" tab never carried.
const SNS_HISTORY_THREADS_ACCOUNT_COLUMNS = [
  'metric',
  'value',
  'collected_at',
];
// The blog tabs (written by appendBlogHistory_ from GA4, not from
// the SNS snapshot). "blog_daily" is keyed by date like "daily";
// "blog_posts" is keyed by the canonical article path.
const SNS_HISTORY_BLOG_DAILY_COLUMNS = [
  'date',
  'views',
  'users',
  'sessions',
  'avg_speed_ms',
  'music_plays',
  'collected_at',
];
const SNS_HISTORY_BLOG_POSTS_COLUMNS = [
  'path',
  'title',
  'views_28d',
  'collected_at',
];
// Stage 2 (the read side serves the blog tab from the sheet)
// added three more blog tabs to the same workbook:
// "blog_pages" mirrors "blog_posts" but keeps EVERY page path,
// not just articles — the screen's top-pages ranking mixes
// articles with the app pages. "blog_totals" holds the window
// totals (the daily users cannot be summed into a 28-day user
// count, so the range totals are collected as their own row).
// "blog_sources" holds the traffic-channel split.
const SNS_HISTORY_BLOG_PAGES_COLUMNS = [
  'path',
  'title',
  'views_28d',
  'collected_at',
];
const SNS_HISTORY_BLOG_TOTALS_COLUMNS = [
  'window',
  'views',
  'users',
  'sessions',
  'collected_at',
];
// The single blog_totals row's key: the totals always cover the
// fixed 28daysAgo..today window the screen's totals report reads.
const BLOG_TOTALS_WINDOW_KEY = '28d';
const SNS_HISTORY_BLOG_SOURCES_COLUMNS = [
  'channel',
  'views_28d',
  'collected_at',
];
// "blog_speed" (key: canonical article path) carries each
// article's total article_render time and sample count over the
// last 28 days, from the blog's article_render event (render_ms
// is the GA4 custom metric 「記事表示時間」). The average is
// total / samples; articles nobody displayed have no row.
const SNS_HISTORY_BLOG_SPEED_COLUMNS = [
  'path',
  'title',
  'total_render_ms',
  'samples',
  'collected_at',
];
// Numbers are written as numbers; anything else (null, undefined,
// non-finite) becomes an empty cell so the sheet stays sortable.
function snsHistoryNumCell_(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : '';
}

function snsHistoryTextCell_(value) {
  return value === null || value === undefined ? '' : String(value);
}

// One "account" row from a snapshot. total_followers is the
// combined follower total the screens chart — main Instagram +
// Threads + YouTube + X — summing only the values that are
// numbers, and stays empty when all four are null. Null values
// become empty cells throughout.
function buildSnsHistoryAccountRow_(snapshot) {
  const snap = snapshot || {};
  const youtube = snap.youtube || {};
  const instagram = snap.instagram || {};
  const threads = snap.threads || {};
  const x = snap.x || {};
  const interactions = instagram.interactions_30d || {};
  const totalParts = [
    snsNumberOrNull_(instagram.freddiefujiwara),
    snsNumberOrNull_(threads.followers),
    snsNumberOrNull_(youtube.subscribers),
    snsNumberOrNull_(x.followers),
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
    snsHistoryNumCell_(x.followers),
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
      snsHistoryTextCell_(item.thumbnail_url),
    ];
  });
}

// One "daily" row per day of instagram.daily_follows that carries
// at least one value. Days whose fetch came back null on both
// sides are skipped entirely: they record nothing, and (through
// the upsert) never erase a value an earlier collection stored
// for the same date.
function buildSnsHistoryDailyRows_(snapshot) {
  const snap = snapshot || {};
  const instagram = snap.instagram || {};
  const series = Array.isArray(instagram.daily_follows)
    ? instagram.daily_follows
    : [];
  return series
    .filter((entry) => {
      const item = entry || {};
      return (
        item.date !== null &&
        item.date !== undefined &&
        item.date !== '' &&
        (snsNumberOrNull_(item.follows) !== null ||
          snsNumberOrNull_(item.unfollows) !== null)
      );
    })
    .map((entry) => [
      snsHistoryTextCell_(entry.date),
      snsHistoryNumCell_(entry.follows),
      snsHistoryNumCell_(entry.unfollows),
      snsHistoryTextCell_(snap.collected_at),
    ]);
}

// One "threads_media" row per entry of threads.recent_posts (an
// empty list while Threads is unconfigured or its fetch failed
// and the snapshot carries null).
function buildSnsHistoryThreadsMediaRows_(snapshot) {
  const snap = snapshot || {};
  const threads = snap.threads || {};
  const posts = Array.isArray(threads.recent_posts) ? threads.recent_posts : [];
  return posts.map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(snap.collected_at),
      snsHistoryTextCell_(item.id),
      snsHistoryTextCell_(item.posted_at),
      snsHistoryTextCell_(item.type),
      snsHistoryTextCell_(item.text),
      snsHistoryTextCell_(item.permalink),
      snsHistoryNumCell_(item.views),
      snsHistoryNumCell_(item.likes),
      snsHistoryNumCell_(item.replies),
      snsHistoryNumCell_(item.reposts),
      snsHistoryNumCell_(item.quotes),
    ];
  });
}

// One "youtube_media" row per entry of youtube.recent_videos. The
// per-video numbers already ride every collection via the uploads
// playlist fetch (SNS_RECENT_VIDEO_LIMIT videos), so nothing extra
// is fetched for the history.
function buildSnsHistoryYouTubeMediaRows_(snapshot) {
  const snap = snapshot || {};
  const youtube = snap.youtube || {};
  const videos = Array.isArray(youtube.recent_videos)
    ? youtube.recent_videos
    : [];
  return videos.map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(snap.collected_at),
      snsHistoryTextCell_(item.id),
      snsHistoryTextCell_(item.published_at),
      snsHistoryTextCell_(item.title),
      snsHistoryNumCell_(item.views),
      snsHistoryNumCell_(item.likes),
      snsHistoryNumCell_(item.comments),
    ];
  });
}

// One "x_media" row per entry of x.recent_posts (an empty list
// while X is unconfigured or its fetch failed and the snapshot
// carries null).
function buildSnsHistoryXMediaRows_(snapshot) {
  const snap = snapshot || {};
  const x = snap.x || {};
  const posts = Array.isArray(x.recent_posts) ? x.recent_posts : [];
  return posts.map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(snap.collected_at),
      snsHistoryTextCell_(item.id),
      snsHistoryTextCell_(item.posted_at),
      snsHistoryTextCell_(item.text),
      snsHistoryNumCell_(item.views),
      snsHistoryNumCell_(item.likes),
      snsHistoryNumCell_(item.reposts),
      snsHistoryNumCell_(item.replies),
    ];
  });
}

// One "ig_demographics" row per (breakdown, segment) of
// instagram.demographics — the age x gender pyramid segments and
// the top cities / countries the "account" tab has no shape for.
// A breakdown the fresh fetch failed (null) contributes no rows,
// so its stored segments are never erased by an outage; a segment
// that drops out of a later top list simply keeps its last value.
function buildSnsHistoryDemographicsRows_(snapshot) {
  const snap = snapshot || {};
  const instagram = snap.instagram || {};
  const demographics = instagram.demographics || {};
  const breakdowns = [
    ['age_gender', demographics.age_gender],
    ['city', demographics.top_cities],
    ['country', demographics.top_countries],
  ];
  const rows = [];
  breakdowns.forEach((pair) => {
    const name = pair[0];
    const segments = pair[1];
    if (!Array.isArray(segments)) {
      return;
    }
    segments.forEach((segment) => {
      const item = segment || {};
      const key = snsHistoryTextCell_(item.key);
      if (!key) {
        return;
      }
      rows.push([
        name + '|' + key,
        name,
        key,
        snsHistoryNumCell_(item.value),
        snsHistoryTextCell_(snap.collected_at),
      ]);
    });
  });
  return rows;
}

// One "threads_account" row per Threads account metric — the
// 30-day views and interaction totals the snapshot carries but no
// tab held. Only metrics that came back as numbers produce a row
// (the same rule as "daily"), so a failed metric never erases its
// stored value through the upsert.
function buildSnsHistoryThreadsAccountRows_(snapshot) {
  const snap = snapshot || {};
  const threads = snap.threads || {};
  const interactions = threads.interactions_30d || {};
  const candidates = [
    ['views_30d', threads.views_30d],
    ['interactions_total', interactions.total],
    ['interactions_likes', interactions.likes],
    ['interactions_replies', interactions.replies],
    ['interactions_reposts', interactions.reposts],
    ['interactions_quotes', interactions.quotes],
  ];
  return candidates
    .filter((pair) => snsNumberOrNull_(pair[1]) !== null)
    .map((pair) => [
      pair[0],
      snsHistoryNumCell_(pair[1]),
      snsHistoryTextCell_(snap.collected_at),
    ]);
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

// Normalizes a key cell read back from a sheet into the string the
// upsert matches on. Sheets coerces a "YYYY-MM-DD" string into a
// Date, so a stored daily key is formatted back in Asia/Tokyo —
// the timezone every daily key is written in — by shifting the
// instant nine hours ahead and reading the UTC fields.
function snsHistoryKeyCell_(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return '';
    }
    const jst = new Date(value.getTime() + 9 * 60 * 60 * 1000);
    const pad = (num) => String(num).padStart(2, '0');
    return (
      jst.getUTCFullYear() +
      '-' +
      pad(jst.getUTCMonth() + 1) +
      '-' +
      pad(jst.getUTCDate())
    );
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

// Reads the data rows (everything under the header) of a history
// sheet, padded out to the column count. Row values keep the types
// Sheets hands back (numbers as numbers, timestamps as Dates).
function readSnsHistoryRows_(sheet, columns) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  return sheet
    .getRange(2, 1, lastRow - 1, columns.length)
    .getValues()
    .map((row) => {
      const cells = (row || []).slice(0, columns.length);
      while (cells.length < columns.length) {
        cells.push('');
      }
      return cells;
    });
}

// Merges fresh rows into the stored ones by key: one output row
// per key, in first-seen order, where a fresh row's non-empty
// cells win and its empty cells (the nulls of the fresh fetch)
// leave the stored values untouched. Rows without a key are
// dropped on both sides.
function mergeSnsHistoryRows_(existingRows, newRows, keyIndex) {
  const merged = [];
  const indexByKey = {};
  const absorb = (row) => {
    const key = snsHistoryKeyCell_(row[keyIndex]);
    if (!key) {
      return;
    }
    if (!(key in indexByKey)) {
      indexByKey[key] = merged.length;
      merged.push(row.slice());
      return;
    }
    const target = merged[indexByKey[key]];
    row.forEach((cell, index) => {
      if (cell !== '' && cell !== null && cell !== undefined) {
        target[index] = cell;
      }
    });
  };
  (existingRows || []).forEach(absorb);
  (newRows || []).forEach(absorb);
  return merged;
}

// Upserts the fresh rows of one key-keyed history tab: ensures the
// sheet, merges stored + fresh rows by key, writes the merged data
// rows under the (untouched) header, and deletes any surplus rows
// the append-only era left behind, so the tab always holds the
// header plus exactly one row per key.
function upsertSnsHistorySheet_(spreadsheet, name, columns, keyIndex, newRows) {
  const sheet = ensureSnsHistorySheet_(spreadsheet, name, columns);
  const merged = mergeSnsHistoryRows_(
    readSnsHistoryRows_(sheet, columns),
    newRows,
    keyIndex
  );
  if (merged.length) {
    sheet.getRange(2, 1, merged.length, columns.length).setValues(merged);
  }
  const surplus = sheet.getLastRow() - (merged.length + 1);
  if (surplus > 0) {
    sheet.deleteRows(merged.length + 2, surplus);
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

// Writes the snapshot to the history spreadsheet. No-op unless
// SNS_HISTORY_SHEET_ID is set (SpreadsheetApp is not even touched
// then). The "account" tab is appended to, one row per collection;
// every other tab is upserted by its key. Never throws: any
// failure is logged as one line and the collection that produced
// the snapshot still counts as a success.
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
    upsertSnsHistorySheet_(
      spreadsheet,
      'media',
      SNS_HISTORY_MEDIA_COLUMNS,
      1,
      buildSnsHistoryMediaRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'daily',
      SNS_HISTORY_DAILY_COLUMNS,
      0,
      buildSnsHistoryDailyRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'threads_media',
      SNS_HISTORY_THREADS_MEDIA_COLUMNS,
      1,
      buildSnsHistoryThreadsMediaRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'youtube_media',
      SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS,
      1,
      buildSnsHistoryYouTubeMediaRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'x_media',
      SNS_HISTORY_X_MEDIA_COLUMNS,
      1,
      buildSnsHistoryXMediaRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'ig_demographics',
      SNS_HISTORY_DEMOGRAPHICS_COLUMNS,
      0,
      buildSnsHistoryDemographicsRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'threads_account',
      SNS_HISTORY_THREADS_ACCOUNT_COLUMNS,
      0,
      buildSnsHistoryThreadsAccountRows_(snapshot)
    );
  } catch (err) {
    console.log(
      'SNS history append failed: ' + summarizeSnsHistoryError_(err, sheetId)
    );
  }
}

// --- Blog history (GA4 -> the same history spreadsheet) ---
// Stage 1 of serving /social from the spreadsheet: the blog's
// numbers join the SNS history in the same workbook, so the
// collection side is complete before any read side switches
// over. Stage 2 (below) reads them back for the screen.
// collectSnsCounts() calls appendBlogHistory_() right after the
// SNS writes; it pulls the blog's GA4 numbers through the
// runReport bridge (buildReportRequest_ / fetchReport_ with
// GA4_PROPERTY_ID) and upserts five tabs:
//   - "blog_daily" (key: date): one row per calendar day over
//     the whole display window (28daysAgo..today, 29 days).
//     Every run re-fetches the full window, so a day GA4 later
//     restates is overwritten with the corrected value on the
//     next run. views / users / sessions are the
//     day's GA4 totals. avg_speed_ms is the day's average wv_lcp
//     value: the blog sends each Core Web Vital as its own event
//     (wv_lcp, wv_inp, ...) with the measured value in the
//     standard `value` parameter, so the Data API aggregates the
//     day's mean as eventValue / eventCount — the aggregation the
//     earlier speed checks used — and LCP is the display-speed
//     metric of that set. music_plays is the day's music_play
//     eventCount.
//   - "blog_posts" (key: path): one row per article, carrying its
//     views over the last 28 days — the window the /social blog
//     tab reads. Article paths arrive split as /<id> and
//     /blog/<id>; both merge under the canonical /blog/<id>, the
//     merge rule the frontend's page ranking applies (and the
//     same article-id test as action=top_articles). The title is
//     GA4's pageTitle on the article's most-viewed path form.
//   - "blog_pages" (key: path): the same fetch with no article
//     filter — every page path under its canonical key — for the
//     top-pages ranking, which mixes articles and app pages.
//   - "blog_totals" (key: window): the window's totals row. The
//     28-day user count deduplicates across days, so it cannot
//     be summed out of blog_daily; it is collected as-is.
//   - "blog_sources" (key: channel): the window's views split
//     by sessionDefaultChannelGroup, for the sources ranking.
//   - "blog_speed" (key: path): one row per article, carrying
//     its total article_render time and sample count over the
//     last 28 days, from the blog's article_render events (the
//     render_ms custom metric). The screen divides the two for
//     the average display time; an article with no display in
//     the window has no row.
// Both writes are best-effort in the same way as the SNS history:
// gated on SNS_HISTORY_SHEET_ID and GA4_PROPERTY_ID, and a failure
// logs one line instead of failing the collection.

const BLOG_POSTS_WINDOW_DAYS = 28;
const BLOG_POSTS_FETCH_LIMIT = 1000;
const BLOG_DAILY_FETCH_LIMIT = 40;
const BLOG_SOURCES_FETCH_LIMIT = 100;
const BLOG_SPEED_EVENT_NAME = 'wv_lcp';
const BLOG_MUSIC_EVENT_NAME = 'music_play';
const BLOG_RENDER_EVENT_NAME = 'article_render';
const BLOG_RENDER_METRIC = 'customEvent:render_ms';

// One runReport call for the blog history: the report's rows, or
// null when the API did not answer 200 (or the fetch itself
// failed). Callers read null as "no fresh data", never as zeros.
function fetchBlogReportRows_(propertyId, params) {
  try {
    const result = fetchReport_(propertyId, buildReportRequest_(params));
    if (result.status !== 200) {
      return null;
    }
    return (result.data && result.data.rows) || [];
  } catch (err) {
    return null;
  }
}

// GA4 reports the date dimension as YYYYMMDD; the sheet keys days
// by the ISO form every other daily tab uses. Anything else reads
// as no date.
function ga4DateKey_(value) {
  const raw = String(value || '');
  if (!/^\d{8}$/.test(raw)) {
    return '';
  }
  return raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
}

function blogReportRowDate_(row) {
  const values = (row && row.dimensionValues) || [];
  return ga4DateKey_(values[0] && values[0].value);
}

function blogReportMetric_(row, index) {
  const values = (row && row.metricValues) || [];
  const num = Number(values[index] && values[index].value);
  return Number.isFinite(num) ? num : null;
}

// The blog's daily numbers over the display window
// (28daysAgo..today, 29 days), keyed by ISO date:
// { views, users, sessions, avg_speed_ms, music_plays }, each
// field null when its report carried no value for that day.
// Returns null when the totals report itself failed — without it
// there is no day to key the rows by. The music and speed reports
// fail independently of it: their fields just stay null.
function fetchBlogDailyData_(propertyId) {
  const nowMs = Date.now();
  const range = {
    startDate: jstDateKey_(nowMs - BLOG_POSTS_WINDOW_DAYS * SNS_DAY_MS),
    endDate: jstDateKey_(nowMs),
  };
  const totals = fetchBlogReportRows_(
    propertyId,
    Object.assign({}, range, {
      metrics: ['screenPageViews', 'activeUsers', 'sessions'],
      dimensions: ['date'],
      limit: BLOG_DAILY_FETCH_LIMIT,
      offset: 0,
      filters: [],
    })
  );
  if (!totals) {
    return null;
  }
  const byDate = {};
  const day = (key) => {
    if (!byDate[key]) {
      byDate[key] = {
        views: null,
        users: null,
        sessions: null,
        avg_speed_ms: null,
        music_plays: null,
      };
    }
    return byDate[key];
  };
  totals.forEach((row) => {
    const key = blogReportRowDate_(row);
    if (!key) {
      return;
    }
    const entry = day(key);
    entry.views = blogReportMetric_(row, 0);
    entry.users = blogReportMetric_(row, 1);
    entry.sessions = blogReportMetric_(row, 2);
  });
  const music = fetchBlogReportRows_(
    propertyId,
    Object.assign({}, range, {
      metrics: ['eventCount'],
      dimensions: ['date'],
      limit: BLOG_DAILY_FETCH_LIMIT,
      offset: 0,
      filters: parseFilterClauses_(
        'eventName:exact:' + BLOG_MUSIC_EVENT_NAME
      ),
    })
  );
  if (music) {
    music.forEach((row) => {
      const key = blogReportRowDate_(row);
      if (key) {
        day(key).music_plays = blogReportMetric_(row, 0);
      }
    });
  }
  const speed = fetchBlogReportRows_(
    propertyId,
    Object.assign({}, range, {
      metrics: ['eventValue', 'eventCount'],
      dimensions: ['date'],
      limit: BLOG_DAILY_FETCH_LIMIT,
      offset: 0,
      filters: parseFilterClauses_(
        'eventName:exact:' + BLOG_SPEED_EVENT_NAME
      ),
    })
  );
  if (speed) {
    speed.forEach((row) => {
      const key = blogReportRowDate_(row);
      if (!key) {
        return;
      }
      const totalValue = blogReportMetric_(row, 0);
      const count = blogReportMetric_(row, 1);
      if (totalValue !== null && count) {
        day(key).avg_speed_ms = Math.round(totalValue / count);
      }
    });
  }
  return byDate;
}

// One "blog_daily" row per day of fetchBlogDailyData_, oldest
// first. A day the totals report did not mention never enters the
// map, so a day GA4 has not processed yet neither records a row
// nor erases a stored one through the upsert.
function buildBlogDailyRows_(byDate, collectedAt) {
  return Object.keys(byDate || {})
    .sort()
    .map((date) => {
      const entry = byDate[date] || {};
      return [
        date,
        snsHistoryNumCell_(entry.views),
        snsHistoryNumCell_(entry.users),
        snsHistoryNumCell_(entry.sessions),
        snsHistoryNumCell_(entry.avg_speed_ms),
        snsHistoryNumCell_(entry.music_plays),
        snsHistoryTextCell_(collectedAt),
      ];
    });
}

// The one pagePath x pageTitle fetch behind both blog_posts
// and blog_pages: the raw report rows, or null when the API did
// not answer 200 (or the fetch itself failed).
function fetchBlogPathRows_(propertyId) {
  return fetchBlogReportRows_(propertyId, {
    startDate: BLOG_POSTS_WINDOW_DAYS + 'daysAgo',
    endDate: 'today',
    metrics: ['screenPageViews'],
    dimensions: ['pagePath', 'pageTitle'],
    limit: BLOG_POSTS_FETCH_LIMIT,
    offset: 0,
    filters: [],
  });
}

// Merges pagePath report rows under the key keyOf(rawPath)
// computes (an empty key drops the row): split path forms of
// one page are summed, and the title comes from the most-viewed
// form. Entries come back sorted by views descending; the
// upsert keeps stored rows in place regardless.
function mergeBlogPathRows_(rows, keyOf) {
  const byPath = {};
  (rows || []).forEach((row) => {
    const dimensionValues = (row && row.dimensionValues) || [];
    const path = keyOf(dimensionValues[0] && dimensionValues[0].value);
    if (!path) {
      return;
    }
    const views = blogReportMetric_(row, 0) || 0;
    const rawTitle = String(
      (dimensionValues[1] && dimensionValues[1].value) || ''
    );
    const title = rawTitle === '(not set)' ? '' : rawTitle;
    const existing = byPath[path];
    if (!existing) {
      byPath[path] = { path, title, views_28d: views, topViews: views };
      return;
    }
    existing.views_28d += views;
    if (views > existing.topViews) {
      existing.topViews = views;
      existing.title = title;
    }
  });
  return Object.keys(byPath)
    .map((path) => byPath[path])
    .sort((a, b) => b.views_28d - a.views_28d)
    .map((entry) => ({
      path: entry.path,
      title: entry.title,
      views_28d: entry.views_28d,
    }));
}

// The canonical key a pagePath counts under in the sheet and in
// the screen's page ranking: an article's split forms merge
// under /blog/<id>; every other path is its own key.
function canonicalBlogPath_(path) {
  const id = articleIdFromPath_(path);
  return id ? '/blog/' + id : String(path || '');
}

// The blog's per-article views over the last 28 days, merged
// under the canonical /blog/<id> path as described above.
// Returns null when the report failed.
function fetchBlogPostsData_(propertyId) {
  const rows = fetchBlogPathRows_(propertyId);
  if (!rows) {
    return null;
  }
  return mergeBlogPathRows_(rows, (path) => {
    const id = articleIdFromPath_(path);
    return id ? '/blog/' + id : '';
  });
}

// The same fetch with no article filter: every page path under
// its canonical key, for the screen's top-pages ranking (which
// mixes articles with the app pages). Returns null when the
// report failed.
function fetchBlogPagesData_(propertyId) {
  const rows = fetchBlogPathRows_(propertyId);
  if (!rows) {
    return null;
  }
  return mergeBlogPathRows_(rows, canonicalBlogPath_);
}

// The window's blog totals as GA4 reports them with no
// dimension. The range-wide user count deduplicates across
// days, so it cannot be summed out of blog_daily — it rides
// its own tab. Returns null when the report failed; a window
// GA4 answers with no rows at all reads as all-null fields.
function fetchBlogTotalsData_(propertyId) {
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: BLOG_POSTS_WINDOW_DAYS + 'daysAgo',
    endDate: 'today',
    metrics: ['screenPageViews', 'activeUsers', 'sessions'],
    dimensions: [],
    limit: 1,
    offset: 0,
    filters: [],
  });
  if (!rows) {
    return null;
  }
  const row = rows[0] || null;
  return {
    views: row ? blogReportMetric_(row, 0) : null,
    users: row ? blogReportMetric_(row, 1) : null,
    sessions: row ? blogReportMetric_(row, 2) : null,
  };
}

// The window's views split by traffic channel
// (sessionDefaultChannelGroup), for the screen's sources
// ranking. Returns null when the report failed.
function fetchBlogSourcesData_(propertyId) {
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: BLOG_POSTS_WINDOW_DAYS + 'daysAgo',
    endDate: 'today',
    metrics: ['screenPageViews'],
    dimensions: ['sessionDefaultChannelGroup'],
    limit: BLOG_SOURCES_FETCH_LIMIT,
    offset: 0,
    filters: [],
  });
  if (!rows) {
    return null;
  }
  return rows
    .map((row) => {
      const dimensionValues = (row && row.dimensionValues) || [];
      return {
        channel: String(
          (dimensionValues[0] && dimensionValues[0].value) || ''
        ),
        views_28d: blogReportMetric_(row, 0) || 0,
      };
    })
    .filter((entry) => entry.channel)
    .sort((a, b) => b.views_28d - a.views_28d);
}

// One "blog_speed" row per entry of fetchBlogSpeedData_.
function buildBlogSpeedRows_(entries, collectedAt) {
  return (entries || []).map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(item.path),
      snsHistoryTextCell_(item.title),
      snsHistoryNumCell_(item.total_render_ms),
      snsHistoryNumCell_(item.samples),
      snsHistoryTextCell_(collectedAt),
    ];
  });
}

// One "blog_posts" row per entry of fetchBlogPostsData_.
function buildBlogPostsRows_(entries, collectedAt) {
  return (entries || []).map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(item.path),
      snsHistoryTextCell_(item.title),
      snsHistoryNumCell_(item.views_28d),
      snsHistoryTextCell_(collectedAt),
    ];
  });
}

// One "blog_pages" row per entry of fetchBlogPagesData_ — the
// same row shape as blog_posts over the wider net.
function buildBlogPagesRows_(entries, collectedAt) {
  return buildBlogPostsRows_(entries, collectedAt);
}

// The single "blog_totals" row. A null totals object (the
// report failed) never reaches this builder — the caller skips
// the tab — while null fields become empty cells, which the
// upsert merge reads as "keep the stored value".
function buildBlogTotalsRows_(totals, collectedAt) {
  if (!totals) {
    return [];
  }
  return [
    [
      BLOG_TOTALS_WINDOW_KEY,
      snsHistoryNumCell_(totals.views),
      snsHistoryNumCell_(totals.users),
      snsHistoryNumCell_(totals.sessions),
      snsHistoryTextCell_(collectedAt),
    ],
  ];
}

// The blog's per-article display times over the last 28 days:
// the article_render events' render_ms total and sample count,
// merged under the canonical /blog/<id> path like blog_posts
// (the title comes from the path form with the most samples).
// Returns null when the report failed — while the render_ms
// custom metric is unregistered in GA4 the API answers an
// error, which reads as a failed report and simply skips the
// tab until the first displays arrive.
function fetchBlogSpeedData_(propertyId) {
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: BLOG_POSTS_WINDOW_DAYS + 'daysAgo',
    endDate: 'today',
    metrics: [BLOG_RENDER_METRIC, 'eventCount'],
    dimensions: ['pagePath', 'pageTitle'],
    limit: BLOG_POSTS_FETCH_LIMIT,
    offset: 0,
    filters: parseFilterClauses_(
      'eventName:exact:' + BLOG_RENDER_EVENT_NAME
    ),
  });
  if (!rows) {
    return null;
  }
  const byPath = {};
  rows.forEach((row) => {
    const dimensionValues = (row && row.dimensionValues) || [];
    const id = articleIdFromPath_(
      dimensionValues[0] && dimensionValues[0].value
    );
    if (!id) {
      return;
    }
    const samples = blogReportMetric_(row, 1) || 0;
    if (!samples) {
      return;
    }
    const path = '/blog/' + id;
    const rawTitle = String(
      (dimensionValues[1] && dimensionValues[1].value) || ''
    );
    const title = rawTitle === '(not set)' ? '' : rawTitle;
    const existing = byPath[path];
    if (!existing) {
      byPath[path] = {
        path,
        title,
        total_render_ms: blogReportMetric_(row, 0) || 0,
        samples,
        topSamples: samples,
      };
      return;
    }
    existing.total_render_ms += blogReportMetric_(row, 0) || 0;
    existing.samples += samples;
    if (samples > existing.topSamples) {
      existing.topSamples = samples;
      existing.title = title;
    }
  });
  return Object.keys(byPath)
    .map((path) => byPath[path])
    .map((entry) => ({
      path: entry.path,
      title: entry.title,
      total_render_ms: entry.total_render_ms,
      samples: entry.samples,
    }))
    .sort(
      (a, b) =>
        b.total_render_ms / b.samples - a.total_render_ms / a.samples
    );
}

// One "blog_sources" row per entry of fetchBlogSourcesData_.
function buildBlogSourcesRows_(entries, collectedAt) {
  return (entries || []).map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(item.channel),
      snsHistoryNumCell_(item.views_28d),
      snsHistoryTextCell_(collectedAt),
    ];
  });
}

// Writes the blog's history tabs into the SNS history
// spreadsheet. No-op unless SNS_HISTORY_SHEET_ID and
// GA4_PROPERTY_ID are both set (SpreadsheetApp is not touched and
// GA4 is not queried then). Never throws, in the same way as
// appendSnsHistory_: a failed tab is logged and skipped, and the
// collection that called it still counts as a success.
function appendBlogHistory_() {
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return;
  }
  const propertyId = getScriptProperty_('GA4_PROPERTY_ID');
  if (!propertyId) {
    return;
  }
  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    const collectedAt = new Date().toISOString();
    const byDate = fetchBlogDailyData_(propertyId);
    if (byDate) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_daily',
        SNS_HISTORY_BLOG_DAILY_COLUMNS,
        0,
        buildBlogDailyRows_(byDate, collectedAt)
      );
    } else {
      console.log('Blog history: daily report failed, blog_daily skipped');
    }
    const posts = fetchBlogPostsData_(propertyId);
    if (posts) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_posts',
        SNS_HISTORY_BLOG_POSTS_COLUMNS,
        0,
        buildBlogPostsRows_(posts, collectedAt)
      );
    } else {
      console.log('Blog history: posts report failed, blog_posts skipped');
    }
    const pages = fetchBlogPagesData_(propertyId);
    if (pages) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_pages',
        SNS_HISTORY_BLOG_PAGES_COLUMNS,
        0,
        buildBlogPagesRows_(pages, collectedAt)
      );
    } else {
      console.log('Blog history: pages report failed, blog_pages skipped');
    }
    const totals = fetchBlogTotalsData_(propertyId);
    if (totals) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_totals',
        SNS_HISTORY_BLOG_TOTALS_COLUMNS,
        0,
        buildBlogTotalsRows_(totals, collectedAt)
      );
    } else {
      console.log('Blog history: totals report failed, blog_totals skipped');
    }
    const sources = fetchBlogSourcesData_(propertyId);
    if (sources) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_sources',
        SNS_HISTORY_BLOG_SOURCES_COLUMNS,
        0,
        buildBlogSourcesRows_(sources, collectedAt)
      );
    } else {
      console.log('Blog history: sources report failed, blog_sources skipped');
    }
    const speed = fetchBlogSpeedData_(propertyId);
    if (speed) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_speed',
        SNS_HISTORY_BLOG_SPEED_COLUMNS,
        0,
        buildBlogSpeedRows_(speed, collectedAt)
      );
    } else {
      console.log('Blog history: speed report failed, blog_speed skipped');
    }
  } catch (err) {
    console.log(
      'Blog history append failed: ' + summarizeSnsHistoryError_(err, sheetId)
    );
  }
}

// --- SNS snapshot history, read side (action=sns_history) ---
// The authenticated counterpart of the append above: the /ga
// trend charts read the "account" sheet back through this action.
// Only the columns the charts need are served, and the response is
// capped at the newest 2400 rows (about 100 days at hourly
// collections — the cap counts rows, so it grew with the move from
// 6-hourly to hourly collection to keep the same window). An
// unset property or a missing/empty sheet is not an
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
  'x_followers',
];
const SNS_HISTORY_MAX_ROWS = 2400;

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

// The history response rides the same read cache as the
// other sheet-backed payloads: the hourly collection
// precomputes it (see precomputeReadCaches_), so a read
// normally never opens the sheet. On a miss the response is
// assembled from the sheet — reading only the newest
// SNS_HISTORY_MAX_ROWS data rows, never the whole tab: the
// account tab grows by a row an hour forever, and rows older
// than the cap were sliced away after the read anyway.
function buildSnsHistoryResponse_() {
  const cache = sheetReadCache_();
  if (cache) {
    const hit = getCachedText_(cache, SNS_HISTORY_CACHE_KEY);
    if (hit) {
      try {
        const parsed = JSON.parse(hit);
        if (parsed && Array.isArray(parsed.rows)) {
          return parsed;
        }
      } catch (err) {
        // A corrupt cache entry is ignored; the history is rebuilt.
      }
    }
  }
  const response = assembleSnsHistoryResponse_();
  if (cache) {
    putCachedText_(
      cache,
      SNS_HISTORY_CACHE_KEY,
      JSON.stringify(response),
      SNS_HISTORY_CACHE_SECONDS
    );
  }
  return response;
}

function assembleSnsHistoryResponse_(openedSpreadsheet) {
  const empty = { ok: true, action: 'sns_history', rows: [] };
  const spreadsheet = openedSpreadsheet || openHistorySpreadsheet_();
  if (!spreadsheet) {
    return empty;
  }
  const sheet = spreadsheet.getSheetByName('account');
  if (!sheet || sheet.getLastRow() < 2) {
    return empty;
  }
  const lastRow = sheet.getLastRow();
  const firstDataRow = Math.max(2, lastRow - SNS_HISTORY_MAX_ROWS + 1);
  const header = sheet
    .getRange(1, 1, 1, SNS_HISTORY_ACCOUNT_COLUMNS.length)
    .getValues()[0]
    .map((cell) => String(cell));
  const values = [header].concat(
    sheet
      .getRange(
        firstDataRow,
        1,
        lastRow - firstDataRow + 1,
        SNS_HISTORY_ACCOUNT_COLUMNS.length
      )
      .getValues()
  );
  const columnIndex = {};
  SNS_HISTORY_RESPONSE_COLUMNS.forEach((column) => {
    const index = header.indexOf(column);
    // A column added after the sheet was created (x_followers)
    // is missing from the stored header until someone extends
    // it; its cells still sit at the canonical position of
    // SNS_HISTORY_ACCOUNT_COLUMNS, so fall back to that.
    columnIndex[column] =
      index >= 0 ? index : SNS_HISTORY_ACCOUNT_COLUMNS.indexOf(column);
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

// --- Sheet-backed read side (stage 2) ---
// The /social screen's reads are assembled from the history
// spreadsheet, so rendering the screen never calls the Meta /
// GA4 / YouTube APIs: the hourly collection is the only API
// client, and the builders below only read sheets. Reads are
// cached in CacheService for an hour — the numbers only
// change at the hourly collection anyway, and the collection
// itself precomputes the payloads into the cache (see
// precomputeReadCaches_), so in the steady state a read never
// touches the sheet at all. A sheet that cannot be read
// degrades to the stored snapshot (SNS detail) or to an
// explicit "not collected yet" error (blog reports), never
// to a live API call made for the screen.

const SNS_DETAIL_CACHE_KEY = 'sns_detail_sheet_v1';
const SNS_DETAIL_CACHE_SECONDS = 3600;
const SNS_HISTORY_CACHE_KEY = 'sns_history_sheet_v1';
const SNS_HISTORY_CACHE_SECONDS = 3600;
const BLOG_REPORT_CACHE_KEY_PREFIX = 'blog_report_sheet_v1_';
const BLOG_REPORT_CACHE_SECONDS = 3600;

// The script cache, or null when CacheService is unavailable
// (unit tests, a bare editor run) — caching is always optional
// on the read side.
function sheetReadCache_() {
  try {
    return typeof CacheService !== 'undefined'
      ? CacheService.getScriptCache()
      : null;
  } catch (err) {
    return null;
  }
}

// CacheService caps one value at 100KB, and the assembled
// payloads can outgrow that (the SNS detail carries dozens of
// captions; the history grows to hundreds of rows). Payload
// texts are therefore stored split into chunks of
// PAYLOAD_CACHE_CHUNK_CHARS characters under "<key>#<index>",
// with the chunk count under "<key>#count" written last, so
// a reader can never assemble a half-written value: a missing
// or corrupt chunk simply reads as a cache miss, and the
// caller rebuilds from the sheet exactly as before. The chunk
// size stays well under the byte cap even for text that is
// three bytes per character in UTF-8.
const PAYLOAD_CACHE_CHUNK_CHARS = 30000;
const PAYLOAD_CACHE_MAX_CHUNKS = 40;

function putCachedText_(cache, key, text, ttlSeconds) {
  if (!cache || typeof text !== 'string') {
    return false;
  }
  try {
    const chunks = [];
    for (
      let index = 0;
      index < text.length;
      index += PAYLOAD_CACHE_CHUNK_CHARS
    ) {
      chunks.push(text.slice(index, index + PAYLOAD_CACHE_CHUNK_CHARS));
    }
    if (chunks.length === 0) {
      chunks.push('');
    }
    if (chunks.length > PAYLOAD_CACHE_MAX_CHUNKS) {
      return false;
    }
    chunks.forEach((chunk, index) => {
      cache.put(key + '#' + index, chunk, ttlSeconds);
    });
    cache.put(key + '#count', String(chunks.length), ttlSeconds);
    return true;
  } catch (err) {
    return false;
  }
}

function getCachedText_(cache, key) {
  if (!cache) {
    return null;
  }
  try {
    const count = Number(cache.get(key + '#count'));
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > PAYLOAD_CACHE_MAX_CHUNKS
    ) {
      return null;
    }
    const parts = [];
    for (let index = 0; index < count; index++) {
      const part = cache.get(key + '#' + index);
      if (typeof part !== 'string') {
        return null;
      }
      parts.push(part);
    }
    return parts.join('');
  } catch (err) {
    return null;
  }
}

// Opens the history spreadsheet, or null when the property is
// unset. Throws only when the open itself fails; callers treat
// that as "sheet unavailable".
function openHistorySpreadsheet_() {
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return null;
  }
  return SpreadsheetApp.openById(sheetId);
}

// Reads one history tab as row objects keyed by column name.
// Returns null when the tab does not exist, [] when it exists
// but holds no data rows. Cell values keep the types Sheets
// hands back (numbers as numbers, timestamps as Dates or ISO
// strings, untouched cells as '').
function readHistoryTabObjects_(spreadsheet, name, columns) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    return null;
  }
  return readSnsHistoryRows_(sheet, columns).map((cells) => {
    const row = {};
    columns.forEach((column, index) => {
      row[column] = cells[index];
    });
    return row;
  });
}

// Reads only the last data row of a history tab, as a row
// object. Returns undefined when the tab does not exist, null
// when it holds no data rows. The account tab is append-only
// and chronological, so its last row is the newest collection
// — the one consumer (the SNS detail) needs nothing older,
// and reading the whole tab for it would grow by a row an
// hour forever.
function readHistoryTabLastRowObject_(spreadsheet, name, columns) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    return undefined;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }
  const cells = sheet
    .getRange(lastRow, 1, 1, columns.length)
    .getValues()[0];
  const row = {};
  columns.forEach((column, index) => {
    row[column] = cells[index];
  });
  return row;
}

// A text cell as a string, or null when it holds nothing.
function historyTextOrNull_(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

// A timestamp cell (a Date, or an ISO string Sheets left alone)
// as an ISO string, or null.
function historyTimestampOrNull_(value) {
  return snsHistoryTimestampCell_(value);
}

// Newest-first ordering for the stored timestamps
// (posted_at / published_at): parsed instants when both sides
// parse, the ISO strings themselves otherwise.
function compareTimestampDesc_(a, b) {
  const ta = Date.parse(a || '');
  const tb = Date.parse(b || '');
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return tb - ta;
  }
  const x = String(a || '');
  const y = String(b || '');
  return x < y ? 1 : x > y ? -1 : 0;
}

// The account row with the newest collected_at, as
// { row, collected_at }, or null when no row carries a
// timestamp. The account tab is the one appended time series,
// so its newest row is the "current" state the SNS detail is
// built around.
function latestAccountRow_(rows) {
  let latest = null;
  (rows || []).forEach((row) => {
    const at = historyTimestampOrNull_(row.collected_at);
    if (at && (!latest || at > latest.collected_at)) {
      latest = { row, collected_at: at };
    }
  });
  return latest;
}

// Only the rows stamped with the newest collected_at of the
// set. The blog window tabs (blog_pages / blog_sources) are
// snapshots of a moving 28-day window: a row the newest
// collection did not refresh belongs to an older window, and
// its frozen views_28d must not leak into the ranking.
function latestBatchRows_(rows) {
  const list = rows || [];
  let max = null;
  list.forEach((row) => {
    const at = historyTimestampOrNull_(row.collected_at);
    if (at && (!max || at > max)) {
      max = at;
    }
  });
  if (!max) {
    return list.slice();
  }
  return list.filter(
    (row) => historyTimestampOrNull_(row.collected_at) === max
  );
}

// The sns_detail payload assembled from the history sheet, in
// exactly the snapshot's shape (buildEmptySnsDetail_ is the
// skeleton). Returns null when the sheet is unconfigured or
// holds no usable account row — the caller falls back to the
// stored snapshot then. What the sheet deliberately does not
// hold stays null: the per-collection error notes
// (insights_error, detail_error, media_error, ...) are the
// diagnostics of one fetch, not history, so a sheet-built
// detail never carries them; and daily_follows lists only the
// days that carry a value (days null on both sides were never
// written), so daily_follows_missing_days stays null too.
function buildSnsDetailFromSheet_(openedSpreadsheet) {
  const spreadsheet = openedSpreadsheet || openHistorySpreadsheet_();
  if (!spreadsheet) {
    return null;
  }
  // The detail is built around the newest account row only:
  // read just the tab's last row, and fall back to scanning
  // the whole tab only when that row carries no timestamp
  // (a leftover of a partial write, say).
  let latest = null;
  const lastAccountRow = readHistoryTabLastRowObject_(
    spreadsheet,
    'account',
    SNS_HISTORY_ACCOUNT_COLUMNS
  );
  if (lastAccountRow) {
    const at = historyTimestampOrNull_(lastAccountRow.collected_at);
    if (at) {
      latest = { row: lastAccountRow, collected_at: at };
    }
  }
  if (!latest) {
    const accountRows = readHistoryTabObjects_(
      spreadsheet,
      'account',
      SNS_HISTORY_ACCOUNT_COLUMNS
    );
    if (!accountRows || !accountRows.length) {
      return null;
    }
    latest = latestAccountRow_(accountRows);
    if (!latest) {
      return null;
    }
  }
  const account = latest.row;
  const num = snsHistoryNumberCell_;
  const detail = buildEmptySnsDetail_();
  detail.collected_at = latest.collected_at;

  detail.youtube.subscribers = num(account.youtube_subscribers);
  detail.youtube.total_views = num(account.yt_total_views);
  detail.youtube.video_count = num(account.yt_video_count);
  const videoRows = readHistoryTabObjects_(
    spreadsheet,
    'youtube_media',
    SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS
  );
  if (videoRows) {
    detail.youtube.recent_videos = videoRows
      .map((row) => {
        const id = historyTextOrNull_(row.video_id);
        return {
          id,
          title: historyTextOrNull_(row.title),
          published_at: historyTimestampOrNull_(row.published_at),
          views: num(row.views),
          likes: num(row.likes),
          comments: num(row.comments),
          // The sheet does not store the watch URL (stage 1's
          // call: it is derivable), so it is rebuilt from the
          // video id here.
          url: id ? 'https://www.youtube.com/watch?v=' + id : null,
        };
      })
      .filter((video) => video.id)
      .sort((a, b) => compareTimestampDesc_(a.published_at, b.published_at))
      .slice(0, SNS_RECENT_VIDEO_LIMIT);
  }

  const ig = detail.instagram;
  ig.freddiefujiwara = num(account.ig_followers);
  ig.anemone_cancer = num(account.ig_anemone_followers);
  ig.media_count = num(account.media_count);
  ig.views_30d = num(account.views_30d);
  ig.non_follower_pct = num(account.non_follower_pct);
  ig.reach_30d = num(account.reach_30d);
  ig.accounts_engaged_30d = num(account.accounts_engaged_30d);
  ig.interactions_30d = {
    total: num(account.interactions_total),
    likes: num(account.interactions_likes),
    comments: num(account.interactions_comments),
    shares: num(account.interactions_shares),
    saves: num(account.interactions_saves),
  };
  ig.profile_links_taps_30d = num(account.profile_links_taps_30d);
  ig.profile_links_taps_source = historyTextOrNull_(
    account.profile_links_taps_source
  );
  ig.follows_30d = num(account.follows_30d);
  ig.unfollows_30d = num(account.unfollows_30d);

  const dailyRows = readHistoryTabObjects_(
    spreadsheet,
    'daily',
    SNS_HISTORY_DAILY_COLUMNS
  );
  if (dailyRows) {
    ig.daily_follows = dailyRows
      .map((row) => ({
        date: snsHistoryKeyCell_(row.date),
        follows: num(row.follows),
        unfollows: num(row.unfollows),
      }))
      .filter((entry) => entry.date)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const demoRows = readHistoryTabObjects_(
    spreadsheet,
    'ig_demographics',
    SNS_HISTORY_DEMOGRAPHICS_COLUMNS
  );
  if (demoRows) {
    const groups = { age_gender: [], city: [], country: [] };
    demoRows.forEach((row) => {
      const breakdown = historyTextOrNull_(row.breakdown);
      const key = historyTextOrNull_(row.key);
      const value = num(row.value);
      if (!breakdown || !key || value === null || !groups[breakdown]) {
        return;
      }
      groups[breakdown].push({ key, value });
    });
    const byValueDesc = (a, b) => b.value - a.value;
    ig.demographics = {
      age_gender: groups.age_gender.sort(byValueDesc),
      top_cities: groups.city
        .sort(byValueDesc)
        .slice(0, SNS_DEMOGRAPHICS_TOP_LIMIT),
      top_countries: groups.country
        .sort(byValueDesc)
        .slice(0, SNS_DEMOGRAPHICS_TOP_LIMIT),
    };
  }

  const mediaRows = readHistoryTabObjects_(
    spreadsheet,
    'media',
    SNS_HISTORY_MEDIA_COLUMNS
  );
  if (mediaRows) {
    ig.recent_media = mediaRows
      .map((row) => ({
        id: historyTextOrNull_(row.media_id),
        type: historyTextOrNull_(row.type),
        posted_at: historyTimestampOrNull_(row.posted_at),
        caption: historyTextOrNull_(row.caption),
        permalink: historyTextOrNull_(row.permalink),
        thumbnail_url: historyTextOrNull_(row.thumbnail_url),
        views: num(row.views),
        reach: num(row.reach),
        likes: num(row.likes),
        comments: num(row.comments),
        shares: num(row.shares),
        saves: num(row.saves),
        avg_watch_sec: num(row.avg_watch_sec),
        total_watch_sec: num(row.total_watch_sec),
      }))
      .filter((entry) => entry.id)
      .sort((a, b) => compareTimestampDesc_(a.posted_at, b.posted_at))
      .slice(0, SNS_RECENT_MEDIA_LIMIT);
  }

  const th = detail.threads;
  th.followers = num(account.threads_followers);
  const thAccountRows = readHistoryTabObjects_(
    spreadsheet,
    'threads_account',
    SNS_HISTORY_THREADS_ACCOUNT_COLUMNS
  );
  if (thAccountRows) {
    const byMetric = {};
    thAccountRows.forEach((row) => {
      const metric = historyTextOrNull_(row.metric);
      const value = num(row.value);
      if (metric && value !== null) {
        byMetric[metric] = value;
      }
    });
    const metricOrNull = (name) =>
      Object.prototype.hasOwnProperty.call(byMetric, name)
        ? byMetric[name]
        : null;
    th.views_30d = metricOrNull('views_30d');
    th.interactions_30d = {
      total: metricOrNull('interactions_total'),
      likes: metricOrNull('interactions_likes'),
      replies: metricOrNull('interactions_replies'),
      reposts: metricOrNull('interactions_reposts'),
      quotes: metricOrNull('interactions_quotes'),
    };
  }
  const postRows = readHistoryTabObjects_(
    spreadsheet,
    'threads_media',
    SNS_HISTORY_THREADS_MEDIA_COLUMNS
  );
  if (postRows) {
    th.recent_posts = postRows
      .map((row) => ({
        id: historyTextOrNull_(row.post_id),
        type: historyTextOrNull_(row.type),
        posted_at: historyTimestampOrNull_(row.posted_at),
        text: historyTextOrNull_(row.text),
        permalink: historyTextOrNull_(row.permalink),
        views: num(row.views),
        likes: num(row.likes),
        replies: num(row.replies),
        reposts: num(row.reposts),
        quotes: num(row.quotes),
      }))
      .filter((entry) => entry.id)
      .sort((a, b) => compareTimestampDesc_(a.posted_at, b.posted_at))
      .slice(0, SNS_THREADS_RECENT_POSTS_LIMIT);
  }

  // X: the follower count rides the account row; the posts ride
  // x_media. The username is not stored in the sheet (it never
  // changes and no screen needs it), so a sheet-built detail
  // leaves it null — the stored-snapshot fallback carries it.
  const x = detail.x;
  x.followers = num(account.x_followers);
  const xRows = readHistoryTabObjects_(
    spreadsheet,
    'x_media',
    SNS_HISTORY_X_MEDIA_COLUMNS
  );
  if (xRows) {
    x.recent_posts = xRows
      .map((row) => {
        const id = historyTextOrNull_(row.post_id);
        return {
          id,
          posted_at: historyTimestampOrNull_(row.posted_at),
          text: historyTextOrNull_(row.text),
          url: id ? 'https://x.com/i/web/status/' + id : null,
          views: num(row.views),
          likes: num(row.likes),
          reposts: num(row.reposts),
          replies: num(row.replies),
        };
      })
      .filter((entry) => entry.id)
      .sort((a, b) => compareTimestampDesc_(a.posted_at, b.posted_at))
      .slice(0, SNS_X_RECENT_POSTS_LIMIT);
  }
  return detail;
}

// The fixed report shapes the /social screen asks for, mapped
// to the sheet construction that answers them. Anything else
// (other dimensions, dimension filters, other metric sets) is
// not served: the endpoint no longer runs live GA4 reports
// for the screen, and an unanswerable shape must say so
// instead of inventing numbers.
function blogReportShape_(params) {
  if (!params || (params.filters && params.filters.length)) {
    return null;
  }
  const dims = params.dimensions || [];
  const metrics = params.metrics || [];
  if (dims.length === 0) {
    return metrics.join(',') === 'screenPageViews,activeUsers,sessions'
      ? 'totals'
      : null;
  }
  // The per-article display-time report: pagePath x the
  // article_render metric pair (total render_ms, sample count),
  // served from the blog_speed tab in the same GA4 shape the
  // live report would return.
  if (
    dims.length === 1 &&
    dims[0] === 'pagePath' &&
    metrics.join(',') === BLOG_RENDER_METRIC + ',eventCount'
  ) {
    return 'speed';
  }
  if (dims.length !== 1 || metrics[0] !== 'screenPageViews') {
    return null;
  }
  if (dims[0] === 'date') {
    return metrics.length === 1 ? 'daily' : null;
  }
  if (dims[0] === 'pagePath') {
    return 'pages';
  }
  if (dims[0] === 'sessionDefaultChannelGroup') {
    return 'sources';
  }
  return null;
}

// A GA4-shaped report row: the screen's shaping helpers read
// only data.rows' dimensionValues[0] and metricValues[i], so
// the synthesized data carries exactly those.
function blogReportRow_(dimensionValue, metricValues) {
  return {
    dimensionValues:
      dimensionValue === null || dimensionValue === undefined
        ? []
        : [{ value: String(dimensionValue) }],
    metricValues: (metricValues || []).map((value) => ({
      value: String(value === null || value === undefined ? 0 : value),
    })),
  };
}

// Metric values for a row whose first metric is a view count.
// The per-page users/sessions of the old live pages report
// were never collected into the sheet, and the screen reads
// only metricValues[0] on those reports, so the remaining
// slots ride as 0.
function blogViewsMetricValues_(views, metricCount) {
  const values = [views === null || views === undefined ? 0 : views];
  while (values.length < Math.max(1, metricCount || 1)) {
    values.push(0);
  }
  return values;
}

function blogTotalsData_(spreadsheet) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_totals',
    SNS_HISTORY_BLOG_TOTALS_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const row = rows.filter(
    (entry) => historyTextOrNull_(entry.window) === BLOG_TOTALS_WINDOW_KEY
  )[0];
  if (!row) {
    return null;
  }
  return {
    rows: [
      blogReportRow_(null, [
        snsHistoryNumberCell_(row.views),
        snsHistoryNumberCell_(row.users),
        snsHistoryNumberCell_(row.sessions),
      ]),
    ],
    rowCount: 1,
  };
}

// A report date parameter ('today', '28daysAgo',
// 'YYYY-MM-DD') resolved to the JST calendar key the sheet
// keys days by, or null for anything else.
function resolveBlogDateKey_(value, nowMs) {
  const raw = String(value || '');
  if (raw === 'today') {
    return jstDateKey_(nowMs);
  }
  const daysAgo = /^(\d+)daysAgo$/.exec(raw);
  if (daysAgo) {
    return jstDateKey_(nowMs - Number(daysAgo[1]) * SNS_DAY_MS);
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function blogDailyData_(spreadsheet, startKey, endKey) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_daily',
    SNS_HISTORY_BLOG_DAILY_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const viewsByDate = {};
  rows.forEach((row) => {
    const date = snsHistoryKeyCell_(row.date);
    if (date && date >= startKey && date <= endKey) {
      viewsByDate[date] = snsHistoryNumberCell_(row.views);
    }
  });
  const dates = Object.keys(viewsByDate).sort();
  return {
    rows: dates.map((date) =>
      blogReportRow_(date.replace(/-/g, ''), [viewsByDate[date]])
    ),
    rowCount: dates.length,
  };
}

function blogPagesData_(spreadsheet, params) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_pages',
    SNS_HISTORY_BLOG_PAGES_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const entries = latestBatchRows_(rows)
    .map((row) => ({
      path: historyTextOrNull_(row.path),
      views: snsHistoryNumberCell_(row.views_28d),
    }))
    .filter((entry) => entry.path)
    .sort((a, b) => (b.views || 0) - (a.views || 0));
  return {
    rows: entries.map((entry) =>
      blogReportRow_(
        entry.path,
        blogViewsMetricValues_(entry.views, params.metrics.length)
      )
    ),
    rowCount: entries.length,
  };
}

// The blog_speed tab in the GA4 report shape: one row per
// article, metricValues [total_render_ms, samples], slowest
// average first. Articles with no recorded display are absent,
// exactly like the live report.
function blogSpeedData_(spreadsheet) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_speed',
    SNS_HISTORY_BLOG_SPEED_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const entries = latestBatchRows_(rows)
    .map((row) => ({
      path: historyTextOrNull_(row.path),
      total: snsHistoryNumberCell_(row.total_render_ms),
      samples: snsHistoryNumberCell_(row.samples),
    }))
    .filter((entry) => entry.path && entry.samples)
    .sort((a, b) => b.total / b.samples - a.total / a.samples);
  return {
    rows: entries.map((entry) =>
      blogReportRow_(entry.path, [entry.total, entry.samples])
    ),
    rowCount: entries.length,
  };
}

function blogSourcesData_(spreadsheet, params) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_sources',
    SNS_HISTORY_BLOG_SOURCES_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const entries = latestBatchRows_(rows)
    .map((row) => ({
      channel: historyTextOrNull_(row.channel),
      views: snsHistoryNumberCell_(row.views_28d),
    }))
    .filter((entry) => entry.channel)
    .sort((a, b) => (b.views || 0) - (a.views || 0));
  return {
    rows: entries.map((entry) =>
      blogReportRow_(
        entry.channel,
        blogViewsMetricValues_(entry.views, params.metrics.length)
      )
    ),
    rowCount: entries.length,
  };
}

// The report response for the screen's fixed blog reports,
// assembled from the history sheet. The envelope matches the
// old live bridge's exactly (including _share, which share
// link validation rides on), but data.rows are synthesized in
// the GA4 shape from the sheet tabs — the Data API is not
// called. Unsupported parameter combinations, and a sheet
// that holds no data yet, answer ok:false instead of falling
// back to a live call. The full (unsliced) payload is cached
// per shape for an hour — and the hourly collection
// precomputes the screen's shapes; the limit/offset slicing
// happens per request, after the cache.
function buildBlogReportResponse_(params, shareSession) {
  const shape = blogReportShape_(params);
  if (!shape) {
    return {
      ok: false,
      error:
        "unsupported report parameters: the /social screen's reports are served from the history sheet in fixed shapes only",
    };
  }
  let startKey = null;
  let endKey = null;
  if (shape === 'daily') {
    const nowMs = Date.now();
    startKey = resolveBlogDateKey_(params.startDate, nowMs);
    endKey = resolveBlogDateKey_(params.endDate, nowMs);
    if (!startKey || !endKey) {
      return {
        ok: false,
        error:
          'unsupported report date range: ' +
          params.startDate +
          '..' +
          params.endDate,
      };
    }
  }
  const cache = sheetReadCache_();
  const cacheKey =
    BLOG_REPORT_CACHE_KEY_PREFIX +
    shape +
    '_' +
    params.metrics.length +
    (shape === 'daily' ? '_' + startKey + '_' + endKey : '');
  let data = null;
  if (cache) {
    const hit = getCachedText_(cache, cacheKey);
    if (hit) {
      try {
        data = JSON.parse(hit);
      } catch (err) {
        data = null;
      }
    }
  }
  if (!data) {
    try {
      const spreadsheet = openHistorySpreadsheet_();
      if (spreadsheet) {
        if (shape === 'totals') {
          data = blogTotalsData_(spreadsheet);
        } else if (shape === 'daily') {
          data = blogDailyData_(spreadsheet, startKey, endKey);
        } else if (shape === 'pages') {
          data = blogPagesData_(spreadsheet, params);
        } else if (shape === 'sources') {
          data = blogSourcesData_(spreadsheet, params);
        } else if (shape === 'speed') {
          data = blogSpeedData_(spreadsheet);
        }
      }
    } catch (err) {
      console.log(
        'Blog report from sheet failed: ' +
          summarizeSnsHistoryError_(
            err,
            getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY)
          )
      );
      data = null;
    }
    if (data && cache) {
      putCachedText_(
        cache,
        cacheKey,
        JSON.stringify(data),
        BLOG_REPORT_CACHE_SECONDS
      );
    }
  }
  if (!data) {
    return {
      ok: false,
      error: 'blog data has not been collected into the history sheet yet',
    };
  }
  const offset = params.offset || 0;
  const limited = Object.assign({}, data, {
    rows: data.rows.slice(offset, offset + params.limit),
  });
  return {
    ok: true,
    property: getScriptProperty_('GA4_PROPERTY_ID'),
    startDate: params.startDate,
    endDate: params.endDate,
    metrics: params.metrics,
    dimensions: params.dimensions,
    filters: params.filters,
    offset: params.offset,
    _share: shareSession ? { expires_at: shareSession.expires_at } : undefined,
    data: limited,
  };
}

// --- Collection-time read precompute ---
// The read side above serves the screen from CacheService;
// this fills that cache at the one moment the data changes —
// the end of the hourly collection — so a screen load never
// pays the sheet reads and assembly at all. Everything here
// is best-effort: a precompute failure is logged and left for
// the read path to rebuild from the sheet, exactly as before
// this step existed. Payloads are stored through the chunked
// helpers, under the same keys the readers consult.
function precomputeReadCaches_() {
  const cache = sheetReadCache_();
  if (!cache) {
    return;
  }
  const spreadsheet = openHistorySpreadsheet_();
  if (!spreadsheet) {
    return;
  }
  try {
    const detail = buildSnsDetailFromSheet_(spreadsheet);
    if (detail) {
      putCachedText_(
        cache,
        SNS_DETAIL_CACHE_KEY,
        JSON.stringify(detail),
        SNS_DETAIL_CACHE_SECONDS
      );
    }
  } catch (err) {
    console.log('SNS detail precompute failed: ' + err);
  }
  try {
    putCachedText_(
      cache,
      SNS_HISTORY_CACHE_KEY,
      JSON.stringify(assembleSnsHistoryResponse_(spreadsheet)),
      SNS_HISTORY_CACHE_SECONDS
    );
  } catch (err) {
    console.log('SNS history precompute failed: ' + err);
  }
  // The blog shapes the screen asks for: the totals (always
  // three metrics) and the daily series over the default
  // window, plus the pages / sources rankings at the metric
  // widths the screen uses. Any other parameter combination
  // simply misses here and is cached by its first read, as
  // before.
  const blogShapes = [
    ['totals', 3, () => blogTotalsData_(spreadsheet)],
    [
      'daily',
      1,
      () => {
        const nowMs = Date.now();
        const startKey = resolveBlogDateKey_('28daysAgo', nowMs);
        const endKey = resolveBlogDateKey_('today', nowMs);
        return startKey && endKey
          ? {
              data: blogDailyData_(spreadsheet, startKey, endKey),
              dates: [startKey, endKey],
            }
          : null;
      },
    ],
    ['pages', 1, () => blogPagesData_(spreadsheet, { metrics: [0] })],
    ['pages', 3, () => blogPagesData_(spreadsheet, { metrics: [0, 0, 0] })],
    ['sources', 1, () => blogSourcesData_(spreadsheet, { metrics: [0] })],
    [
      'sources',
      3,
      () => blogSourcesData_(spreadsheet, { metrics: [0, 0, 0] }),
    ],
    ['speed', 2, () => blogSpeedData_(spreadsheet)],
  ];
  blogShapes.forEach(([shape, metricsLength, build]) => {
    try {
      const built = build();
      if (!built) {
        return;
      }
      const data = built.data !== undefined ? built.data : built;
      if (!data) {
        return;
      }
      let key = BLOG_REPORT_CACHE_KEY_PREFIX + shape + '_' + metricsLength;
      if (built.dates) {
        key += '_' + built.dates[0] + '_' + built.dates[1];
      }
      putCachedText_(
        cache,
        key,
        JSON.stringify(data),
        BLOG_REPORT_CACHE_SECONDS
      );
    } catch (err) {
      console.log('Blog ' + shape + ' precompute failed: ' + err);
    }
  });
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
  const thDetail = fetchThreadsAccountDetail_();
  const thPosts = fetchThreadsRecentPosts_();
  const xDetail = fetchXDetail_();
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
      daily_follows: igDetail.daily_follows,
      daily_follows_missing_days: igDetail.daily_follows_missing_days,
      daily_follows_error: igDetail.daily_follows_error,
      demographics: igDemographics.demographics,
      detail_error: joinSnsErrors_([igDetail.detail_error, igDemographics.error]),
      recent_media: igMedia.recent_media,
      media_error: igMedia.media_error,
    },
    threads: {
      followers: fetchThreadsFollowers_(),
      threads_error: threadsRefreshError,
      views_30d: thDetail.views_30d,
      interactions_30d: thDetail.interactions_30d,
      detail_error: thDetail.detail_error,
      recent_posts: thPosts.recent_posts,
      posts_error: thPosts.posts_error,
    },
    x: {
      followers: xDetail.followers,
      username: xDetail.username,
      x_error: xDetail.x_error,
      recent_posts: xDetail.recent_posts,
      posts_error: xDetail.posts_error,
    },
  };
  if (snapshot.threads.threads_error) {
    console.log('Threads refresh error: ' + snapshot.threads.threads_error);
  }
  if (snapshot.threads.detail_error) {
    console.log('Threads detail error: ' + snapshot.threads.detail_error);
  }
  if (snapshot.threads.posts_error) {
    console.log('Threads posts error: ' + snapshot.threads.posts_error);
  }
  if (igViews.insights_error) {
    console.log('Instagram insights error: ' + igViews.insights_error);
  }
  if (snapshot.instagram.detail_error) {
    console.log('Instagram detail error: ' + snapshot.instagram.detail_error);
  }
  if (snapshot.instagram.daily_follows_error) {
    console.log(
      'Instagram daily follows error: ' + snapshot.instagram.daily_follows_error
    );
  }
  if (snapshot.instagram.daily_follows_missing_days) {
    console.log(
      'Instagram daily follows missing days: ' +
        snapshot.instagram.daily_follows_missing_days
    );
  }
  if (snapshot.instagram.media_error) {
    console.log('Instagram media error: ' + snapshot.instagram.media_error);
  }
  if (snapshot.youtube.youtube_error) {
    console.log('YouTube detail error: ' + snapshot.youtube.youtube_error);
  }
  if (snapshot.x.x_error) {
    console.log('X detail error: ' + snapshot.x.x_error);
  }
  if (snapshot.x.posts_error && snapshot.x.posts_error !== snapshot.x.x_error) {
    console.log('X posts error: ' + snapshot.x.posts_error);
  }
  PropertiesService.getScriptProperties().setProperty(
    SNS_SNAPSHOT_PROPERTY,
    JSON.stringify(snapshot)
  );
  appendSnsHistory_(snapshot);
  appendBlogHistory_();
  // The history writes above are the only moments the read
  // payloads can change, so rebuild them into the read cache
  // here; screen loads then never assemble from the sheet.
  try {
    precomputeReadCaches_();
  } catch (err) {
    console.log('Read cache precompute failed: ' + err);
  }
  console.log('SNS counts collected: ' + JSON.stringify(snapshot));
  return snapshot;
}

// Editor helper: (re)install the hourly time-driven trigger for
// collectSnsCounts. Run once from the editor after deployment; triggers
// are not part of the deployed code.
function setupSnsTriggers() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'collectSnsCounts')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('collectSnsCounts').timeBased().everyHours(1).create();
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

// --- Smoke records inlet (doPost, action=record_smoke) ---
// The morning smoke workflow on GitHub Actions measures the
// static pages, the pinned blog articles and the GAS endpoints
// from its runner and POSTs one JSON batch here:
//   { action: 'record_smoke', token,
//     records: [{ target, kind, ms, ok }] }
// Rows land in the history spreadsheet's "smoke_records" tab —
// an append-only log (recorded_at, target, kind, ms, ok) the
// trend is read from. The token must match the Script Property
// SMOKE_RECORD_TOKEN; while that property is unset the inlet
// refuses every batch, so deploying this code alone records
// nothing. The matching GitHub Actions secret carries the same
// token; neither side prints it.
const SMOKE_RECORDS_TAB = 'smoke_records';
const SMOKE_RECORDS_COLUMNS = ['recorded_at', 'target', 'kind', 'ms', 'ok'];
const SMOKE_RECORD_TOKEN_PROPERTY = 'SMOKE_RECORD_TOKEN';
const SMOKE_RECORDS_MAX_BATCH = 100;

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body && body.action === 'record_smoke') {
      return jsonOut_(recordSmoke_(body));
    }
    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid request body' });
  }
}

// Validates one record_smoke batch and appends its rows.
// Refusals are ok:false answers, never throws, so the caller
// can log the reason; a failed append writes nothing (the
// batch lands in a single setValues call).
function recordSmoke_(body) {
  const expected = getScriptProperty_(SMOKE_RECORD_TOKEN_PROPERTY);
  if (!expected) {
    return { ok: false, error: 'smoke recording is not configured' };
  }
  if (!body || body.token !== expected) {
    return { ok: false, error: 'invalid token' };
  }
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return { ok: false, error: 'history sheet is not configured' };
  }
  const records = Array.isArray(body.records)
    ? body.records.slice(0, SMOKE_RECORDS_MAX_BATCH)
    : [];
  if (!records.length) {
    return { ok: false, error: 'no records' };
  }
  const recordedAt = new Date().toISOString();
  const rows = records.map((record) => {
    const item = record || {};
    return [
      recordedAt,
      String(item.target || ''),
      String(item.kind || ''),
      typeof item.ms === 'number' && Number.isFinite(item.ms)
        ? Math.round(item.ms)
        : '',
      item.ok === true ? 'ok' : 'ng',
    ];
  });
  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    appendSmokeRows_(spreadsheet, rows);
  } catch (err) {
    return {
      ok: false,
      error: 'append failed: ' + summarizeSnsHistoryError_(err, sheetId),
    };
  }
  return { ok: true, recorded: rows.length };
}

// Appends rows to the smoke_records tab, creating it with its
// header row on first use.
function appendSmokeRows_(spreadsheet, rows) {
  let sheet = spreadsheet.getSheetByName(SMOKE_RECORDS_TAB);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SMOKE_RECORDS_TAB);
    sheet
      .getRange(1, 1, 1, SMOKE_RECORDS_COLUMNS.length)
      .setValues([SMOKE_RECORDS_COLUMNS]);
  }
  if (rows.length) {
    sheet
      .getRange(sheet.getLastRow() + 1, 1, rows.length, SMOKE_RECORDS_COLUMNS.length)
      .setValues(rows);
  }
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
    if (parameter.action === 'exchange_session') {
      try {
        verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
      } catch (error) {
        return jsonOut_({ ok: false, status: 401, error: String((error && error.message) || error) });
      }
      return jsonOut_(Object.assign({ ok: true }, issueOwnerSession_()));
    }
    if (parameter.action === 'revoke_session') {
      return jsonOut_(Object.assign({ ok: true }, revokeOwnerSession_()));
    }
    if (parameter.action === 'issue_share' || parameter.action === 'revoke_share') {
      try {
        requireOwnerAuth_(e);
      } catch (error) {
        return jsonOut_({ ok: false, status: 401, error: String((error && error.message) || error) });
      }
      const result =
        parameter.action === 'issue_share' ? issueShareSession_() : revokeShareSession_();
      return jsonOut_(Object.assign({ ok: true }, result));
    }
    if (isAuthConfigured_()) {
      if (parameter.session_token) {
        if (!validateOwnerToken_(parameter.session_token)) {
          return jsonOut_({
            ok: false,
            status: 401,
            error: 'session expired or invalid',
          });
        }
      } else if (parameter.share_token) {
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
    // The screen's blog reports are served from the history
    // sheet (stage 2): the GA4 Data API is no longer called to
    // render the screen. buildReportRequest_ / fetchReport_
    // remain as the collection side's bridge (the blog history
    // writes, music_count, top_articles).
    const params = parseRunParams_(parameter);
    return jsonOut_(buildBlogReportResponse_(params, shareSession));
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
  exports.issueOwnerSession_ = issueOwnerSession_;
  exports.revokeOwnerSession_ = revokeOwnerSession_;
  exports.validateOwnerToken_ = validateOwnerToken_;
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
  exports.threadsToken_ = threadsToken_;
  exports.threadsUserId_ = threadsUserId_;
  exports.threadsAccountInsightsUrl_ = threadsAccountInsightsUrl_;
  exports.fetchThreadsAccountInsightTotal_ = fetchThreadsAccountInsightTotal_;
  exports.fetchThreadsAccountDetail_ = fetchThreadsAccountDetail_;
  exports.threadsPostListUrl_ = threadsPostListUrl_;
  exports.buildThreadsPostEntry_ = buildThreadsPostEntry_;
  exports.parseThreadsMediaInsights_ = parseThreadsMediaInsights_;
  exports.fetchThreadsPostInsights_ = fetchThreadsPostInsights_;
  exports.fetchThreadsRecentPosts_ = fetchThreadsRecentPosts_;
  exports.threadsInsightEntryTotal_ = threadsInsightEntryTotal_;
  exports.parseThreadsInsightsByName_ = parseThreadsInsightsByName_;
  exports.debugThreadsPosts = debugThreadsPosts;
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
  exports.fetchInstagramDailyFollows_ = fetchInstagramDailyFollows_;
  exports.fetchInstagramDailyFollowsDay_ = fetchInstagramDailyFollowsDay_;
  exports.dailyFollowsDateKeys_ = dailyFollowsDateKeys_;
  exports.jstDateKey_ = jstDateKey_;
  exports.jstDayWindowSec_ = jstDayWindowSec_;
  exports.debugInstagramDailyFollows = debugInstagramDailyFollows;
  exports.fetchProfileLinksTaps_ = fetchProfileLinksTaps_;
  exports.fetchInstagramDemographics_ = fetchInstagramDemographics_;
  exports.parseDemographicsBreakdown_ = parseDemographicsBreakdown_;
  exports.fetchInstagramRecentMedia_ = fetchInstagramRecentMedia_;
  exports.fetchMediaInsights_ = fetchMediaInsights_;
  exports.parseMediaInsights_ = parseMediaInsights_;
  exports.fetchYouTubeChannelDetail_ = fetchYouTubeChannelDetail_;
  exports.fetchYouTubeRecentVideos_ = fetchYouTubeRecentVideos_;
  exports.summarizeYouTubeError_ = summarizeYouTubeError_;
  exports.fetchXDetail_ = fetchXDetail_;
  exports.buildXPostEntry_ = buildXPostEntry_;
  exports.xWireNumberOrNull_ = xWireNumberOrNull_;
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
  exports.buildSnsHistoryDailyRows_ = buildSnsHistoryDailyRows_;
  exports.buildSnsHistoryThreadsMediaRows_ = buildSnsHistoryThreadsMediaRows_;
  exports.buildSnsHistoryYouTubeMediaRows_ = buildSnsHistoryYouTubeMediaRows_;
  exports.buildSnsHistoryXMediaRows_ = buildSnsHistoryXMediaRows_;
  exports.buildSnsHistoryDemographicsRows_ = buildSnsHistoryDemographicsRows_;
  exports.buildSnsHistoryThreadsAccountRows_ = buildSnsHistoryThreadsAccountRows_;
  exports.appendBlogHistory_ = appendBlogHistory_;
  exports.fetchBlogReportRows_ = fetchBlogReportRows_;
  exports.fetchBlogDailyData_ = fetchBlogDailyData_;
  exports.buildBlogDailyRows_ = buildBlogDailyRows_;
  exports.fetchBlogPostsData_ = fetchBlogPostsData_;
  exports.buildBlogPostsRows_ = buildBlogPostsRows_;
  exports.fetchBlogPathRows_ = fetchBlogPathRows_;
  exports.mergeBlogPathRows_ = mergeBlogPathRows_;
  exports.canonicalBlogPath_ = canonicalBlogPath_;
  exports.fetchBlogPagesData_ = fetchBlogPagesData_;
  exports.buildBlogPagesRows_ = buildBlogPagesRows_;
  exports.fetchBlogTotalsData_ = fetchBlogTotalsData_;
  exports.buildBlogTotalsRows_ = buildBlogTotalsRows_;
  exports.fetchBlogSourcesData_ = fetchBlogSourcesData_;
  exports.buildBlogSourcesRows_ = buildBlogSourcesRows_;
  exports.fetchBlogSpeedData_ = fetchBlogSpeedData_;
  exports.buildBlogSpeedRows_ = buildBlogSpeedRows_;
  exports.doPost = doPost;
  exports.recordSmoke_ = recordSmoke_;
  exports.appendSmokeRows_ = appendSmokeRows_;
  exports.SMOKE_RECORDS_COLUMNS = SMOKE_RECORDS_COLUMNS;
  exports.openHistorySpreadsheet_ = openHistorySpreadsheet_;
  exports.readHistoryTabObjects_ = readHistoryTabObjects_;
  exports.readHistoryTabLastRowObject_ = readHistoryTabLastRowObject_;
  exports.getCachedText_ = getCachedText_;
  exports.putCachedText_ = putCachedText_;
  exports.assembleSnsHistoryResponse_ = assembleSnsHistoryResponse_;
  exports.precomputeReadCaches_ = precomputeReadCaches_;
  exports.latestAccountRow_ = latestAccountRow_;
  exports.latestBatchRows_ = latestBatchRows_;
  exports.buildSnsDetailFromSheet_ = buildSnsDetailFromSheet_;
  exports.blogReportShape_ = blogReportShape_;
  exports.buildBlogReportResponse_ = buildBlogReportResponse_;
  exports.ga4DateKey_ = ga4DateKey_;
  exports.mergeSnsHistoryRows_ = mergeSnsHistoryRows_;
  exports.snsHistoryKeyCell_ = snsHistoryKeyCell_;
  exports.readSnsHistoryRows_ = readSnsHistoryRows_;
  exports.upsertSnsHistorySheet_ = upsertSnsHistorySheet_;
  exports.ensureSnsHistorySheet_ = ensureSnsHistorySheet_;
  exports.summarizeSnsHistoryError_ = summarizeSnsHistoryError_;
  exports.SNS_HISTORY_ACCOUNT_COLUMNS = SNS_HISTORY_ACCOUNT_COLUMNS;
  exports.SNS_HISTORY_MEDIA_COLUMNS = SNS_HISTORY_MEDIA_COLUMNS;
  exports.SNS_HISTORY_DAILY_COLUMNS = SNS_HISTORY_DAILY_COLUMNS;
  exports.SNS_HISTORY_THREADS_MEDIA_COLUMNS = SNS_HISTORY_THREADS_MEDIA_COLUMNS;
  exports.SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS = SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS;
  exports.SNS_HISTORY_X_MEDIA_COLUMNS = SNS_HISTORY_X_MEDIA_COLUMNS;
  exports.SNS_HISTORY_DEMOGRAPHICS_COLUMNS = SNS_HISTORY_DEMOGRAPHICS_COLUMNS;
  exports.SNS_HISTORY_THREADS_ACCOUNT_COLUMNS = SNS_HISTORY_THREADS_ACCOUNT_COLUMNS;
  exports.SNS_HISTORY_BLOG_DAILY_COLUMNS = SNS_HISTORY_BLOG_DAILY_COLUMNS;
  exports.SNS_HISTORY_BLOG_POSTS_COLUMNS = SNS_HISTORY_BLOG_POSTS_COLUMNS;
  exports.SNS_HISTORY_BLOG_PAGES_COLUMNS = SNS_HISTORY_BLOG_PAGES_COLUMNS;
  exports.SNS_HISTORY_BLOG_TOTALS_COLUMNS = SNS_HISTORY_BLOG_TOTALS_COLUMNS;
  exports.SNS_HISTORY_BLOG_SOURCES_COLUMNS = SNS_HISTORY_BLOG_SOURCES_COLUMNS;
  exports.SNS_HISTORY_BLOG_SPEED_COLUMNS = SNS_HISTORY_BLOG_SPEED_COLUMNS;
}
