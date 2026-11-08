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
    const propertyId =
      PropertiesService.getScriptProperties().getProperty('GA4_PROPERTY_ID');
    if (!propertyId) {
      return jsonOut_({
        ok: false,
        error: 'GA4_PROPERTY_ID is not set in Script Properties',
      });
    }
    const parameter = (e && e.parameter) || {};
    // The public music play count is served before any
    // authentication: it is the single action that is callable
    // without a token, and it exposes only the aggregate count.
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
}
