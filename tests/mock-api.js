'use strict';

/**
 * 本地 DNSHE API mock：用于确定性测试，不打真实接口。
 *
 * 支持：
 *   - subdomains &action=list
 *   - dns_records &action=list / create / update / delete
 *   - 故障注入：
 *       FAULT_LOST_CREATE=ipv6-4   该记录会真的写进去，但故意返回 500（模拟响应丢失）
 *       FAULT_REJECT=ipv4-3        该记录直接返回 400（模拟真正的失败）
 *   - 静态文件：/ipv6.txt /ipv4.txt 返回测试用的优选列表
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.Key || 'test-key';
const API_SECRET = process.env.Secret || 'test-secret';

const state = {
  domain: process.env.YM || 'y1s1.cc.cd',
  subdomainId: 1412389330,
  records: [],
  nextId: 900000000001,
  calls: []
};

const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        resolve({});
      }
    });
  });
}

function fullName(record) {
  return String(record.name || '').indexOf('.') >= 0
    ? record.name
    : record.name + '.' + state.domain;
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://localhost');

  // 测试控制接口
  if (url.pathname === '/__state') return send(res, 200, { records: state.records, calls: state.calls });
  if (url.pathname === '/__reset') {
    state.records = [];
    state.calls = [];
    return send(res, 200, { ok: true });
  }

  // 优选列表静态文件
  if (url.pathname === '/ipv6.txt' || url.pathname === '/ipv4.txt') {
    const file = path.join(FIXTURES, path.basename(url.pathname));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    return res.end(fs.readFileSync(file, 'utf8'));
  }

  if (url.pathname !== '/index.php') {
    res.statusCode = 404;
    return res.end('not found');
  }

  if (req.headers['x-api-key'] !== API_KEY || req.headers['x-api-secret'] !== API_SECRET) {
    return send(res, 401, { success: false, message: 'Invalid API key' });
  }

  const endpoint = url.searchParams.get('endpoint');
  const action = url.searchParams.get('action');
  state.calls.push(endpoint + ':' + action);

  if (endpoint === 'subdomains' && action === 'list') {
    return send(res, 200, {
      success: true,
      subdomains: [{ id: state.subdomainId, full_domain: state.domain, status: 'Registered' }],
      pagination: { has_more: false }
    });
  }

  if (endpoint === 'dns_records' && action === 'list') {
    return send(res, 200, {
      success: true,
      records: state.records.map(function (r) {
        return { id: r.id, name: r.name, type: r.type, content: r.content, ttl: r.ttl };
      }),
      pagination: { has_more: false, next_cursor: null }
    });
  }

  if (endpoint === 'dns_records' && action === 'create') {
    const body = await readBody(req);
    const name = body.name + '.' + state.domain;
    state.calls.push('create:' + body.name);

    const faultLost = process.env.FAULT_LOST_CREATE;
    const faultReject = process.env.FAULT_REJECT;
    const fault429 = process.env.FAULT_429;

    if (fault429 && body.name === fault429) {
      return send(res, 429, {
        success: false,
        message: 'Too many requests. Please try again in 25 minutes.'
      });
    }

    if (faultReject && body.name === faultReject) {
      return send(res, 400, { success: false, message: 'invalid_record (injected)' });
    }

    const record = {
      id: state.nextId++,
      name: name,
      type: body.type,
      content: body.content,
      ttl: body.ttl
    };
    state.records.push(record);

    if (faultLost && body.name === faultLost) {
      // 已经写进去了，但故意回 500：调用方应当重新查询确认
      return send(res, 500, { success: false, message: 'upstream error (injected, record was created)' });
    }

    return send(res, 200, { success: true, id: record.id, message: 'created' });
  }

  if (endpoint === 'dns_records' && action === 'update') {
    const body = await readBody(req);
    const record = state.records.find(function (r) { return String(r.id) === String(body.id); });
    if (!record) return send(res, 404, { success: false, message: 'not_found' });
    record.content = body.content;
    record.ttl = body.ttl;
    return send(res, 200, { success: true, message: 'updated' });
  }

  if (endpoint === 'dns_records' && action === 'delete') {
    const body = await readBody(req);
    state.records = state.records.filter(function (r) { return String(r.id) !== String(body.id); });
    return send(res, 200, { success: true, message: 'deleted' });
  }

  return send(res, 400, { success: false, message: 'unknown action' });
});

function listen(port) {
  return new Promise(function (resolve) {
    server.listen(port || 0, '127.0.0.1', function () {
      resolve('http://127.0.0.1:' + server.address().port);
    });
  });
}

module.exports = { server, listen, state };

if (require.main === module) {
  listen(Number(process.env.PORT || 4010)).then(function (base) {
    console.log('mock DNSHE:', base);
  });
}
