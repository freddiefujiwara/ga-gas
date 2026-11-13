import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as Code from '../src/Code.js';

// Stage 2: the /social screen's reads (sns_detail and the blog
// reports) are assembled from the history spreadsheet. These
// tests pin the sheet -> response mapping, the snapshot
// fallback of sns_detail, and the fixed report shapes.
describe('Sheet-backed read side (stage 2)', () => {
  let outputs;
  let store;
  let fetchHandler;
  let sheets;
  let spreadsheet;
  let openById;
  let nowSpy;

  const res = (status, body) => ({
    getResponseCode: () => status,
    getContentText: () =>
      typeof body === 'string' ? body : JSON.stringify(body),
  });

  const makeSheet = () => {
    const sheet = {
      rows: [],
      getLastRow() {
        return sheet.rows.length;
      },
      getRange(row, col, numRows, numCols) {
        return {
          setValues: (values) => {
            values.forEach((valueRow, i) => {
              sheet.rows[row - 1 + i] = valueRow.slice();
            });
          },
          getValues: () => {
            const out = [];
            for (let i = 0; i < numRows; i++) {
              const source = sheet.rows[row - 1 + i] || [];
              out.push(
                source.slice(col - 1, col - 1 + (numCols || source.length))
              );
            }
            return out;
          },
        };
      },
      appendRow(row) {
        sheet.rows.push(row.slice());
      },
      deleteRows(position, count) {
        sheet.rows.splice(position - 1, count);
      },
    };
    return sheet;
  };

  // Installs a fake history spreadsheet whose tabs hold the
  // given rows (arrays of raw cells, header row first).
  const serveTabs = (tabs) => {
    sheets = {};
    for (const [name, rows] of Object.entries(tabs)) {
      const sheet = makeSheet();
      sheet.rows = rows.map((row) => row.slice());
      sheets[name] = sheet;
    }
    spreadsheet = {
      getSheetByName: (name) => sheets[name] || null,
      insertSheet: (name) => {
        sheets[name] = makeSheet();
        return sheets[name];
      },
    };
    openById = vi.fn(() => spreadsheet);
    global.SpreadsheetApp = { openById };
    store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
  };

  const lastJson = () => JSON.parse(outputs[outputs.length - 1].text);

  // The private actions sit behind the auth gate, so the doGet
  // integration tests present a freshly issued share token.
  const testShareToken = () => Code.issueShareSession_().share_token;

  const accountRow = (values) => {
    const row = Code.SNS_HISTORY_ACCOUNT_COLUMNS.map(() => '');
    for (const [name, value] of Object.entries(values)) {
      row[Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf(name)] = value;
    }
    return row;
  };

  const AT_OLD = '2026-11-09T05:00:00.000Z';
  const AT_NEW = '2026-11-09T06:00:00.000Z';

  const detailTabs = () => ({
    account: [
      Code.SNS_HISTORY_ACCOUNT_COLUMNS,
      accountRow({
        collected_at: AT_OLD,
        ig_followers: 1990,
        threads_followers: 250,
        youtube_subscribers: 8,
      }),
      accountRow({
        collected_at: AT_NEW,
        ig_followers: 2000,
        ig_anemone_followers: 59,
        threads_followers: 252,
        youtube_subscribers: 10,
        media_count: 2420,
        views_30d: 585650,
        non_follower_pct: 94.5,
        reach_30d: 150636,
        accounts_engaged_30d: 30000,
        interactions_total: 42000,
        interactions_likes: 30000,
        interactions_comments: 5000,
        interactions_shares: 4000,
        interactions_saves: 3000,
        profile_links_taps_30d: '',
        profile_links_taps_source: '',
        follows_30d: 498,
        unfollows_30d: 58,
        yt_total_views: 3599,
        yt_video_count: 7,
      }),
    ],
    media: [
      Code.SNS_HISTORY_MEDIA_COLUMNS,
      [
        AT_NEW, 'media-old', '2026-11-07T03:00:00+0000', 'FEED', '古い投稿',
        'https://www.instagram.com/p/OLD/', 100, 90, 10, 1, 0, 2, '', '',
      ],
      [
        AT_NEW, 'media-new', '2026-11-08T03:00:00+0000', 'REELS', '新しい投稿',
        'https://www.instagram.com/reel/NEW/', 1000, 900, 50, 5, 3, 7, 8.5, 765,
        'https://example.com/thumb-new.jpg',
      ],
    ],
    daily: [
      Code.SNS_HISTORY_DAILY_COLUMNS,
      ['2026-11-08', 40, 3, AT_NEW],
      ['2026-11-07', 30, 2, AT_NEW],
    ],
    threads_media: [
      Code.SNS_HISTORY_THREADS_MEDIA_COLUMNS,
      [
        AT_NEW, 'th-1', '2026-11-08T12:00:00Z', 'TEXT_POST', 'スレッズ投稿',
        'https://www.threads.net/@freddiefujiwara/post/XYZ/', 100, 10, 2, 1, 0,
      ],
    ],
    youtube_media: [
      Code.SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS,
      [AT_NEW, 'vid-old', '2026-11-01T00:00:00Z', '前の動画', 300, 10, 1],
      [AT_NEW, 'vid-new', '2026-11-08T00:00:00Z', '新しい動画', 500, 20, 3],
    ],
    ig_demographics: [
      Code.SNS_HISTORY_DEMOGRAPHICS_COLUMNS,
      ['age_gender|25-34/F', 'age_gender', '25-34/F', 500, AT_NEW],
      ['age_gender|35-44/M', 'age_gender', '35-44/M', 700, AT_NEW],
      ['city|Kawaguchi', 'city', 'Kawaguchi', 800, AT_NEW],
      ['city|Tokyo', 'city', 'Tokyo', 300, AT_NEW],
      ['country|JP', 'country', 'JP', 1900, AT_NEW],
    ],
    threads_account: [
      Code.SNS_HISTORY_THREADS_ACCOUNT_COLUMNS,
      ['views_30d', 53558, AT_NEW],
      ['interactions_total', 815, AT_NEW],
      ['interactions_likes', 654, AT_NEW],
      ['interactions_replies', 151, AT_NEW],
      ['interactions_reposts', 3, AT_NEW],
      ['interactions_quotes', 0, AT_NEW],
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    store = {};
    sheets = {};
    fetchHandler = () => {
      throw new Error('unexpected fetch: the read side must not fetch');
    };
    delete global.YouTube;
    delete global.CacheService;
    delete global.SpreadsheetApp;
    nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-11-09T03:00:00.000Z'));

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
    let uuidCounter = 0;
    global.Utilities = {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: vi.fn((algo, value) => [
        ...createHash('sha256').update(String(value)).digest(),
      ]),
      getUuid: vi.fn(() => '00000000-0000-4000-8000-00000000000' + uuidCounter++),
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
      fetch: vi.fn((url, options) => fetchHandler(url, options)),
    };
    global.ScriptApp = {
      getOAuthToken: vi.fn(() => 'test-token'),
    };
    store.GA4_PROPERTY_ID = '561730442';
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  describe('buildSnsDetailFromSheet_', () => {
    it('assembles the detail from the tabs around the newest account row', () => {
      serveTabs(detailTabs());
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.collected_at).toBe(AT_NEW);
      expect(detail.youtube).toEqual({
        subscribers: 10,
        total_views: 3599,
        video_count: 7,
        recent_videos: [
          {
            id: 'vid-new',
            title: '新しい動画',
            published_at: '2026-11-08T00:00:00Z',
            views: 500,
            likes: 20,
            comments: 3,
            url: 'https://www.youtube.com/watch?v=vid-new',
          },
          {
            id: 'vid-old',
            title: '前の動画',
            published_at: '2026-11-01T00:00:00Z',
            views: 300,
            likes: 10,
            comments: 1,
            url: 'https://www.youtube.com/watch?v=vid-old',
          },
        ],
        youtube_error: null,
      });
      expect(detail.instagram.freddiefujiwara).toBe(2000);
      expect(detail.instagram.anemone_cancer).toBe(59);
      expect(detail.instagram.interactions_30d).toEqual({
        total: 42000,
        likes: 30000,
        comments: 5000,
        shares: 4000,
        saves: 3000,
      });
      expect(detail.instagram.profile_links_taps_30d).toBeNull();
      expect(detail.instagram.recent_media.map((m) => m.id)).toEqual([
        'media-new',
        'media-old',
      ]);
      expect(detail.instagram.recent_media[0].avg_watch_sec).toBe(8.5);
      expect(detail.instagram.recent_media[1].avg_watch_sec).toBeNull();
      // The thumbnail column rides at the end of the media tab; a
      // row written before the column existed reads back null.
      expect(detail.instagram.recent_media[0].thumbnail_url).toBe(
        'https://example.com/thumb-new.jpg'
      );
      expect(detail.instagram.recent_media[1].thumbnail_url).toBeNull();
      expect(detail.instagram.daily_follows).toEqual([
        { date: '2026-11-07', follows: 30, unfollows: 2 },
        { date: '2026-11-08', follows: 40, unfollows: 3 },
      ]);
      expect(detail.instagram.daily_follows_missing_days).toBeNull();
      expect(detail.instagram.daily_follows_error).toBeNull();
      expect(detail.instagram.demographics).toEqual({
        age_gender: [
          { key: '35-44/M', value: 700 },
          { key: '25-34/F', value: 500 },
        ],
        top_cities: [
          { key: 'Kawaguchi', value: 800 },
          { key: 'Tokyo', value: 300 },
        ],
        top_countries: [{ key: 'JP', value: 1900 }],
      });
      expect(detail.instagram.insights_error).toBeNull();
      expect(detail.instagram.media_error).toBeNull();
      expect(detail.threads).toEqual({
        followers: 252,
        threads_error: null,
        views_30d: 53558,
        interactions_30d: {
          total: 815,
          likes: 654,
          replies: 151,
          reposts: 3,
          quotes: 0,
        },
        detail_error: null,
        recent_posts: [
          {
            id: 'th-1',
            type: 'TEXT_POST',
            posted_at: '2026-11-08T12:00:00Z',
            text: 'スレッズ投稿',
            permalink: 'https://www.threads.net/@freddiefujiwara/post/XYZ/',
            views: 100,
            likes: 10,
            replies: 2,
            reposts: 1,
            quotes: 0,
          },
        ],
        posts_error: null,
      });
    });

    it('returns null while the sheet is unconfigured or holds no account rows', () => {
      expect(Code.buildSnsDetailFromSheet_()).toBeNull();
      serveTabs({ account: [Code.SNS_HISTORY_ACCOUNT_COLUMNS] });
      expect(Code.buildSnsDetailFromSheet_()).toBeNull();
      serveTabs({});
      expect(Code.buildSnsDetailFromSheet_()).toBeNull();
    });

    it('keeps sections null when their tab was never written', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({ collected_at: AT_NEW, ig_followers: 2000 }),
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.instagram.freddiefujiwara).toBe(2000);
      expect(detail.instagram.recent_media).toBeNull();
      expect(detail.instagram.daily_follows).toBeNull();
      expect(detail.instagram.demographics).toEqual({
        age_gender: null,
        top_cities: null,
        top_countries: null,
      });
      expect(detail.youtube.recent_videos).toBeNull();
      expect(detail.threads.recent_posts).toBeNull();
      expect(detail.threads.views_30d).toBeNull();
    });

    it('normalizes Date cells Sheets coerced (daily keys, timestamps)', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: new Date(AT_NEW),
            ig_followers: 2000,
          }),
        ],
        daily: [
          Code.SNS_HISTORY_DAILY_COLUMNS,
          [new Date('2026-11-07T15:00:00.000Z'), 30, 2, AT_NEW],
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.collected_at).toBe(AT_NEW);
      expect(detail.instagram.daily_follows).toEqual([
        { date: '2026-11-08', follows: 30, unfollows: 2 },
      ]);
    });
  });

  describe('buildSnsDetailResponse_ fallback and cache', () => {
    const snapshot = {
      collected_at: '2026-11-08T12:00:00.000Z',
      youtube: { subscribers: 8 },
      instagram: { freddiefujiwara: 1988 },
      threads: { followers: 250 },
    };

    it('serves the stored snapshot verbatim when the sheet is unconfigured', () => {
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(snapshot);
      expect(Code.buildSnsDetailResponse_()).toEqual(
        Object.assign({ ok: true, action: 'sns_detail' }, snapshot)
      );
    });

    it('serves the empty shape before any collection', () => {
      const response = Code.buildSnsDetailResponse_();
      expect(response.ok).toBe(true);
      expect(response.collected_at).toBeNull();
      expect(response.instagram.recent_media).toBeNull();
    });

    it('falls back to the snapshot when the sheet read throws', () => {
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(snapshot);
      global.SpreadsheetApp = {
        openById: vi.fn(() => {
          throw new Error('drive exploded for history-sheet-id');
        }),
      };
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const response = Code.buildSnsDetailResponse_();
        expect(response.instagram.freddiefujiwara).toBe(1988);
        const line = logSpy.mock.calls
          .map((call) => String(call[0]))
          .find((text) => text.startsWith('SNS detail from sheet failed:'));
        expect(line).toBeTruthy();
        expect(line).not.toContain('history-sheet-id');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('prefers the sheet over the snapshot when both exist', () => {
      serveTabs(detailTabs());
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(snapshot);
      const response = Code.buildSnsDetailResponse_();
      expect(response.collected_at).toBe(AT_NEW);
      expect(response.instagram.freddiefujiwara).toBe(2000);
    });

    it('serves the second call from CacheService without re-reading the sheet', () => {
      serveTabs(detailTabs());
      const cacheStore = new Map();
      global.CacheService = {
        getScriptCache: () => ({
          get: (key) => (cacheStore.has(key) ? cacheStore.get(key) : null),
          put: (key, value) => cacheStore.set(key, value),
        }),
      };
      const first = Code.buildSnsDetailResponse_();
      const second = Code.buildSnsDetailResponse_();
      expect(second).toEqual(first);
      expect(openById).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildBlogReportResponse_', () => {
    const paramsFor = (overrides) =>
      Object.assign(
        {
          startDate: '28daysAgo',
          endDate: 'today',
          metrics: ['screenPageViews', 'activeUsers', 'sessions'],
          dimensions: ['pagePath'],
          limit: 25,
          offset: 0,
          filters: [],
        },
        overrides || {}
      );

    const blogTabs = () => ({
      blog_totals: [
        Code.SNS_HISTORY_BLOG_TOTALS_COLUMNS,
        ['28d', 4925, 241, 900, AT_NEW],
      ],
      blog_daily: [
        Code.SNS_HISTORY_BLOG_DAILY_COLUMNS,
        ['2026-10-11', 999, 90, 100, '', '', AT_OLD],
        ['2026-10-12', 100, 40, 55, 2400, 7, AT_NEW],
        ['2026-11-09', 30, 12, 15, 2500, '', AT_NEW],
      ],
      blog_pages: [
        Code.SNS_HISTORY_BLOG_PAGES_COLUMNS,
        ['/stale-page', '古い窓のページ', 9999, AT_OLD],
        ['/blog/1abcdefghijklmnopqrstuvwx', '記事タイトル', 321, AT_NEW],
        ['/', 'トップ', 123, AT_NEW],
      ],
      blog_sources: [
        Code.SNS_HISTORY_BLOG_SOURCES_COLUMNS,
        ['Direct', 300, AT_NEW],
        ['Organic Search', 800, AT_NEW],
      ],
    });

    it('serves the totals shape from blog_totals', () => {
      serveTabs(blogTabs());
      const response = Code.buildBlogReportResponse_(
        paramsFor({ dimensions: [], limit: 1 }),
        null
      );
      expect(response.ok).toBe(true);
      expect(response.property).toBe('561730442');
      expect(response.startDate).toBe('28daysAgo');
      expect(response.data).toEqual({
        rows: [
          {
            dimensionValues: [],
            metricValues: [
              { value: '4925' },
              { value: '241' },
              { value: '900' },
            ],
          },
        ],
        rowCount: 1,
      });
      expect(response._share).toBeUndefined();
    });

    it('carries _share for the share-validation call', () => {
      serveTabs(blogTabs());
      const response = Code.buildBlogReportResponse_(
        paramsFor({ dimensions: [], limit: 1 }),
        { expires_at: '2026-12-06T02:47:00.000Z' }
      );
      expect(response.ok).toBe(true);
      expect(response._share).toEqual({
        expires_at: '2026-12-06T02:47:00.000Z',
      });
    });

    it('serves the daily shape inside the requested window only', () => {
      serveTabs(blogTabs());
      const response = Code.buildBlogReportResponse_(
        paramsFor({
          dimensions: ['date'],
          metrics: ['screenPageViews'],
          limit: 40,
        }),
        null
      );
      expect(response.ok).toBe(true);
      expect(response.data.rowCount).toBe(2);
      expect(response.data.rows).toEqual([
        { dimensionValues: [{ value: '20261012' }], metricValues: [{ value: '100' }] },
        { dimensionValues: [{ value: '20261109' }], metricValues: [{ value: '30' }] },
      ]);
    });

    it('serves the pages shape from the newest collection batch only', () => {
      serveTabs(blogTabs());
      const response = Code.buildBlogReportResponse_(paramsFor(), null);
      expect(response.ok).toBe(true);
      expect(response.data.rowCount).toBe(2);
      expect(response.data.rows).toEqual([
        {
          dimensionValues: [{ value: '/blog/1abcdefghijklmnopqrstuvwx' }],
          metricValues: [{ value: '321' }, { value: '0' }, { value: '0' }],
        },
        {
          dimensionValues: [{ value: '/' }],
          metricValues: [{ value: '123' }, { value: '0' }, { value: '0' }],
        },
      ]);
    });

    it('serves the speed shape from blog_speed, slowest average first', () => {
      serveTabs(
        Object.assign(blogTabs(), {
          blog_speed: [
            Code.SNS_HISTORY_BLOG_SPEED_COLUMNS,
            ['/blog/9stalearticle00000000000', '古い窓の記事', 999999, 1, AT_OLD],
            ['/blog/1abcdefghijklmnopqrstuvwx', '記事タイトル', 40000, 20, AT_NEW],
            ['/blog/2abcdefghijklmnopqrstuvwx', '', 9000, 3, AT_NEW],
          ],
        })
      );
      const response = Code.buildBlogReportResponse_(
        paramsFor({
          metrics: ['customEvent:render_ms', 'eventCount'],
          dimensions: ['pagePath'],
          limit: 25,
        }),
        null
      );
      expect(response.ok).toBe(true);
      expect(response.data.rowCount).toBe(2);
      expect(response.data.rows).toEqual([
        {
          dimensionValues: [{ value: '/blog/2abcdefghijklmnopqrstuvwx' }],
          metricValues: [{ value: '9000' }, { value: '3' }],
        },
        {
          dimensionValues: [{ value: '/blog/1abcdefghijklmnopqrstuvwx' }],
          metricValues: [{ value: '40000' }, { value: '20' }],
        },
      ]);
    });

    it('serves the sources shape sorted by views', () => {
      serveTabs(blogTabs());
      const response = Code.buildBlogReportResponse_(
        paramsFor({
          dimensions: ['sessionDefaultChannelGroup'],
          metrics: ['screenPageViews'],
          limit: 8,
        }),
        null
      );
      expect(response.ok).toBe(true);
      expect(response.data.rows).toEqual([
        {
          dimensionValues: [{ value: 'Organic Search' }],
          metricValues: [{ value: '800' }],
        },
        {
          dimensionValues: [{ value: 'Direct' }],
          metricValues: [{ value: '300' }],
        },
      ]);
    });

    it('rejects shapes and filters the sheet cannot answer', () => {
      serveTabs(blogTabs());
      expect(
        Code.buildBlogReportResponse_(
          paramsFor({ dimensions: ['sessionMedium'] }),
          null
        ).ok
      ).toBe(false);
      const filtered = Code.buildBlogReportResponse_(
        paramsFor({
          filters: [
            { fieldName: 'pagePath', matchType: 'CONTAINS', value: '/blog/' },
          ],
        }),
        null
      );
      expect(filtered.ok).toBe(false);
      expect(filtered.error).toContain('unsupported report parameters');
      expect(
        Code.buildBlogReportResponse_(
          paramsFor({ dimensions: [], metrics: ['sessions'] }),
          null
        ).ok
      ).toBe(false);
    });

    it('answers "not collected yet" when the sheet holds no blog data', () => {
      serveTabs({});
      const response = Code.buildBlogReportResponse_(paramsFor(), null);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('has not been collected');
      delete store.SNS_HISTORY_SHEET_ID;
      expect(Code.buildBlogReportResponse_(paramsFor(), null).ok).toBe(false);
    });
  });

  describe('doGet integration', () => {
    it('serves sns_detail from the sheet without any fetch', () => {
      serveTabs(detailTabs());
      Code.doGet({
        parameter: { action: 'sns_detail', share_token: testShareToken() },
      });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.action).toBe('sns_detail');
      expect(json.collected_at).toBe(AT_NEW);
      expect(json.instagram.freddiefujiwara).toBe(2000);
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('serves the default report from the sheet without any fetch', () => {
      serveTabs({
        blog_pages: [
          Code.SNS_HISTORY_BLOG_PAGES_COLUMNS,
          ['/', 'トップ', 123, AT_NEW],
        ],
      });
      Code.doGet({ parameter: { share_token: testShareToken() } });
      const json = lastJson();
      expect(json.ok).toBe(true);
      expect(json.data.rows).toHaveLength(1);
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });
  });

  describe('read performance: chunked cache, bounded reads, precompute', () => {
    const installCache = () => {
      const cacheStore = new Map();
      global.CacheService = {
        getScriptCache: () => ({
          get: (key) => (cacheStore.has(key) ? cacheStore.get(key) : null),
          put: (key, value) => cacheStore.set(key, value),
          remove: (key) => cacheStore.delete(key),
        }),
      };
      return cacheStore;
    };

    it('round-trips a payload larger than one cache value', () => {
      const backing = new Map();
      const cache = {
        get: (key) => (backing.has(key) ? backing.get(key) : null),
        put: (key, value) => backing.set(key, value),
      };
      const text = 'x'.repeat(75000) + 'END';
      expect(Code.putCachedText_(cache, 'k', text, 60)).toBe(true);
      expect(Code.getCachedText_(cache, 'k')).toBe(text);
      // A missing chunk reads as a miss, never as a corrupt value.
      backing.delete('k#1');
      expect(Code.getCachedText_(cache, 'k')).toBeNull();
      expect(Code.getCachedText_(cache, 'absent')).toBeNull();
      // A payload past the chunk cap is refused, not truncated.
      expect(
        Code.putCachedText_(cache, 'big', 'y'.repeat(30000 * 41), 60)
      ).toBe(false);
      expect(Code.getCachedText_(null, 'k')).toBeNull();
    });

    it('serves sns_history from the cache without re-reading the sheet', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({ collected_at: AT_OLD, ig_followers: 1990 }),
          accountRow({ collected_at: AT_NEW, ig_followers: 2000 }),
        ],
      });
      installCache();
      const first = Code.buildSnsHistoryResponse_();
      expect(first.rows).toHaveLength(2);
      expect(openById).toHaveBeenCalledTimes(1);
      const second = Code.buildSnsHistoryResponse_();
      expect(second).toEqual(first);
      expect(openById).toHaveBeenCalledTimes(1);
    });

    it('serves the interaction breakdown columns in sns_history rows', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: AT_NEW,
            views_30d: 500000,
            reach_30d: 130000,
            interactions_total: 6400,
            interactions_likes: 4400,
            interactions_comments: 140,
            interactions_shares: 320,
            interactions_saves: 1130,
          }),
        ],
      });
      const response = Code.buildSnsHistoryResponse_();
      expect(response.rows).toHaveLength(1);
      const row = response.rows[0];
      expect(row.views_30d).toBe(500000);
      expect(row.reach_30d).toBe(130000);
      expect(row.interactions_total).toBe(6400);
      expect(row.interactions_likes).toBe(4400);
      expect(row.interactions_comments).toBe(140);
      expect(row.interactions_shares).toBe(320);
      expect(row.interactions_saves).toBe(1130);
    });

    it('reads only the newest 2400 account rows for sns_history', () => {
      const rows = [Code.SNS_HISTORY_ACCOUNT_COLUMNS];
      const total = 2405; // SNS_HISTORY_MAX_ROWS (2400) + 5
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < total; i++) {
        rows.push(
          accountRow({
            collected_at: new Date(base + i * 3600000).toISOString(),
            ig_followers: i,
          })
        );
      }
      serveTabs({ account: rows });
      const response = Code.buildSnsHistoryResponse_();
      expect(response.rows).toHaveLength(2400);
      expect(response.rows[0].ig_followers).toBe(5);
      expect(response.rows[2399].ig_followers).toBe(2404);
    });

    it('falls back to a full account scan when the last row has no timestamp', () => {
      const tabs = detailTabs();
      tabs.account.push(accountRow({ collected_at: '', ig_followers: 9999 }));
      serveTabs(tabs);
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.collected_at).toBe(AT_NEW);
      expect(detail.instagram.freddiefujiwara).toBe(2000);
    });

    it('precomputeReadCaches_ fills the read caches from the sheet', () => {
      serveTabs(
        Object.assign(detailTabs(), {
          blog_totals: [
            Code.SNS_HISTORY_BLOG_TOTALS_COLUMNS,
            ['28d', 4925, 241, 900, AT_NEW],
          ],
          blog_daily: [
            Code.SNS_HISTORY_BLOG_DAILY_COLUMNS,
            ['2026-11-09', 30, 12, 15, 2500, '', AT_NEW],
          ],
          blog_pages: [
            Code.SNS_HISTORY_BLOG_PAGES_COLUMNS,
            ['/', 'トップ', 123, AT_NEW],
          ],
          blog_sources: [
            Code.SNS_HISTORY_BLOG_SOURCES_COLUMNS,
            ['Direct', 300, AT_NEW],
          ],
        })
      );
      installCache();
      Code.precomputeReadCaches_();
      // With the sheet unreachable, every read must be answered
      // from the precomputed cache alone.
      global.SpreadsheetApp = {
        openById: vi.fn(() => {
          throw new Error('sheet unreachable');
        }),
      };
      const detail = Code.buildSnsDetailResponse_();
      expect(detail.collected_at).toBe(AT_NEW);
      expect(detail.instagram.freddiefujiwara).toBe(2000);
      const history = Code.buildSnsHistoryResponse_();
      expect(history.rows).toHaveLength(2);
      const totals = Code.buildBlogReportResponse_(
        {
          startDate: '28daysAgo',
          endDate: 'today',
          metrics: ['screenPageViews', 'activeUsers', 'sessions'],
          dimensions: [],
          limit: 1,
          offset: 0,
          filters: [],
        },
        null
      );
      expect(totals.ok).toBe(true);
      expect(totals.data.rows[0].metricValues[0].value).toBe('4925');
    });
  });
});
