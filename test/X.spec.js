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
      expect(xIndex).toBe(Code.SNS_HISTORY_ACCOUNT_COLUMNS.length - 1);
      expect(row[xIndex]).toBe(321);
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

    it('serves x_followers in sns_history from the canonical position when the stored header predates the column', () => {
      const oldColumns = Code.SNS_HISTORY_ACCOUNT_COLUMNS.slice(0, -1);
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
