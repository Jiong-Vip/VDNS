'use strict';

const dnshe = require('./dnshe');
const source = require('./source');

const WRITE_CONCURRENCY = 3;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 本地毫秒级时间：2026-10-28 07:15:35.269 */
function tsNow(timeZone) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(now);
  const get = function (type) {
    const found = parts.find(function (item) { return item.type === type; });
    return found ? found.value : '00';
  };
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
    get('hour') + ':' + get('minute') + ':' + get('second') + '.' +
    String(now.getMilliseconds()).padStart(3, '0');
}

function formatLine(time, action, result) {
  return time + '：' + action + '>>>' + result;
}

/** 并发受限的 map，保持结果顺序 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = [];
  const size = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < size; i++) {
    runners.push((async function () {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })());
  }

  await Promise.all(runners);
  return results;
}

async function settled(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function triggerLabel(trigger) {
  if (trigger === 'api') return '外部 API';
  if (trigger === 'action') return 'GitHub Actions';
  return '面板手动';
}

/** 只检查凭证与主域名，不写任何记录 */
async function runCheck(config) {
  const lines = [];
  const push = function (op, res) {
    lines.push(formatLine(tsNow(config.timeZone), op, res));
  };

  push('测试连接', '正在校验 DNSHE 凭证与主域名 ' + config.domain);
  try {
    const sub = await dnshe.findSubdomain(config, config.domain);
    if (!sub) {
      push('查询主域名 ' + config.domain, '失败：账号下没有找到该域名');
      return { ok: false, summary: '主域名不存在', lines: lines };
    }
    push('查询主域名 ' + config.domain, '成功：subdomain_id=' + sub.id);
    const records = await dnshe.listRecords(config, sub.id);
    push('读取现有解析记录', '成功：共 ' + records.length + ' 条');
    return { ok: true, summary: '凭证有效，域名下现有 ' + records.length + ' 条记录', lines: lines };
  } catch (err) {
    push('测试连接', '失败：' + err.message);
    return { ok: false, summary: '检查失败', lines: lines };
  }
}

/**
 * 执行一轮同步。
 * 规则：地址不变则跳过；某一家抓取失败则完全不碰该家的记录。
 */
async function runSync(config, options) {
  const startedAt = Date.now();
  const trigger = (options && options.trigger) || 'manual';
  const lines = [];
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };

  const push = function (op, res) {
    lines.push(formatLine(tsNow(config.timeZone), op, res));
  };

  push('开始执行', '主域名 ' + config.domain + '，TTL ' + config.ttl + 's，触发方式 ' + triggerLabel(trigger));

  // ---- 1. 抓取两个优选列表（并行）----
  const results = await Promise.all([
    settled(source.fetchSource(config.sourceV6, 'ipv6')),
    settled(source.fetchSource(config.sourceV4, 'ipv4'))
  ]);

  const families = [
    { key: 'ipv6', label: 'IPv6', type: 'AAAA', result: results[0] },
    { key: 'ipv4', label: 'IPv4', type: 'A', result: results[1] }
  ];

  const usable = [];
  for (const family of families) {
    if (!family.result.ok) {
      push('获取' + family.label + '优选地址', '失败：' + family.result.error);
      continue;
    }
    const slots = family.result.value.slots;
    push('获取' + family.label + '优选地址', '成功：共 ' + family.result.value.totalLines + ' 行');
    push('解析 ' + family.label + ' 优选', '命中 ' + slots.length + ' 条（移动/联通/电信各取前 2 个）');
    if (slots.length > 0) {
      usable.push({ type: family.type, label: family.label, slots: slots });
    } else {
      push('同步' + family.label + '记录', '跳过：没有解析到可用地址，保持原记录不变');
    }
  }

  if (usable.length === 0) {
    push('本轮结束', '失败：IPv4/IPv6 均无可用地址，未修改任何 DNS 记录');
    return {
      ok: false,
      summary: '抓取失败，未修改任何记录',
      counts: counts,
      lines: lines,
      durationMs: Date.now() - startedAt,
      trigger: trigger
    };
  }

  // ---- 2. 定位主域名 ----
  let subdomain = null;
  try {
    subdomain = await dnshe.findSubdomain(config, config.domain);
  } catch (err) {
    push('查询主域名 ' + config.domain, '失败：' + err.message);
    push('本轮结束', '失败：无法确认主域名，未修改任何 DNS 记录');
    return {
      ok: false, summary: '主域名查询失败', counts: counts,
      lines: lines, durationMs: Date.now() - startedAt, trigger: trigger
    };
  }

  if (!subdomain) {
    push('查询主域名 ' + config.domain, '失败：账号下没有找到该域名');
    push('本轮结束', '失败：无法确认主域名，未修改任何 DNS 记录');
    return {
      ok: false, summary: '主域名不存在', counts: counts,
      lines: lines, durationMs: Date.now() - startedAt, trigger: trigger
    };
  }
  push('查询主域名 ' + config.domain, '成功：subdomain_id=' + subdomain.id);

  // ---- 3. 读取现有记录 ----
  let existing = [];
  try {
    existing = await dnshe.listRecords(config, subdomain.id);
  } catch (err) {
    push('读取现有解析记录', '失败：' + err.message);
    push('本轮结束', '失败：读取现有记录失败，未做任何修改');
    return {
      ok: false, summary: '读取记录失败', counts: counts,
      lines: lines, durationMs: Date.now() - startedAt, trigger: trigger
    };
  }
  push('读取现有解析记录', '成功：共 ' + existing.length + ' 条');

  const index = new Map();
  for (const record of existing) {
    index.set(record.name.toLowerCase() + '|' + record.type.toUpperCase(), record);
  }

  // ---- 4. 逐条写入 ----
  const tasks = [];
  for (const family of usable) {
    for (const slot of family.slots) {
      tasks.push({
        type: family.type,
        label: family.label,
        name: slot.name,
        addr: slot.addr,
        operator: slot.operator,
        fqdn: slot.name + '.' + config.domain
      });
    }
  }

  const outcomes = await mapLimit(tasks, WRITE_CONCURRENCY, async function (task) {
    const key = task.fqdn.toLowerCase() + '|' + task.type;
    const hit = index.get(key);
    const suffix = '（' + task.label + ' · ' + task.operator + '）';
    const label = hit ? '更新 ' : '新增 ';

    if (hit && String(hit.content) === task.addr) {
      return { kind: 'skipped', action: '检查 ' + task.fqdn + suffix, result: '无变化：' + task.addr };
    }

    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      // 轻微错峰，降低触发 DNSHE 突发限流的概率（12 条一共也就多花 2 秒）
      if (attempt === 1) await sleep(200);

      try {
        if (hit) {
          await dnshe.updateRecord(config, {
            id: hit.id,
            type: task.type,
            content: task.addr,
            ttl: config.ttl
          });
          return {
            kind: 'updated',
            action: label + task.fqdn + suffix,
            result: '成功：' + hit.content + ' → ' + task.addr
          };
        }

        await dnshe.createRecord(config, {
          subdomainId: subdomain.id,
          type: task.type,
          name: task.name,
          content: task.addr,
          ttl: config.ttl
        });
        return {
          kind: 'created',
          action: label + task.fqdn + suffix,
          result: '成功：' + task.addr
        };
      } catch (err) {
        lastError = err;
        // 明确失败（参数错、鉴权错等）没有重试价值，直接记失败
        if (!err || !err.uncertain) break;

        // 结果不确定（超时 / 连接被断 / 5xx）：先查询确认，避免重复写入
        await sleep(600 * attempt);
        try {
          const fresh = await dnshe.listRecords(config, subdomain.id);
          const found = fresh.find(function (item) {
            return item.name.toLowerCase() === task.fqdn.toLowerCase() &&
              item.type.toUpperCase() === task.type.toUpperCase();
          });
          if (found && String(found.content) === task.addr) {
            return {
              kind: hit ? 'updated' : 'created',
              action: label + task.fqdn + suffix,
              result: '成功：响应异常，重新查询确认已生效（' + task.addr + '）'
            };
          }
        } catch (verifyErr) {
          // 查询也失败时继续下一轮写入
        }
      }
    }

    const reason = lastError && lastError.message ? lastError.message : '未知错误';
    let extra = '';
    if (lastError && lastError.rateLimited && lastError.waitSeconds) {
      extra = '（限流，约 ' + Math.ceil(lastError.waitSeconds / 60) + ' 分钟后再试）';
    }

    return {
      kind: 'failed',
      action: label + task.fqdn + suffix,
      result: '失败：' + reason + extra
    };
  });

  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (outcome.kind === 'created') counts.created += 1;
    else if (outcome.kind === 'updated') counts.updated += 1;
    else if (outcome.kind === 'skipped') counts.skipped += 1;
    else counts.failed += 1;
    lines.push(formatLine(tsNow(config.timeZone), outcome.action, outcome.result));
  }

  const summary = '新增 ' + counts.created + '，更新 ' + counts.updated +
    '，无变化 ' + counts.skipped + '，失败 ' + counts.failed;
  lines.push(formatLine(tsNow(config.timeZone), '本轮结束', summary));

  return {
    ok: counts.failed === 0,
    summary: summary,
    counts: counts,
    lines: lines,
    durationMs: Date.now() - startedAt,
    trigger: trigger
  };
}

module.exports = { runSync, runCheck, tsNow, formatLine, mapLimit };
