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

  const mockGraphSuccess = () => {
    fetchHandler = (url) => {
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
        instagram: { freddiefujiwara: null, anemone_cancer: null },
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
      expect(snapshot.instagram).toEqual({ freddiefujiwara: 1988, anemone_cancer: 59 });
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
      expect(snapshot.instagram).toEqual({ freddiefujiwara: null, anemone_cancer: null });
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
