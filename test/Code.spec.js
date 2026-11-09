import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as Code from '../src/Code.js';

const PROPERTY_ID = '561730442';

describe('Code.js', () => {
  let outputs;
  let store;
  let uuidCounter;

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    store = {};
    uuidCounter = 0;
    delete global.UrlFetchApp;
    delete global.ContentService;
    delete global.PropertiesService;
    delete global.ScriptApp;
    delete global.Utilities;

    global.Utilities = {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: vi.fn((algo, value) => [
        ...createHash('sha256').update(String(value)).digest(),
      ]),
      getUuid: vi.fn(() => '00000000-0000-4000-8000-00000000000' + uuidCounter++),
    };
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (key) => (key in store ? store[key] : null),
        setProperty: (key, value) => {
          store[key] = value;
        },
        deleteProperty: (key) => {
          delete store[key];
        },
      }),
    };

    global.ContentService = {
      createTextOutput: vi.fn((text) => {
        const out = {
          text,
          mimeType: null,
          setMimeType(m) {
            this.mimeType = m;
            return this;
          },
        };
        outputs.push(out);
        return out;
      }),
      MimeType: { JSON: 'application/json' },
    };
    global.ScriptApp = { getOAuthToken: vi.fn(() => 'test-token') };
  });

  const setProperty = (value) => {
    if (value == null) {
      delete store.GA4_PROPERTY_ID;
    } else {
      store.GA4_PROPERTY_ID = value;
    }
  };

  const mockFetch = (status, body) => {
    global.UrlFetchApp = {
      fetch: vi.fn(() => ({
        getResponseCode: () => status,
        getContentText: () => JSON.stringify(body),
      })),
    };
  };

  const lastJson = () => JSON.parse(outputs[outputs.length - 1].text);

  describe('doGet', () => {
    it('returns an error when GA4_PROPERTY_ID is not set', () => {
      setProperty(null);
      Code.doGet({ parameter: {} });
      const json = lastJson();
      expect(json.ok).toBe(false);
      expect(json.error).toContain('GA4_PROPERTY_ID');
    });

    it('returns report data with default parameters', () => {
      setProperty(PROPERTY_ID);
      mockFetch(200, { rowCount: 1, rows: [] });
      Code.doGet({ parameter: {} });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.property).toBe(PROPERTY_ID);
      expect(json.startDate).toBe('28daysAgo');
      expect(json.endDate).toBe('today');
      expect(json.metrics).toEqual(['screenPageViews', 'activeUsers', 'sessions']);
      expect(json.dimensions).toEqual(['pagePath']);
      expect(json.data.rowCount).toBe(1);

      const [url, options] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(url).toBe(
        'https://analyticsdata.googleapis.com/v1beta/properties/' +
          PROPERTY_ID +
          ':runReport'
      );
      expect(options.headers.Authorization).toBe('Bearer test-token');
      const body = JSON.parse(options.payload);
      expect(body.dateRanges).toEqual([{ startDate: '28daysAgo', endDate: 'today' }]);
      expect(body.limit).toBe('25');
      expect(body.orderBys).toEqual([
        { metric: { metricName: 'screenPageViews' }, desc: true },
      ]);
    });

    it('honours explicit parameters and omits orderBys without dimensions', () => {
      setProperty(PROPERTY_ID);
      mockFetch(200, { rows: [] });
      Code.doGet({
        parameter: {
          start: '2026-11-01',
          end: '2026-11-05',
          metrics: 'sessions, activeUsers',
          dimensions: '',
          limit: '5',
        },
      });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.startDate).toBe('2026-11-01');
      expect(json.endDate).toBe('2026-11-05');
      expect(json.metrics).toEqual(['sessions', 'activeUsers']);
      expect(json.dimensions).toEqual([]);
      const body = JSON.parse(global.UrlFetchApp.fetch.mock.calls[0][1].payload);
      expect(body.dimensions).toEqual([]);
      expect(body.limit).toBe('5');
      expect(body.orderBys).toBeUndefined();
    });

    it('falls back to the default limit for an invalid limit', () => {
      setProperty(PROPERTY_ID);
      mockFetch(200, { rows: [] });
      Code.doGet({ parameter: { limit: 'abc' } });
      const body = JSON.parse(global.UrlFetchApp.fetch.mock.calls[0][1].payload);
      expect(body.limit).toBe('25');
    });

    it('passes through a non-200 API response as an error', () => {
      setProperty(PROPERTY_ID);
      mockFetch(403, { error: { message: 'forbidden' } });
      Code.doGet({ parameter: {} });
      const json = lastJson();
      expect(json.ok).toBe(false);
      expect(json.status).toBe(403);
      expect(json.error.error.message).toBe('forbidden');
    });

    it('returns an error JSON when fetch throws', () => {
      setProperty(PROPERTY_ID);
      global.UrlFetchApp = {
        fetch: vi.fn(() => {
          throw new Error('network down');
        }),
      };
      Code.doGet({ parameter: {} });
      const json = lastJson();
      expect(json.ok).toBe(false);
      expect(json.error).toContain('network down');
    });

    it('works when called without an event object', () => {
      setProperty(PROPERTY_ID);
      mockFetch(200, { rows: [] });
      Code.doGet();
      expect(lastJson().ok).toBe(true);
    });
  });

  describe('parseListParam_', () => {
    it('splits, trims and drops empty entries', () => {
      expect(Code.parseListParam_(' a, b ,,c ', 'x')).toEqual(['a', 'b', 'c']);
    });

    it('uses the fallback when the value is missing', () => {
      expect(Code.parseListParam_(null, 'pagePath')).toEqual(['pagePath']);
      expect(Code.parseListParam_(undefined, 'pagePath')).toEqual(['pagePath']);
    });
  });

  describe('parseRunParams_', () => {
    it('applies defaults for an empty parameter set', () => {
      const params = Code.parseRunParams_({});
      expect(params).toEqual({
        startDate: '28daysAgo',
        endDate: 'today',
        metrics: ['screenPageViews', 'activeUsers', 'sessions'],
        dimensions: ['pagePath'],
        limit: 25,
        offset: 0,
        filters: [],
      });
    });

    it('floors a fractional limit', () => {
      expect(Code.parseRunParams_({ limit: '7.9' }).limit).toBe(7);
    });

    it('rejects zero and negative limits', () => {
      expect(Code.parseRunParams_({ limit: '0' }).limit).toBe(25);
      expect(Code.parseRunParams_({ limit: '-3' }).limit).toBe(25);
    });

    it('parses a valid offset and rejects invalid ones', () => {
      expect(Code.parseRunParams_({ offset: '25' }).offset).toBe(25);
      expect(Code.parseRunParams_({ offset: '2.9' }).offset).toBe(2);
      expect(Code.parseRunParams_({ offset: '-5' }).offset).toBe(0);
      expect(Code.parseRunParams_({ offset: 'abc' }).offset).toBe(0);
    });
  });

  describe('parseFilterClauses_', () => {
    it('returns an empty list for missing or empty input', () => {
      expect(Code.parseFilterClauses_(null)).toEqual([]);
      expect(Code.parseFilterClauses_('')).toEqual([]);
    });

    it('parses a single clause', () => {
      expect(Code.parseFilterClauses_('pagePath:contains:/blog/')).toEqual([
        { fieldName: 'pagePath', matchType: 'CONTAINS', value: '/blog/' },
      ]);
    });

    it('parses multiple clauses and keeps colons inside the value', () => {
      const clauses = Code.parseFilterClauses_(
        'pagePath:beginsWith:/blog/;sessionDefaultChannelGroup:exact:Organic Search'
      );
      expect(clauses).toEqual([
        { fieldName: 'pagePath', matchType: 'BEGINS_WITH', value: '/blog/' },
        {
          fieldName: 'sessionDefaultChannelGroup',
          matchType: 'EXACT',
          value: 'Organic Search',
        },
      ]);
    });

    it('supports endsWith and regexp', () => {
      expect(Code.parseFilterClauses_('pagePath:endsWith:.html')[0].matchType).toBe(
        'ENDS_WITH'
      );
      expect(Code.parseFilterClauses_('pagePath:regexp:^/a:b$')[0]).toEqual({
        fieldName: 'pagePath',
        matchType: 'FULL_REGEXP',
        value: '^/a:b$',
      });
    });

    it('throws for malformed clauses', () => {
      expect(() => Code.parseFilterClauses_('pagePath')).toThrow('Invalid filter clause');
      expect(() => Code.parseFilterClauses_('pagePath:typo:x')).toThrow(
        'Invalid filter clause'
      );
      expect(() => Code.parseFilterClauses_('pagePath:exact:')).toThrow(
        'Invalid filter clause'
      );
      expect(() => Code.parseFilterClauses_(':exact:x')).toThrow('Invalid filter clause');
    });
  });

  describe('buildDimensionFilter_', () => {
    it('returns a plain filter for one clause', () => {
      const filter = Code.buildDimensionFilter_([
        { fieldName: 'pagePath', matchType: 'EXACT', value: '/' },
      ]);
      expect(filter).toEqual({
        filter: {
          fieldName: 'pagePath',
          stringFilter: { matchType: 'EXACT', value: '/', caseSensitive: false },
        },
      });
    });

    it('wraps multiple clauses in an AND group', () => {
      const filter = Code.buildDimensionFilter_([
        { fieldName: 'pagePath', matchType: 'CONTAINS', value: '/blog/' },
        { fieldName: 'deviceCategory', matchType: 'EXACT', value: 'mobile' },
      ]);
      expect(filter.andGroup.expressions).toHaveLength(2);
      expect(filter.andGroup.expressions[1].filter.fieldName).toBe('deviceCategory');
    });
  });

  describe('buildReportRequest_', () => {
    it('builds metrics and dimensions as name objects', () => {
      const body = Code.buildReportRequest_({
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        metrics: ['sessions'],
        dimensions: ['date'],
        limit: 10,
      });
      expect(body.metrics).toEqual([{ name: 'sessions' }]);
      expect(body.dimensions).toEqual([{ name: 'date' }]);
      expect(body.orderBys).toEqual([{ metric: { metricName: 'sessions' }, desc: true }]);
    });

    it('omits orderBys when there are no metrics', () => {
      const body = Code.buildReportRequest_({
        startDate: '28daysAgo',
        endDate: 'today',
        metrics: [],
        dimensions: ['date'],
        limit: 10,
      });
      expect(body.orderBys).toBeUndefined();
    });

    it('includes offset and dimensionFilter when provided', () => {
      const body = Code.buildReportRequest_({
        startDate: '28daysAgo',
        endDate: 'today',
        metrics: ['sessions'],
        dimensions: ['pagePath'],
        limit: 10,
        offset: 30,
        filters: [{ fieldName: 'pagePath', matchType: 'CONTAINS', value: '/blog/' }],
      });
      expect(body.offset).toBe('30');
      expect(body.dimensionFilter.filter.fieldName).toBe('pagePath');
    });

    it('defaults the offset to 0 and omits dimensionFilter without filters', () => {
      const body = Code.buildReportRequest_({
        startDate: '28daysAgo',
        endDate: 'today',
        metrics: ['sessions'],
        dimensions: ['pagePath'],
        limit: 10,
      });
      expect(body.offset).toBe('0');
      expect(body.dimensionFilter).toBeUndefined();
    });
  });

  describe('doGet with filter and offset', () => {
    it('passes filter and offset through to the request', () => {
      setProperty(PROPERTY_ID);
      mockFetch(200, { rows: [] });
      Code.doGet({
        parameter: { filter: 'pagePath:contains:/list-of-stuff/', offset: '50', limit: '10' },
      });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.filters).toEqual([
        { fieldName: 'pagePath', matchType: 'CONTAINS', value: '/list-of-stuff/' },
      ]);
      expect(json.offset).toBe(50);
      const body = JSON.parse(global.UrlFetchApp.fetch.mock.calls[0][1].payload);
      expect(body.offset).toBe('50');
      expect(body.limit).toBe('10');
      expect(body.dimensionFilter.filter.stringFilter.value).toBe('/list-of-stuff/');
    });

    it('returns an error JSON for an invalid filter clause', () => {
      setProperty(PROPERTY_ID);
      mockFetch(200, { rows: [] });
      Code.doGet({ parameter: { filter: 'pagePath' } });
      const json = lastJson();
      expect(json.ok).toBe(false);
      expect(json.error).toContain('Invalid filter clause');
    });
  });

  describe('share sessions', () => {
    it('validates an issued token and rejects others', () => {
      store.SHARE_TOKEN_HASH = Code.hashShareToken_('tok123');
      store.SHARE_EXPIRES_AT = '2999-01-01T00:00:00.000Z';
      expect(Code.validateShareToken_('tok123')).toEqual({
        expires_at: '2999-01-01T00:00:00.000Z',
      });
      expect(Code.validateShareToken_('wrong')).toBeNull();
      expect(Code.validateShareToken_(undefined)).toBeNull();
      expect(Code.validateShareToken_('')).toBeNull();
    });

    it('rejects expired or unissued tokens', () => {
      expect(Code.validateShareToken_('tok123')).toBeNull();
      store.SHARE_TOKEN_HASH = Code.hashShareToken_('tok123');
      store.SHARE_EXPIRES_AT = '2000-01-01T00:00:00.000Z';
      expect(Code.validateShareToken_('tok123')).toBeNull();
      delete store.SHARE_EXPIRES_AT;
      expect(Code.validateShareToken_('tok123')).toBeNull();
    });

    it('issueShareSession_ stores only the hash and returns the token', () => {
      const session = Code.issueShareSession_();
      expect(session.share_token).toMatch(/^[0-9a-f]{64}$/);
      expect(session.ttl_seconds).toBe(30 * 24 * 60 * 60);
      expect(store.SHARE_TOKEN_HASH).toBe(Code.hashShareToken_(session.share_token));
      expect(store.SHARE_TOKEN_HASH).not.toBe(session.share_token);
      expect(Code.validateShareToken_(session.share_token)).not.toBeNull();
    });

    it('issuing a new token invalidates the previous one', () => {
      const first = Code.issueShareSession_().share_token;
      const second = Code.issueShareSession_().share_token;
      expect(first).not.toBe(second);
      expect(Code.validateShareToken_(first)).toBeNull();
      expect(Code.validateShareToken_(second)).not.toBeNull();
    });

    it('revokeShareSession_ clears the stored token', () => {
      const token = Code.issueShareSession_().share_token;
      expect(Code.revokeShareSession_()).toEqual({ revoked: true });
      expect(store.SHARE_TOKEN_HASH).toBeUndefined();
      expect(Code.validateShareToken_(token)).toBeNull();
    });

    it('issueShareToken logs a #share= frontend URL', () => {
      const url = Code.issueShareToken();
      expect(url).toMatch(/^https:\/\/freddiefujiwara\.com\/social\/#share=[0-9a-f]{64}$/);
    });

    it('hashShareToken_ produces a SHA-256 hex digest', () => {
      expect(Code.hashShareToken_('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    });
  });

  describe('google id token auth', () => {
    const CLIENT_ID = 'test-client-id';
    const EMAIL = 'owner@example.com';
    const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

    const configureAuth = () => {
      store.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
      store.AVAILABLE_GMAILS = 'other@example.com, ' + EMAIL;
    };

    const mockAuthFetch = (tokeninfo) => {
      global.UrlFetchApp = {
        fetch: vi.fn((url) => {
          if (String(url).startsWith('https://oauth2.googleapis.com/tokeninfo')) {
            return {
              getResponseCode: () => tokeninfo.status || 200,
              getContentText: () => JSON.stringify(tokeninfo.payload || {}),
            };
          }
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify({ rows: [] }),
          };
        }),
      };
    };

    const goodPayload = (overrides) =>
      Object.assign(
        {
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          exp: futureExp(),
          email_verified: 'true',
          email: EMAIL,
          sub: '12345',
        },
        overrides || {}
      );

    it('isAuthConfigured_ reflects the two properties', () => {
      expect(Code.isAuthConfigured_()).toBe(false);
      store.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
      expect(Code.isAuthConfigured_()).toBe(false);
      store.AVAILABLE_GMAILS = EMAIL;
      expect(Code.isAuthConfigured_()).toBe(true);
    });

    it('extractIdToken_ prefers the Bearer header and falls back to the parameter', () => {
      expect(
        Code.extractIdToken_({ headers: { Authorization: 'Bearer abc' }, parameter: {} })
      ).toBe('abc');
      expect(Code.extractIdToken_({ parameter: { id_token: 'xyz' } })).toBe('xyz');
      expect(Code.extractIdToken_({})).toBe('');
      expect(Code.extractIdToken_(null)).toBe('');
    });

    it('verifies a good token', () => {
      configureAuth();
      mockAuthFetch({ payload: goodPayload() });
      expect(Code.verifyGoogleIdTokenOrThrow_('token')).toEqual({
        email: EMAIL,
        sub: '12345',
      });
    });

    it('rejects bad tokens for each reason', () => {
      configureAuth();
      const cases = [
        [{ payload: goodPayload({ iss: 'https://evil.example' }) }, 'invalid iss'],
        [{ payload: goodPayload({ aud: 'other' }) }, 'invalid aud'],
        [{ payload: goodPayload({ exp: 1 }) }, 'token expired'],
        [{ payload: goodPayload({ email_verified: 'false' }) }, 'email not verified'],
        [{ payload: goodPayload({ email: '' }) }, 'missing email'],
        [{ payload: goodPayload({ email: 'nope@example.com' }) }, 'forbidden email'],
        [{ status: 400, payload: {} }, 'token verification failed'],
      ];
      for (const [tokeninfo, message] of cases) {
        mockAuthFetch(tokeninfo);
        expect(() => Code.verifyGoogleIdTokenOrThrow_('token')).toThrow(message);
      }
      expect(() => Code.verifyGoogleIdTokenOrThrow_('')).toThrow('missing id token');
      delete store.GOOGLE_OAUTH_CLIENT_ID;
      mockAuthFetch({ payload: goodPayload() });
      expect(() => Code.verifyGoogleIdTokenOrThrow_('token')).toThrow(
        'missing GOOGLE_OAUTH_CLIENT_ID'
      );
    });

    it('doGet serves data with a valid id token', () => {
      setProperty(PROPERTY_ID);
      configureAuth();
      mockAuthFetch({ payload: goodPayload() });
      Code.doGet({ parameter: { id_token: 'token' } });
      expect(lastJson().ok).toBe(true);
    });

    it('doGet rejects a missing token with 401 and a forbidden email with 403', () => {
      setProperty(PROPERTY_ID);
      configureAuth();
      mockAuthFetch({ payload: goodPayload() });
      Code.doGet({ parameter: {} });
      expect(lastJson()).toEqual({ ok: false, status: 401, error: 'missing id token' });
      mockAuthFetch({ payload: goodPayload({ email: 'nope@example.com' }) });
      Code.doGet({ parameter: { id_token: 'token' } });
      expect(lastJson().status).toBe(403);
    });

    it('doGet serves data with a valid share token and reports its expiry', () => {
      setProperty(PROPERTY_ID);
      configureAuth();
      mockAuthFetch({ payload: goodPayload() });
      const token = Code.issueShareSession_().share_token;
      Code.doGet({ parameter: { share_token: token } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json._share.expires_at).toBe(store.SHARE_EXPIRES_AT);
      Code.doGet({ parameter: { share_token: 'bogus' } });
      expect(lastJson().status).toBe(401);
    });

    it('issue_share and revoke_share require an id token', () => {
      setProperty(PROPERTY_ID);
      configureAuth();
      mockAuthFetch({ payload: goodPayload() });
      Code.doGet({ parameter: { action: 'issue_share' } });
      expect(lastJson().status).toBe(401);
      Code.doGet({ parameter: { action: 'issue_share', id_token: 'token' } });
      const issued = lastJson();
      expect(issued.ok).toBe(true);
      expect(issued.share_token).toMatch(/^[0-9a-f]{64}$/);
      Code.doGet({ parameter: { action: 'revoke_share', id_token: 'token' } });
      expect(lastJson()).toEqual({ ok: true, revoked: true });
    });

    it('leaves the gate open while auth is not configured', () => {
      setProperty(PROPERTY_ID);
      mockFetch(200, { rows: [] });
      Code.doGet({ parameter: {} });
      expect(lastJson().ok).toBe(true);
    });
  });

  describe('doGet action=music_count', () => {
    const mockCache = () => {
      const entries = {};
      global.CacheService = {
        getScriptCache: () => ({
          get: (key) => (key in entries ? entries[key] : null),
          put: (key, value) => {
            entries[key] = value;
          },
        }),
      };
      return entries;
    };

    const mockCountFetch = (count) =>
      mockFetch(200, {
        rows: [{ metricValues: [{ value: String(count) }] }],
        rowCount: 1,
      });

    it('returns the cumulative music_play count without any token', () => {
      setProperty(PROPERTY_ID);
      mockCache();
      mockCountFetch(85);
      Code.doGet({ parameter: { action: 'music_count' } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.action).toBe('music_count');
      expect(json.count).toBe(85);
      expect(typeof json.updated_at).toBe('string');

      const [url, options] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(url).toBe(
        'https://analyticsdata.googleapis.com/v1beta/properties/' +
          PROPERTY_ID +
          ':runReport'
      );
      const body = JSON.parse(options.payload);
      expect(body.dateRanges).toEqual([{ startDate: '2026-11-08', endDate: 'today' }]);
      expect(body.metrics).toEqual([{ name: 'eventCount' }]);
      expect(body.dimensions).toEqual([]);
      expect(body.dimensionFilter).toEqual({
        filter: {
          fieldName: 'eventName',
          stringFilter: { matchType: 'EXACT', value: 'music_play', caseSensitive: false },
        },
      });
    });

    it('stays public while authentication is configured', () => {
      setProperty(PROPERTY_ID);
      store.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
      store.AVAILABLE_GMAILS = 'owner@example.com';
      mockCache();
      mockCountFetch(12);
      Code.doGet({ parameter: { action: 'music_count' } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.count).toBe(12);
      // The only network call is the GA4 report itself: no tokeninfo.
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
    });

    it('serves the second call from CacheService without refetching', () => {
      setProperty(PROPERTY_ID);
      mockCache();
      mockCountFetch(30);
      Code.doGet({ parameter: { action: 'music_count' } });
      const first = lastJson();
      Code.doGet({ parameter: { action: 'music_count' } });
      const second = lastJson();
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
      expect(second.count).toBe(30);
      expect(second.updated_at).toBe(first.updated_at);
    });

    it('reports zero when GA4 has no music_play rows yet', () => {
      setProperty(PROPERTY_ID);
      mockCache();
      mockFetch(200, { rows: [], rowCount: 0 });
      Code.doGet({ parameter: { action: 'music_count' } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.count).toBe(0);
    });

    it('returns an error when the GA4 request fails', () => {
      setProperty(PROPERTY_ID);
      mockCache();
      mockFetch(500, { error: { message: 'boom' } });
      Code.doGet({ parameter: { action: 'music_count' } });
      const json = lastJson();
      expect(json.ok).toBe(false);
      expect(json.status).toBe(502);
    });

    it('keeps other actions behind the gate', () => {
      setProperty(PROPERTY_ID);
      store.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
      store.AVAILABLE_GMAILS = 'owner@example.com';
      mockCache();
      mockCountFetch(1);
      Code.doGet({ parameter: {} });
      expect(lastJson().status).toBe(401);
    });
  });

  describe('doGet action=top_articles', () => {
    const mockCache = () => {
      const entries = {};
      global.CacheService = {
        getScriptCache: () => ({
          get: (key) => (key in entries ? entries[key] : null),
          put: (key, value) => {
            entries[key] = value;
          },
        }),
      };
      return entries;
    };

    const row = (path, views) => ({
      dimensionValues: [{ value: path }],
      metricValues: [{ value: String(views) }],
    });

    const ID_A = '1zNCqYU6xAzU3hft36Eh9oemWf6rA0yl2Hu2gPf2KI_Q';
    const ID_B = '1ORcobKE3DfRrSUV6yMUodfVQgiL1ouKaCTWKTEFUR6A';

    it('merges the split article paths and ranks by views', () => {
      setProperty(PROPERTY_ID);
      mockCache();
      mockFetch(200, {
        rows: [
          row('/blog/' + ID_A, 100),
          row('/' + ID_A, 50),
          row('/blog/' + ID_B, 120),
          row('/list-of-stuff/', 999),
          row('/', 500),
        ],
        rowCount: 5,
      });
      Code.doGet({ parameter: { action: 'top_articles' } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.action).toBe('top_articles');
      expect(json.days).toBe(28);
      expect(json.articles).toEqual([
        { id: ID_A, views: 150 },
        { id: ID_B, views: 120 },
      ]);
      expect(typeof json.updated_at).toBe('string');

      const [url, options] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(url).toBe(
        'https://analyticsdata.googleapis.com/v1beta/properties/' +
          PROPERTY_ID +
          ':runReport'
      );
      const body = JSON.parse(options.payload);
      expect(body.dateRanges).toEqual([
        { startDate: '28daysAgo', endDate: 'today' },
      ]);
      expect(body.metrics).toEqual([{ name: 'screenPageViews' }]);
      expect(body.dimensions).toEqual([{ name: 'pagePath' }]);
    });

    it('stays public while authentication is configured', () => {
      setProperty(PROPERTY_ID);
      store.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
      store.AVAILABLE_GMAILS = 'owner@example.com';
      mockCache();
      mockFetch(200, { rows: [row('/blog/' + ID_B, 7)], rowCount: 1 });
      Code.doGet({ parameter: { action: 'top_articles' } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.articles).toEqual([{ id: ID_B, views: 7 }]);
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
    });

    it('serves the second call from CacheService without refetching', () => {
      setProperty(PROPERTY_ID);
      mockCache();
      mockFetch(200, { rows: [row('/blog/' + ID_A, 30)], rowCount: 1 });
      Code.doGet({ parameter: { action: 'top_articles' } });
      const first = lastJson();
      Code.doGet({ parameter: { action: 'top_articles' } });
      const second = lastJson();
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
      expect(second.articles).toEqual(first.articles);
      expect(second.updated_at).toBe(first.updated_at);
    });

    it('returns an error when the GA4 request fails', () => {
      setProperty(PROPERTY_ID);
      mockCache();
      mockFetch(500, { error: { message: 'boom' } });
      Code.doGet({ parameter: { action: 'top_articles' } });
      const json = lastJson();
      expect(json.ok).toBe(false);
      expect(json.status).toBe(502);
    });
  });
});
