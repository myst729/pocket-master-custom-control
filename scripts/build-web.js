// 打包纯静态的 Web 版，可整体丢到任意静态托管（GitHub Pages / Netlify / nginx）。
// 保持与源码相同的相对目录结构，避免改写 HTML 里的引用路径。

const fs = require('fs');
const path = require('path');

const dist = process.argv.slice(2)[0] || 'dist-web';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, dist.trim());

const COPY = [
  'src/assets/icon.png',
  'src/core/client.js',
  'src/core/protocol.js',
  'src/renderer/index.html',
  'src/renderer/renderer.js',
  'src/renderer/style.css',
  'src/transport/index.js',
];

fs.rmSync(OUT, { recursive: true, force: true });

for (const rel of COPY) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
}

// 根目录放一个跳转页，托管在站点根路径时可直接访问
fs.writeFileSync(
  path.join(OUT, 'index.html'),
  `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="refresh" content="0; url=./src/renderer/index.html" />
    <title>Pocket Master Custom Control</title>
  </head>
  <body>
    <p>正在跳转… 若未自动跳转，请<a href="./src/renderer/index.html">点此打开</a>。</p>
  </body>
</html>
`
);

console.log(`Web 产物已生成：${dist.trim()}/`);
