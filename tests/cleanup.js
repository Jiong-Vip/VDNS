'use strict';

/**
 * 删除测试过程中创建的 ipv4-1~6 / ipv6-1~6 记录，恢复域名原有状态。
 *   Key=xxx Secret=xxx YM=y1s1.cc.cd node tests/cleanup.js
 */

const dnshe = require('../lib/dnshe');
const { loadConfig } = require('../lib/config');

async function main() {
  const config = loadConfig();
  if (!config.apiKey || !config.apiSecret || !config.domain) {
    console.error('缺少 Key / Secret / YM 环境变量');
    process.exit(1);
  }

  const pattern = new RegExp('^ipv[46]-[1-6]\\.' + config.domain.replace(/\./g, '\\.') + '$', 'i');

  const sub = await dnshe.findSubdomain(config, config.domain);
  if (!sub) {
    console.error('找不到域名', config.domain);
    process.exit(1);
  }

  const records = await dnshe.listRecords(config, sub.id);
  const targets = records.filter(function (r) { return pattern.test(r.name); });
  console.log('待删除: ' + targets.length + ' 条');

  for (const record of targets) {
    try {
      await dnshe.deleteRecord(config, record.id);
      console.log('  已删除 ' + record.name + ' ' + record.type + ' ' + record.content);
    } catch (err) {
      console.log('  删除失败 ' + record.name + ': ' + err.message);
    }
    await new Promise(function (resolve) { setTimeout(resolve, 600); });
  }

  const left = await dnshe.listRecords(config, sub.id);
  console.log('剩余 ' + left.length + ' 条:');
  left.forEach(function (r) { console.log('  ' + r.name + ' ' + r.type + ' ' + r.content); });

  process.exit(left.some(function (r) { return pattern.test(r.name); }) ? 1 : 0);
}

main().catch(function (err) {
  console.error('出错:', err.message);
  process.exit(1);
});
