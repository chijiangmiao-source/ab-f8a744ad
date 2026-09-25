// HTTP 服务：页面、健康路径与复核 API。无第三方依赖。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { parseReviewPayload, ValidationError } from './protocol.js';
import { createReview, requestCancel, getReview, publicStatus } from './reviewManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = Number(process.env.MAX_BODY_BYTES || 8 * 1024 * 1024);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ValidationError(`请求体超过上限 ${MAX_BODY} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: { code: 'EFORBIDDEN', message: '禁止访问' } });
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { code: 'ENOTFOUND', message: '资源不存在' } });
  }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/reviews') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new ValidationError('请求体不是合法 JSON');
      }
      const parsed = parseReviewPayload(payload);
      const id = createReview(parsed);
      sendJson(res, 202, { id, status: 'running', pollUrl: `/api/reviews/${id}` });
      return;
    }

    let m = pathname.match(/^\/api\/reviews\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && m) {
      const job = getReview(m[1]);
      if (!job) {
        sendJson(res, 404, { error: { code: 'ENOTFOUND', message: '复核任务不存在或已过期' } });
        return;
      }
      sendJson(res, 200, publicStatus(job));
      return;
    }

    m = pathname.match(/^\/api\/reviews\/([0-9a-f-]{36})\/cancel$/);
    if (req.method === 'POST' && m) {
      const accepted = requestCancel(m[1]);
      const job = getReview(m[1]);
      if (!job) {
        sendJson(res, 404, { error: { code: 'ENOTFOUND', message: '复核任务不存在或已过期' } });
        return;
      }
      sendJson(res, accepted ? 202 : 200, publicStatus(job));
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: { code: 'EMETHOD', message: '方法或路径不支持' } });
  } catch (err) {
    if (err instanceof ValidationError) {
      sendJson(res, 400, { error: { code: err.code, message: err.message } });
      return;
    }
    sendJson(res, 500, { error: { code: 'EINTERNAL', message: err.message || '内部错误' } });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => {
    console.log(`整数校正量复核服务已启动: http://${HOST}:${PORT}`);
  });
}
