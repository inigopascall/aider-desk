import { promisify } from 'util';
import { gzip } from 'zlib';

import { NextFunction, Request, RequestHandler, Response } from 'express';

import logger from '@/logger';
import { acceptsGzip } from '@/server/static-compression';

const gzipAsync = promisify(gzip);

// JSON replies smaller than this are sent as they are; compressing them would save little.
export const JSON_GZIP_THRESHOLD_BYTES = 64 * 1024;

type EtagFn = (body: Buffer, encoding?: string) => string | undefined;

const wantsEventStream = (req: Request): boolean => (req.headers.accept ?? '').includes('text/event-stream');

/**
 * Sends large JSON replies gzip-compressed to clients that accept gzip.
 * Only replies sent with res.json are affected. Responses written with res.write, such as the
 * text/event-stream prompt stream, never pass through here. Small replies, clients that do not
 * accept gzip, and any compression failure get the reply exactly as before.
 */
export const createJsonGzipMiddleware = (threshold = JSON_GZIP_THRESHOLD_BYTES): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    res.vary('Accept-Encoding');
    if (wantsEventStream(req) || !acceptsGzip(req)) {
      next();
      return;
    }

    const originalJson = res.json.bind(res) as (...args: unknown[]) => Response;
    let pending = false;

    res.json = ((...args: unknown[]): Response => {
      if (pending) {
        logger.warn('[JsonGzip] Ignoring a second reply to the same request', { path: req.originalUrl });
        return res;
      }
      if (args.length !== 1 || res.headersSent || req.app.get('json escape')) {
        return originalJson(...args);
      }
      const text = JSON.stringify(args[0], req.app.get('json replacer'), req.app.get('json spaces'));
      if (text === undefined || Buffer.byteLength(text) < threshold) {
        return originalJson(...args);
      }
      const raw = Buffer.from(text, 'utf8');
      pending = true;

      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      const etagFn = req.app.get('etag fn') as EtagFn | undefined;
      if (etagFn && !res.getHeader('ETag')) {
        const etag = etagFn(raw, 'utf8');
        if (etag) {
          res.setHeader('ETag', etag);
        }
      }
      if (req.fresh) {
        res.removeHeader('Content-Type');
        res.status(304).end();
        return res;
      }

      gzipAsync(raw)
        .then((compressed) => {
          if (res.headersSent || res.destroyed) {
            return;
          }
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Length', compressed.length);
          res.end(compressed);
        })
        .catch((error) => {
          logger.warn('[JsonGzip] Sending uncompressed after a compression failure', {
            path: req.originalUrl,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent && !res.destroyed) {
            res.setHeader('Content-Length', raw.length);
            res.end(raw);
          }
        });
      return res;
    }) as Response['json'];

    next();
  };
};
