'use strict';

/**
 * 读取并校验环境变量配置。
 * 变量名兼容大小写（Vercel 上是大小写敏感的）：
 *   PW           面板密码（必填）
 *   Key / KEY    DNSHE API Key（必填）
 *   Secret       DNSHE API Secret（必填）
 *   YM           操作主域名，如 y1s1.cc.cd（必填）
 *   CRON_SECRET  外部执行 API 的密钥（可选，不填则只能手动执行）
 */
function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const name = arguments[i];
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

const DEFAULTS = {
  sourceV6: 'https://bestcf.pages.dev/cfyes/ipv6.txt',
  sourceV4: 'https://bestcf.pages.dev/wetest/ipv4.txt',
  ttl: 600,
  sessionDays: 7,
  timeZone: 'Asia/Shanghai'
};

function loadConfig() {
  return {
    pw: pick('PW'),
    apiKey: pick('Key', 'KEY', 'API_KEY'),
    apiSecret: pick('Secret', 'SECRET', 'API_SECRET'),
    domain: pick('YM', 'ym', 'DOMAIN').replace(/^\.+/, '').replace(/\.+$/, ''),
    cronSecret: pick('CRON_SECRET'),
    sourceV6: pick('SOURCE_IPV6') || DEFAULTS.sourceV6,
    sourceV4: pick('SOURCE_IPV4') || DEFAULTS.sourceV4,
    ttl: DEFAULTS.ttl,
    sessionDays: DEFAULTS.sessionDays,
    timeZone: DEFAULTS.timeZone
  };
}

/** 返回缺失的必填项（用于面板提示 / 接口报错） */
function missingOf(config) {
  const missing = [];
  if (!config.pw) missing.push('PW');
  if (!config.apiKey) missing.push('Key');
  if (!config.apiSecret) missing.push('Secret');
  if (!config.domain) missing.push('YM');
  return missing;
}

/** 密钥打码，用于页面展示 */
function mask(value) {
  if (!value) return '未配置';
  if (value.length <= 10) return value.slice(0, 2) + '****';
  return value.slice(0, 6) + '****' + value.slice(-4);
}

module.exports = { loadConfig, missingOf, mask, DEFAULTS };
