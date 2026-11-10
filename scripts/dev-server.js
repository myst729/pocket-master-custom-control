// 本地开发用的静态服务器（零依赖）。
// Web Serial 要求安全上下文，file:// 不可用，所以走 http://localhost。
// 用法：npm run dev:web，然后浏览器打开 http://localhost:5173/

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 5173;
const ENTRY = '/src/renderer/index.html';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('400 Bad Request');
    return;
  }
  if (urlPath === '/') {
    // 必须跳转而不是直接返回内容，否则 HTML 里的相对路径会解析到站点根目录
    res.writeHead(302, { location: ENTRY }).end();
    return;
  }

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Web 版开发服务器已启动：http://localhost:${PORT}/`);
  console.log('请使用桌面版 Chrome / Edge 打开（Web Serial 需要 localhost 或 HTTPS）。');
});
