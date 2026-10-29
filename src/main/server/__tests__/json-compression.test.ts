import http from 'http';
import { AddressInfo } from 'net';
import { gunzipSync } from 'zlib';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createJsonGzipMiddleware } from '../json-compression';

vi.mock('@/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface StreamResult {
  headers: http.IncomingHttpHeaders;
  firstChunkAt: number;
  endAt: number;
  text: string;
}

describe('createJsonGzipMiddleware', () => {
  const large = {
    messages: Array.from({ length: 3000 }, (_, i) => ({ id: i, type: 'tool', content: `line ${i} `.repeat(10) })),
  };
  const largeText = JSON.stringify(large);
  let server: http.Server;
  let port: number;

  const request = (method: string, urlPath: string, headers: Record<string, string> = {}): Promise<RawResponse> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

  const readStream = (headers: Record<string, string>): Promise<StreamResult> =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const req = http.request({ host: '127.0.0.1', port, path: '/api/stream', method: 'POST', headers }, (res) => {
        let firstChunkAt = -1;
        let text = '';
        res.on('data', (chunk: Buffer) => {
          if (firstChunkAt < 0) {
            firstChunkAt = Date.now() - start;
          }
          text += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ headers: res.headers, firstChunkAt, endAt: Date.now() - start, text }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

  beforeAll(async () => {
    const app = express();
    app.use('/api', createJsonGzipMiddleware());
    app.post('/api/large', (_req, res) => {
      res.json(large);
    });
    app.get('/api/large', (_req, res) => {
      res.json(large);
    });
    app.post('/api/small', (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/api/large-error', (_req, res) => {
      res.status(500).json(large);
    });
    app.post('/api/stream', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: first\ndata: {"n":1}\n\n');
      setTimeout(() => {
        res.write('event: stream-end\ndata: {}\n\n');
        res.end();
      }, 300);
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('gzips a large JSON reply for a client that accepts gzip, and it decompresses to the same bytes', async () => {
    const res = await request('POST', '/api/large', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers.vary).toContain('Accept-Encoding');
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
    expect(res.body.length).toBeLessThan(Buffer.byteLength(largeText));
    expect(gunzipSync(res.body).toString('utf8')).toBe(largeText);
  });

  it('sends the reply unchanged to a client that does not accept gzip', async () => {
    for (const headers of [{}, { 'Accept-Encoding': 'gzip;q=0' }] as Record<string, string>[]) {
      const res = await request('POST', '/api/large', headers);
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString('utf8')).toBe(largeText);
    }
  });

  it('sends a small reply unchanged', async () => {
    const res = await request('POST', '/api/small', { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString('utf8')).toBe('{"ok":true}');
  });

  it('keeps the status code of a compressed reply', async () => {
    const res = await request('POST', '/api/large-error', { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(500);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(res.body).toString('utf8')).toBe(largeText);
  });

  it('answers a repeated GET with 304 when the reply has not changed', async () => {
    const first = await request('GET', '/api/large', { 'Accept-Encoding': 'gzip' });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const second = await request('GET', '/api/large', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
  });

  it('leaves an event stream uncompressed and delivers its first event before the stream ends', async () => {
    const headerSets = [
      { Accept: 'text/event-stream', 'Accept-Encoding': 'gzip' },
      { Accept: '*/*', 'Accept-Encoding': 'gzip' },
    ];
    for (const headers of headerSets) {
      const result = await readStream(headers);
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.firstChunkAt).toBeGreaterThanOrEqual(0);
      expect(result.firstChunkAt).toBeLessThan(result.endAt - 200);
      expect(result.text).toContain('event: first');
      expect(result.text).toContain('event: stream-end');
    }
  });
});
