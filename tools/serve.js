/**
 * Minimal static server for local development and the end-to-end tests.
 *
 * The app needs to be served over HTTP rather than opened from the filesystem,
 * because the sample scores are fetched at runtime and ES modules are blocked
 * on file:// origins. Node's own http module is enough, so running the project
 * still needs no dependencies.
 *
 * Usage: node tools/serve.js [port]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8000);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.musicxml': 'application/vnd.recordare.musicxml+xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mxl': 'application/vnd.recordare.musicxml',
  '.wav': 'audio/wav'
};

/** Resolve a request path to a file inside the project, or null if it escapes. */
function resolveRequestPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded.endsWith('/')) decoded += 'index.html';
  const candidate = resolve(join(ROOT, normalize(decoded)));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  return candidate;
}

const server = createServer(async (request, response) => {
  const filePath = resolveRequestPath(request.url || '/');
  if (!filePath) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      response.writeHead(301, { location: `${request.url.replace(/\/?$/, '')}/` }).end();
      return;
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      // Always revalidate so a reload during development shows the new code.
      'cache-control': 'no-cache'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Choir Practice is served at http://localhost:${PORT}`);
});
