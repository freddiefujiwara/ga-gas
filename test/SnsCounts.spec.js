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
    global.YouTube = {
      Channels: {
        list: vi.fn((part) => (part === 'statistics' ? result : { items: [] })),
      },
      PlaylistItems: { list: vi.fn(() => ({ items: [] })) },
      Videos: { list: vi.fn(() => ({ items: [] })) },
    };
  };

  const mockYouTubeFull = () => {
    global.YouTube = {
      Channels: {
        list: vi.fn((part) => {
          if (part === 'statistics') {
            return {
              items: [
                {
                  statistics: {
                    subscriberCount: '8',
                    viewCount: '123456',
                    videoCount: '42',
                  },
                },
              ],
            };
          }
          if (part === 'contentDetails') {
            return {
              items: [
                { contentDetails: { relatedPlaylists: { uploads: 'UUuploads' } } },
              ],
            };
          }
          throw new Error('unexpected part: ' + part);
        }),
      },
      PlaylistItems: {
        list: vi.fn(() => ({
          items: [
            {
              snippet: {
                title: '川口の歌',
                publishedAt: '2026-11-08T00:00:00Z',
                resourceId: { videoId: 'vid1' },
              },
            },
          ],
        })),
      },
      Videos: {
        list: vi.fn(() => ({
          items: [
            {
              id: 'vid1',
              statistics: { viewCount: '1000', likeCount: '50', commentCount: '4' },
            },
          ],
        })),
      },
    };
  };

  const totalValueBody = (name, value, breakdowns) => ({
    data: [
      {
        name,
        period: 'day',
        total_value: breakdowns ? { value, breakdowns } : { value },
      },
    ],
  });

  // The shape production actually returns for follows_and_unfollows
  // (confirmed by debugSnsInsights on 2026-11-09): total_value has
  // no plain number, only the follow_type breakdown, labelled by the
  // resulting state — FOLLOWER = new follows, NON_FOLLOWER =
  // unfollows.
  const followsBreakdownBody = () => ({
    data: [
      {
        name: 'follows_and_unfollows',
        period: 'day',
        total_value: {
          breakdowns: [
            {
              dimension_keys: ['follow_type'],
              results: [
                { dimension_values: ['FOLLOWER'], value: 498 },
                { dimension_values: ['NON_FOLLOWER'], value: 58 },
              ],
            },
          ],
        },
      },
    ],
  });

  const demographicsBody = (dims, results) => ({
    data: [
      {
        name: 'follower_demographics',
        period: 'lifetime',
        total_value: { value: 1991, breakdowns: [{ dimension_keys: dims, results }] },
      },
    ],
  });

  const MEDIA_LIST = [
    {
      id: 'media-reel-1',
      media_type: 'VIDEO',
      media_product_type: 'REELS',
      caption: 'リールのキャプション',
      timestamp: '2026-11-08T03:00:00+0000',
      permalink: 'https://www.instagram.com/reel/ABC/',
      thumbnail_url: 'https://example.com/thumb1.jpg',
    },
    {
      id: 'media-image-1',
      media_type: 'IMAGE',
      media_product_type: 'FEED',
      caption: '写真のキャプション',
      timestamp: '2026-11-07T03:00:00+0000',
      permalink: 'https://www.instagram.com/p/DEF/',
    },
  ];

  const mediaInsightsBody = (pairs) => ({
    data: pairs.map(([name, value]) => ({
      name,
      period: 'lifetime',
      values: [{ value }],
    })),
  });

  const metricFromUrl = (url) => {
    const match = url.match(/[?&]metric=([a-z_]+)/);
    return match ? match[1] : null;
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
    const accountTotals = {
      reach: 5000,
      accounts_engaged: 1200,
      total_interactions: 3000,
      likes: 2000,
      comments: 300,
      shares: 400,
      saves: 300,
      profile_links_taps: 46,
    };
    fetchHandler = (url) => {
      if (url.includes('graph.threads.net') && url.includes(THREADS_ID)) {
        return res(200, totalValueBody('followers_count', 252));
      }
      if (url.includes('/media?')) {
        return res(200, { data: MEDIA_LIST });
      }
      if (url.includes('media-reel-1/insights')) {
        return res(
          200,
          mediaInsightsBody([
            ['views', 1000],
            ['reach', 900],
            ['likes', 50],
            ['comments', 5],
            ['shares', 3],
            ['saved', 7],
            ['total_interactions', 65],
            ['ig_reels_avg_watch_time', 8500],
            ['ig_reels_video_view_total_time', 765432],
          ])
        );
      }
      if (url.includes('media-image-1/insights')) {
        return res(
          200,
          mediaInsightsBody([
            ['views', 100],
            ['reach', 90],
            ['likes', 10],
            ['comments', 1],
            ['shares', 0],
            ['saved', 2],
            ['total_interactions', 13],
          ])
        );
      }
      if (url.includes('fields=media_count')) {
        return res(200, { media_count: 2404 });
      }
      if (url.includes('/insights') && url.includes('metric=follower_demographics')) {
        if (url.includes('breakdown=age,gender')) {
          return res(
            200,
            demographicsBody(
              ['age', 'gender'],
              [
                { dimension_values: ['35-44', 'M'], value: 300 },
                { dimension_values: ['25-34', 'F'], value: 500 },
              ]
            )
          );
        }
        if (url.includes('breakdown=city')) {
          return res(
            200,
            demographicsBody(
              ['city'],
              [
                { dimension_values: ['Tokyo'], value: 100 },
                { dimension_values: ['Kawaguchi'], value: 800 },
              ]
            )
          );
        }
        if (url.includes('breakdown=country')) {
          return res(
            200,
            demographicsBody(
              ['country'],
              [
                { dimension_values: ['JP'], value: 1500 },
                { dimension_values: ['US'], value: 20 },
              ]
            )
          );
        }
        throw new Error('unexpected demographics url: ' + url);
      }
      if (url.includes('/insights') && url.includes('metric=follows_and_unfollows')) {
        return res(200, followsBreakdownBody());
      }
      if (url.includes('/insights') && url.includes('breakdown=follow_type')) {
        return res(200, insightsBreakdownBody(370, 9630, 10000));
      }
      if (url.includes('/insights')) {
        const metric = metricFromUrl(url);
        if (metric in accountTotals) {
          return res(200, totalValueBody(metric, accountTotals[metric]));
        }
        throw new Error('unexpected insights metric: ' + metric);
      }
      if (url.includes('graph.facebook.com') && url.includes(MAIN_IG_ID)) {
        return res(200, { followers_count: 1988 });
      }
      if (url.includes('graph.facebook.com') && url.includes(SUB_IG_ID)) {
        return res(200, { followers_count: 59 });
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

    it('returns the stored snapshot projected to the public shape', () => {
      const snapshot = {
        collected_at: '2026-11-08T12:00:00.000Z',
        youtube: { subscribers: 8 },
        instagram: { freddiefujiwara: 1988, anemone_cancer: 59 },
        threads: { followers: 252 },
      };
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(snapshot);
      Code.doGet({ parameter: { action: 'sns_counts' } });
      expect(lastJson()).toEqual({
        ok: true,
        action: 'sns_counts',
        collected_at: '2026-11-08T12:00:00.000Z',
        youtube: { subscribers: 8 },
        instagram: {
          freddiefujiwara: 1988,
          anemone_cancer: 59,
          media_count: null,
          views_30d: null,
          non_follower_pct: null,
          insights_error: null,
        },
        threads: { followers: 252 },
      });
    });

    it('never leaks the admin detail fields into the public response', () => {
      const snapshot = {
        collected_at: '2026-11-08T12:00:00.000Z',
        youtube: {
          subscribers: 8,
          total_views: 123456,
          video_count: 42,
          recent_videos: [{ id: 'vid1', title: 'secret-ish title' }],
          youtube_error: null,
        },
        instagram: {
          freddiefujiwara: 1988,
          anemone_cancer: 59,
          media_count: 2404,
          views_30d: 10000,
          non_follower_pct: 96.3,
          insights_error: null,
          reach_30d: 5000,
          profile_links_taps_30d: 46,
          profile_links_taps_source: 'daily_sum',
          demographics: { age_gender: [{ key: '25-34/F', value: 500 }] },
          recent_media: [{ id: 'media-1', caption: 'a caption' }],
        },
        threads: { followers: 252 },
      };
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(snapshot);
      Code.doGet({ parameter: { action: 'sns_counts' } });
      const json = lastJson();
      expect(Object.keys(json.youtube)).toEqual(['subscribers']);
      expect(Object.keys(json.instagram).sort()).toEqual(
        [
          'anemone_cancer',
          'freddiefujiwara',
          'insights_error',
          'media_count',
          'non_follower_pct',
          'views_30d',
        ].sort()
      );
      const text = outputs[outputs.length - 1].text;
      expect(text).not.toContain('recent_media');
      expect(text).not.toContain('profile_links_taps');
      expect(text).not.toContain('demographics');
      expect(text).not.toContain('total_views');
      expect(text).not.toContain('recent_videos');
      expect(text).not.toContain('a caption');
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
      mockYouTubeFull();

      const snapshot = Code.collectSnsCounts();
      expect(snapshot.youtube).toEqual({
        subscribers: 8,
        total_views: 123456,
        video_count: 42,
        recent_videos: [
          {
            id: 'vid1',
            title: '川口の歌',
            published_at: '2026-11-08T00:00:00Z',
            views: 1000,
            likes: 50,
            comments: 4,
            url: 'https://www.youtube.com/watch?v=vid1',
          },
        ],
        youtube_error: null,
      });
      expect(snapshot.instagram).toEqual({
        freddiefujiwara: 1988,
        anemone_cancer: 59,
        media_count: 2404,
        views_30d: 10000,
        non_follower_pct: 96.3,
        insights_error: null,
        reach_30d: 5000,
        accounts_engaged_30d: 1200,
        interactions_30d: { total: 3000, likes: 2000, comments: 300, shares: 400, saves: 300 },
        profile_links_taps_30d: 46,
        profile_links_taps_source: 'total_value',
        follows_30d: 498,
        unfollows_30d: 58,
        demographics: {
          age_gender: [
            { key: '25-34/F', value: 500 },
            { key: '35-44/M', value: 300 },
          ],
          top_cities: [
            { key: 'Kawaguchi', value: 800 },
            { key: 'Tokyo', value: 100 },
          ],
          top_countries: [
            { key: 'JP', value: 1500 },
            { key: 'US', value: 20 },
          ],
        },
        detail_error: null,
        recent_media: [
          {
            id: 'media-reel-1',
            type: 'REELS',
            posted_at: '2026-11-08T03:00:00+0000',
            caption: 'リールのキャプション',
            permalink: 'https://www.instagram.com/reel/ABC/',
            views: 1000,
            reach: 900,
            likes: 50,
            comments: 5,
            shares: 3,
            saves: 7,
            avg_watch_sec: 8.5,
            total_watch_sec: 765,
          },
          {
            id: 'media-image-1',
            type: 'FEED',
            posted_at: '2026-11-07T03:00:00+0000',
            caption: '写真のキャプション',
            permalink: 'https://www.instagram.com/p/DEF/',
            views: 100,
            reach: 90,
            likes: 10,
            comments: 1,
            shares: 0,
            saves: 2,
            avg_watch_sec: null,
            total_watch_sec: null,
          },
        ],
        media_error: null,
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
        reach_30d: null,
        accounts_engaged_30d: null,
        interactions_30d: { total: null, likes: null, comments: null, shares: null, saves: null },
        profile_links_taps_30d: null,
        profile_links_taps_source: null,
        follows_30d: null,
        unfollows_30d: null,
        demographics: { age_gender: null, top_cities: null, top_countries: null },
        detail_error: null,
        recent_media: null,
        media_error: null,
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
          return res(200, totalValueBody('followers_count', 252));
        }
        return res(200, { followers_count: 1 });
      };
      mockYouTube({ items: [] });
      Code.collectSnsCounts();
      expect(threadsUrl).toContain('/threads_insights?metric=followers_count');
      expect(threadsUrl).toContain('access_token=threads-token');
    });
  });

  describe('SNS history append', () => {
    let sheets;
    let spreadsheet;
    let openById;

    const makeSheet = () => {
      const sheet = {
        rows: [],
        getLastRow() {
          return sheet.rows.length;
        },
        getRange(row, col, numRows) {
          return {
            setValues: (values) => {
              values.forEach((valueRow, i) => {
                sheet.rows[row - 1 + i] = valueRow.slice();
              });
            },
          };
        },
        appendRow(row) {
          sheet.rows.push(row.slice());
        },
      };
      return sheet;
    };

    const fixtureSnapshot = () => ({
      collected_at: '2026-11-09T00:00:00.000Z',
      youtube: {
        subscribers: 8,
        total_views: 123456,
        video_count: 42,
        recent_videos: [],
        youtube_error: null,
      },
      instagram: {
        freddiefujiwara: 1988,
        anemone_cancer: 59,
        media_count: 2404,
        views_30d: 10000,
        non_follower_pct: 96.3,
        insights_error: null,
        reach_30d: 5000,
        accounts_engaged_30d: 1200,
        interactions_30d: { total: 3000, likes: 2000, comments: 300, shares: 400, saves: 300 },
        profile_links_taps_30d: 46,
        profile_links_taps_source: 'total_value',
        follows_30d: 498,
        unfollows_30d: 58,
        demographics: { age_gender: [], top_cities: [], top_countries: [] },
        detail_error: null,
        recent_media: [
          {
            id: 'media-reel-1',
            type: 'REELS',
            posted_at: '2026-11-08T03:00:00+0000',
            caption: 'リールのキャプション',
            permalink: 'https://www.instagram.com/reel/ABC/',
            views: 1000,
            reach: 900,
            likes: 50,
            comments: 5,
            shares: 3,
            saves: 7,
            avg_watch_sec: 8.5,
            total_watch_sec: 765,
          },
          {
            id: 'media-image-1',
            type: 'FEED',
            posted_at: '2026-11-07T03:00:00+0000',
            caption: '写真のキャプション',
            permalink: 'https://www.instagram.com/p/DEF/',
            views: 100,
            reach: 90,
            likes: 10,
            comments: 1,
            shares: 0,
            saves: 2,
            avg_watch_sec: null,
            total_watch_sec: null,
          },
        ],
        media_error: null,
      },
      threads: { followers: 252 },
    });

    const expectedAccountValues = [
      1988, 59, 252, 8, 2248, 2404, 10000, 96.3, 5000, 1200, 3000, 2000, 300,
      400, 300, 46, 'total_value', 498, 58, 123456, 42,
    ];

    beforeEach(() => {
      sheets = {};
      spreadsheet = {
        getSheetByName: (name) => sheets[name] || null,
        insertSheet: (name) => {
          sheets[name] = makeSheet();
          return sheets[name];
        },
      };
      openById = vi.fn(() => spreadsheet);
      global.SpreadsheetApp = { openById };
    });

    it('builds the account row from a snapshot fixture', () => {
      expect(Code.buildSnsHistoryAccountRow_(fixtureSnapshot())).toEqual([
        '2026-11-09T00:00:00.000Z',
        ...expectedAccountValues,
      ]);
    });

    it('builds one media row per recent post from a snapshot fixture', () => {
      expect(Code.buildSnsHistoryMediaRows_(fixtureSnapshot())).toEqual([
        [
          '2026-11-09T00:00:00.000Z',
          'media-reel-1',
          '2026-11-08T03:00:00+0000',
          'REELS',
          'リールのキャプション',
          'https://www.instagram.com/reel/ABC/',
          1000, 900, 50, 5, 3, 7, 8.5, 765,
        ],
        [
          '2026-11-09T00:00:00.000Z',
          'media-image-1',
          '2026-11-07T03:00:00+0000',
          'FEED',
          '写真のキャプション',
          'https://www.instagram.com/p/DEF/',
          100, 90, 10, 1, 0, 2, '', '',
        ],
      ]);
    });

    it('blanks null values and the total when every follower count is null', () => {
      const row = Code.buildSnsHistoryAccountRow_({
        collected_at: '2026-11-09T00:00:00.000Z',
        youtube: { subscribers: null, total_views: null, video_count: null },
        instagram: {
          freddiefujiwara: null,
          anemone_cancer: null,
          interactions_30d: null,
          profile_links_taps_source: null,
        },
        threads: { followers: null },
      });
      expect(row).toHaveLength(Code.SNS_HISTORY_ACCOUNT_COLUMNS.length);
      expect(row[0]).toBe('2026-11-09T00:00:00.000Z');
      expect(row.slice(1)).toEqual(
        Array(Code.SNS_HISTORY_ACCOUNT_COLUMNS.length - 1).fill('')
      );
      expect(Code.buildSnsHistoryMediaRows_({ instagram: { recent_media: null } })).toEqual([]);
    });

    it('does not touch SpreadsheetApp while SNS_HISTORY_SHEET_ID is unset', () => {
      Code.appendSnsHistory_(fixtureSnapshot());
      expect(openById).not.toHaveBeenCalled();

      store.META_ACCESS_TOKEN = 'meta-token';
      mockGraphSuccess();
      mockYouTubeFull();
      const snapshot = Code.collectSnsCounts();
      expect(snapshot).toBeTruthy();
      expect(store.SNS_COUNTS_SNAPSHOT).toBeTruthy();
      expect(openById).not.toHaveBeenCalled();
    });

    it('appends headers and rows end to end on collectSnsCounts', () => {
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      store.META_ACCESS_TOKEN = 'meta-token';
      mockGraphSuccess();
      mockYouTubeFull();

      Code.collectSnsCounts();

      expect(openById).toHaveBeenCalledWith('history-sheet-id');
      expect(sheets.account.rows[0]).toEqual(Code.SNS_HISTORY_ACCOUNT_COLUMNS);
      expect(sheets.account.rows).toHaveLength(2);
      expect(sheets.account.rows[1].slice(1)).toEqual(expectedAccountValues);
      expect(sheets.media.rows[0]).toEqual(Code.SNS_HISTORY_MEDIA_COLUMNS);
      expect(sheets.media.rows).toHaveLength(3);
      expect(sheets.media.rows[1].slice(1, 7)).toEqual([
        'media-reel-1',
        '2026-11-08T03:00:00+0000',
        'REELS',
        'リールのキャプション',
        'https://www.instagram.com/reel/ABC/',
        1000,
      ]);
    });

    it('writes each header only once and keeps an existing header', () => {
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      Code.appendSnsHistory_(fixtureSnapshot());
      Code.appendSnsHistory_(fixtureSnapshot());
      expect(sheets.account.rows).toHaveLength(3);
      expect(sheets.account.rows[0]).toEqual(Code.SNS_HISTORY_ACCOUNT_COLUMNS);
      expect(sheets.account.rows[1].slice(1)).toEqual(expectedAccountValues);
      expect(sheets.account.rows[2].slice(1)).toEqual(expectedAccountValues);
      expect(sheets.media.rows).toHaveLength(5);
      expect(sheets.media.rows[0]).toEqual(Code.SNS_HISTORY_MEDIA_COLUMNS);

      const headed = makeSheet();
      headed.rows.push(['preset', 'header']);
      sheets.account = headed;
      sheets.media = makeSheet();
      sheets.media.rows.push(['preset', 'header']);
      Code.appendSnsHistory_(fixtureSnapshot());
      expect(headed.rows).toHaveLength(2);
      expect(headed.rows[0]).toEqual(['preset', 'header']);
      expect(sheets.media.rows[0]).toEqual(['preset', 'header']);
    });

    it('keeps collectSnsCounts successful when the append throws', () => {
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      openById.mockImplementation(() => {
        throw new Error('drive exploded for history-sheet-id');
      });
      store.META_ACCESS_TOKEN = 'meta-token';
      mockGraphSuccess();
      mockYouTubeFull();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const snapshot = Code.collectSnsCounts();
        expect(snapshot.instagram.freddiefujiwara).toBe(1988);
        expect(JSON.parse(store.SNS_COUNTS_SNAPSHOT)).toEqual(snapshot);
        const failures = logSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith('SNS history append failed:'));
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('drive exploded');
        expect(failures[0]).not.toContain('history-sheet-id');
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('doGet action=sns_history', () => {
    const HEADER = Code.SNS_HISTORY_ACCOUNT_COLUMNS;

    // A readable stand-in for a Sheets sheet: rows are the raw cell
    // values ('' for empty, Date objects for timestamps).
    const makeReadableSheet = (rows) => ({
      getLastRow: () => rows.length,
      getRange: (row, col, numRows, numCols) => ({
        getValues: () =>
          rows
            .slice(row - 1, row - 1 + numRows)
            .map((r) => r.slice(col - 1, col - 1 + numCols)),
      }),
    });

    const dataRow = (overrides) => {
      const row = Array(HEADER.length).fill('');
      const set = (column, value) => {
        row[HEADER.indexOf(column)] = value;
      };
      set('collected_at', '2026-11-09T00:00:00.000Z');
      set('ig_followers', 1988);
      set('threads_followers', 252);
      set('youtube_subscribers', 8);
      set('total_followers', 2248);
      set('media_count', 2404);
      set('views_30d', 10000);
      set('non_follower_pct', 96.3);
      set('reach_30d', 5000);
      set('interactions_total', 3000);
      set('follows_30d', 180);
      set('unfollows_30d', 30);
      set('yt_total_views', 123456);
      Object.entries(overrides || {}).forEach(([column, value]) =>
        set(column, value)
      );
      return row;
    };

    const serveHistory = (sheet) => {
      store.GA4_PROPERTY_ID = '561730442';
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      global.SpreadsheetApp = {
        openById: vi.fn(() => ({
          getSheetByName: (name) => (name === 'account' ? sheet : null),
        })),
      };
      Code.doGet({ parameter: { action: 'sns_history' } });
      return lastJson();
    };

    it('returns empty rows while SNS_HISTORY_SHEET_ID is unset', () => {
      store.GA4_PROPERTY_ID = '561730442';
      const openById = vi.fn(() => {
        throw new Error('SpreadsheetApp must not be touched');
      });
      global.SpreadsheetApp = { openById };
      Code.doGet({ parameter: { action: 'sns_history' } });
      expect(lastJson()).toEqual({ ok: true, action: 'sns_history', rows: [] });
      expect(openById).not.toHaveBeenCalled();
    });

    it('returns empty rows when the account sheet is missing or header-only', () => {
      expect(serveHistory(null).rows).toEqual([]);
      expect(serveHistory(makeReadableSheet([HEADER])).rows).toEqual([]);
    });

    it('converts cells: numbers stay numbers, blanks become null, Dates become ISO strings', () => {
      const sheet = makeReadableSheet([
        HEADER,
        dataRow({
          collected_at: new Date('2026-11-09T06:00:00.000Z'),
          views_30d: '',
          follows_30d: '',
        }),
      ]);
      const json = serveHistory(sheet);
      expect(json.ok).toBe(true);
      expect(json.action).toBe('sns_history');
      expect(json.rows).toEqual([
        {
          collected_at: '2026-11-09T06:00:00.000Z',
          ig_followers: 1988,
          threads_followers: 252,
          youtube_subscribers: 8,
          total_followers: 2248,
          media_count: 2404,
          views_30d: null,
          non_follower_pct: 96.3,
          reach_30d: 5000,
          interactions_total: 3000,
          follows_30d: null,
          unfollows_30d: 30,
          yt_total_views: 123456,
        },
      ]);
      // Only the 13 served columns come back: no anemone counts, no
      // taps source, no other sheet columns leak into the response.
      expect(Object.keys(json.rows[0])).toHaveLength(13);
    });

    it('sorts ascending by collected_at and drops timestamp-less rows', () => {
      const sheet = makeReadableSheet([
        HEADER,
        dataRow({ collected_at: '2026-11-09T12:00:00.000Z', ig_followers: 2000 }),
        dataRow({ collected_at: '', ig_followers: 1500 }),
        dataRow({ collected_at: '2026-11-09T00:00:00.000Z', ig_followers: 1988 }),
      ]);
      const json = serveHistory(sheet);
      expect(json.rows.map((row) => row.ig_followers)).toEqual([1988, 2000]);
    });

    it('caps the response at the newest 400 rows', () => {
      const rows = [HEADER];
      for (let i = 0; i < 405; i += 1) {
        const at = new Date(Date.UTC(2026, 0, 1) + i * 6 * 3600 * 1000);
        rows.push(dataRow({ collected_at: at.toISOString(), ig_followers: i }));
      }
      const json = serveHistory(makeReadableSheet(rows));
      expect(json.rows).toHaveLength(400);
      expect(json.rows[0].ig_followers).toBe(5);
      expect(json.rows[399].ig_followers).toBe(404);
    });

    it('rejects anonymous calls while authentication is configured', () => {
      store.GA4_PROPERTY_ID = '561730442';
      store.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
      store.AVAILABLE_GMAILS = 'owner@example.com';
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      global.SpreadsheetApp = {
        openById: vi.fn(() => ({ getSheetByName: () => null })),
      };
      Code.doGet({ parameter: { action: 'sns_history' } });
      expect(lastJson().ok).toBe(false);
      expect(lastJson().status).toBe(401);
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
          return res(200, totalValueBody('followers_count', 252));
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
          return res(200, totalValueBody('followers_count', 252));
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

  describe('doGet action=sns_detail', () => {
    const detailSnapshot = {
      collected_at: '2026-11-08T12:00:00.000Z',
      youtube: {
        subscribers: 8,
        total_views: 123456,
        video_count: 42,
        recent_videos: [{ id: 'vid1', title: '川口の歌' }],
        youtube_error: null,
      },
      instagram: {
        freddiefujiwara: 1988,
        reach_30d: 5000,
        demographics: { age_gender: [{ key: '25-34/F', value: 500 }] },
        recent_media: [{ id: 'media-1', views: 1000 }],
      },
      threads: { followers: 252 },
    };

    it('returns the empty detail shape before the first collection', () => {
      store.GA4_PROPERTY_ID = '561730442';
      Code.doGet({ parameter: { action: 'sns_detail' } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.action).toBe('sns_detail');
      expect(json.collected_at).toBeNull();
      expect(json.youtube).toEqual({
        subscribers: null,
        total_views: null,
        video_count: null,
        recent_videos: null,
        youtube_error: null,
      });
      expect(json.instagram.interactions_30d).toEqual({
        total: null,
        likes: null,
        comments: null,
        shares: null,
        saves: null,
      });
      expect(json.instagram.demographics).toEqual({
        age_gender: null,
        top_cities: null,
        top_countries: null,
      });
      expect(json.instagram.recent_media).toBeNull();
      expect(json.threads).toEqual({ followers: null, threads_error: null });
    });

    it('returns the full stored snapshot, detail included', () => {
      store.GA4_PROPERTY_ID = '561730442';
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(detailSnapshot);
      Code.doGet({ parameter: { action: 'sns_detail' } });
      expect(lastJson()).toEqual(
        Object.assign({ ok: true, action: 'sns_detail' }, detailSnapshot)
      );
    });

    it('rejects anonymous calls while authentication is configured', () => {
      store.GA4_PROPERTY_ID = '561730442';
      store.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
      store.AVAILABLE_GMAILS = 'owner@example.com';
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(detailSnapshot);
      Code.doGet({ parameter: { action: 'sns_detail' } });
      expect(lastJson().ok).toBe(false);
      expect(lastJson().status).toBe(401);
    });

    it('serves with a valid share token while authentication is configured', () => {
      store.GA4_PROPERTY_ID = '561730442';
      store.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
      store.AVAILABLE_GMAILS = 'owner@example.com';
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(detailSnapshot);
      global.Utilities = {
        computeDigest: vi.fn(() => new Array(32).fill(7)),
        getUuid: vi.fn(() => '12345678-1234-1234-1234-1234567890ab'),
        DigestAlgorithm: { SHA_256: 'SHA_256' },
      };
      const token = Code.issueShareSession_().share_token;
      Code.doGet({ parameter: { action: 'sns_detail', share_token: token } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.action).toBe('sns_detail');
      expect(json.instagram.reach_30d).toBe(5000);
    });

    it('serves with a valid id token while authentication is configured', () => {
      store.GA4_PROPERTY_ID = '561730442';
      store.GOOGLE_OAUTH_CLIENT_ID = 'client-id';
      store.AVAILABLE_GMAILS = 'owner@example.com';
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(detailSnapshot);
      fetchHandler = (url) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/tokeninfo')) {
          return res(200, {
            iss: 'https://accounts.google.com',
            aud: 'client-id',
            exp: Math.floor(Date.now() / 1000) + 3600,
            email_verified: 'true',
            email: 'owner@example.com',
            sub: '12345',
          });
        }
        throw new Error('unexpected url: ' + url);
      };
      Code.doGet({ parameter: { action: 'sns_detail', id_token: 'token' } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.action).toBe('sns_detail');
      expect(json.youtube.total_views).toBe(123456);
    });
  });

  describe('Instagram account detail', () => {
    const detailHandler = (overrides) => {
      const totals = Object.assign(
        {
          reach: 5000,
          accounts_engaged: 1200,
          total_interactions: 3000,
          likes: 2000,
          comments: 300,
          shares: 400,
          saves: 300,
          profile_links_taps: 46,
        },
        (overrides && overrides.totals) || {}
      );
      fetchHandler = (url) => {
        if (url.includes('metric=follows_and_unfollows')) {
          return overrides && overrides.follows
            ? overrides.follows()
            : res(200, followsBreakdownBody());
        }
        if (url.includes('/insights')) {
          const metric = metricFromUrl(url);
          if (overrides && overrides.errors && overrides.errors[metric]) {
            return overrides.errors[metric]();
          }
          if (metric in totals && totals[metric] !== null) {
            return res(200, totalValueBody(metric, totals[metric]));
          }
          throw new Error('unexpected insights metric: ' + metric);
        }
        throw new Error('unexpected url: ' + url);
      };
    };

    it('collects every metric and the follows split', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      detailHandler();
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail).toEqual({
        reach_30d: 5000,
        accounts_engaged_30d: 1200,
        interactions_30d: { total: 3000, likes: 2000, comments: 300, shares: 400, saves: 300 },
        profile_links_taps_30d: 46,
        profile_links_taps_source: 'total_value',
        follows_30d: 498,
        unfollows_30d: 58,
        detail_error: null,
      });
    });

    it('nulls only the failed metric and records its error without the token', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      detailHandler({
        errors: {
          reach: () => res(400, { error: { message: 'metric reach unsupported', code: 100 } }),
        },
      });
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail.reach_30d).toBeNull();
      expect(detail.accounts_engaged_30d).toBe(1200);
      expect(detail.interactions_30d.total).toBe(3000);
      expect(detail.follows_30d).toBe(498);
      expect(detail.detail_error).toContain('reach: HTTP 400 code=100');
      expect(detail.detail_error).toContain('metric reach unsupported');
      expect(detail.detail_error).not.toContain('meta-token');
    });

    it('keeps the follows split null when its request fails', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      detailHandler({
        follows: () => res(500, { error: { message: 'boom', code: 1 } }),
      });
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail.follows_30d).toBeNull();
      expect(detail.unfollows_30d).toBeNull();
      expect(detail.reach_30d).toBe(5000);
      expect(detail.detail_error).toContain('follows_and_unfollows: HTTP 500');
    });

    it('returns nulls without a token and never calls the API', () => {
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail.reach_30d).toBeNull();
      expect(detail.interactions_30d).toEqual({
        total: null,
        likes: null,
        comments: null,
        shares: null,
        saves: null,
      });
      expect(detail.detail_error).toBeNull();
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('parseFollowsBreakdown_ reads FOLLOWER as follows and NON_FOLLOWER as unfollows', () => {
      // The confirmed production shape: FOLLOWER=498, NON_FOLLOWER=58.
      expect(Code.parseFollowsBreakdown_(followsBreakdownBody())).toEqual({
        follows: 498,
        unfollows: 58,
      });
      expect(Code.parseFollowsBreakdown_(null)).toBeNull();
      expect(Code.parseFollowsBreakdown_({ data: [] })).toBeNull();
    });

    it('parseFollowsBreakdown_ matches the two labels exactly, ignoring case only', () => {
      const bodyWith = (pairs) =>
        totalValueBody('follows_and_unfollows', 0, [
          {
            dimension_keys: ['follow_type'],
            results: pairs.map(([dim, value]) => ({
              dimension_values: [dim],
              value,
            })),
          },
        ]);
      expect(
        Code.parseFollowsBreakdown_(bodyWith([['follower', 10], ['non_follower', 2]]))
      ).toEqual({ follows: 10, unfollows: 2 });
      // Looser readings from before the production diagnosis are gone:
      // only the two confirmed labels count as a split.
      expect(
        Code.parseFollowsBreakdown_(bodyWith([['FOLLOWS', 10], ['UNFOLLOWS', 2]]))
      ).toBeNull();
      expect(
        Code.parseFollowsBreakdown_(bodyWith([['FOLLOW', 10], ['UNFOLLOW', 2]]))
      ).toBeNull();
      expect(
        Code.parseFollowsBreakdown_(bodyWith([['FOLLOWER_FOLLOWS', 7]]))
      ).toBeNull();
      expect(
        Code.parseFollowsBreakdown_(bodyWith([['GAINED', 7], ['LOST', 1]]))
      ).toBeNull();
      expect(
        Code.followsBreakdownLabels_(bodyWith([['GAINED', 7], ['LOST', 1]]))
      ).toEqual(['GAINED', 'LOST']);
      expect(Code.followsBreakdownLabels_(null)).toEqual([]);
      expect(Code.followsBreakdownLabels_({ data: [] })).toEqual([]);
    });

    it('records the observed follows labels when no label matches', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      detailHandler({
        follows: () =>
          res(
            200,
            totalValueBody('follows_and_unfollows', 8, [
              {
                dimension_keys: ['follow_type'],
                results: [
                  { dimension_values: ['GAINED'], value: 7 },
                  { dimension_values: ['LOST'], value: 1 },
                ],
              },
            ])
          ),
      });
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail.follows_30d).toBeNull();
      expect(detail.unfollows_30d).toBeNull();
      expect(detail.detail_error).toContain(
        'follows_and_unfollows labels: [GAINED, LOST]'
      );
      expect(detail.detail_error).not.toContain('meta-token');
    });

    it('parseInsightsTotalValue_ and parseInsightsDailySum_ read only their own form', () => {
      const both = {
        data: [
          {
            name: 'profile_links_taps',
            period: 'day',
            total_value: { value: 9 },
            values: [{ value: 3 }, { value: 4 }],
          },
        ],
      };
      expect(Code.parseInsightsTotalValue_(both)).toBe(9);
      expect(Code.parseInsightsDailySum_(both)).toBe(7);
      expect(
        Code.parseInsightsTotalValue_({ data: [{ values: [{ value: 1 }] }] })
      ).toBeNull();
      expect(
        Code.parseInsightsDailySum_({ data: [{ total_value: { value: 1 } }] })
      ).toBeNull();
      expect(Code.parseInsightsTotalValue_(null)).toBeNull();
      expect(Code.parseInsightsDailySum_(null)).toBeNull();
    });

    const tapsDetailHandler = ({ firstBody, secondBody }) => {
      const totals = {
        reach: 5000,
        accounts_engaged: 1200,
        total_interactions: 3000,
        likes: 2000,
        comments: 300,
        shares: 400,
        saves: 300,
      };
      const calls = { taps: 0 };
      fetchHandler = (url) => {
        if (url.includes('metric=follows_and_unfollows')) {
          return res(200, followsBreakdownBody());
        }
        if (url.includes('/insights')) {
          const metric = metricFromUrl(url);
          if (metric === 'profile_links_taps') {
            calls.taps += 1;
            return res(200, calls.taps === 1 ? firstBody : secondBody);
          }
          if (metric in totals) {
            return res(200, totalValueBody(metric, totals[metric]));
          }
          throw new Error('unexpected insights metric: ' + metric);
        }
        throw new Error('unexpected url: ' + url);
      };
      return calls;
    };

    it('falls back to the daily sum when the taps total_value is 0', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      const calls = tapsDetailHandler({
        firstBody: totalValueBody('profile_links_taps', 0),
        secondBody: {
          data: [
            {
              name: 'profile_links_taps',
              period: 'day',
              values: [{ value: 3 }, { value: 4 }, { value: 0 }],
            },
          ],
        },
      });
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail.profile_links_taps_30d).toBe(7);
      expect(detail.profile_links_taps_source).toBe('daily_sum');
      expect(calls.taps).toBe(2);
    });

    it('sums daily values from the first response when its total_value is 0', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      const calls = tapsDetailHandler({
        firstBody: {
          data: [
            {
              name: 'profile_links_taps',
              period: 'day',
              total_value: { value: 0 },
              values: [{ value: 5 }, { value: 6 }],
            },
          ],
        },
      });
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail.profile_links_taps_30d).toBe(11);
      expect(detail.profile_links_taps_source).toBe('daily_sum');
      expect(calls.taps).toBe(1);
    });

    it('keeps the total_value form when it is positive', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      const calls = tapsDetailHandler({
        firstBody: totalValueBody('profile_links_taps', 46),
      });
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail.profile_links_taps_30d).toBe(46);
      expect(detail.profile_links_taps_source).toBe('total_value');
      expect(calls.taps).toBe(1);
    });

    it('nulls the taps and records the error when the request fails', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      detailHandler({
        errors: {
          profile_links_taps: () =>
            res(400, { error: { message: 'taps unsupported', code: 100 } }),
        },
      });
      const detail = Code.fetchInstagramAccountDetail_();
      expect(detail.profile_links_taps_30d).toBeNull();
      expect(detail.profile_links_taps_source).toBeNull();
      expect(detail.detail_error).toContain('profile_links_taps: HTTP 400 code=100');
    });
  });

  describe('Instagram demographics', () => {
    it('sorts rows, slices the top 10 and falls back to the age-only breakdown', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      const cities = Array.from({ length: 12 }, (_, i) => ({
        dimension_values: ['City' + (i + 1)],
        value: 120 - i * 10,
      }));
      fetchHandler = (url) => {
        if (url.includes('breakdown=age,gender')) {
          return res(400, { error: { message: 'single breakdown only', code: 100 } });
        }
        if (url.includes('breakdown=age')) {
          return res(
            200,
            demographicsBody(
              ['age'],
              [
                { dimension_values: ['18-24'], value: 300 },
                { dimension_values: ['25-34'], value: 500 },
              ]
            )
          );
        }
        if (url.includes('breakdown=city')) {
          return res(200, demographicsBody(['city'], cities));
        }
        if (url.includes('breakdown=country')) {
          return res(400, { error: { message: 'country unavailable', code: 100 } });
        }
        throw new Error('unexpected url: ' + url);
      };
      const { demographics, error } = Code.fetchInstagramDemographics_();
      expect(demographics.age_gender).toEqual([
        { key: '25-34', value: 500 },
        { key: '18-24', value: 300 },
      ]);
      expect(demographics.top_cities).toHaveLength(10);
      expect(demographics.top_cities[0]).toEqual({ key: 'City1', value: 120 });
      expect(demographics.top_cities[9]).toEqual({ key: 'City10', value: 30 });
      expect(demographics.top_countries).toBeNull();
      expect(error).toContain('demographics(top_countries)');
      expect(error).toContain('country unavailable');
      expect(error).not.toContain('age_gender');
    });

    it('returns null lists without a token and never calls the API', () => {
      const { demographics, error } = Code.fetchInstagramDemographics_();
      expect(demographics).toEqual({
        age_gender: null,
        top_cities: null,
        top_countries: null,
      });
      expect(error).toBeNull();
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('parseDemographicsBreakdown_ requires the requested dimensions', () => {
      const body = demographicsBody(
        ['age'],
        [{ dimension_values: ['25-34'], value: 500 }]
      );
      expect(Code.parseDemographicsBreakdown_(body, ['age'])).toEqual([
        { key: '25-34', value: 500 },
      ]);
      expect(Code.parseDemographicsBreakdown_(body, ['city'])).toBeNull();
      expect(Code.parseDemographicsBreakdown_(null, ['age'])).toBeNull();
    });
  });

  describe('Instagram recent media', () => {
    const reel = MEDIA_LIST[0];
    const image = MEDIA_LIST[1];

    it('builds entries with insights, converts watch time and keeps the full caption', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      const longCaption = 'あ'.repeat(100);
      fetchHandler = (url) => {
        if (url.includes('/media?')) {
          return res(200, { data: [Object.assign({}, reel, { caption: longCaption })] });
        }
        if (url.includes('media-reel-1/insights')) {
          return res(
            200,
            mediaInsightsBody([
              ['views', 1000],
              ['reach', 900],
              ['likes', 50],
              ['comments', 5],
              ['shares', 3],
              ['saved', 7],
              ['total_interactions', 65],
              ['ig_reels_avg_watch_time', 8500],
              ['ig_reels_video_view_total_time', 765432],
            ])
          );
        }
        throw new Error('unexpected url: ' + url);
      };
      const { recent_media, media_error } = Code.fetchInstagramRecentMedia_();
      expect(media_error).toBeNull();
      expect(recent_media).toHaveLength(1);
      expect(recent_media[0].caption).toHaveLength(100);
      expect(recent_media[0]).toEqual({
        id: 'media-reel-1',
        type: 'REELS',
        posted_at: '2026-11-08T03:00:00+0000',
        caption: longCaption,
        permalink: 'https://www.instagram.com/reel/ABC/',
        views: 1000,
        reach: 900,
        likes: 50,
        comments: 5,
        shares: 3,
        saves: 7,
        avg_watch_sec: 8.5,
        total_watch_sec: 765,
      });
    });

    it('caps a pathological caption at 2000 characters', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      const hugeCaption = 'あ'.repeat(2500);
      fetchHandler = (url) => {
        if (url.includes('/media?')) {
          return res(200, { data: [Object.assign({}, reel, { caption: hugeCaption })] });
        }
        if (url.includes('media-reel-1/insights')) {
          return res(200, mediaInsightsBody([['likes', 1]]));
        }
        throw new Error('unexpected url: ' + url);
      };
      const { recent_media } = Code.fetchInstagramRecentMedia_();
      expect(recent_media).toHaveLength(1);
      expect(recent_media[0].caption).toHaveLength(2000);
      expect(recent_media[0].caption).toBe(hugeCaption.slice(0, 2000));
    });

    it('retries with fewer metrics when the full set is rejected', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      fetchHandler = (url) => {
        if (url.includes('/media?')) {
          return res(200, { data: [image] });
        }
        if (url.includes('media-image-1/insights')) {
          if (url.includes('metric=views')) {
            return res(400, { error: { message: 'views unsupported', code: 100 } });
          }
          return res(
            200,
            mediaInsightsBody([
              ['reach', 90],
              ['likes', 10],
              ['comments', 1],
              ['saved', 2],
              ['total_interactions', 13],
            ])
          );
        }
        throw new Error('unexpected url: ' + url);
      };
      const { recent_media, media_error } = Code.fetchInstagramRecentMedia_();
      expect(media_error).toBeNull();
      expect(recent_media[0].views).toBeNull();
      expect(recent_media[0].reach).toBe(90);
      expect(recent_media[0].saves).toBe(2);
      expect(recent_media[0].likes).toBe(10);
    });

    it('keeps numbers null and reports when every attempt fails for a post', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      fetchHandler = (url) => {
        if (url.includes('/media?')) {
          return res(200, { data: [image] });
        }
        if (url.includes('/insights')) {
          return res(400, { error: { message: 'insights unavailable', code: 100 } });
        }
        throw new Error('unexpected url: ' + url);
      };
      const { recent_media, media_error } = Code.fetchInstagramRecentMedia_();
      expect(recent_media).toHaveLength(1);
      expect(recent_media[0].views).toBeNull();
      expect(recent_media[0].likes).toBeNull();
      expect(media_error).toContain('1 of 1 media insights failed');
      expect(media_error).toContain('HTTP 400');
      expect(media_error).not.toContain('meta-token');
    });

    it('returns null when the media list itself fails', () => {
      store.META_ACCESS_TOKEN = 'meta-token';
      fetchHandler = () => res(400, { error: { message: 'bad token', code: 190 } });
      const { recent_media, media_error } = Code.fetchInstagramRecentMedia_();
      expect(recent_media).toBeNull();
      expect(media_error).toContain('media list: HTTP 400 code=190');
    });

    it('returns nulls without a token and never calls the API', () => {
      expect(Code.fetchInstagramRecentMedia_()).toEqual({
        recent_media: null,
        media_error: null,
      });
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('parseMediaInsights_ maps saved and converts milliseconds to seconds', () => {
      expect(
        Code.parseMediaInsights_({
          data: [
            { name: 'saved', values: [{ value: 3 }] },
            { name: 'ig_reels_avg_watch_time', values: [{ value: 12345 }] },
            { name: 'ig_reels_video_view_total_time', values: [{ value: 999 }] },
            { name: 'total_interactions', values: [{ value: 10 }] },
          ],
        })
      ).toEqual({ saves: 3, avg_watch_sec: 12.3, total_watch_sec: 1 });
      expect(Code.parseMediaInsights_(null)).toEqual({});
    });
  });

  describe('YouTube detail', () => {
    it('collects channel totals and the newest videos', () => {
      mockYouTubeFull();
      const detail = Code.fetchYouTubeChannelDetail_();
      expect(detail).toEqual({
        subscribers: 8,
        total_views: 123456,
        video_count: 42,
        recent_videos: [
          {
            id: 'vid1',
            title: '川口の歌',
            published_at: '2026-11-08T00:00:00Z',
            views: 1000,
            likes: 50,
            comments: 4,
            url: 'https://www.youtube.com/watch?v=vid1',
          },
        ],
        youtube_error: null,
      });
      expect(global.YouTube.PlaylistItems.list).toHaveBeenCalledWith('snippet', {
        playlistId: 'UUuploads',
        maxResults: 10,
      });
      expect(global.YouTube.Videos.list).toHaveBeenCalledWith('statistics', {
        id: 'vid1',
      });
    });

    it('records the error and keeps nulls when the API throws', () => {
      global.YouTube = {
        Channels: {
          list: vi.fn(() => {
            throw new Error('quota exceeded');
          }),
        },
        PlaylistItems: { list: vi.fn(() => ({ items: [] })) },
        Videos: { list: vi.fn(() => ({ items: [] })) },
      };
      const detail = Code.fetchYouTubeChannelDetail_();
      expect(detail.subscribers).toBeNull();
      expect(detail.total_views).toBeNull();
      expect(detail.video_count).toBeNull();
      expect(detail.recent_videos).toBeNull();
      expect(detail.youtube_error).toContain('quota exceeded');
    });

    it('keeps the videos when only the statistics call fails', () => {
      mockYouTubeFull();
      const full = global.YouTube.Channels.list.getMockImplementation();
      global.YouTube.Channels.list = vi.fn((part) => {
        if (part === 'statistics') {
          throw new Error('statistics down');
        }
        return full(part);
      });
      const detail = Code.fetchYouTubeChannelDetail_();
      expect(detail.subscribers).toBeNull();
      expect(detail.total_views).toBeNull();
      expect(detail.recent_videos).toHaveLength(1);
      expect(detail.youtube_error).toContain('statistics down');
      expect(detail.youtube_error).not.toContain('recent videos');
    });

    it('reports the unavailable service and keeps subscribers null', () => {
      const detail = Code.fetchYouTubeChannelDetail_();
      expect(detail.subscribers).toBeNull();
      expect(detail.recent_videos).toBeNull();
      expect(detail.youtube_error).toBe('YouTube advanced service is unavailable');
      expect(Code.fetchYouTubeSubscribers_()).toBeNull();
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
