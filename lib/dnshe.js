'use strict';

/**
 * DNSHE 免费域名 API 客户端（V2：m=domain_hub + X-API-Key / X-API-Secret）
 * 文档：https://my.dnshe.com/knowledgebase/13/
 */

// 本地测试时可以用 DNSHE_BASE 指向 mock 服务
const BASE_URL = process.env.DNSHE_BASE || 'https://api005.dnshe.com/index.php';
const TIMEOUT_MS = 25000;

function buildUrl(endpoint, action, query) {
  const params = new URLSearchParams();
  params.set('m', 'domain_hub');
  params.set('endpoint', endpoint);
  params.set('action', action);
  if (query) {
    Object.keys(query).forEach(function (key) {
      const value = query[key];
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, String(value));
      }
    });
  }
  return BASE_URL + '?' + params.toString();
}

function errorMessage(status, payload) {
  if (payload && typeof payload === 'object') {
    const msg = payload.message || payload.error_code || payload.error;
    // DNSHE 的错误文案里可能带换行（例如 Error code: ... 另起一行），
    // 这里压成单行，保证日志一条一步、不被打断
    if (msg) return 'HTTP ' + status + ' ' + String(msg).replace(/\s+/g, ' ').trim();
  }
  return 'HTTP ' + status;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 从 Retry-After 头或报错文案里解析需要等待的秒数 */
function parseRetryAfter(header, payload) {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds;
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
  }

  const text = payload && (payload.message || payload.error || '');
  const minutes = /(\d+)\s*分钟|(\d+)\s*minutes?/i.exec(text || '');
  if (minutes) return Number(minutes[1] || minutes[2]) * 60;

  const secondsMatch = /(\d+)\s*秒|(\d+)\s*seconds?/i.exec(text || '');
  if (secondsMatch) return Number(secondsMatch[1] || secondsMatch[2]);

  return null;
}

/** 单次请求；可重试的错误会带上 retriable 标记 */
async function callOnce(config, options) {
  const method = options.body ? 'POST' : 'GET';
  const headers = {
    'X-API-Key': config.apiKey,
    'X-API-Secret': config.apiSecret,
    Accept: 'application/json',
    'User-Agent': 'CFDNS-Vercel/1.0'
  };
  const init = {
    method: method,
    headers: headers,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const url = buildUrl(options.endpoint, options.action, options.query);
  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const wrapped = new Error('网络错误：' + (err && err.message ? err.message : String(err)));
    // GET 可以安全重试；写请求结果不确定，不重试，交由调用方重新查询确认
    wrapped.retriable = !options.body;
    wrapped.uncertain = Boolean(options.body);
    throw wrapped;
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (err) {
    payload = null;
  }

  if (!response.ok) {
    const message = errorMessage(response.status, payload);
    const wrapped = new Error(message);

    // 429 是配额限流：DNSHE 会给出"请 N 分钟后重试"的冷却时间，
    // 立刻重试只会继续撞墙，所以标记为不可重试，并把等待时间带出去。
    if (response.status === 429) {
      wrapped.retriable = false;
      wrapped.uncertain = false;
      wrapped.rateLimited = true;
      wrapped.waitSeconds = parseRetryAfter(response.headers.get('retry-after'), payload);
      throw wrapped;
    }

    // DNSHE 有时用 400 包装上游的临时故障：
    //   HTTP 400 Operation failed. Please try again later. Error code: domain-...
    // 这种是"结果不确定"的瞬时错误，既不能直接记失败，也不能盲目重放，
    // 交给调用方先重新查询确认再决定要不要重试。
    const transientHint = /try again later|operation failed|please retry|temporarily/i.test(message);

    if (transientHint) {
      wrapped.retriable = false;
      wrapped.uncertain = Boolean(options.body);
      throw wrapped;
    }

    // 5xx 对写操作结果不确定，不重试，交由调用方重新查询确认
    wrapped.retriable = !options.body && response.status >= 500;
    wrapped.uncertain = Boolean(options.body) && response.status >= 500;
    throw wrapped;
  }

  if (!payload || payload.success !== true) {
    throw new Error(errorMessage(response.status, payload));
  }

  return payload;
}

async function call(config, options) {
  const attempts = options.body ? 2 : 3;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await callOnce(config, options);
    } catch (err) {
      lastError = err;
      if (!err.retriable || attempt === attempts) throw err;
      await sleep(400 * attempt + Math.floor(Math.random() * 300));
    }
  }

  throw lastError;
}

/** 按完整域名查找 subdomain，返回 { id, fullDomain } */
async function findSubdomain(config, domain) {
  const payload = await call(config, {
    endpoint: 'subdomains',
    action: 'list',
    query: { search: domain, per_page: 50, include_total: 1 }
  });

  const list = Array.isArray(payload.subdomains) ? payload.subdomains : [];
  for (const item of list) {
    if (String(item.full_domain || '').toLowerCase() === domain.toLowerCase()) {
      return { id: item.id, fullDomain: item.full_domain };
    }
  }
  return null;
}

/** 拉取域名下全部记录，自动翻页（最多 5 页 / 500 条） */
async function listRecords(config, subdomainId) {
  const records = [];
  let cursor = 0;

  for (let page = 0; page < 5; page++) {
    const payload = await call(config, {
      endpoint: 'dns_records',
      action: 'list',
      query: { subdomain_id: subdomainId, per_page: 100, cursor: cursor }
    });

    const list = Array.isArray(payload.records) ? payload.records : [];
    for (const item of list) {
      records.push({
        id: item.id,
        name: String(item.name || ''),
        type: String(item.type || ''),
        content: String(item.content || '')
      });
    }

    const pagination = payload.pagination || {};
    if (pagination.has_more === true && pagination.next_cursor !== undefined && pagination.next_cursor !== null) {
      cursor = pagination.next_cursor;
    } else {
      break;
    }
  }

  return records;
}

async function createRecord(config, { subdomainId, type, name, content, ttl }) {
  return call(config, {
    endpoint: 'dns_records',
    action: 'create',
    body: {
      subdomain_id: subdomainId,
      type: type,
      name: name,
      content: content,
      ttl: ttl
    }
  });
}

async function updateRecord(config, { id, type, content, ttl }) {
  return call(config, {
    endpoint: 'dns_records',
    action: 'update',
    body: { id: id, type: type, content: content, ttl: ttl }
  });
}

async function deleteRecord(config, id) {
  return call(config, {
    endpoint: 'dns_records',
    action: 'delete',
    body: { id: id }
  });
}

module.exports = { findSubdomain, listRecords, createRecord, updateRecord, deleteRecord, buildUrl };
