import { promises as fs } from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { gunzipSync } from 'zlib';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createStaticGzipMiddleware } from '../static-compression';

vi.mock('@/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const request = (port: number, urlPath: string, headers: Record<string, string> = {}): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });

describe('createStaticGzipMiddleware', () => {
  const js = 'console.log("hello");\n'.repeat(2000);
  const css = 'body { color: red; }\n'.repeat(500);
  let dir: string;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'static-gzip-'));
    await fs.mkdir(path.join(dir, 'assets'));
    await fs.writeFile(path.join(dir, 'assets', 'index-abc.js'), js);
    await fs.writeFile(path.join(dir, 'assets', 'index-abc.css'), css);
    await fs.writeFile(path.join(dir, 'assets', 'changing.js'), 'first version');
    await fs.writeFile(path.join(dir, 'index.html'), '<html></html>');
    const app = express();
    app.use(createStaticGzipMiddleware(dir));
    app.use(express.static(dir));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('serves a gzipped JS bundle that decompresses to the original bytes', async () => {
    const res = await request(port, '/assets/index-abc.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers.vary).toContain('Accept-Encoding');
    expect(res.body.length).toBeLessThan(Buffer.byteLength(js));
    expect(gunzipSync(res.body).toString()).toBe(js);
  });

  it('serves a gzipped CSS bundle that decompresses to the original bytes', async () => {
    const res = await request(port, '/assets/index-abc.css', { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toContain('text/css');
    expect(gunzipSync(res.body).toString()).toBe(css);
  });

  it('serves the original bytes when the client does not accept gzip', async () => {
    for (const headers of [{}, { 'Accept-Encoding': 'gzip;q=0, br' }] as Record<string, string>[]) {
      const res = await request(port, '/assets/index-abc.js', headers);
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers.vary).toContain('Accept-Encoding');
      expect(res.body.toString()).toBe(js);
    }
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await request(port, '/assets/index-abc.js', { 'Accept-Encoding': 'gzip' });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const second = await request(port, '/assets/index-abc.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': etag });
    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
  });

  it('leaves files outside the assets bundles to the next handler', async () => {
    const res = await request(port, '/index.html', { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toBe('<html></html>');
  });

  it('falls through when the bundle does not exist', async () => {
    const res = await request(port, '/assets/missing.js', { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(404);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('serves the new content after the file changes', async () => {
    const before = await request(port, '/assets/changing.js', { 'Accept-Encoding': 'gzip' });
    expect(gunzipSync(before.body).toString()).toBe('first version');
    const file = path.join(dir, 'assets', 'changing.js');
    await fs.writeFile(file, 'second, longer version');
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(file, later, later);
    const after = await request(port, '/assets/changing.js', { 'Accept-Encoding': 'gzip' });
    expect(gunzipSync(after.body).toString()).toBe('second, longer version');
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });
});
