'use strict';

/**
 * 进程内状态：日志环形缓冲 + 最近一次执行结果。
 *
 * 注意：Vercel 无状态，这里的数据只存在于当前函数实例的内存里。
 * 冷启动、实例切换、扩容都会清空。登录/执行/查询都走同一个函数，
 * 因此正常情况下面板能读到同一实例的日志。
 */

const MAX_LINES = 100;

const state = {
  lines: [],           // 旧 → 新，超出 100 条丢弃最早的
  lastRun: null,       // { at, ok, summary, durationMs, trigger, counts }
  running: false,
  runningSince: 0,
  runningTrigger: '',
  totalRuns: 0,
  bootedAt: Date.now()
};

const STALE_RUN_MS = 90 * 1000;

function addLine(text) {
  state.lines.push(text);
  const overflow = state.lines.length - MAX_LINES;
  if (overflow > 0) state.lines.splice(0, overflow);
}

function addLines(lines) {
  (lines || []).forEach(addLine);
}

function isRunning() {
  if (!state.running) return false;
  // 进程被杀等异常情况下 running 会卡住，超时自动放行
  if (Date.now() - state.runningSince > STALE_RUN_MS) {
    state.running = false;
    return false;
  }
  return true;
}

function beginRun(trigger) {
  state.running = true;
  state.runningSince = Date.now();
  state.runningTrigger = trigger || 'manual';
}

function finishRun(result) {
  state.running = false;
  state.runningTrigger = '';
  state.lastRun = {
    at: new Date().toISOString(),
    ok: !!result.ok,
    summary: result.summary || '',
    durationMs: result.durationMs || 0,
    trigger: result.trigger || 'manual',
    counts: result.counts || null
  };
  state.totalRuns += 1;
}

/** 给接口用的快照：日志倒序（最新在最前面） */
function snapshot() {
  return {
    lines: state.lines.slice().reverse(),
    lineCount: state.lines.length,
    lastRun: state.lastRun,
    running: isRunning(),
    runningTrigger: state.runningTrigger,
    totalRuns: state.totalRuns,
    bootedAt: new Date(state.bootedAt).toISOString()
  };
}

function clear() {
  state.lines = [];
  state.lastRun = null;
}

module.exports = { addLine, addLines, isRunning, beginRun, finishRun, snapshot, clear, MAX_LINES };
