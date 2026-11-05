import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

const PROPERTY_ID = '561730442';

describe('Code.js', () => {
  let outputs;

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    delete global.UrlFetchApp;
    delete global.ContentService;
    delete global.PropertiesService;
    delete global.ScriptApp;

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
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: vi.fn(() => value),
      }),
    };
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
      });
    });

    it('floors a fractional limit', () => {
      expect(Code.parseRunParams_({ limit: '7.9' }).limit).toBe(7);
    });

    it('rejects zero and negative limits', () => {
      expect(Code.parseRunParams_({ limit: '0' }).limit).toBe(25);
      expect(Code.parseRunParams_({ limit: '-3' }).limit).toBe(25);
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
  });
});
