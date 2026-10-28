'use strict';

/**
 * CFDNS 控制台的唯一后端函数。
 *
 * 为什么只有一个函数：Vercel 的每个 api/*.js 都是独立的实例，
 * 内存不共享。日志保存在内存里，所以登录 / 执行 / 查询必须走同一个函数，
 * 否则执行产生的日志在面板里读不到。
 *
 * 路由由 vercel.json 的 rewrites 映射到：
 *   /api/login   -> /api/cfdns?action=login
 *   /api/logout  -> /api/cfdns?action=logout
 *   /api/state   -> /api/cfdns?action=state
 *   /api/run     -> /api/cfdns?action=run
 *   /api/check   -> /api/cfdns?action=check
 *   /api/clear   -> /api/cfdns?action=clear
 *   /api/health  -> /api/cfdns?action=health
 * 也可以直接访问 /api/cfdns?action=xxx（rewrite 不生效时的兜底）。
 */

const crypto = require('crypto');

const auth = require('../lib/auth');
const store = require('../lib/store');
const sync = require('../lib/sync');
const { loadConfig, missingOf, mask } = require('../lib/config');

const MAX_BODY = 64 * 1024;

function sendJson(res, status, payload, headers) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (headers) {
    Object.keys(headers).forEach(function (key) {
      res.setHeader(key, headers[key]);
    });
  }
  res.end(body);
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let done = false;

    req.on('data', function (chunk) {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', function () {
      if (done) return;
      done = true;
      if (chunks.length === 0) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });

    req.on('error', function (err) {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/** 定时任务鉴权：Authorization: Bearer <CRON_SECRET> 或 x-cron-secret 头 */
function cronAuthorized(req, config) {
  if (!config.cronSecret) return false;

  const header = req.headers.authorization || '';
  const direct = req.headers['x-cron-secret'];
  let provided = '';

  if (typeof header === 'string' && /^bearer\s+/i.test(header)) {
    provided = header.replace(/^bearer\s+/i, '').trim();
  } else if (typeof direct === 'string') {
    provided = direct.trim();
  }

  if (!provided) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(config.cronSecret, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function buildState(config) {
  const missing = missingOf(config);
  const snapshot = store.snapshot();

  return {
    ok: true,
    configured: missing.length === 0,
    missing: missing,
    domain: config.domain || '',
    apiKeyMasked: mask(config.apiKey),
    apiSecretMasked: mask(config.apiSecret),
    ttl: config.ttl,
    cronEnabled: Boolean(config.cronSecret),
    maxLines: store.MAX_LINES,
    serverNow: new Date().toISOString(),
    lines: snapshot.lines,
    lastRun: snapshot.lastRun,
    running: snapshot.running,
    totalRuns: snapshot.totalRuns,
    bootedAt: snapshot.bootedAt
  };
}

async function handleLogin(req, res, config) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '请使用 POST 请求' });
  if (!config.pw) return sendJson(res, 500, { ok: false, error: '服务端未配置 PW 环境变量' });
  if (auth.tooManyAttempts(req)) {
    return sendJson(res, 429, { ok: false, error: '密码错误次数过多，请 10 分钟后再试' });
  }

  const body = await readJsonBody(req).catch(function () { return {}; });
  if (!auth.passwordEquals(body.password, config.pw)) {
    auth.recordFailure(req);
    return sendJson(res, 401, { ok: false, error: '密码错误' });
  }

  auth.resetFailures(req);
  const token = auth.createToken(config.pw, config.sessionDays);
  return sendJson(res, 200, { ok: true }, {
    'Set-Cookie': auth.buildCookie(token, config.sessionDays)
  });
}

function handleLogout(req, res) {
  return sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
}

async function handleRun(req, res, config) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '请使用 POST 请求' });

  const byCron = cronAuthorized(req, config);
  const bySession = auth.isLoggedIn(req, config.pw);

  if (!byCron && !bySession) {
    return sendJson(res, 401, {
      ok: false,
      error: config.cronSecret
        ? '未授权：请先登录，或带上 Authorization: Bearer <CRON_SECRET>'
        : '未授权：请先登录（服务端未配置 CRON_SECRET，外部调用已禁用）'
    });
  }

  const missing = missingOf(config);
  if (missing.length > 0) {
    return sendJson(res, 500, { ok: false, error: '缺少环境变量：' + missing.join(', ') });
  }

  if (store.isRunning()) {
    return sendJson(res, 409, { ok: false, error: '上一轮仍在执行中，请稍后再试' });
  }

  const trigger = byCron ? 'action' : 'manual';
  store.beginRun(trigger);

  try {
    // onLog：每产生一行就写进内存日志，面板轮询时能边执行边显示
    const result = await sync.runSync(config, { trigger: trigger, onLog: store.addLine });
    store.finishRun(result);

    return sendJson(res, 200, {
      ok: result.ok,
      summary: result.summary,
      counts: result.counts,
      durationMs: result.durationMs,
      trigger: result.trigger,
      logs: result.lines
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const line = sync.formatLine(sync.tsNow(config.timeZone), '执行异常', message);
    store.addLine(line);
    store.finishRun({ ok: false, summary: '执行异常：' + message, durationMs: 0, trigger: trigger });
    return sendJson(res, 500, { ok: false, error: message, logs: [line] });
  }
}

async function handleCheck(req, res, config) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '请使用 POST 请求' });
  if (!auth.isLoggedIn(req, config.pw)) return sendJson(res, 401, { ok: false, error: '未授权' });

  const missing = missingOf(config);
  if (missing.length > 0) {
    return sendJson(res, 500, { ok: false, error: '缺少环境变量：' + missing.join(', ') });
  }

  try {
    const result = await sync.runCheck(config, { onLog: store.addLine });
    return sendJson(res, 200, { ok: result.ok, summary: result.summary, logs: result.lines });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function handleState(req, res, config) {
  if (!auth.isLoggedIn(req, config.pw)) return sendJson(res, 401, { ok: false, error: '未登录' });
  return sendJson(res, 200, buildState(config));
}

function handleClear(req, res, config) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '请使用 POST 请求' });
  if (!auth.isLoggedIn(req, config.pw)) return sendJson(res, 401, { ok: false, error: '未授权' });
  store.clear();
  return sendJson(res, 200, { ok: true });
}

function handleHealth(req, res, config) {
  const missing = missingOf(config);
  return sendJson(res, 200, {
    ok: true,
    service: 'cfdns',
    configured: missing.length === 0,
    missing: missing,
    domain: config.domain || ''
  });
}

module.exports = async function handler(req, res) {
  const config = loadConfig();
  const url = new URL(req.url, 'http://localhost');
  let action = url.searchParams.get('action') || '';

  if (!action) {
    const segments = url.pathname.split('/').filter(Boolean);
    action = segments.length > 0 ? segments[segments.length - 1] : '';
  }

  try {
    switch (action) {
      case 'login': return await handleLogin(req, res, config);
      case 'logout': return handleLogout(req, res, config);
      case 'state': return handleState(req, res, config);
      case 'run': return await handleRun(req, res, config);
      case 'check': return await handleCheck(req, res, config);
      case 'clear': return handleClear(req, res, config);
      case 'health': return handleHealth(req, res, config);
      default:
        return sendJson(res, 404, {
          ok: false,
          error: '未知接口',
          hint: '可用：/api/login /api/logout /api/state /api/run /api/check /api/clear /api/health'
        });
    }
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
  }
};
