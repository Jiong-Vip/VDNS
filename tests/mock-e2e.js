'use strict';

/**
 * 离线确定性测试：用本地 mock 替代 DNSHE 与 BestCF，覆盖
 *   - 12 条记录的新增
 *   - 写响应丢失（500 但其实已写入）→ 重新查询确认，不误判失败
 *   - 真正失败（400）→ 记失败且不重试
 *   - 第二轮地址未变 → 全部跳过
 *   - 日志格式 / 倒序 / 上限
 *
 *   node tests/mock-e2e.js
 */

process.env.Key = 'test-key';
process.env.Secret = 'test-secret';
process.env.YM = 'y1s1.cc.cd';

const mock = require('./mock-api');

let failed = 0;

function check(name, expected, actual) {
  if (String(expected) === String(actual)) {
    console.log('  \u001b[32mOK\u001b[0m   ' + name + '（' + actual + '）');
  } else {
    failed += 1;
    console.log('  \u001b[31mFAIL\u001b[0m ' + name + '（期望 ' + expected + '，实际 ' + actual + '）');
  }
}

function checkTrue(name, condition, detail) {
  if (condition) console.log('  \u001b[32mOK\u001b[0m   ' + name + (detail ? '（' + detail + '）' : ''));
  else {
    failed += 1;
    console.log('  \u001b[31mFAIL\u001b[0m ' + name + (detail ? '（' + detail + '）' : ''));
  }
}

const LINE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}：.+>>>.+$/;

async function main() {
  const base = await mock.listen();
  process.env.DNSHE_BASE = base + '/index.php';
  process.env.SOURCE_IPV6 = base + '/ipv6.txt';
  process.env.SOURCE_IPV4 = base + '/ipv4.txt';

  const { loadConfig } = require('../lib/config');
  const sync = require('../lib/sync');
  const source = require('../lib/source');
  const store = require('../lib/store');

  const config = loadConfig();

  console.log('=== 0. 列表解析');
  const fs = require('fs');
  const path = require('path');
  const v6 = source.parseList(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'ipv6.txt'), 'utf8'), 'ipv6');
  const v4 = source.parseList(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'ipv4.txt'), 'utf8'), 'ipv4');
  check('IPv6 槽位数', 6, v6.length);
  check('IPv4 槽位数', 6, v4.length);
  check('IPv6 第一条', 'ipv6-1 2606:4700:9b0d:ba2d:66ce:d4b3:2fa0:f3fe 移动', v6[0].name + ' ' + v6[0].addr + ' ' + v6[0].operator);
  check('IPv4 第 6 条', 'ipv4-6 104.16.145.28 电信', v4[5].name + ' ' + v4[5].addr + ' ' + v4[5].operator);

  console.log('\n=== 1. 首次同步（含一条"响应丢失"的写入）');
  process.env.FAULT_LOST_CREATE = 'ipv6-4';
  const run1 = await sync.runSync(config, { trigger: 'api' });
  check('新增条数', 12, run1.counts.created);
  check('失败条数', 0, run1.counts.failed);
  check('执行结果', true, run1.ok);
  checkTrue('日志格式正确', run1.lines.every(function (line) { return LINE_PATTERN.test(line); }), run1.lines.length + ' 行');
  checkTrue('有一条走了"重新查询确认"',
    run1.lines.some(function (line) { return line.indexOf('重新查询确认已生效') >= 0; }),
    run1.lines.filter(function (line) { return line.indexOf('重新查询确认已生效') >= 0; })[0]);
  check('mock 里的记录数', 12, mock.state.records.length);
  check('最后一行是本轮结束', true, run1.lines[run1.lines.length - 1].indexOf('本轮结束') >= 0);

  console.log('\n=== 2. 第二轮（地址未变，应全部跳过）');
  const run2 = await sync.runSync(config, { trigger: 'api' });
  check('无变化条数', 12, run2.counts.skipped);
  check('新增条数', 0, run2.counts.created);
  check('失败条数', 0, run2.counts.failed);

  console.log('\n=== 3. 真正失败（400）应记失败且不重试');
  mock.state.records = mock.state.records.filter(function (r) { return r.name !== 'ipv6-2.y1s1.cc.cd'; });
  process.env.FAULT_REJECT = 'ipv6-2';
  const run3 = await sync.runSync(config, { trigger: 'api' });
  check('其余记录跳过数', 11, run3.counts.skipped);
  check('新增成功条数', 0, run3.counts.created);
  check('失败条数', 1, run3.counts.failed);
  check('执行结果', false, run3.ok);
  const failLine = run3.lines.filter(function (line) { return line.indexOf('>>>失败') >= 0; })[0];
  checkTrue('失败原因可读', failLine && failLine.indexOf('HTTP 400') >= 0, failLine);
  delete process.env.FAULT_REJECT;

  console.log('\n=== 4. 地址变化应触发更新，缺失的补建');
  const changed = mock.state.records.find(function (r) { return r.name === 'ipv4-1.y1s1.cc.cd'; });
  changed.content = '1.1.1.1';
  const run4 = await sync.runSync(config, { trigger: 'api' });
  check('更新条数', 1, run4.counts.updated);
  check('补建条数', 1, run4.counts.created);
  check('无变化条数', 10, run4.counts.skipped);

  console.log('\n=== 4.1 限流（429）不重试，且提示冷却时间');
  mock.state.records = [];
  mock.state.calls = [];
  process.env.FAULT_429 = 'ipv4-5';
  const run4a = await sync.runSync(config, { trigger: 'api' });
  check('成功条数', 11, run4a.counts.created);
  check('失败条数', 1, run4a.counts.failed);
  check('该记录只尝试了 1 次', 1, mock.state.calls.filter(function (c) { return c === 'create:ipv4-5'; }).length);
  const limitLine = run4a.lines.filter(function (line) { return line.indexOf('>>>失败') >= 0; })[0];
  checkTrue('提示了冷却时间', limitLine && limitLine.indexOf('25 分钟后再试') >= 0, limitLine);
  delete process.env.FAULT_429;

  console.log('\n=== 5. 日志缓冲');
  const allRuns = [run1, run2, run3, run4, run4a];
  const totalLines = allRuns.reduce(function (sum, run) { return sum + run.lines.length; }, 0);
  store.clear();
  allRuns.forEach(function (run) { store.addLines(run.lines); });
  check('缓冲上限', Math.min(100, totalLines), store.snapshot().lines.length);
  checkTrue('不超过 100 条', store.snapshot().lines.length <= 100, store.snapshot().lines.length + ' 条');
  check('快照倒序（最新在最前）', true,
    store.snapshot().lines[0] === run4a.lines[run4a.lines.length - 1]);
  console.log('     共产生日志 ' + totalLines + ' 行，缓冲保留最近 ' + store.snapshot().lines.length + ' 行');

  console.log('');
  if (failed === 0) console.log('\u001b[32m全部通过\u001b[0m');
  else console.log('\u001b[31m失败 ' + failed + ' 项\u001b[0m');

  mock.server.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (err) {
  console.error(err);
  try { mock.server.close(); } catch (e) { /* ignore */ }
  process.exit(1);
});
