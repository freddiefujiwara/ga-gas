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
 *   action=music_count - the one public action: returns only the
 *                cumulative music_play event count and its timestamp
 *                (cached for about an hour). Every other request,
 *                including the default report, requires authentication
 *                once it is configured (see below).
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
// returns that snapshot (service names, follower counts, collected_at).
// It never exposes tokens or any GA4 data.
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

function buildSnsCountsResponse_() {
  const snapshot = getSnsCountsSnapshot_();
  if (!snapshot) {
    return {
      ok: true,
      action: 'sns_counts',
      collected_at: null,
      youtube: { subscribers: null },
      instagram: { freddiefujiwara: null, anemone_cancer: null },
      threads: { followers: null },
    };
  }
  return Object.assign({ ok: true, action: 'sns_counts' }, snapshot);
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

function fetchThreadsFollowers_() {
  const token =
    getScriptProperty_('META_THREADS_ACCESS_TOKEN') ||
    getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return null;
  }
  return fetchGraphFollowersCount_(
    THREADS_GRAPH_BASE +
      SNS_THREADS_USER_ID +
      '?fields=followers_count&access_token=' +
      encodeURIComponent(token)
  );
}

function fetchYouTubeSubscribers_() {
  try {
    if (typeof YouTube === 'undefined' || !YouTube.Channels) {
      return null;
    }
    const res = YouTube.Channels.list('statistics', { id: SNS_YOUTUBE_CHANNEL_ID });
    const items = (res && res.items) || [];
    if (!items.length || !items[0].statistics) {
      return null;
    }
    if (items[0].statistics.hiddenSubscriberCount) {
      return null;
    }
    const count = Number(items[0].statistics.subscriberCount);
    return Number.isFinite(count) ? count : null;
  } catch (err) {
    return null;
  }
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

// Trigger target: collects the latest follower counts and stores the
// snapshot. Each service fails independently (null), so one broken or
// unconfigured service never blocks the others.
function collectSnsCounts() {
  refreshMetaTokenIfNeeded_();
  refreshThreadsTokenIfNeeded_();
  const snapshot = {
    collected_at: new Date().toISOString(),
    youtube: { subscribers: fetchYouTubeSubscribers_() },
    instagram: {
      freddiefujiwara: fetchInstagramFollowers_(SNS_INSTAGRAM_MAIN_ID),
      anemone_cancer: fetchInstagramFollowers_(SNS_INSTAGRAM_SUB_ID),
    },
    threads: { followers: fetchThreadsFollowers_() },
  };
  PropertiesService.getScriptProperties().setProperty(
    SNS_SNAPSHOT_PROPERTY,
    JSON.stringify(snapshot)
  );
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

function doGet(e) {
  try {
    const parameter = (e && e.parameter) || {};
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
  exports.jsonOut_ = jsonOut_;
  exports.collectSnsCounts = collectSnsCounts;
  exports.setupSnsTriggers = setupSnsTriggers;
  exports.getSnsCountsSnapshot_ = getSnsCountsSnapshot_;
  exports.buildSnsCountsResponse_ = buildSnsCountsResponse_;
  exports.fetchGraphFollowersCount_ = fetchGraphFollowersCount_;
  exports.fetchInstagramFollowers_ = fetchInstagramFollowers_;
  exports.fetchThreadsFollowers_ = fetchThreadsFollowers_;
  exports.fetchYouTubeSubscribers_ = fetchYouTubeSubscribers_;
  exports.isTokenRefreshDue_ = isTokenRefreshDue_;
  exports.refreshMetaTokenIfNeeded_ = refreshMetaTokenIfNeeded_;
  exports.refreshThreadsTokenIfNeeded_ = refreshThreadsTokenIfNeeded_;
}
