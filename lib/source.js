'use strict';

/**
 * BestCF 优选地址列表的抓取与解析。
 *
 * 行格式：
 *   IPv6: [2606:4700:9b0d:ba2d:66ce:d4b3:2fa0:f3fe]:443#CFYes优选 | 移动 | [2606:...]
 *   IPv4: 104.16.49.56:443#微测优选 | 移动 | LAX | 104.16.49.56
 * 首行/末行是广告行（不含运营商），会被忽略。
 */

const TIMEOUT_MS = 20000;

const OPERATORS = [
  { label: '移动', base: 1 },
  { label: '联通', base: 3 },
  { label: '电信', base: 5 }
];

function isValidIPv4(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return false;
  return parts.every(function (part) {
    return /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255;
  });
}

function isValidIPv6(value) {
  const text = String(value);
  if (text.indexOf(':') < 0) return false;
  if (!/^[0-9a-fA-F:]+$/.test(text)) return false;
  return text.split(':').length >= 3;
}

function isValidAddress(value, family) {
  return family === 'ipv6' ? isValidIPv6(value) : isValidIPv4(value);
}

/** 从注释里找运营商：移动 / 联通 / 电信 */
function pickOperator(comment) {
  const fields = String(comment).split('|');
  for (const field of fields) {
    const text = field.trim();
    for (const op of OPERATORS) {
      if (text.indexOf(op.label) >= 0) return op.label;
    }
  }
  return '';
}

/**
 * 解析列表文本，返回按记录名排好序的槽位：
 *   [{ name: 'ipv6-1', addr: '2606:...', operator: '移动', family: 'ipv6' }]
 */
function parseList(text, family) {
  const used = { 移动: 0, 联通: 0, 电信: 0 };
  const slots = [];

  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const hash = line.indexOf('#');
    if (hash < 0) continue;

    const addressPart = line.slice(0, hash).trim();
    const comment = line.slice(hash + 1);

    let addr = '';
    if (addressPart.charAt(0) === '[') {
      const close = addressPart.indexOf(']');
      if (close > 1) addr = addressPart.slice(1, close);
    } else {
      const colon = addressPart.indexOf(':');
      addr = colon > 0 ? addressPart.slice(0, colon) : addressPart;
    }

    if (!isValidAddress(addr, family)) continue;

    const operator = pickOperator(comment);
    if (!operator) continue;

    if (used[operator] >= 2) continue;

    const base = operator === '移动' ? 1 : operator === '联通' ? 3 : 5;
    const slot = base + used[operator];
    used[operator] += 1;

    slots.push({
      name: family + '-' + slot,
      addr: addr,
      operator: operator,
      family: family
    });
  }

  slots.sort(function (a, b) {
    return Number(a.name.split('-')[1]) - Number(b.name.split('-')[1]);
  });

  return slots;
}

/** 抓取并解析；返回 { slots, totalLines } */
async function fetchSource(url, family) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (CFDNS)',
      Accept: 'text/plain'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }

  const text = await response.text();
  if (!text) throw new Error('返回内容为空');

  const totalLines = text.split(/\r?\n/).filter(function (line) {
    return line.trim() !== '';
  }).length;

  return { slots: parseList(text, family), totalLines: totalLines };
}

module.exports = { parseList, fetchSource, isValidIPv4, isValidIPv6, OPERATORS };
