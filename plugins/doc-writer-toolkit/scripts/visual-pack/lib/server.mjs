import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.map': 'application/json',
};

async function fileAt(p) {
  try {
    return (await fs.stat(p)).isFile() ? p : null;
  } catch {
    return null;
  }
}

// Where a URL path lives in a Docusaurus build: the file itself, `<path>/index.html` or `<path>.html`.
export async function resolveFile(buildDir, urlPath, baseUrl = '/') {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  // The build holds the site without its base URL. A path outside it is looked up as it is.
  if (baseUrl !== '/' && rel.startsWith(baseUrl)) rel = `/${rel.slice(baseUrl.length)}`;
  const abs = path.resolve(buildDir, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  if (abs !== path.resolve(buildDir) && !abs.startsWith(path.resolve(buildDir) + path.sep)) return null;
  const trimmed = abs.replace(/[\\/]+$/, '');
  return (await fileAt(abs)) ?? (await fileAt(path.join(abs, 'index.html'))) ?? (await fileAt(`${trimmed}.html`));
}

// A static server on 127.0.0.1 and a free port for one build folder. It serves nothing from outside the folder.
export async function startServer(buildDir, baseUrl = '/') {
  const stats = { requests: 0, notFound: 0 };
  const server = http.createServer(async (req, res) => {
    stats.requests += 1;
    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname;
    let file = await resolveFile(buildDir, urlPath, baseUrl);
    let status = 200;
    if (!file) {
      status = 404;
      stats.notFound += 1;
      file = await fileAt(path.join(buildDir, '404.html'));
    }
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(status, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await fs.readFile(file));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}
