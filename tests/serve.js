'use strict';

/**
 * 本地调试服务器：模拟 Vercel 的 rewrite 规则与静态文件服务，
 * 这样面板和接口可以在没有 Vercel CLI 的情况下完整验证。
 *
 *   node tests/serve.js            # 默认 3001 端口
 *   PORT=8080 node tests/serve.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const handler = require('../api/cfdns');

// 与 vercel.json 的 rewrites 保持一致
const ROUTES = {
  '/api/login': 'login',
  '/api/logout': 'logout',
  '/api/state': 'state',
  '/api/run': 'run',
  '/api/check': 'check',
  '/api/clear': 'clear',
  '/api/health': 'health'
};

// Vercel 对无框架项目是从仓库根目录提供静态文件的，这里只放行面板需要的三个文件
const ROOT_DIR = path.join(__dirname, '..');
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/app.js': 'app.js'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function serveStatic(res, file) {
  fs.readFile(path.join(ROOT_DIR, file), function (err, data) {
    if (err) {
      res.statusCode = 500;
      res.end('读取静态文件失败');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const action = ROUTES[url.pathname];

  if (action) {
    // 模拟 vercel.json 的 rewrite：/api/xxx -> /api/cfdns?action=xxx
    url.searchParams.set('action', action);
    req.url = '/api/cfdns?' + url.searchParams.toString();
    return handler(req, res);
  }

  if (url.pathname.indexOf('/api/') === 0) {
    return handler(req, res);
  }

  if (STATIC_FILES[url.pathname]) {
    return serveStatic(res, STATIC_FILES[url.pathname]);
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('404 Not Found');
});

const port = Number(process.env.PORT || 3001);

if (require.main === module) {
  server.listen(port, '127.0.0.1', function () {
    console.log('CFDNS 本地服务已启动: http://127.0.0.1:' + port);
  });
}

module.exports = { server, ROUTES };
