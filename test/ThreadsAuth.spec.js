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
      expect(url).toContain('scope=threads_basic');
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
        return res(200, { followers_count: 252 });
      };
      expect(Code.fetchThreadsFollowers_()).toBe(252);
      expect(seenUrls[0]).toContain('/' + THREADS_ID + '?');
      store.THREADS_USER_ID = '999888777';
      expect(Code.fetchThreadsFollowers_()).toBe(252);
      expect(seenUrls[1]).toContain('/999888777?');
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
          return res(200, { followers_count: 252 });
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
          return res(200, { followers_count: 252, id: 'threads-user-42' });
        }
        throw new Error('unexpected fetch: ' + url);
      };
      Code.debugThreadsFollowers();
      expect(allLogs()).toContain('META_THREADS_ACCESS_TOKEN is set.');
      expect(allLogs()).toContain(
        'Threads user id: threads-user-42 (from THREADS_USER_ID)'
      );
      expect(allLogs()).toContain('HTTP 200');
      expect(allLogs()).toContain('"followers_count":252');
      expect(allLogs()).not.toContain('threads-secret-token');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(
        'https://graph.threads.net/v1.0/threads-user-42?fields=followers_count&access_token=threads-secret-token'
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
});
