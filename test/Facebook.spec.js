import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

const EXEC_URL = 'https://script.google.com/macros/s/TESTDEPLOY/exec';
const PAGE_ID = '362616541057810';
const PAGE_TOKEN = 'page-secret-token';

describe('Facebook Page collection completed inside GAS', () => {
  let outputs;
  let store;
  let fetchHandler;
  let fetchCalls;
  let uuidCounter;

  const res = (status, body) => ({
    getResponseCode: () => status,
    getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
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
  const lastJson = () => JSON.parse(lastOutput().text);

  const setupApp = () => {
    store.FACEBOOK_APP_ID = 'facebook-app-id';
    store.FACEBOOK_APP_SECRET = 'facebook-app-secret';
  };

  const setupPage = () => {
    store.FACEBOOK_PAGE_ACCESS_TOKEN = PAGE_TOKEN;
    store.FACEBOOK_PAGE_ID = PAGE_ID;
  };

  const insightsBody = (name, pairs) => ({
    data: [
      {
        name,
        period: 'day',
        values: pairs.map(([value, end_time]) => ({ value, end_time })),
      },
    ],
  });

  const totalValueBody = (name, value) => ({
    data: [{ name, period: 'day', total_value: { value } }],
  });

  describe('facebookAuthorizeUrl', () => {
    it('builds the dialog URL with the callback action and saves the state', () => {
      setupApp();
      const url = Code.facebookAuthorizeUrl();
      expect(url).toContain('https://www.facebook.com/v25.0/dialog/oauth');
      expect(url).toContain('client_id=facebook-app-id');
      expect(url).toContain(
        'redirect_uri=' +
          encodeURIComponent(EXEC_URL + '?action=facebook_callback')
      );
      expect(url).toContain('scope=pages_show_list,pages_read_engagement');
      expect(url).toContain('response_type=code');
      expect(store.FACEBOOK_OAUTH_STATE).toBeTruthy();
      expect(url).toContain(
        'state=' + encodeURIComponent(store.FACEBOOK_OAUTH_STATE)
      );
    });

    it('prefers FACEBOOK_REDIRECT_URI over the service URL', () => {
      setupApp();
      store.FACEBOOK_REDIRECT_URI = 'https://example.com/callback';
      const url = Code.facebookAuthorizeUrl();
      expect(url).toContain(
        'redirect_uri=' + encodeURIComponent('https://example.com/callback')
      );
    });

    it('returns an empty string without FACEBOOK_APP_ID', () => {
      expect(Code.facebookAuthorizeUrl()).toBe('');
      expect(store.FACEBOOK_OAUTH_STATE).toBeUndefined();
    });
  });

  describe('doGet action=facebook_callback', () => {
    const mockSuccessfulCallback = (accounts) => {
      fetchHandler = (url) => {
        if (url.includes('me/accounts')) {
          return res(200, { data: accounts });
        }
        if (url.startsWith('https://graph.facebook.com/v25.0/oauth/access_token')) {
          if (url.includes('grant_type=fb_exchange_token')) {
            expect(url).toContain('fb_exchange_token=short-user-token');
            return res(200, { access_token: 'long-user-token', expires_in: 5184000 });
          }
          expect(url).toContain('code=auth-code');
          expect(url).toContain('client_id=facebook-app-id');
          return res(200, { access_token: 'short-user-token', expires_in: 3600 });
        }
        throw new Error('unexpected fetch: ' + url);
      };
    };

    it('exchanges the code, upgrades the user token and stores the pinned Page token', () => {
      setupApp();
      store.FACEBOOK_OAUTH_STATE = 'expected-state';
      store.FACEBOOK_PAGE_ID = PAGE_ID;
      mockSuccessfulCallback([
        { id: '111', name: 'Other Page', access_token: 'other-page-token' },
        { id: PAGE_ID, name: 'freddiefujiwara', access_token: PAGE_TOKEN },
      ]);
      Code.doGet({
        parameter: {
          action: 'facebook_callback',
          code: 'auth-code',
          state: 'expected-state',
        },
      });
      expect(store.FACEBOOK_USER_ACCESS_TOKEN).toBe('long-user-token');
      expect(store.FACEBOOK_PAGE_ACCESS_TOKEN).toBe(PAGE_TOKEN);
      expect(store.FACEBOOK_PAGE_ID).toBe(PAGE_ID);
      expect(Date.parse(store.FACEBOOK_TOKEN_AT)).toBeGreaterThan(Date.now() - 60000);
      expect(Date.parse(store.FACEBOOK_TOKEN_EXPIRES_AT)).toBeGreaterThan(Date.now());
      expect(store.FACEBOOK_OAUTH_STATE).toBeUndefined();
      expect(lastOutput().mimeType).toBe('text/html');
      expect(lastOutput().text).toContain('認可が完了');
    });

    it('selects the first managed Page when FACEBOOK_PAGE_ID is not pinned', () => {
      setupApp();
      store.FACEBOOK_OAUTH_STATE = 'expected-state';
      mockSuccessfulCallback([
        { id: '111', name: 'Only Page', access_token: 'only-page-token' },
      ]);
      Code.doGet({
        parameter: {
          action: 'facebook_callback',
          code: 'auth-code',
          state: 'expected-state',
        },
      });
      expect(store.FACEBOOK_PAGE_ACCESS_TOKEN).toBe('only-page-token');
      expect(store.FACEBOOK_PAGE_ID).toBe('111');
      expect(lastOutput().text).toContain('認可が完了');
    });

    it('fails without storing a Page token when the pinned Page is not managed', () => {
      setupApp();
      store.FACEBOOK_OAUTH_STATE = 'expected-state';
      store.FACEBOOK_PAGE_ID = PAGE_ID;
      mockSuccessfulCallback([
        { id: '111', name: 'Other Page', access_token: 'other-page-token' },
      ]);
      Code.doGet({
        parameter: {
          action: 'facebook_callback',
          code: 'auth-code',
          state: 'expected-state',
        },
      });
      expect(store.FACEBOOK_PAGE_ACCESS_TOKEN).toBeUndefined();
      expect(lastOutput().text).toContain('認可に失敗');
    });

    it('ignores a callback whose state does not match, without any token call', () => {
      setupApp();
      store.FACEBOOK_OAUTH_STATE = 'expected-state';
      Code.doGet({
        parameter: {
          action: 'facebook_callback',
          code: 'auth-code',
          state: 'wrong-state',
        },
      });
      expect(fetchCalls).toHaveLength(0);
      expect(store.FACEBOOK_USER_ACCESS_TOKEN).toBeUndefined();
      expect(lastOutput().mimeType).toBe('text/html');
      expect(lastOutput().text).toContain('確認できませんでした');
    });

    it('reports failure and stores nothing when the code exchange fails', () => {
      setupApp();
      store.FACEBOOK_OAUTH_STATE = 'expected-state';
      fetchHandler = () =>
        res(400, { error: { message: 'bad code', code: 100 } });
      Code.doGet({
        parameter: {
          action: 'facebook_callback',
          code: 'bad-code',
          state: 'expected-state',
        },
      });
      expect(store.FACEBOOK_USER_ACCESS_TOKEN).toBeUndefined();
      expect(store.FACEBOOK_PAGE_ACCESS_TOKEN).toBeUndefined();
      expect(lastOutput().text).toContain('認可に失敗');
    });
  });

  describe('refreshFacebookTokenIfNeeded', () => {
    const setupRefreshable = () => {
      setupApp();
      store.FACEBOOK_USER_ACCESS_TOKEN = 'old-user-token';
      store.FACEBOOK_TOKEN_EXPIRES_AT = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();
    };

    it('does nothing without a user token or while the token is fresh', () => {
      expect(Code.refreshFacebookTokenIfNeeded()).toBeNull();
      store.FACEBOOK_USER_ACCESS_TOKEN = 'some-token';
      store.FACEBOOK_TOKEN_EXPIRES_AT = new Date(
        Date.now() + 40 * 24 * 60 * 60 * 1000
      ).toISOString();
      expect(Code.refreshFacebookTokenIfNeeded()).toBeNull();
      expect(fetchCalls).toHaveLength(0);
    });

    it('does nothing without app credentials even when the token is due', () => {
      store.FACEBOOK_USER_ACCESS_TOKEN = 'old-user-token';
      store.FACEBOOK_TOKEN_EXPIRES_AT = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();
      expect(Code.refreshFacebookTokenIfNeeded()).toBeNull();
      expect(fetchCalls).toHaveLength(0);
    });

    it('re-exchanges a due token and re-reads the Page token', () => {
      setupRefreshable();
      fetchHandler = (url) => {
        if (url.includes('me/accounts')) {
          return res(200, {
            data: [{ id: PAGE_ID, name: 'freddiefujiwara', access_token: 'new-page-token' }],
          });
        }
        if (url.includes('grant_type=fb_exchange_token')) {
          expect(url).toContain('fb_exchange_token=old-user-token');
          return res(200, { access_token: 'new-user-token', expires_in: 5184000 });
        }
        throw new Error('unexpected fetch: ' + url);
      };
      expect(Code.refreshFacebookTokenIfNeeded()).toBeNull();
      expect(store.FACEBOOK_USER_ACCESS_TOKEN).toBe('new-user-token');
      expect(store.FACEBOOK_PAGE_ACCESS_TOKEN).toBe('new-page-token');
      expect(store.FACEBOOK_PAGE_ID).toBe(PAGE_ID);
      expect(Date.parse(store.FACEBOOK_TOKEN_AT)).toBeGreaterThan(Date.now() - 60000);
      expect(Date.parse(store.FACEBOOK_TOKEN_EXPIRES_AT)).toBeGreaterThan(Date.now());
    });

    it('returns an error summary and keeps the tokens when the exchange fails', () => {
      setupRefreshable();
      fetchHandler = () =>
        res(400, { error: { message: 'user token expired', code: 190 } });
      const error = Code.refreshFacebookTokenIfNeeded();
      expect(error).toContain('refresh:');
      expect(error).toContain('user token expired');
      expect(store.FACEBOOK_USER_ACCESS_TOKEN).toBe('old-user-token');
    });
  });

  describe('fetchFacebookFollowers_', () => {
    it('returns null without a token or a Page id and never calls the API', () => {
      expect(Code.fetchFacebookFollowers_()).toBeNull();
      store.FACEBOOK_PAGE_ACCESS_TOKEN = PAGE_TOKEN;
      expect(Code.fetchFacebookFollowers_()).toBeNull();
      expect(fetchCalls).toHaveLength(0);
    });

    it('prefers fan_count and falls back to followers_count', () => {
      setupPage();
      fetchHandler = (url) => {
        expect(url).toContain('/' + PAGE_ID + '?fields=fan_count,followers_count');
        return res(200, { fan_count: 123, followers_count: 456 });
      };
      expect(Code.fetchFacebookFollowers_()).toBe(123);
      fetchHandler = () => res(200, { followers_count: 456 });
      expect(Code.fetchFacebookFollowers_()).toBe(456);
      fetchHandler = () => res(400, { error: { message: 'nope', code: 190 } });
      expect(Code.fetchFacebookFollowers_()).toBeNull();
    });

    it('parseFacebookFanCount_ returns null for error bodies and junk', () => {
      expect(Code.parseFacebookFanCount_({ error: { message: 'boom' } })).toBeNull();
      expect(Code.parseFacebookFanCount_(null)).toBeNull();
      expect(Code.parseFacebookFanCount_({ fan_count: '78' })).toBe(78);
    });
  });

  describe('fetchFacebookAccountDetail_', () => {
    it('returns nulls without a token and never calls the API', () => {
      const detail = Code.fetchFacebookAccountDetail_();
      expect(detail).toEqual({
        views_28d: null,
        unique_viewers_28d: null,
        engagement_28d: null,
        profile_visits_28d: null,
        new_followers_28d: null,
        unfollowers_28d: null,
        detail_error: null,
      });
      expect(fetchCalls).toHaveLength(0);
    });

    const pageMetricHandler = (overrides) => {
      const bodies = Object.assign(
        {
          page_media_view: insightsBody('page_media_view', [
            [100, '2026-11-08T07:00:00+0000'],
            [23, '2026-11-09T07:00:00+0000'],
          ]),
          page_media_view_unique: totalValueBody('page_media_view_unique', 90),
          page_post_engagements: insightsBody('page_post_engagements', [
            [5, '2026-11-09T07:00:00+0000'],
          ]),
          page_views_total: insightsBody('page_views_total', [
            [2, '2026-11-09T07:00:00+0000'],
          ]),
          page_fan_adds_unique: insightsBody('page_fan_adds_unique', [
            [3, '2026-11-09T07:00:00+0000'],
          ]),
          page_fan_removes_unique: insightsBody('page_fan_removes_unique', [
            [1, '2026-11-09T07:00:00+0000'],
          ]),
        },
        overrides || {}
      );
      return (url) => {
        const match = url.match(/[?&]metric=([a-z_]+)/);
        const metric = match ? match[1] : null;
        if (metric in bodies) {
          const body = bodies[metric];
          return typeof body === 'function' ? body() : res(200, body);
        }
        throw new Error('unexpected metric url: ' + url);
      };
    };

    it('collects every metric over the 28-day window', () => {
      setupPage();
      fetchHandler = pageMetricHandler();
      const detail = Code.fetchFacebookAccountDetail_();
      expect(detail).toEqual({
        views_28d: 123,
        unique_viewers_28d: 90,
        engagement_28d: 5,
        profile_visits_28d: 2,
        new_followers_28d: 3,
        unfollowers_28d: 1,
        detail_error: null,
      });
      const viewsCall = fetchCalls.find((c) => c.url.includes('page_media_view'));
      expect(viewsCall.url).toContain('period=day');
      const since = Number(viewsCall.url.match(/[?&]since=(\d+)/)[1]);
      const until = Number(viewsCall.url.match(/[?&]until=(\d+)/)[1]);
      expect(until - since).toBe(28 * 24 * 60 * 60);
    });

    it('falls back to the legacy metric name when the current one is refused', () => {
      setupPage();
      fetchHandler = pageMetricHandler({
        page_media_view: () =>
          res(400, { error: { message: 'metric unknown', code: 100 } }),
        page_impressions: () =>
          res(200, insightsBody('page_impressions', [[77, '2026-11-09T07:00:00+0000']])),
      });
      const detail = Code.fetchFacebookAccountDetail_();
      expect(detail.views_28d).toBe(77);
      expect(detail.detail_error).toBeNull();
    });

    it('nulls only the failed metric and records its error without the token', () => {
      setupPage();
      fetchHandler = pageMetricHandler({
        page_views_total: () =>
          res(400, { error: { message: 'views denied', code: 10 } }),
      });
      const detail = Code.fetchFacebookAccountDetail_();
      expect(detail.views_28d).toBe(123);
      expect(detail.profile_visits_28d).toBeNull();
      expect(detail.detail_error).toContain('profile_visits');
      expect(detail.detail_error).toContain('views denied');
      expect(detail.detail_error).not.toContain(PAGE_TOKEN);
    });
  });

  describe('fetchFacebookRecentPosts_', () => {
    const POSTS = [
      {
        id: 'page-post-1',
        message: '川口のラーメン屋に行ってきました',
        created_time: '2026-11-08T03:00:00+0000',
        permalink_url: 'https://www.facebook.com/freddiefujiwara/posts/1',
      },
      {
        id: 'page-post-2',
        message: '明日の予定',
        created_time: '2026-11-07T03:00:00+0000',
        permalink_url: 'https://www.facebook.com/freddiefujiwara/posts/2',
      },
    ];

    const postInsightsBody = (pairs, clickTypes) => ({
      data: pairs
        .map(([name, value]) => ({ name, period: 'lifetime', values: [{ value }] }))
        .concat(
          clickTypes
            ? [
                {
                  name: 'post_clicks_by_type',
                  period: 'lifetime',
                  values: [{ value: clickTypes }],
                },
              ]
            : []
        ),
    });

    it('returns nulls without a token and never calls the API', () => {
      expect(Code.fetchFacebookRecentPosts_()).toEqual({
        recent_posts: null,
        posts_error: null,
      });
      expect(fetchCalls).toHaveLength(0);
    });

    it('builds entries with insights and lifts link clicks out of the breakdown', () => {
      setupPage();
      fetchHandler = (url) => {
        if (url.includes('/published_posts')) {
          return res(200, { data: POSTS });
        }
        if (url.includes('page-post-1/insights')) {
          return res(
            200,
            postInsightsBody(
              [
                ['post_media_view', 500],
                ['post_media_view_unique', 400],
                ['post_engaged_users', 30],
                ['post_clicks', 12],
              ],
              { 'link clicks': 4, 'other clicks': 8 }
            )
          );
        }
        if (url.includes('page-post-2/insights')) {
          if (url.includes('post_media_view')) {
            return res(400, { error: { message: 'metric unknown', code: 100 } });
          }
          return res(
            200,
            postInsightsBody(
              [
                ['post_impressions', 60],
                ['post_impressions_unique', 50],
                ['post_engaged_users', 3],
                ['post_clicks', 1],
              ],
              { 'link clicks': 0 }
            )
          );
        }
        throw new Error('unexpected fetch: ' + url);
      };
      const result = Code.fetchFacebookRecentPosts_();
      expect(result.posts_error).toBeNull();
      expect(result.recent_posts).toEqual([
        {
          id: 'page-post-1',
          posted_at: '2026-11-08T03:00:00+0000',
          message: '川口のラーメン屋に行ってきました',
          permalink: 'https://www.facebook.com/freddiefujiwara/posts/1',
          views: 500,
          unique_viewers: 400,
          engagements: 30,
          clicks: 12,
          link_clicks: 4,
          saves: null,
        },
        {
          id: 'page-post-2',
          posted_at: '2026-11-07T03:00:00+0000',
          message: '明日の予定',
          permalink: 'https://www.facebook.com/freddiefujiwara/posts/2',
          views: 60,
          unique_viewers: 50,
          engagements: 3,
          clicks: 1,
          link_clicks: 0,
          saves: null,
        },
      ]);
    });

    it('caps a pathological message at 2000 characters', () => {
      setupPage();
      fetchHandler = (url) => {
        if (url.includes('/published_posts')) {
          return res(200, {
            data: [{ id: 'p1', message: 'あ'.repeat(2100), created_time: 't' }],
          });
        }
        return res(200, { data: [] });
      };
      const result = Code.fetchFacebookRecentPosts_();
      expect(result.recent_posts[0].message).toHaveLength(2000);
    });

    it('nulls the whole section when the list fetch fails', () => {
      setupPage();
      fetchHandler = () =>
        res(400, { error: { message: 'list denied', code: 10 } });
      const result = Code.fetchFacebookRecentPosts_();
      expect(result.recent_posts).toBeNull();
      expect(result.posts_error).toContain('posts list:');
      expect(result.posts_error).toContain('list denied');
    });

    it('keeps a post with null numbers and counts it when every insights attempt fails', () => {
      setupPage();
      fetchHandler = (url) => {
        if (url.includes('/published_posts')) {
          return res(200, { data: POSTS });
        }
        if (url.includes('page-post-1/insights')) {
          return res(200, postInsightsBody([['post_media_view', 10]]));
        }
        return res(400, { error: { message: 'insights denied', code: 10 } });
      };
      const result = Code.fetchFacebookRecentPosts_();
      expect(result.recent_posts[0].views).toBe(10);
      expect(result.recent_posts[1].views).toBeNull();
      expect(result.posts_error).toContain('1 of 2 post insights failed');
    });

    it('parseFacebookPostInsights_ ignores unknown metrics and junk', () => {
      expect(
        Code.parseFacebookPostInsights_({
          data: [
            { name: 'post_reactions_by_type_total', values: [{ value: { like: 3 } }] },
            { name: 'post_media_view', values: [{ value: '42' }] },
          ],
        })
      ).toEqual({ views: 42 });
      expect(Code.parseFacebookPostInsights_(null)).toEqual({});
      expect(Code.parseFacebookPostInsights_({ error: {} })).toEqual({});
    });
  });

  describe('collectSnsCounts with Facebook configured', () => {
    const mockAllButFacebook = () => {
      fetchHandler = (url) => {
        if (url.includes('graph.threads.net')) {
          return res(200, totalValueBody('followers_count', 252));
        }
        if (url.includes('published_posts')) {
          return res(200, {
            data: [
              {
                id: 'page-post-1',
                message: '投稿本文',
                created_time: '2026-11-08T03:00:00+0000',
                permalink_url: 'https://www.facebook.com/freddiefujiwara/posts/1',
              },
            ],
          });
        }
        if (url.includes('page-post-1/insights')) {
          return res(200, {
            data: [
              { name: 'post_media_view', values: [{ value: 500 }] },
              { name: 'post_engaged_users', values: [{ value: 30 }] },
            ],
          });
        }
        if (url.includes(PAGE_ID) && url.includes('fields=fan_count')) {
          return res(200, { fan_count: 321, followers_count: 321 });
        }
        if (url.includes(PAGE_ID) && url.includes('/insights')) {
          const match = url.match(/[?&]metric=([a-z_]+)/);
          const metric = match ? match[1] : null;
          const values = {
            page_media_view: 100,
            page_media_view_unique: 80,
            page_post_engagements: 5,
            page_views_total: 2,
            page_fan_adds_unique: 3,
            page_fan_removes_unique: 1,
          };
          if (metric in values) {
            return res(200, totalValueBody(metric, values[metric]));
          }
          throw new Error('unexpected page metric: ' + metric);
        }
        if (url.includes('graph.facebook.com')) {
          return res(200, { followers_count: 100, media_count: 10 });
        }
        throw new Error('unexpected fetch: ' + url);
      };
    };

    it('collects the Facebook section alongside the other channels', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      setupPage();
      mockAllButFacebook();
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.facebook).toEqual({
        followers: 321,
        facebook_error: null,
        views_28d: 100,
        unique_viewers_28d: 80,
        engagement_28d: 5,
        profile_visits_28d: 2,
        new_followers_28d: 3,
        unfollowers_28d: 1,
        detail_error: null,
        recent_posts: [
          {
            id: 'page-post-1',
            posted_at: '2026-11-08T03:00:00+0000',
            message: '投稿本文',
            permalink: 'https://www.facebook.com/freddiefujiwara/posts/1',
            views: 500,
            unique_viewers: null,
            engagements: 30,
            clicks: null,
            link_clicks: null,
            saves: null,
          },
        ],
        posts_error: null,
      });
      expect(snapshot.threads.followers).toBe(252);
    });

    it('keeps the Facebook section out of the public sns_counts projection by default', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      setupPage();
      mockAllButFacebook();
      Code.collectSnsCounts();
      expect(Code.SNS_COUNTS_INCLUDE_FACEBOOK).toBe(false);
      const response = Code.buildSnsCountsResponse_();
      expect(response.facebook).toBeUndefined();
      expect(response.threads).toEqual({ followers: 252 });

      Code.doGet({ parameter: { action: 'sns_counts' } });
      expect(lastJson().facebook).toBeUndefined();
      expect(lastJson().threads.followers).toBe(252);
    });

    it('surfaces a failing Facebook refresh as facebook_error and still completes', () => {
      setupApp();
      store.FACEBOOK_USER_ACCESS_TOKEN = 'stale-user-token';
      store.FACEBOOK_TOKEN_EXPIRES_AT = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();
      store.META_ACCESS_TOKEN = 'meta-token';
      fetchHandler = (url) => {
        if (url.includes('grant_type=fb_exchange_token')) {
          return res(400, { error: { message: 'user token expired', code: 190 } });
        }
        if (url.includes('graph.threads.net')) {
          return res(200, totalValueBody('followers_count', 252));
        }
        if (url.includes('graph.facebook.com')) {
          return res(200, { followers_count: 100, media_count: 10 });
        }
        throw new Error('unexpected fetch: ' + url);
      };
      const snapshot = Code.collectSnsCounts();
      expect(snapshot.facebook.facebook_error).toContain('user token expired');
      expect(snapshot.facebook.followers).toBeNull();
      expect(snapshot.threads.followers).toBe(252);
    });
  });

  describe('debugFacebook', () => {
    let logs;

    beforeEach(() => {
      logs = [];
      global.Logger = {
        log: vi.fn((...args) => logs.push(args.join(' '))),
      };
    });

    const allLogs = () => logs.join('\n');

    it('logs that authorization is missing and does not fetch', () => {
      Code.debugFacebook();
      expect(allLogs()).toContain('FACEBOOK_PAGE_ACCESS_TOKEN is not set.');
      expect(allLogs()).toContain('run facebookAuthorizeUrl() first');
      expect(fetchCalls).toHaveLength(0);
    });

    it('logs the raw stages and parsed values without leaking the token', () => {
      setupPage();
      store.FACEBOOK_USER_ACCESS_TOKEN = 'user-token';
      fetchHandler = (url) => {
        if (url.includes('published_posts')) {
          return res(200, {
            data: [
              {
                id: 'page-post-1',
                message: '投稿本文',
                created_time: '2026-11-08T03:00:00+0000',
                permalink_url: 'https://www.facebook.com/freddiefujiwara/posts/1',
              },
            ],
          });
        }
        if (url.includes('page-post-1/insights')) {
          return res(200, {
            data: [{ name: 'post_media_view', values: [{ value: 500 }] }],
          });
        }
        if (url.includes('fields=name,fan_count,followers_count')) {
          return res(200, { name: 'freddiefujiwara', fan_count: 321 });
        }
        if (url.includes('/insights')) {
          const match = url.match(/[?&]metric=([a-z_]+)/);
          const metric = match ? match[1] : null;
          const values = {
            page_media_view: 100,
            page_media_view_unique: 80,
            page_post_engagements: 5,
            page_views_total: 2,
            page_fan_adds_unique: 3,
            page_fan_removes_unique: 1,
          };
          if (metric in values) {
            return res(200, totalValueBody(metric, values[metric]));
          }
          throw new Error('unexpected metric: ' + metric);
        }
        throw new Error('unexpected fetch: ' + url);
      };
      Code.debugFacebook();
      expect(allLogs()).toContain('FACEBOOK_PAGE_ACCESS_TOKEN is set.');
      expect(allLogs()).toContain('FACEBOOK_PAGE_ID: ' + PAGE_ID);
      expect(allLogs()).toContain('parsed fan count: 321');
      expect(allLogs()).toContain('"views_28d":100');
      expect(allLogs()).toContain('"id":"page-post-1"');
      expect(allLogs()).toContain('parsed post insights: {"views":500}');
      expect(allLogs()).not.toContain(PAGE_TOKEN);
    });
  });
});
