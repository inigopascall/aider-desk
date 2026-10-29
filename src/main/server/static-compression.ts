import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { gzip } from 'zlib';

import { NextFunction, Request, RequestHandler, Response } from 'express';

import logger from '@/logger';

const gzipAsync = promisify(gzip);

// Built JS and CSS bundles. Their names contain no slash, so a match cannot point outside the assets directory.
const COMPRESSIBLE_ASSET = /^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/;

const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=UTF-8',
  css: 'text/css; charset=UTF-8',
};

interface CompressedAsset {
  size: number;
  mtimeMs: number;
  etag: string;
  body: Promise<Buffer>;
}

const acceptsGzip = (req: Request): boolean => {
  const header = req.headers['accept-encoding'];
  if (!header) {
    return false;
  }
  return header.split(',').some((part) => {
    const [coding, ...params] = part.split(';').map((item) => item.trim().toLowerCase());
    if (coding !== 'gzip') {
      return false;
    }
    const quality = params.find((param) => param.startsWith('q='));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
};

const matchesEtag = (req: Request, etag: string): boolean => {
  const header = req.headers['if-none-match'];
  return !!header && header.split(',').some((value) => value.trim() === etag);
};

/**
 * Serves the renderer's JS and CSS bundles gzip-compressed to clients that accept gzip.
 * Each bundle is compressed once and kept in memory until the file on disk changes.
 * Every other request, and any failure, falls through to the next handler unchanged.
 */
export const createStaticGzipMiddleware = (rendererDir: string): RequestHandler => {
  const cache = new Map<string, CompressedAsset>();

  const getAsset = async (filePath: string): Promise<CompressedAsset | null> => {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      cache.delete(filePath);
      return null;
    }
    const cached = cache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }
    const asset: CompressedAsset = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      etag: `W/"gz-${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
      body: fs.readFile(filePath).then((raw) => gzipAsync(raw)),
    };
    cache.set(filePath, asset);
    asset.body.catch(() => {
      if (cache.get(filePath) === asset) {
        cache.delete(filePath);
      }
    });
    return asset;
  };

  const serve = async (req: Request, res: Response, next: NextFunction, extension: string): Promise<void> => {
    const asset = await getAsset(path.join(rendererDir, req.path));
    if (!asset) {
      next();
      return;
    }
    const body = await asset.body;
    res.setHeader('Content-Type', CONTENT_TYPES[extension]);
    res.setHeader('Cache-Control', 'public, max-age=0');
    res.setHeader('ETag', asset.etag);
    if (matchesEtag(req, asset.etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.status(200).end(body);
  };

  return (req, res, next) => {
    const match = req.method === 'GET' ? COMPRESSIBLE_ASSET.exec(req.path) : null;
    if (!match) {
      next();
      return;
    }
    res.vary('Accept-Encoding');
    if (req.headers.range || !acceptsGzip(req)) {
      next();
      return;
    }
    serve(req, res, next, match[1]).catch((error) => {
      logger.warn('[StaticGzip] Serving uncompressed after a compression failure', {
        path: req.path,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        next();
      }
    });
  };
};
