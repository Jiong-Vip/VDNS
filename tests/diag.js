'use strict';
// 临时诊断脚本：查看域名下的记录现状与接口耗时
const dnshe = require('../lib/dnshe');
const { loadConfig } = require('../lib/config');

(async function () {
  const config = loadConfig();
  const t0 = Date.now();
  try {
    const sub = await dnshe.findSubdomain(config, config.domain);
    console.log('findSubdomain ok:', JSON.stringify(sub), Date.now() - t0, 'ms');
    const recs = await dnshe.listRecords(config, sub.id);
    console.log('records:', recs.length);
    recs.sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (r) { console.log('  ', r.name, r.type, r.content); });
  } catch (err) {
    console.log('ERROR:', err.message, Date.now() - t0, 'ms');
  }
})();
