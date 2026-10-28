'use strict';

/**
 * 端到端测试：起本地服务，走真实的登录 / 鉴权 / 同步 / 日志 / 清空流程。
 * 会真的往 DNSHE 写记录，跑完请执行：
 *   CFDNS_KEY=... CFDNS_SECRET=... python ../tests/e2e/cleanup.py
 *
 *   PW=xxx Key=xxx Secret=xxx YM=y1s1.cc.cd CRON_SECRET=xxx node tests/e2e.js
 */

const { server } = require('./serve');

const PORT = Number(process.env.PORT || 3199);
const BASE = 'http://127.0.0.1:' + PORT;

const PW = process.env.PW || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

let failed = 0;
let cookie = '';

function ok(name, detail) {
  console.log('  \u001b[32mOK\u001b[0m   ' + name + (detail === undefined ? '' : '（' + detail + '）'));
}

function bad(name, expected, actual) {
  failed += 1;
  console.log('  \u001b[31mFAIL\u001b[0m ' + name + '（期望 ' + expected + '，实际 ' + actual + '）');
}

function check(name, expected, actual) {
  if (String(expected) === String(actual)) ok(name, actual);
  else bad(name, expected, actual);
}

function checkTrue(name, condition, detail) {
  if (condition) ok(name, detail);
  else bad(name, true, detail);
}

async function call(path, options) {
  options = options || {};
  const init = { method: options.method || 'GET', headers: {} };

  if (options.cookie) init.headers.Cookie = options.cookie;
  if (options.auth) init.headers.Authorization = options.auth;
  if (options.headers) Object.assign(init.headers, options.headers);
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(BASE + path, init);
  const setCookie = response.headers.get('set-cookie');
  const data = await response.json().catch(function () { return {}; });
  return { status: response.status, data: data, setCookie: setCookie };
}

async function main() {
  await new Promise(function (resolve) { server.listen(PORT, '127.0.0.1', resolve); });
  console.log('本地服务: ' + BASE + '\n');

  console.log('=== 1. 基础健康检查与未登录拦截');
  const health = await call('/api/health');
  check('健康检查状态码', 200, health.status);
  check('配置是否完整', true, health.data.configured);

  const stateNoAuth = await call('/api/state');
  check('未登录读取状态', 401, stateNoAuth.status);

  const runNoAuth = await call('/api/run', { method: 'POST' });
  check('未登录执行', 401, runNoAuth.status);

  console.log('\n=== 2. 登录');
  const loginWrong = await call('/api/login', { method: 'POST', body: { password: 'wrong-password' } });
  check('错误密码', 401, loginWrong.status);

  const loginOk = await call('/api/login', { method: 'POST', body: { password: PW } });
  check('正确密码', 200, loginOk.status);
  checkTrue('返回会话 Cookie', typeof loginOk.setCookie === 'string' && loginOk.setCookie.indexOf('cfdns_auth=') === 0,
    loginOk.setCookie ? loginOk.setCookie.split(';')[0].slice(0, 24) + '…' : '无');
  cookie = (loginOk.setCookie || '').split(';')[0];

  const stateAuthed = await call('/api/state', { cookie: cookie });
  check('登录后读取状态', 200, stateAuthed.status);
  check('初始日志条数', 0, (stateAuthed.data.lines || []).length);

  console.log('\n=== 3. 外部执行接口鉴权');
  const runBadSecret = await call('/api/run', { method: 'POST', auth: 'Bearer not-the-secret' });
  check('错误的 CRON_SECRET', 401, runBadSecret.status);

  console.log('\n=== 4. 真实同步（通过 CRON_SECRET 触发）');
  const started = Date.now();
  const run1 = await call('/api/run', { method: 'POST', auth: 'Bearer ' + CRON_SECRET });
  check('执行状态码', 200, run1.status);
  check('执行是否成功', true, run1.data.ok);
  check('返回日志行数大于 0', true, Array.isArray(run1.data.logs) && run1.data.logs.length > 0);
  const counts = run1.data.counts || {};
  const total = (counts.created || 0) + (counts.updated || 0) + (counts.skipped || 0) + (counts.failed || 0);
  check('处理记录总数', 12, total);
  console.log('     摘要: ' + run1.data.summary + '，耗时 ' + (run1.data.durationMs) + ' ms');
  console.log('     日志样例: ' + (run1.data.logs || []).slice(-1)[0]);
  console.log('     首行样例: ' + (run1.data.logs || [])[0]);
  (run1.data.logs || []).filter(function (line) {
    return line.indexOf('>>>失败') >= 0;
  }).forEach(function (line) {
    console.log('     失败行: ' + line);
  });

  console.log('\n=== 5. 日志回到面板');
  const stateAfter = await call('/api/state', { cookie: cookie });
  check('日志条数大于 0', true, (stateAfter.data.lines || []).length > 0);
  check('上次执行是否成功', true, stateAfter.data.lastRun && stateAfter.data.lastRun.ok);
  check('触发方式', 'action', stateAfter.data.lastRun && stateAfter.data.lastRun.trigger);
  checkTrue('日志倒序（最新在最前）',
    (stateAfter.data.lines || [])[0].indexOf('本轮结束') >= 0,
    (stateAfter.data.lines || [])[0]);

  console.log('\n=== 6. 再执行一次（地址不变应跳过）');
  const run2 = await call('/api/run', { method: 'POST', auth: 'Bearer ' + CRON_SECRET });
  check('第二次执行状态码', 200, run2.status);
  const c2 = run2.data.counts || {};
  check('第二次处理总数', 12, (c2.created || 0) + (c2.updated || 0) + (c2.skipped || 0) + (c2.failed || 0));
  console.log('     摘要: ' + run2.data.summary);

  console.log('\n=== 7. 测试连接（面板会话）');
  const checkRes = await call('/api/check', { method: 'POST', cookie: cookie });
  check('测试连接状态码', 200, checkRes.status);
  check('测试连接结果', true, checkRes.data.ok);
  console.log('     ' + checkRes.data.summary);

  console.log('\n=== 8. 清空日志');
  const cleared = await call('/api/clear', { method: 'POST', cookie: cookie });
  check('清空状态码', 200, cleared.status);
  const stateCleared = await call('/api/state', { cookie: cookie });
  check('清空后日志条数', 0, (stateCleared.data.lines || []).length);

  console.log('\n=== 9. 登录限流');
  const headers = { 'X-Forwarded-For': '203.0.113.9' };
  let lastStatus = 0;
  for (let i = 0; i < 12; i++) {
    const res = await call('/api/login', { method: 'POST', headers: headers, body: { password: 'nope-' + i } });
    lastStatus = res.status;
  }
  check('连续错误后被限流', 429, lastStatus);

  console.log('\n=== 10. 退出登录');
  const logout = await call('/api/logout', { method: 'POST', cookie: cookie });
  check('退出状态码', 200, logout.status);
  checkTrue('服务端要求清除 Cookie',
    typeof logout.setCookie === 'string' && logout.setCookie.indexOf('Max-Age=0') >= 0,
    logout.setCookie ? 'Max-Age=0' : '无 Set-Cookie');

  console.log('\n总耗时: ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  if (failed === 0) console.log('\u001b[32m全部通过\u001b[0m');
  else console.log('\u001b[31m失败 ' + failed + ' 项\u001b[0m');

  server.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (err) {
  console.error(err);
  server.close();
  process.exit(1);
});
