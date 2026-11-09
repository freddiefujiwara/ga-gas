import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

const EXEC_URL = 'https://script.google.com/macros/s/TESTDEPLOY/exec';
const THREADS_ID = '17841462976834295';

describe('Threads OAuth completed inside GAS', () => {
  let outputs;
  let store;
  let fetchHandler;
  let fetchCalls;
  let uuidCounter;

  const res = (status, body) => ({
    getResponseCode: () => status,
    getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

  // The threads_insights response shape for metric=followers_count:
  // the count lives in data[0].total_value.value (followers_count is
  // not a field on the Threads user node).
  const threadsInsightsBody = (value) => ({
    data: [
      {
        name: 'followers_count',
        period: 'day',
        total_value: { value },
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    store = {};
    fetchCalls = [];
    uuidCounter = 0;
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
      MimeType: { JSON: 'application/json', HTML: 'text/html' },
    };
    global.UrlFetchApp = {
      fetch: vi.fn((url, options) => {
        fetchCalls.push({ url, options });
        return fetchHandler(url, options);
      }),
    };
    global.ScriptApp = {
      getOAuthToken: vi.fn(() => 'test-token'),
      getService: vi.fn(() => ({ getUrl: () => EXEC_URL })),
      getProjectTriggers: vi.fn(() => []),
      deleteTrigger: vi.fn(),
      newTrigger: vi.fn(),
    };
    global.Utilities = {
      getUuid: vi.fn(() => 'uuid-' + ++uuidCounter + '-0000-0000-0000'),
    };
  });

  const lastOutput = () => outputs[outputs.length - 1];

  const setupApp = () => {
    store.THREADS_APP_ID = 'threads-app-id';
    store.THREADS_APP_SECRET = 'threads-app-secret';
  };

  const mockSuccessfulExchange = () => {
    fetchHandler = (url, options) => {
      if (url === 'https://graph.threads.net/oauth/access_token') {
        return res(200, { access_token: 'short-token', user_id: 123456789 });
      }
      if (url.startsWith('https://graph.threads.net/access_token')) {
        return res(200, { access_token: 'long-token', expires_in: 5184000 });
      }
      throw new Error('unexpected fetch: ' + url);
    };
  };

  describe('threadsAuthorizeUrl', () => {
    it('builds the authorize URL and saves the state', () => {
      setupApp();
      const url = Code.threadsAuthorizeUrl();
      expect(url).toContain('https://threads.net/oauth/authorize');
      expect(url).toContain('client_id=threads-app-id');
      expect(url).toContain('redirect_uri=' + encodeURIComponent(EXEC_URL));
      expect(url).toContain('scope=threads_basic,threads_manage_insights');
      expect(url).toContain('response_type=code');
      expect(store.THREADS_OAUTH_STATE).toBeTruthy();
      expect(url).toContain('state=' + encodeURIComponent(store.THREADS_OAUTH_STATE));
    });

    it('prefers THREADS_REDIRECT_URI over the service URL', () => {
      setupApp();
      store.THREADS_REDIRECT_URI = 'https://example.com/callback';
      const url = Code.threadsAuthorizeUrl();
      expect(url).toContain('redirect_uri=' + encodeURIComponent('https://example.com/callback'));
    });

    it('returns an empty string without THREADS_APP_ID', () => {
      expect(Code.threadsAuthorizeUrl()).toBe('');
      expect(store.THREADS_OAUTH_STATE).toBeUndefined();
    });
  });

  describe('doGet Threads OAuth callback', () => {
    it('exchanges the code, upgrades to a long-lived token and stores it', () => {
      setupApp();
      store.THREADS_OAUTH_STATE = 'expected-state';
      mockSuccessfulExchange();
      Code.doGet({ parameter: { code: 'auth-code', state: 'expected-state' } });
      const post = fetchCalls.find(
        (c) => c.url === 'https://graph.threads.net/oauth/access_token'
      );
      expect(post.options.method).toBe('post');
      expect(post.options.payload).toMatchObject({
        client_id: 'threads-app-id',
        client_secret: 'threads-app-secret',
        grant_type: 'authorization_code',
        redirect_uri: EXEC_URL,
        code: 'auth-code',
      });
      const exchange = fetchCalls.find((c) =>
        c.url.startsWith('https://graph.threads.net/access_token')
      );
      expect(exchange.url).toContain('grant_type=th_exchange_token');
      expect(exchange.url).toContain('access_token=short-token');
      expect(store.META_THREADS_ACCESS_TOKEN).toBe('long-token');
      expect(store.THREADS_USER_ID).toBe('123456789');
      expect(Date.parse(store.THREADS_TOKEN_AT)).toBeGreaterThan(Date.now() - 60000);
      expect(Date.parse(store.META_THREADS_TOKEN_EXPIRES_AT)).toBeGreaterThan(Date.now());
      expect(store.THREADS_OAUTH_STATE).toBeUndefined();
      expect(lastOutput().mimeType).toBe('text/html');
      expect(lastOutput().text).toContain('認可が完了');
    });

    it('ignores a code whose state does not match, without any token call', () => {
      setupApp();
      store.THREADS_OAUTH_STATE = 'expected-state';
      Code.doGet({ parameter: { code: 'auth-code', state: 'wrong-state' } });
      expect(fetchCalls).toHaveLength(0);
      expect(store.META_THREADS_ACCESS_TOKEN).toBeUndefined();
      expect(lastOutput().mimeType).toBe('text/html');
      expect(lastOutput().text).toContain('確認できませんでした');
    });

    it('never falls through to an action when the state does not match', () => {
      setupApp();
      store.THREADS_OAUTH_STATE = 'expected-state';
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify({ collected_at: 'x', threads: { followers: 1 } });
      Code.doGet({
        parameter: { code: 'auth-code', state: 'wrong-state', action: 'sns_counts' },
      });
      expect(lastOutput().mimeType).toBe('text/html');
    });

    it('reports failure and stores nothing when the code exchange fails', () => {
      setupApp();
      store.THREADS_OAUTH_STATE = 'expected-state';
      fetchHandler = () => res(400, { error: { message: 'bad code', code: 100 } });
      Code.doGet({ parameter: { code: 'bad-code', state: 'expected-state' } });
      expect(store.META_THREADS_ACCESS_TOKEN).toBeUndefined();
      expect(store.THREADS_TOKEN_AT).toBeUndefined();
      expect(lastOutput().text).toContain('認可に失敗');
    });
  });

  describe('refreshThreadsTokenIfNeeded (age based)', () => {
    it('does nothing without a token or without THREADS_TOKEN_AT', () => {
      expect(Code.refreshThreadsTokenIfNeeded()).toBeNull();
      store.META_THREADS_ACCESS_TOKEN = 'some-token';
      expect(Code.refreshThreadsTokenIfNeeded()).toBeNull();
      expect(fetchCalls).toHaveLength(0);
    });

    it('does nothing while the token is younger than 50 days', () => {
      store.META_THREADS_ACCESS_TOKEN = 'some-token';
      store.THREADS_TOKEN_AT = daysAgo(49);
      expect(Code.refreshThreadsTokenIfNeeded()).toBeNull();
      expect(fetchCalls).toHaveLength(0);
      expect(store.META_THREADS_ACCESS_TOKEN).toBe('some-token');
    });

    it('refreshes a token that is 50+ days old and restamps it', () => {
      store.META_THREADS_ACCESS_TOKEN = 'old-token';
      store.THREADS_TOKEN_AT = daysAgo(51);
      fetchHandler = (url) => {
        expect(url).toContain('https://graph.threads.net/refresh_access_token');
        expect(url).toContain('grant_type=th_refresh_token');
        expect(url).toContain('access_token=old-token');
        return res(200, { access_token: 'renewed-token', expires_in: 5184000 });
      };
      expect(Code.refreshThreadsTokenIfNeeded()).toBeNull();
      expect(store.META_THREADS_ACCESS_TOKEN).toBe('renewed-token');
      expect(Date.parse(store.THREADS_TOKEN_AT)).toBeGreaterThan(Date.now() - 60000);
      expect(Date.parse(store.META_THREADS_TOKEN_EXPIRES_AT)).toBeGreaterThan(Date.now());
    });

    it('returns an error summary and keeps the token when the refresh fails', () => {
      store.META_THREADS_ACCESS_TOKEN = 'old-token';
      store.THREADS_TOKEN_AT = daysAgo(60);
      fetchHandler = () => res(400, { error: { message: 'token expired', code: 190 } });
      const error = Code.refreshThreadsTokenIfNeeded();
      expect(error).toContain('refresh:');
      expect(error).toContain('token expired');
      expect(store.META_THREADS_ACCESS_TOKEN).toBe('old-token');
    });
  });

  describe('fetchThreadsFollowers_ THREADS_USER_ID', () => {
    it('uses THREADS_USER_ID when set and falls back to the constant', () => {
      store.META_THREADS_ACCESS_TOKEN = 'threads-token';
      const seenUrls = [];
      fetchHandler = (url) => {
        seenUrls.push(url);
        return res(200, threadsInsightsBody(252));
      };
      expect(Code.fetchThreadsFollowers_()).toBe(252);
      expect(seenUrls[0]).toContain('/' + THREADS_ID + '/threads_insights');
      expect(seenUrls[0]).toContain('metric=followers_count');
      store.THREADS_USER_ID = '999888777';
      expect(Code.fetchThreadsFollowers_()).toBe(252);
      expect(seenUrls[1]).toContain('/999888777/threads_insights');
    });
  });

  describe('fetchThreadsFollowers_ insights parsing', () => {
    beforeEach(() => {
      store.META_THREADS_ACCESS_TOKEN = 'threads-token';
    });

    it('reads total_value.value out of the insights response', () => {
      fetchHandler = () => res(200, threadsInsightsBody(252));
      expect(Code.fetchThreadsFollowers_()).toBe(252);
    });

    it('reads the newest values entry when there is no total_value', () => {
      fetchHandler = () =>
        res(200, {
          data: [
            {
              name: 'followers_count',
              period: 'day',
              values: [
                { value: 240, end_time: '2026-11-07T07:00:00+0000' },
                { value: 252, end_time: '2026-11-08T07:00:00+0000' },
              ],
            },
          ],
        });
      // The newest entry wins; the values are a current total per
      // day, not a flow to sum (240 + 252 would be wrong).
      expect(Code.fetchThreadsFollowers_()).toBe(252);
    });

    it('returns null on an HTTP error with a THApiException body', () => {
      fetchHandler = () =>
        res(500, {
          error: {
            message: 'Tried accessing nonexisting field (followers_count)',
            type: 'THApiException',
            code: 100,
          },
        });
      expect(Code.fetchThreadsFollowers_()).toBeNull();
    });

    it('parseThreadsFollowersCount_ prefers total_value over values', () => {
      expect(
        Code.parseThreadsFollowersCount_({
          data: [
            {
              name: 'followers_count',
              total_value: { value: 300 },
              values: [{ value: 252 }],
            },
          ],
        })
      ).toBe(300);
    });

    it('parseThreadsFollowersCount_ returns null for error bodies and junk', () => {
      expect(
        Code.parseThreadsFollowersCount_({
          error: { message: 'boom', type: 'THApiException', code: 100 },
        })
      ).toBeNull();
      expect(Code.parseThreadsFollowersCount_({ data: [] })).toBeNull();
      expect(Code.parseThreadsFollowersCount_(null)).toBeNull();
      expect(Code.parseThreadsFollowersCount_('nope')).toBeNull();
    });
  });

  describe('collectSnsCounts with a failing Threads refresh', () => {
    it('still completes and surfaces the failure as threads_error', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      store.META_THREADS_ACCESS_TOKEN = 'old-threads-token';
      store.THREADS_TOKEN_AT = daysAgo(60);
      fetchHandler = (url) => {
        if (url.includes('graph.threads.net/refresh_access_token')) {
          return res(400, { error: { message: 'expired', code: 190 } });
        }
        if (url.includes('graph.threads.net')) {
          return res(200, threadsInsightsBody(252));
        }
        if (url.includes('graph.facebook.com')) {
          return res(200, { followers_count: 100, media_count: 10 });
        }
        throw new Error('unexpected fetch: ' + url);
      };
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.threads.followers).toBe(252);
      expect(snapshot.threads.threads_error).toContain('expired');
    });
  });

  describe('debugThreadsFollowers', () => {
    let logs;

    beforeEach(() => {
      logs = [];
      global.Logger = {
        log: vi.fn((...args) => logs.push(args.join(' '))),
      };
    });

    const allLogs = () => logs.join('\n');

    it('logs that no token is set and does not fetch', () => {
      Code.debugThreadsFollowers();
      expect(allLogs()).toContain('META_THREADS_ACCESS_TOKEN is not set.');
      expect(allLogs()).toContain('META_ACCESS_TOKEN is not set either');
      expect(fetchCalls).toHaveLength(0);
    });

    it('logs the property user id, the status and the body without leaking the token', () => {
      store.META_THREADS_ACCESS_TOKEN = 'threads-secret-token';
      store.THREADS_USER_ID = 'threads-user-42';
      fetchHandler = (url) => {
        if (url.includes('graph.threads.net')) {
          return res(200, threadsInsightsBody(252));
        }
        throw new Error('unexpected fetch: ' + url);
      };
      Code.debugThreadsFollowers();
      expect(allLogs()).toContain('META_THREADS_ACCESS_TOKEN is set.');
      expect(allLogs()).toContain(
        'Threads user id: threads-user-42 (from THREADS_USER_ID)'
      );
      expect(allLogs()).toContain('HTTP 200');
      expect(allLogs()).toContain('"total_value":{"value":252}');
      expect(allLogs()).toContain('parsed followers_count: 252');
      expect(allLogs()).not.toContain('threads-secret-token');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(
        'https://graph.threads.net/v1.0/threads-user-42/threads_insights?metric=followers_count&access_token=threads-secret-token'
      );
    });

    it('logs the fallback user id and an error body', () => {
      store.META_THREADS_ACCESS_TOKEN = 'threads-secret-token';
      fetchHandler = (url) => {
        if (url.includes('graph.threads.net')) {
          return res(400, {
            error: { message: 'Invalid OAuth access token.', code: 190 },
          });
        }
        throw new Error('unexpected fetch: ' + url);
      };
      Code.debugThreadsFollowers();
      expect(allLogs()).toContain(
        'Threads user id: ' +
          THREADS_ID +
          ' (THREADS_USER_ID is not set; using the SNS_THREADS_USER_ID fallback)'
      );
      expect(allLogs()).toContain('HTTP 400');
      expect(allLogs()).toContain('Invalid OAuth access token.');
      expect(allLogs()).not.toContain('threads-secret-token');
    });
  });

  describe('debugThreadsPosts', () => {
    let logs;

    beforeEach(() => {
      logs = [];
      global.Logger = {
        log: vi.fn((...args) => logs.push(args.join(' '))),
      };
    });

    const allLogs = () => logs.join('\n');

    const mockDebugThreadsSuccess = () => {
      fetchHandler = (url) => {
        if (url.includes('/threads_insights')) {
          return res(200, {
            data: [
              { name: 'views', period: 'day', values: [{ value: 10 }, { value: 5 }] },
              { name: 'likes', period: 'day', total_value: { value: 33 } },
              { name: 'replies', period: 'day', values: [{ value: 7 }] },
              { name: 'reposts', period: 'day', total_value: { value: 2 } },
              { name: 'quotes', period: 'day', values: [{ value: 1 }] },
            ],
          });
        }
        if (url.includes('/threads?')) {
          return res(200, {
            data: [
              {
                id: 'th-1',
                text: 'テスト投稿',
                timestamp: '2026-11-09T00:00:00+0000',
                permalink: 'https://www.threads.net/@freddiefujiwara/post/XXX',
                media_type: 'TEXT_POST',
              },
            ],
          });
        }
        if (url.includes('th-1/insights')) {
          return res(200, {
            data: [
              { name: 'views', values: [{ value: 500 }] },
              { name: 'likes', values: [{ value: 20 }] },
              { name: 'replies', values: [{ value: 4 }] },
              { name: 'reposts', values: [{ value: 2 }] },
              { name: 'quotes', values: [{ value: 1 }] },
            ],
          });
        }
        throw new Error('unexpected fetch: ' + url);
      };
    };

    it('logs that no token is set and does not fetch', () => {
      Code.debugThreadsPosts();
      expect(allLogs()).toContain('META_THREADS_ACCESS_TOKEN is not set.');
      expect(allLogs()).toContain('META_ACCESS_TOKEN is not set either');
      expect(fetchCalls).toHaveLength(0);
    });

    it('logs all three stages with parsed values and no token', () => {
      store.META_THREADS_ACCESS_TOKEN = 'threads-secret-token';
      store.THREADS_USER_ID = 'threads-user-42';
      mockDebugThreadsSuccess();
      Code.debugThreadsPosts();
      expect(allLogs()).toContain('Threads user id: threads-user-42 (from THREADS_USER_ID)');
      expect(allLogs()).toContain(
        'parsed account totals: {"views":15,"likes":33,"replies":7,"reposts":2,"quotes":1}'
      );
      expect(allLogs()).toContain('"id":"th-1"');
      expect(allLogs()).toContain(
        'parsed media insights: {"views":500,"likes":20,"replies":4,"reposts":2,"quotes":1}'
      );
      expect(allLogs()).not.toContain('threads-secret-token');
      expect(fetchCalls).toHaveLength(3);
      expect(fetchCalls[0].url).toContain(
        '/threads_insights?metric=views,likes,replies,reposts,quotes'
      );
      expect(fetchCalls[0].url).toContain('access_token=threads-secret-token');
      expect(fetchCalls[1].url).toContain('/threads?fields=id,text,timestamp,permalink,media_type&limit=3');
      expect(fetchCalls[2].url).toContain(
        '/th-1/insights?metric=views,likes,replies,reposts,quotes'
      );
    });

    it('logs a refused account request and an empty list without throwing', () => {
      store.META_THREADS_ACCESS_TOKEN = 'threads-secret-token';
      fetchHandler = (url) => {
        if (url.includes('/threads_insights')) {
          return res(403, {
            error: {
              message: 'Application does not have permission for this action',
              code: 10,
            },
          });
        }
        if (url.includes('/threads?')) {
          return res(200, { data: [] });
        }
        throw new Error('unexpected fetch: ' + url);
      };
      Code.debugThreadsPosts();
      expect(allLogs()).toContain('HTTP 403');
      expect(allLogs()).toContain(
        'Application does not have permission for this action'
      );
      expect(allLogs()).not.toContain('parsed account totals');
      expect(allLogs()).toContain(
        'no posts in the list response; skipping media insights.'
      );
      expect(allLogs()).not.toContain('threads-secret-token');
      expect(fetchCalls).toHaveLength(2);
    });

    it('survives a fetch exception in the media insights stage', () => {
      store.META_THREADS_ACCESS_TOKEN = 'threads-secret-token';
      mockDebugThreadsSuccess();
      const inner = fetchHandler;
      fetchHandler = (url) => {
        if (url.includes('th-1/insights')) {
          throw new Error('network down');
        }
        return inner(url);
      };
      Code.debugThreadsPosts();
      expect(allLogs()).toContain('fetch exception (Error)');
      expect(allLogs()).toContain('"id":"th-1"');
      expect(allLogs()).not.toContain('parsed media insights');
    });
  });
});
