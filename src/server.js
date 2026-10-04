'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { verify, MAX_TOKENS, MAX_INSTRUCTIONS } = require('./verifier');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const HEALTH_PATH = process.env.HEALTH_PATH || '/healthz';

const DIST_DIR = path.join(__dirname, '..', 'dist');
const WEB_DIR = path.join(__dirname, '..', 'web');

function staticRoot() {
  try {
    fs.accessSync(path.join(DIST_DIR, 'index.html'));
    return DIST_DIR;
  } catch {
    return WEB_DIR;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store'
  });
  res.end(buf);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer() {
  const root = staticRoot();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
    const p = url.pathname;

    if (req.method === 'GET' && (p === HEALTH_PATH || p === '/healthz')) {
      sendJson(res, 200, {
        status: 'ok',
        service: 'avionics-isolation-review',
        time: new Date().toISOString()
      });
      return;
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      serveFile(res, path.join(root, 'index.html'));
      return;
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const name = path.posix.basename(p);
      serveFile(res, path.join(root, name));
      return;
    }

    if (req.method === 'POST' && p === '/api/verify') {
      let payload;
      try {
        const text = await readBody(req);
        payload = text ? JSON.parse(text) : {};
      } catch {
        sendJson(res, 400, { ok: false, fatal: true, evidenceRemoved: true,
          error: { type: 'bad-request', message: '请求体不是合法 JSON' } });
        return;
      }
      const result = verify(payload.script == null ? '' : String(payload.script), {
        tokenNames: Array.isArray(payload.tokens) ? payload.tokens : [],
        maxLoop: payload.maxLoop == null ? undefined : Number(payload.maxLoop)
      });
      // 任何错误/违规都意味着旧证据失效（evidenceRemoved 已由引擎置位）
      sendJson(res, result.fatal ? 422 : 200, result);
      return;
    }

    // 清空草稿与结论（服务端无会话状态：确认旧证据已移除）
    if (req.method === 'POST' && p === '/api/clear') {
      sendJson(res, 200, { cleared: true, evidenceRemoved: true });
      return;
    }

    if (req.method === 'GET' && p === '/api/meta') {
      sendJson(res, 200, { maxTokens: MAX_TOKENS, maxInstructions: MAX_INSTRUCTIONS });
      return;
    }

    sendJson(res, 404, { error: { type: 'not-found', message: `无此路径: ${p}` } });
  });
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': data.length
    });
    res.end(data);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    console.log(`[avionics-review] http://${HOST}:${addr.port}  health=${HEALTH_PATH}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, HOST, PORT, HEALTH_PATH };
