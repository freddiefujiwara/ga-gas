import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

// X joins the collection through tweet-gas (GAS-to-GAS): the X
// API keys live only in tweet-gas, and collectSnsCounts POSTs
// { action: 'sns_snapshot', sync_token } to its web app — the
// same machine sync-token pattern alarm-gas / time-table-gas
// use. These tests pin the caller side: the request shape, the
// response mapping into the snapshot / history / read shapes,
// and the failure behaviour (nulls plus a summary, never a throw).
describe('X via tweet-gas (GAS-to-GAS sync)', () => {
  let store;
  let fetchHandler;

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

  let sheets;
  let spreadsheet;
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
    global.SpreadsheetApp = { openById: vi.fn(() => spreadsheet) };
    store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = {};
    sheets = {};
    fetchHandler = () => {
      throw new Error('unexpected fetch');
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
    global.UrlFetchApp = {
      fetch: vi.fn((url, options) => fetchHandler(url, options)),
    };
    delete global.SpreadsheetApp;
  });

  const configureSync = () => {
    store.TWEET_GAS_EXEC_URL = 'https://example.com/tweet-gas/exec';
    store.TWEET_GAS_SYNC_TOKEN = 'sync-secret';
  };

  const WIRE_POSTS = [
    {
      id: '2001',
      posted_at: '2026-11-09T10:00:00.000Z',
      text: '川口のブログを更新しました',
      views: 500,
      likes: 12,
      reposts: 3,
      replies: 2,
    },
    {
      id: '2002',
      posted_at: '2026-11-08T10:00:00.000Z',
      text: '数字が欠けた投稿',
      views: null,
      likes: 1,
      reposts: 0,
      replies: 0,
    },
  ];

  describe('fetchXDetail_', () => {
    it('returns all nulls without fetching while unconfigured', () => {
      const detail = Code.fetchXDetail_();
      expect(detail).toEqual({
        followers: null,
        username: null,
        api_balance_usd: null,
        api_daily_posts: null,
        usage_error: null,
        recent_posts: null,
        x_error: null,
        posts_error: null,
      });
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('POSTs the sync action with the token and maps the response', () => {
      configureSync();
      fetchHandler = (url, options) => {
        expect(url).toBe('https://example.com/tweet-gas/exec');
        expect(options.method).toBe('post');
        expect(options.contentType).toBe('text/plain');
        expect(JSON.parse(options.payload)).toEqual({
          action: 'sns_snapshot',
          sync_token: 'sync-secret',
        });
        return res(200, {
          ok: true,
          action: 'sns_snapshot',
          collected_at: '2026-11-10T00:00:00.000Z',
          x: {
            followers: 321,
            username: 'freddiefujiwara',
            recent_posts: WIRE_POSTS,
          },
          x_error: null,
          posts_error: null,
        });
      };
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(321);
      expect(detail.username).toBe('freddiefujiwara');
      expect(detail.x_error).toBeNull();
      expect(detail.posts_error).toBeNull();
      expect(detail.recent_posts).toHaveLength(2);
      expect(detail.recent_posts[0]).toEqual({
        id: '2001',
        posted_at: '2026-11-09T10:00:00.000Z',
        text: '川口のブログを更新しました',
        url: 'https://x.com/i/web/status/2001',
        views: 500,
        likes: 12,
        reposts: 3,
        replies: 2,
      });
      expect(detail.recent_posts[1].views).toBeNull();
    });

    it('reports an HTTP failure on both error fields', () => {
      configureSync();
      fetchHandler = () => res(401, 'Unauthorized');
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBeNull();
      expect(detail.recent_posts).toBeNull();
      expect(detail.x_error).toBe('tweet-gas HTTP 401');
      expect(detail.posts_error).toBe('tweet-gas HTTP 401');
    });

    it('reports a not-ok body with its reason', () => {
      configureSync();
      fetchHandler = () =>
        res(200, { ok: false, status: 401, error: 'sync token invalid' });
      const detail = Code.fetchXDetail_();
      expect(detail.x_error).toBe('tweet-gas: sync token invalid');
      expect(detail.posts_error).toBe('tweet-gas: sync token invalid');
    });

    it('passes tweet-gas partial errors through and keeps the numbers', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: null },
          x_error: null,
          posts_error: 'x posts: HTTP 429 code=88: Rate limit exceeded',
        });
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(321);
      expect(detail.recent_posts).toBeNull();
      expect(detail.x_error).toBeNull();
      expect(detail.posts_error).toContain('HTTP 429');
    });

    it('maps the usage half from the snapshot response', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: WIRE_POSTS },
          x_error: null,
          posts_error: null,
          x_usage: {
            credit_balance_usd: 41.65,
            prepaid_balance_usd: 25,
            free_balance_usd: 16.65,
            daily_posts: [
              { date: '2026-11-08', tweets_consumed: 120 },
              { date: '2026-11-07', tweets_consumed: null },
            ],
          },
          usage_error: null,
        });
      const detail = Code.fetchXDetail_();
      expect(detail.api_balance_usd).toBe(41.65);
      // Daily posts come out ascending, null counts preserved.
      expect(detail.api_daily_posts).toEqual([
        { date: '2026-11-07', tweets_consumed: null },
        { date: '2026-11-08', tweets_consumed: 120 },
      ]);
      expect(detail.usage_error).toBeNull();
      expect(detail.followers).toBe(321);
    });

    it('maps the usage half when the dates arrive as ISO timestamps', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: [] },
          x_error: null,
          posts_error: null,
          x_usage: {
            credit_balance_usd: 41.65,
            cycle_posts_consumed: 321,
            daily_posts: [
              { date: '2026-11-10T00:00:00.000Z', tweets_consumed: 96 },
              { date: '2026-11-09T00:00:00.000Z', tweets_consumed: 140 },
            ],
          },
          usage_error: null,
        });
      const detail = Code.fetchXDetail_();
      expect(detail.api_balance_usd).toBe(41.65);
      // The timestamp shape production sends is cut to its day.
      expect(detail.api_daily_posts).toEqual([
        { date: '2026-11-09', tweets_consumed: 140 },
        { date: '2026-11-10', tweets_consumed: 96 },
      ]);
    });

    it('passes a partial usage failure through as usage_error', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: [] },
          x_error: null,
          posts_error: null,
          x_usage: { credit_balance_usd: null, daily_posts: null },
          usage_error: 'credits fetch failed',
        });
      const detail = Code.fetchXDetail_();
      expect(detail.api_balance_usd).toBeNull();
      expect(detail.api_daily_posts).toBeNull();
      expect(detail.usage_error).toBe('credits fetch failed');
    });

    it('keeps the balance null when the response carries none', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: [] },
          x_error: null,
          posts_error: null,
        });
      expect(Code.fetchXDetail_().api_balance_usd).toBeNull();
    });

    it('survives a fetch exception', () => {
      configureSync();
      fetchHandler = () => {
        throw new Error('network down');
      };
      const detail = Code.fetchXDetail_();
      expect(detail.x_error).toContain('tweet-gas fetch exception');
      expect(detail.followers).toBeNull();
    });
  });

  describe('extractXUsage_', () => {
    it('reads the balance and daily posts from x_usage', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: 41.65,
          daily_posts: [{ date: '2026-11-08', tweets_consumed: 120 }],
        },
        usage_error: null,
      });
      expect(usage.balance_usd).toBe(41.65);
      expect(usage.daily_posts).toEqual([
        { date: '2026-11-08', tweets_consumed: 120 },
      ]);
      expect(usage.usage_error).toBeNull();
    });

    it('keeps a reported zero balance', () => {
      expect(
        Code.extractXUsage_({ x_usage: { credit_balance_usd: 0 } }).balance_usd
      ).toBe(0);
    });

    it('drops malformed daily entries and keeps null counts', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: null,
          daily_posts: [
            { date: 'not-a-date', tweets_consumed: 5 },
            { tweets_consumed: 5 },
            null,
            { date: '2026-11-08', tweets_consumed: null },
          ],
        },
      });
      expect(usage.daily_posts).toEqual([
        { date: '2026-11-08', tweets_consumed: null },
      ]);
    });

    it('normalizes ISO timestamp dates to their calendar day', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: 41.65,
          daily_posts: [
            { date: '2026-11-10T00:00:00.000Z', tweets_consumed: 96 },
            { date: '2026-11-09T12:34:56.789Z', tweets_consumed: 140 },
          ],
        },
      });
      expect(usage.daily_posts).toEqual([
        { date: '2026-11-09', tweets_consumed: 140 },
        { date: '2026-11-10', tweets_consumed: 96 },
      ]);
    });

    it('keeps one entry when both date shapes of a day arrive', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: null,
          daily_posts: [
            { date: '2026-11-09', tweets_consumed: 100 },
            { date: '2026-11-09T00:00:00.000Z', tweets_consumed: 140 },
          ],
        },
      });
      expect(usage.daily_posts).toEqual([
        { date: '2026-11-09', tweets_consumed: 140 },
      ]);
    });

    it('ignores usage fields it does not consume', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: 41.65,
          cycle_posts_consumed: 321,
          prepaid_balance_usd: 25,
          free_balance_usd: 16.65,
          daily_posts: [{ date: '2026-11-08', tweets_consumed: 120 }],
        },
        usage_error: null,
      });
      expect(usage).toEqual({
        balance_usd: 41.65,
        daily_posts: [{ date: '2026-11-08', tweets_consumed: 120 }],
        usage_error: null,
      });
    });

    it('returns all nulls when x_usage itself is null or absent', () => {
      expect(Code.extractXUsage_({ x_usage: null })).toEqual({
        balance_usd: null,
        daily_posts: null,
        usage_error: null,
      });
      expect(Code.extractXUsage_({})).toEqual({
        balance_usd: null,
        daily_posts: null,
        usage_error: null,
      });
      expect(Code.extractXUsage_(null)).toEqual({
        balance_usd: null,
        daily_posts: null,
        usage_error: null,
      });
    });

    it('keeps usage_error even when x_usage is null', () => {
      const usage = Code.extractXUsage_({
        x_usage: null,
        usage_error: 'tweet-gas bearer unavailable',
      });
      expect(usage.usage_error).toBe('tweet-gas bearer unavailable');
      expect(usage.balance_usd).toBeNull();
    });
  });

  describe('xDailyDateKey_', () => {
    it('keeps a plain date and cuts an ISO timestamp to its day', () => {
      expect(Code.xDailyDateKey_('2026-11-10')).toBe('2026-11-10');
      expect(Code.xDailyDateKey_('2026-11-10T00:00:00.000Z')).toBe(
        '2026-11-10'
      );
    });

    it('formats a stored Date cell in Asia/Tokyo', () => {
      expect(Code.xDailyDateKey_(new Date('2026-11-10T00:00:00.000Z'))).toBe(
        '2026-11-10'
      );
      // 16:00 UTC is already the next day in Tokyo.
      expect(Code.xDailyDateKey_(new Date('2026-11-09T16:00:00.000Z'))).toBe(
        '2026-11-10'
      );
    });

    it('returns null for anything without a leading date', () => {
      expect(Code.xDailyDateKey_('not-a-date')).toBeNull();
      expect(Code.xDailyDateKey_('')).toBeNull();
      expect(Code.xDailyDateKey_(null)).toBeNull();
      expect(Code.xDailyDateKey_(undefined)).toBeNull();
      expect(Code.xDailyDateKey_(20261110)).toBeNull();
    });
  });

  describe('history rows', () => {
    const snapshotWithX = () => ({
      collected_at: '2026-11-10T00:00:00.000Z',
      instagram: { freddiefujiwara: 2000 },
      threads: { followers: 252 },
      youtube: { subscribers: 10 },
      x: {
        followers: 321,
        username: 'freddiefujiwara',
        recent_posts: [
          {
            id: '2001',
            posted_at: '2026-11-09T10:00:00.000Z',
            text: '投稿その1',
            url: 'https://x.com/i/web/status/2001',
            views: 500,
            likes: 12,
            reposts: 3,
            replies: 2,
          },
        ],
      },
    });

    it('counts X in the account row total and the trailing cell', () => {
      const row = Code.buildSnsHistoryAccountRow_(snapshotWithX());
      expect(row).toHaveLength(Code.SNS_HISTORY_ACCOUNT_COLUMNS.length);
      const totalIndex = Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('total_followers');
      expect(row[totalIndex]).toBe(2000 + 252 + 10 + 321);
      const xIndex = Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('x_followers');
      expect(row[xIndex]).toBe(321);
      // The API balance column rides last, after x_followers.
      const balanceIndex =
        Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('x_api_balance_usd');
      expect(balanceIndex).toBe(Code.SNS_HISTORY_ACCOUNT_COLUMNS.length - 1);
      expect(row[balanceIndex]).toBe('');
    });

    it('builds one x_media row per post, without the derived URL', () => {
      const rows = Code.buildSnsHistoryXMediaRows_(snapshotWithX());
      expect(rows).toEqual([
        [
          '2026-11-10T00:00:00.000Z',
          '2001',
          '2026-11-09T10:00:00.000Z',
          '投稿その1',
          500,
          12,
          3,
          2,
        ],
      ]);
    });

    it('builds one x_daily row per consumed day', () => {
      const snap = snapshotWithX();
      snap.x.api_daily_posts = [
        { date: '2026-11-08', tweets_consumed: 120 },
        { date: '2026-11-09', tweets_consumed: null },
      ];
      expect(Code.buildSnsHistoryXDailyRows_(snap)).toEqual([
        ['2026-11-08', 120, '2026-11-10T00:00:00.000Z'],
        ['2026-11-09', '', '2026-11-10T00:00:00.000Z'],
      ]);
      // A failed daily fetch (null) contributes no rows.
      snap.x.api_daily_posts = null;
      expect(Code.buildSnsHistoryXDailyRows_(snap)).toEqual([]);
    });

    it('keys x_daily rows by the calendar day of timestamp-shaped dates', () => {
      const snap = snapshotWithX();
      snap.x.api_daily_posts = [
        { date: '2026-11-09T00:00:00.000Z', tweets_consumed: 140 },
      ];
      expect(Code.buildSnsHistoryXDailyRows_(snap)).toEqual([
        ['2026-11-09', 140, '2026-11-10T00:00:00.000Z'],
      ]);
    });

    it('upserts x_daily end to end through appendSnsHistory_', () => {
      const snap = snapshotWithX();
      snap.x.api_daily_posts = [{ date: '2026-11-09', tweets_consumed: 100 }];
      serveTabs({});
      Code.appendSnsHistory_(snap);
      expect(sheets.x_daily.rows[0]).toEqual(Code.SNS_HISTORY_X_DAILY_COLUMNS);
      expect(sheets.x_daily.rows).toHaveLength(2);
      snap.x.api_daily_posts = [{ date: '2026-11-09', tweets_consumed: 140 }];
      Code.appendSnsHistory_(snap);
      // Still one row for the day, carrying the newer count.
      expect(sheets.x_daily.rows).toHaveLength(2);
      expect(sheets.x_daily.rows[1][1]).toBe(140);
    });

    it('merges a stored timestamp-shaped x_daily row into the normalized day', () => {
      serveTabs({
        x_daily: [
          Code.SNS_HISTORY_X_DAILY_COLUMNS,
          ['2026-11-09T00:00:00.000Z', 100, '2026-11-10T00:00:00.000Z'],
        ],
      });
      const snap = snapshotWithX();
      snap.x.api_daily_posts = [{ date: '2026-11-09', tweets_consumed: 140 }];
      Code.appendSnsHistory_(snap);
      // The legacy row converges onto the day key instead of
      // surviving as a second row for the same day.
      expect(sheets.x_daily.rows).toHaveLength(2);
      expect(sheets.x_daily.rows[1][0]).toBe('2026-11-09');
      expect(sheets.x_daily.rows[1][1]).toBe(140);
    });

    it('upserts x_media end to end through appendSnsHistory_', () => {
      serveTabs({});
      Code.appendSnsHistory_(snapshotWithX());
      expect(sheets.x_media.rows[0]).toEqual(Code.SNS_HISTORY_X_MEDIA_COLUMNS);
      expect(sheets.x_media.rows).toHaveLength(2);
      const updated = snapshotWithX();
      updated.collected_at = '2026-11-10T01:00:00.000Z';
      updated.x.recent_posts[0].views = 640;
      Code.appendSnsHistory_(updated);
      // Still one row for the post, carrying the newer numbers.
      expect(sheets.x_media.rows).toHaveLength(2);
      expect(sheets.x_media.rows[1][4]).toBe(640);
    });
  });

  describe('sheet-backed read side', () => {
    const accountRow = (values) => {
      const row = Code.SNS_HISTORY_ACCOUNT_COLUMNS.map(() => '');
      for (const [name, value] of Object.entries(values)) {
        row[Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf(name)] = value;
      }
      return row;
    };

    it('builds the X section of sns_detail from the sheet', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-10T00:00:00.000Z',
            ig_followers: 2000,
            threads_followers: 252,
            youtube_subscribers: 10,
            x_followers: 321,
          }),
        ],
        x_media: [
          Code.SNS_HISTORY_X_MEDIA_COLUMNS,
          [
            '2026-11-10T00:00:00.000Z',
            '2001',
            '2026-11-09T10:00:00.000Z',
            '古い投稿',
            500,
            12,
            3,
            2,
          ],
          [
            '2026-11-10T00:00:00.000Z',
            '2002',
            '2026-11-09T12:00:00.000Z',
            '新しい投稿',
            900,
            30,
            5,
            4,
          ],
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.x.followers).toBe(321);
      expect(detail.x.api_balance_usd).toBeNull();
      expect(detail.x.username).toBeNull();
      expect(detail.x.recent_posts.map((post) => post.id)).toEqual([
        '2002',
        '2001',
      ]);
      expect(detail.x.recent_posts[0].url).toBe(
        'https://x.com/i/web/status/2002'
      );
      expect(detail.x.recent_posts[0].views).toBe(900);
    });

    it('carries the daily posts through the sheet into sns_detail', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-10T00:00:00.000Z',
            x_followers: 321,
            x_api_balance_usd: 41.65,
          }),
        ],
        x_daily: [
          Code.SNS_HISTORY_X_DAILY_COLUMNS,
          ['2026-11-09', 140, '2026-11-10T00:00:00.000Z'],
          ['2026-11-08', '', '2026-11-10T00:00:00.000Z'],
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.x.api_daily_posts).toEqual([
        { date: '2026-11-08', tweets_consumed: null },
        { date: '2026-11-09', tweets_consumed: 140 },
      ]);
    });

    it('normalizes stored x_daily date shapes on the read side', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-10T00:00:00.000Z',
            x_followers: 321,
            x_api_balance_usd: 41.65,
          }),
        ],
        x_daily: [
          Code.SNS_HISTORY_X_DAILY_COLUMNS,
          // A row stored in the timestamp shape, the same day
          // stored again normalized, and a date cell Sheets
          // coerced into a Date: one entry per calendar day.
          ['2026-11-09T00:00:00.000Z', 100, '2026-11-10T00:00:00.000Z'],
          ['2026-11-09', 140, '2026-11-10T01:00:00.000Z'],
          [new Date('2026-11-08T00:00:00.000Z'), 55, '2026-11-10T00:00:00.000Z'],
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.x.api_daily_posts).toEqual([
        { date: '2026-11-08', tweets_consumed: 55 },
        { date: '2026-11-09', tweets_consumed: 140 },
      ]);
    });

    it('carries the API balance through the account row, sns_detail and sns_history', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-10T00:00:00.000Z',
            x_followers: 321,
            x_api_balance_usd: 41.65,
          }),
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.x.api_balance_usd).toBe(41.65);
      const response = Code.buildSnsHistoryResponse_();
      expect(response.rows).toHaveLength(1);
      expect(response.rows[0].x_api_balance_usd).toBe(41.65);
    });

    it('writes the API balance into the appended account row', () => {
      const row = Code.buildSnsHistoryAccountRow_({
        collected_at: '2026-11-10T00:00:00.000Z',
        x: { followers: 321, api_balance_usd: 41.65 },
      });
      const balanceIndex =
        Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('x_api_balance_usd');
      expect(row[balanceIndex]).toBe(41.65);
    });

    it('serves x_followers in sns_history from the canonical position when the stored header predates the column', () => {
      const oldColumns = Code.SNS_HISTORY_ACCOUNT_COLUMNS.slice(
        0,
        Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('x_followers')
      );
      expect(oldColumns).not.toContain('x_followers');
      const dataRow = oldColumns.map(() => '');
      dataRow[0] = '2026-11-10T00:00:00.000Z';
      dataRow.push(321); // the x_followers cell, past the old header
      const accountSheet = {
        getLastRow: () => 2,
        getRange: (row, col, numRows, numCols) => ({
          getValues: () =>
            [oldColumns, dataRow]
              .slice(row - 1, row - 1 + numRows)
              .map((r) => r.slice(col - 1, col - 1 + numCols)),
        }),
      };
      global.SpreadsheetApp = {
        openById: vi.fn(() => ({
          getSheetByName: (name) => (name === 'account' ? accountSheet : null),
        })),
      };
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      const response = Code.buildSnsHistoryResponse_();
      expect(response.rows).toHaveLength(1);
      expect(response.rows[0].x_followers).toBe(321);
    });
  });

  describe('public projection', () => {
    it('includes x.followers in sns_counts and stays null-safe', () => {
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify({
        collected_at: '2026-11-10T00:00:00.000Z',
        x: { followers: 321, recent_posts: [{ id: '2001' }] },
      });
      const response = Code.buildSnsCountsResponse_();
      expect(response.x).toEqual({ followers: 321 });
    });
  });
});
