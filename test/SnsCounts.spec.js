import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

const MAIN_IG_ID = '17841401041540002';
const SUB_IG_ID = '17841434285478967';
const THREADS_ID = '17841462976834295';
const CHANNEL_ID = 'UCbiDZXbr391oT_vsRiqwPFg';

describe('SNS follower counts', () => {
  let outputs;
  let store;
  let fetchHandler;
  let triggers;
  let createdTriggers;

  const res = (status, body) => ({
    getResponseCode: () => status,
    getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    store = {};
    triggers = [];
    createdTriggers = [];
    fetchHandler = () => {
      throw new Error('unexpected fetch');
    };
    delete global.YouTube;

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
    global.UrlFetchApp = { fetch: vi.fn((url) => fetchHandler(url)) };
    global.ScriptApp = {
      getOAuthToken: vi.fn(() => 'test-token'),
      getProjectTriggers: vi.fn(() => triggers),
      deleteTrigger: vi.fn((trigger) => {
        triggers = triggers.filter((t) => t !== trigger);
      }),
      newTrigger: vi.fn((handler) => ({
        timeBased: () => ({
          everyHours: (hours) => ({
            create: () => {
              createdTriggers.push({ handler, hours });
            },
          }),
        }),
      })),
    };
  });

  const lastJson = () => JSON.parse(outputs[outputs.length - 1].text);

  const mockYouTube = (result) => {
    global.YouTube = { Channels: { list: vi.fn(() => result) } };
  };

  const insightsBreakdownBody = (follower, nonFollower, total) => ({
    data: [
      {
        name: 'views',
        period: 'day',
        total_value: {
          value: total,
          breakdowns: [
            {
              dimension_keys: ['follow_type'],
              results: [
                { dimension_values: ['FOLLOWER'], value: follower },
                { dimension_values: ['NON_FOLLOWER'], value: nonFollower },
              ],
            },
          ],
        },
      },
    ],
  });

  const mockGraphSuccess = () => {
    fetchHandler = (url) => {
      if (url.includes('/insights') && url.includes('breakdown=follow_type')) {
        return res(200, insightsBreakdownBody(370, 9630, 10000));
      }
      if (url.includes('graph.facebook.com') && url.includes('fields=media_count')) {
        return res(200, { media_count: 2404 });
      }
      if (url.includes('graph.facebook.com') && url.includes(MAIN_IG_ID)) {
        return res(200, { followers_count: 1988 });
      }
      if (url.includes('graph.facebook.com') && url.includes(SUB_IG_ID)) {
        return res(200, { followers_count: 59 });
      }
      if (url.includes('graph.threads.net') && url.includes(THREADS_ID)) {
        return res(200, { followers_count: 252 });
      }
      throw new Error('unexpected url: ' + url);
    };
  };

  describe('doGet action=sns_counts', () => {
    it('returns nulls before the first collection, even without GA4_PROPERTY_ID', () => {
      Code.doGet({ parameter: { action: 'sns_counts' } });
      expect(lastJson()).toEqual({
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
      });
    });

    it('returns the stored snapshot', () => {
      const snapshot = {
        collected_at: '2026-11-08T12:00:00.000Z',
        youtube: { subscribers: 8 },
        instagram: { freddiefujiwara: 1988, anemone_cancer: 59 },
        threads: { followers: 252 },
      };
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(snapshot);
      Code.doGet({ parameter: { action: 'sns_counts' } });
      expect(lastJson()).toEqual(Object.assign({ ok: true, action: 'sns_counts' }, snapshot));
    });

    it('does not require authentication', () => {
      store.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
      store.AVAILABLE_GMAILS = 'owner@example.com';
      Code.doGet({ parameter: { action: 'sns_counts' } });
      expect(lastJson().ok).toBe(true);
    });

    it('survives a corrupt stored snapshot', () => {
      store.SNS_COUNTS_SNAPSHOT = '{broken json';
      Code.doGet({ parameter: { action: 'sns_counts' } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.collected_at).toBeNull();
    });
  });

  describe('collectSnsCounts', () => {
    it('collects all services and stores the snapshot', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      mockGraphSuccess();
      mockYouTube({ items: [{ statistics: { subscriberCount: '8' } }] });

      const snapshot = Code.collectSnsCounts();
      expect(snapshot.youtube.subscribers).toBe(8);
      expect(snapshot.instagram).toEqual({
        freddiefujiwara: 1988,
        anemone_cancer: 59,
        media_count: 2404,
        views_30d: 10000,
        non_follower_pct: 96.3,
        insights_error: null,
      });
      expect(snapshot.threads.followers).toBe(252);
      expect(snapshot.collected_at).toBeTruthy();
      expect(JSON.parse(store.SNS_COUNTS_SNAPSHOT)).toEqual(snapshot);
      expect(global.YouTube.Channels.list).toHaveBeenCalledWith('statistics', {
        id: CHANNEL_ID,
      });
    });

    it('leaves Meta services null when the token is not set', () => {
      mockYouTube({ items: [{ statistics: { subscriberCount: '8' } }] });
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.youtube.subscribers).toBe(8);
      expect(snapshot.instagram).toEqual({
        freddiefujiwara: null,
        anemone_cancer: null,
        media_count: null,
        views_30d: null,
        non_follower_pct: null,
        insights_error: null,
      });
      expect(snapshot.threads.followers).toBeNull();
      expect(store.SNS_COUNTS_SNAPSHOT).toBeTruthy();
    });

    it('leaves failed services null and keeps the others', () => {
      store.META_ACCESS_TOKEN = 'expired-token';
      fetchHandler = () => res(400, { error: { message: 'Invalid OAuth access token' } });
      mockYouTube({ items: [{ statistics: { subscriberCount: '8' } }] });
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.youtube.subscribers).toBe(8);
      expect(snapshot.instagram.freddiefujiwara).toBeNull();
      expect(snapshot.threads.followers).toBeNull();
    });

    it('collects Meta counts when the YouTube service is unavailable', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      mockGraphSuccess();
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.youtube.subscribers).toBeNull();
      expect(snapshot.instagram.freddiefujiwara).toBe(1988);
      expect(snapshot.threads.followers).toBe(252);
    });

    it('returns null subscribers for hidden counts and empty channels', () => {
      mockYouTube({ items: [{ statistics: { hiddenSubscriberCount: true } }] });
      expect(Code.fetchYouTubeSubscribers_()).toBeNull();
      mockYouTube({ items: [] });
      expect(Code.fetchYouTubeSubscribers_()).toBeNull();
      mockYouTube({ items: [{ statistics: { subscriberCount: '12' } }] });
      expect(Code.fetchYouTubeSubscribers_()).toBe(12);
    });

    it('survives fetch throwing', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      fetchHandler = () => {
        throw new Error('network down');
      };
      mockYouTube({ items: [{ statistics: { subscriberCount: '8' } }] });
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.instagram.freddiefujiwara).toBeNull();
      expect(snapshot.youtube.subscribers).toBe(8);
    });

    it('prefers the dedicated Threads token when one is set', () => {
      store.META_ACCESS_TOKEN = 'facebook-token';
      store.META_THREADS_ACCESS_TOKEN = 'threads-token';
      let threadsUrl = '';
      fetchHandler = (url) => {
        if (url.includes('graph.threads.net')) {
          threadsUrl = url;
          return res(200, { followers_count: 252 });
        }
        return res(200, { followers_count: 1 });
      };
      mockYouTube({ items: [] });
      Code.collectSnsCounts();
      expect(threadsUrl).toContain('access_token=threads-token');
    });
  });

  describe('Instagram KPIs', () => {
    const graphWithInsights = (insightsHandler) => {
      fetchHandler = (url) => {
        if (url.includes('/insights')) {
          return insightsHandler(url);
        }
        if (url.includes('fields=media_count')) {
          return res(200, { media_count: 2404 });
        }
        if (url.includes('graph.facebook.com')) {
          return res(200, { followers_count: 1988 });
        }
        if (url.includes('graph.threads.net')) {
          return res(200, { followers_count: 252 });
        }
        throw new Error('unexpected url: ' + url);
      };
    };

    it('keeps views KPIs null when insights permission is missing', () => {
      store.META_ACCESS_TOKEN = 'basic-only-token';
      graphWithInsights(() =>
        res(400, {
          error: {
            message: '(#10) Application does not have permission for this action',
            code: 10,
          },
        })
      );
      mockYouTube({ items: [{ statistics: { subscriberCount: '8' } }] });
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.instagram.freddiefujiwara).toBe(1988);
      expect(snapshot.instagram.media_count).toBe(2404);
      expect(snapshot.instagram.views_30d).toBeNull();
      expect(snapshot.instagram.non_follower_pct).toBeNull();
      expect(snapshot.youtube.subscribers).toBe(8);
      expect(snapshot.threads.followers).toBe(252);
    });

    it('records the API error summary in insights_error and logs it', () => {
      store.META_ACCESS_TOKEN = 'basic-only-token';
      graphWithInsights(() =>
        res(400, {
          error: {
            message: '(#10) Application does not have permission for this action',
            code: 10,
            error_subcode: 1234567,
          },
        })
      );
      mockYouTube({ items: [{ statistics: { subscriberCount: '8' } }] });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const snapshot = Code.collectSnsCounts();
        expect(snapshot.instagram.views_30d).toBeNull();
        expect(snapshot.instagram.non_follower_pct).toBeNull();
        expect(snapshot.instagram.insights_error).toContain('HTTP 400');
        expect(snapshot.instagram.insights_error).toContain('code=10');
        expect(snapshot.instagram.insights_error).toContain('subcode=1234567');
        expect(snapshot.instagram.insights_error).toContain(
          'Application does not have permission'
        );
        // The token must never leak into the summary or the log.
        expect(snapshot.instagram.insights_error).not.toContain('basic-only-token');
        const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(logged).toContain('Instagram insights error:');
        expect(logged).toContain('HTTP 400');
        expect(logged).not.toContain('access_token=');
        expect(JSON.parse(store.SNS_COUNTS_SNAPSHOT).instagram.insights_error).toBe(
          snapshot.instagram.insights_error
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('records both errors when the breakdown and daily requests fail differently', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      graphWithInsights((url) => {
        if (url.includes('breakdown=follow_type')) {
          return res(400, { error: { message: 'breakdown unsupported', code: 100 } });
        }
        return res(500, { error: { message: 'internal boom', code: 1 } });
      });
      mockYouTube({ items: [] });
      const kpi = Code.fetchInstagramViewsInsights_();
      expect(kpi.views_30d).toBeNull();
      expect(kpi.non_follower_pct).toBeNull();
      expect(kpi.insights_error).toContain('breakdown: HTTP 400 code=100');
      expect(kpi.insights_error).toContain('breakdown unsupported');
      expect(kpi.insights_error).toContain('daily: HTTP 500 code=1');
      expect(kpi.insights_error).toContain('internal boom');
    });

    it('records a fetch exception without leaking the request URL', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      graphWithInsights(() => {
        throw new Error(
          'Request failed for https://graph.facebook.com/v25.0/x?access_token=meta-token'
        );
      });
      mockYouTube({ items: [] });
      const kpi = Code.fetchInstagramViewsInsights_();
      expect(kpi.views_30d).toBeNull();
      expect(kpi.non_follower_pct).toBeNull();
      expect(kpi.insights_error).toContain('fetch exception');
      expect(kpi.insights_error).not.toContain('access_token');
      expect(kpi.insights_error).not.toContain('meta-token');
    });

    it('falls back to summed daily values when the breakdown is unavailable', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      graphWithInsights((url) => {
        if (url.includes('breakdown=follow_type')) {
          return res(400, { error: { message: 'breakdown unsupported' } });
        }
        return res(200, {
          data: [
            {
              name: 'views',
              period: 'day',
              values: [{ value: 100 }, { value: 250 }, { value: 50 }],
            },
          ],
        });
      });
      mockYouTube({ items: [] });
      const kpi = Code.fetchInstagramViewsInsights_();
      expect(kpi.views_30d).toBe(400);
      expect(kpi.non_follower_pct).toBeNull();
      expect(kpi.insights_error).toContain('used daily totals fallback');
      expect(kpi.insights_error).toContain('breakdown unsupported');
    });

    it('notes the fallback even when the breakdown response is just unusable', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      graphWithInsights((url) => {
        if (url.includes('breakdown=follow_type')) {
          return res(200, { data: [{ name: 'views', period: 'day' }] });
        }
        return res(200, {
          data: [
            {
              name: 'views',
              period: 'day',
              values: [{ value: 10 }, { value: 20 }],
            },
          ],
        });
      });
      mockYouTube({ items: [] });
      const kpi = Code.fetchInstagramViewsInsights_();
      expect(kpi.views_30d).toBe(30);
      expect(kpi.non_follower_pct).toBeNull();
      expect(kpi.insights_error).toBe(
        'follow_type breakdown unavailable; used daily totals fallback'
      );
    });

    it('requests breakdown=follow_type and metric_type=total_value on the daily fallback', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      const insightsUrls = [];
      graphWithInsights((url) => {
        insightsUrls.push(url);
        if (url.includes('breakdown=')) {
          return res(400, { error: { message: 'breakdown unsupported', code: 100 } });
        }
        return res(200, {
          data: [{ name: 'views', period: 'day', total_value: { value: 777 } }],
        });
      });
      mockYouTube({ items: [] });
      const kpi = Code.fetchInstagramViewsInsights_();
      expect(insightsUrls).toHaveLength(2);
      expect(insightsUrls[0]).toContain('breakdown=follow_type');
      expect(insightsUrls[1]).not.toContain('breakdown=');
      expect(insightsUrls[1]).toContain('metric_type=total_value');
      // The daily fallback also accepts the total_value response shape.
      expect(kpi.views_30d).toBe(777);
      expect(kpi.non_follower_pct).toBeNull();
      expect(kpi.insights_error).toContain('used daily totals fallback');
    });

    it('parseViewsDailyTotal_ reads the total_value and values[] forms', () => {
      expect(
        Code.parseViewsDailyTotal_({ data: [{ total_value: { value: 42 } }] })
      ).toBe(42);
      expect(
        Code.parseViewsDailyTotal_({
          data: [{ values: [{ value: 1 }, { value: 2 }] }],
        })
      ).toBe(3);
      expect(Code.parseViewsDailyTotal_({ data: [{ name: 'views' }] })).toBeNull();
      expect(Code.parseViewsDailyTotal_(null)).toBeNull();
    });

    it('keeps media_count null when only that request fails', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      fetchHandler = (url) => {
        if (url.includes('fields=media_count')) {
          return res(500, { error: { message: 'boom' } });
        }
        if (url.includes('/insights') && url.includes('breakdown=follow_type')) {
          return res(200, insightsBreakdownBody(370, 9630, 10000));
        }
        if (url.includes('graph.facebook.com')) {
          return res(200, { followers_count: 1988 });
        }
        if (url.includes('graph.threads.net')) {
          return res(200, { followers_count: 252 });
        }
        throw new Error('unexpected url: ' + url);
      };
      mockYouTube({ items: [] });
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.instagram.media_count).toBeNull();
      expect(snapshot.instagram.freddiefujiwara).toBe(1988);
      expect(snapshot.instagram.views_30d).toBe(10000);
      expect(snapshot.instagram.non_follower_pct).toBe(96.3);
    });

    it('rounds the non-follower percentage to one decimal', () => {
      expect(
        Code.parseViewsBreakdown_(insightsBreakdownBody(1, 2, 3))
      ).toEqual({ total: 3, follower: 1, nonFollower: 2 });
      store.META_ACCESS_TOKEN = 'meta-token';
      graphWithInsights(() => res(200, insightsBreakdownBody(1, 2, 3)));
      const kpi = Code.fetchInstagramViewsInsights_();
      expect(kpi.views_30d).toBe(3);
      expect(kpi.non_follower_pct).toBe(66.7);
    });

    it('returns null KPIs without a token and never calls the API', () => {
      expect(Code.fetchInstagramMediaCount_()).toBeNull();
      expect(Code.fetchInstagramViewsInsights_()).toEqual({
        views_30d: null,
        non_follower_pct: null,
        insights_error: null,
      });
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('summarizeInsightsError_ formats status, code, subcode and message', () => {
      expect(
        Code.summarizeInsightsError_(
          400,
          JSON.stringify({
            error: { message: 'oops', code: 10, error_subcode: 42 },
          })
        )
      ).toBe('HTTP 400 code=10 subcode=42: oops');
      expect(Code.summarizeInsightsError_(500, 'not json')).toBe('HTTP 500');
      expect(
        Code.summarizeInsightsError_(403, JSON.stringify({ error: {} }))
      ).toBe('HTTP 403');
    });
  });

  describe('token refresh', () => {
    const daysFromNow = (days) =>
      new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    it('isTokenRefreshDue_ handles missing, invalid and future expiries', () => {
      expect(Code.isTokenRefreshDue_(null)).toBe(true);
      expect(Code.isTokenRefreshDue_('not-a-date')).toBe(true);
      expect(Code.isTokenRefreshDue_(daysFromNow(30))).toBe(false);
      expect(Code.isTokenRefreshDue_(daysFromNow(5))).toBe(true);
    });

    it('does nothing without app credentials', () => {
      store.META_ACCESS_TOKEN = 'token';
      expect(Code.refreshMetaTokenIfNeeded_()).toBe(false);
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('skips the exchange while the token is still fresh', () => {
      store.META_APP_ID = 'app-id';
      store.META_APP_SECRET = 'app-secret';
      store.META_ACCESS_TOKEN = 'token';
      store.META_TOKEN_EXPIRES_AT = daysFromNow(30);
      expect(Code.refreshMetaTokenIfNeeded_()).toBe(false);
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('exchanges a token that is close to expiry and stores the new expiry', () => {
      store.META_APP_ID = 'app-id';
      store.META_APP_SECRET = 'app-secret';
      store.META_ACCESS_TOKEN = 'old-token';
      store.META_TOKEN_EXPIRES_AT = daysFromNow(5);
      let exchangeUrl = '';
      fetchHandler = (url) => {
        exchangeUrl = url;
        return res(200, { access_token: 'new-token', expires_in: 5184000 });
      };
      expect(Code.refreshMetaTokenIfNeeded_()).toBe(true);
      expect(exchangeUrl).toContain('grant_type=fb_exchange_token');
      expect(exchangeUrl).toContain('fb_exchange_token=old-token');
      expect(store.META_ACCESS_TOKEN).toBe('new-token');
      const recorded = Date.parse(store.META_TOKEN_EXPIRES_AT);
      expect(recorded).toBeGreaterThan(Date.now() + 50 * 24 * 60 * 60 * 1000);
    });

    it('refreshes when no expiry is recorded yet', () => {
      store.META_APP_ID = 'app-id';
      store.META_APP_SECRET = 'app-secret';
      store.META_ACCESS_TOKEN = 'old-token';
      fetchHandler = () => res(200, { access_token: 'new-token', expires_in: 5184000 });
      expect(Code.refreshMetaTokenIfNeeded_()).toBe(true);
      expect(store.META_ACCESS_TOKEN).toBe('new-token');
    });

    it('keeps the old token when the exchange fails', () => {
      store.META_APP_ID = 'app-id';
      store.META_APP_SECRET = 'wrong-secret';
      store.META_ACCESS_TOKEN = 'old-token';
      store.META_TOKEN_EXPIRES_AT = daysFromNow(5);
      fetchHandler = () => res(400, { error: { message: 'bad secret' } });
      expect(Code.refreshMetaTokenIfNeeded_()).toBe(false);
      expect(store.META_ACCESS_TOKEN).toBe('old-token');
    });

    it('refreshes the Threads token with th_refresh_token', () => {
      store.META_THREADS_ACCESS_TOKEN = 'old-threads-token';
      store.META_THREADS_TOKEN_EXPIRES_AT = daysFromNow(3);
      let refreshUrl = '';
      fetchHandler = (url) => {
        refreshUrl = url;
        return res(200, { access_token: 'new-threads-token', expires_in: 5184000 });
      };
      expect(Code.refreshThreadsTokenIfNeeded_()).toBe(true);
      expect(refreshUrl).toContain('graph.threads.net/refresh_access_token');
      expect(refreshUrl).toContain('grant_type=th_refresh_token');
      expect(store.META_THREADS_ACCESS_TOKEN).toBe('new-threads-token');
    });

    it('does nothing without a Threads token and keeps it on failure', () => {
      expect(Code.refreshThreadsTokenIfNeeded_()).toBe(false);
      store.META_THREADS_ACCESS_TOKEN = 'old-threads-token';
      store.META_THREADS_TOKEN_EXPIRES_AT = daysFromNow(3);
      fetchHandler = () => res(400, { error: { message: 'expired' } });
      expect(Code.refreshThreadsTokenIfNeeded_()).toBe(false);
      expect(store.META_THREADS_ACCESS_TOKEN).toBe('old-threads-token');
    });
  });

  describe('setupSnsTriggers', () => {
    it('replaces existing collectSnsCounts triggers with one 6-hour trigger', () => {
      const mine = { getHandlerFunction: () => 'collectSnsCounts' };
      const other = { getHandlerFunction: () => 'somethingElse' };
      triggers = [mine, other];
      Code.setupSnsTriggers();
      expect(global.ScriptApp.deleteTrigger).toHaveBeenCalledTimes(1);
      expect(global.ScriptApp.deleteTrigger).toHaveBeenCalledWith(mine);
      expect(createdTriggers).toEqual([{ handler: 'collectSnsCounts', hours: 6 }]);
    });
  });
});
