'use strict';

const crypto = require('crypto');
const { DEFAULTS } = require('./config');

const COOKIE_NAME = 'cfdns_auth';

/** 用密码派生签名密钥，不引入额外的 AUTH_SECRET */
function signingKey(password) {
  return crypto.createHash('sha256').update('cfdns-v1|' + password).digest();
}

function sign(expireAt, password) {
  return crypto
    .createHmac('sha256', signingKey(password))
    .update(String(expireAt))
    .digest('hex');
}

/** 生成形如 <过期毫秒>.<签名> 的令牌 */
function createToken(password, days) {
  const expireAt = Date.now() + (days || DEFAULTS.sessionDays) * 24 * 60 * 60 * 1000;
  return expireAt + '.' + sign(expireAt, password);
}

function verifyToken(token, password) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const expireAt = Number(token.slice(0, dot));
  const signature = token.slice(dot + 1);
  if (!Number.isFinite(expireAt) || expireAt <= Date.now()) return false;

  const expected = sign(expireAt, password);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const name = pair.slice(0, idx).trim();
    if (!name) return;
    out[name] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function buildCookie(token, days) {
  const maxAge = (days || DEFAULTS.sessionDays) * 24 * 60 * 60;
  return [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + maxAge
  ].join('; ');
}

function clearCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

/** 从请求里取登录状态 */
function isLoggedIn(req, password) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME], password);
}

/** 密码比较，避免计时攻击 */
function passwordEquals(input, password) {
  const a = Buffer.from(String(input || ''), 'utf8');
  const b = Buffer.from(String(password || ''), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b); // 保持耗时一致
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------------------
 * 简单的登录限流：同一 IP 10 分钟内最多 10 次失败
 * （实例内存，冷启动会重置；只用于挡住暴力破解，够用）
 * ------------------------------------------------------------------------ */
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

function tooManyAttempts(req) {
  const entry = attempts.get(clientIp(req));
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    attempts.delete(clientIp(req));
    return false;
  }
  return entry.count >= MAX_FAILS;
}

function recordFailure(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function resetFailures(req) {
  attempts.delete(clientIp(req));
}

module.exports = {
  COOKIE_NAME,
  createToken,
  verifyToken,
  buildCookie,
  clearCookie,
  isLoggedIn,
  passwordEquals,
  tooManyAttempts,
  recordFailure,
  resetFailures,
  clientIp
};
