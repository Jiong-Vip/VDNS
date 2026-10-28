(function () {
  'use strict';

  var CACHE_KEY = 'cfdns.logs.v1';
  var POLL_MS = 8000;        // 空闲时的刷新间隔
  var FAST_POLL_MS = 1000;   // 执行中：每秒拉一次，日志就能一步步出现

  var main = document.getElementById('main');
  var topbarRight = document.getElementById('topbarRight');
  var toastEl = document.getElementById('toast');

  var model = {
    authed: false,
    busy: false,
    state: null,
    cache: loadCache()
  };

  var pollTimer = null;
  var pollInterval = POLL_MS;

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      toastEl.className = 'toast';
    }, 2600);
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return { lines: [], lastRun: null };
      var parsed = JSON.parse(raw);
      return {
        lines: Array.isArray(parsed.lines) ? parsed.lines.slice(0, 100) : [],
        lastRun: parsed.lastRun || null
      };
    } catch (err) {
      return { lines: [], lastRun: null };
    }
  }

  function saveCache(lines, lastRun) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        lines: (lines || []).slice(0, 100),
        lastRun: lastRun || null
      }));
    } catch (err) { /* 忽略 */ }
  }

  function api(path, options) {
    options = options || {};
    var init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: {}
    };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    return fetch(path, init).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        return { status: response.status, data: data || {} };
      });
    });
  }

  function timeText(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function durationText(ms) {
    if (typeof ms !== 'number' || ms <= 0) return '—';
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
  }

  function triggerText(trigger) {
    if (trigger === 'action') return 'GitHub Actions';
    if (trigger === 'api') return '外部 API';
    if (trigger === 'manual') return '面板手动';
    return '—';
  }

  /* ------------------------------------------------------------------ */
  /* 登录                                                                */
  /* ------------------------------------------------------------------ */

  function renderLogin(message) {
    model.authed = false;
    topbarRight.innerHTML = '';
    stopPolling();

    main.innerHTML =
      '<div class="card login-card">' +
        '<h1>CFDNS 控制台</h1>' +
        '<p>请输入访问密码（服务端环境变量 PW）</p>' +
        (message ? '<div class="note">' + esc(message) + '</div>' : '') +
        '<input id="pwInput" type="password" placeholder="访问密码" autocomplete="current-password" autofocus>' +
        '<button id="loginBtn" class="btn primary block">进入控制台</button>' +
      '</div>';

    var input = document.getElementById('pwInput');
    var button = document.getElementById('loginBtn');

    function submit() {
      var password = input.value;
      if (!password) {
        toast('请输入密码', true);
        return;
      }
      button.disabled = true;
      button.textContent = '校验中…';

      api('/api/login', { method: 'POST', body: { password: password } })
        .then(function (res) {
          if (res.status === 200 && res.data.ok) {
            input.value = '';
            boot();
            return;
          }
          button.disabled = false;
          button.textContent = '进入控制台';
          toast(res.data.error || '登录失败', true);
        })
        .catch(function () {
          button.disabled = false;
          button.textContent = '进入控制台';
          toast('网络错误，请稍后再试', true);
        });
    }

    button.addEventListener('click', submit);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') submit();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 控制台                                                              */
  /* ------------------------------------------------------------------ */

  function statusTag(state) {
    if (state.running) return '<span class="tag warn">执行中…</span>';
    if (!state.lastRun) return '<span class="tag idle">尚未执行</span>';
    if (state.lastRun.ok) return '<span class="tag ok">成功</span>';
    return '<span class="tag bad">失败</span>';
  }

  function dashboardShell() {
    return '' +
      '<div class="card">' +
        '<h2>运行状态</h2>' +
        '<div class="grid" id="statGrid"></div>' +
        '<div class="row" style="margin-top:14px">' +
          '<button id="runBtn" class="btn primary">立即执行</button>' +
          '<button id="checkBtn" class="btn">测试连接</button>' +
          '<button id="refreshBtn" class="btn">刷新</button>' +
          '<button id="clearBtn" class="btn danger">清空日志</button>' +
        '</div>' +
        '<div class="hint" id="stateHint"></div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>执行日志（最新在最上面，最多 100 条）</h2>' +
        '<div class="log" id="logBox"></div>' +
        '<div class="hint" id="logHint"></div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>定时执行（GitHub Actions）</h2>' +
        '<table class="kv">' +
          '<tr><td>执行接口</td><td><code id="apiUrl"></code></td></tr>' +
          '<tr><td>鉴权方式</td><td><code>Authorization: Bearer $CRON_SECRET</code></td></tr>' +
        '</table>' +
        '<pre class="code" id="curlSample"></pre>' +
        '<div class="hint">在 Vercel 环境变量里设置 <code>CRON_SECRET</code> 后，外部才能调用；' +
          '未设置时接口只接受面板登录态。</div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>环境变量</h2>' +
        '<table class="kv">' +
          '<tr><td>PW</td><td>面板访问密码</td></tr>' +
          '<tr><td>Key</td><td>DNSHE API Key</td></tr>' +
          '<tr><td>Secret</td><td>DNSHE API Secret</td></tr>' +
          '<tr><td>YM</td><td>操作主域名，如 <code>y1s1.cc.cd</code></td></tr>' +
          '<tr><td>CRON_SECRET</td><td>外部执行接口的密钥（可选但推荐）</td></tr>' +
        '</table>' +
        '<div class="hint">修改环境变量后需要重新部署才会生效。</div>' +
      '</div>';
  }

  function renderDashboard() {
    model.authed = true;

    topbarRight.innerHTML =
      '<span class="badge" id="domainBadge"></span>' +
      '<button id="logoutBtn" class="btn ghost">退出登录</button>';

    main.innerHTML = dashboardShell();

    document.getElementById('logoutBtn').addEventListener('click', function () {
      api('/api/logout', { method: 'POST' }).then(function () {
        model.state = null;
        renderLogin('');
        toast('已退出登录');
      });
    });

    document.getElementById('runBtn').addEventListener('click', function () {
      runAction('/api/run', '已触发执行');
    });
    document.getElementById('checkBtn').addEventListener('click', function () {
      runAction('/api/check', '测试完成');
    });
    document.getElementById('refreshBtn').addEventListener('click', function () {
      refresh().then(function () { toast('已刷新'); });
    });
    document.getElementById('clearBtn').addEventListener('click', function () {
      if (!confirm('确定清空日志？清空后无法恢复。')) return;
      api('/api/clear', { method: 'POST' }).then(function () {
        model.cache = { lines: [], lastRun: model.cache.lastRun };
        saveCache([], model.cache.lastRun);
        refresh();
        toast('日志已清空');
      });
    });

    var apiUrl = location.origin + '/api/run';
    document.getElementById('apiUrl').textContent = apiUrl;
    document.getElementById('curlSample').textContent =
      'curl -fsS -X POST "' + apiUrl + '" \\\n' +
      '  -H "Authorization: Bearer $CRON_SECRET"';

    refresh();
    startPolling();
  }

  function renderStats(state) {
    var grid = document.getElementById('statGrid');
    if (!grid) return;

    var items = [
      { k: '状态', v: statusTag(state), raw: true },
      { k: '上次执行', v: state.lastRun ? timeText(state.lastRun.at) : '—' },
      { k: '耗时', v: state.lastRun ? durationText(state.lastRun.durationMs) : '—' },
      { k: '触发方式', v: state.lastRun ? triggerText(state.lastRun.trigger) : '—' },
      { k: '主域名', v: esc(state.domain || '未配置') },
      { k: 'API Key', v: esc(state.apiKeyMasked || '未配置') },
      { k: 'TTL', v: state.ttl + ' s' },
      { k: '本次启动', v: timeText(state.bootedAt) }
    ];

    grid.innerHTML = items.map(function (item) {
      return '<div class="stat"><div class="k">' + esc(item.k) + '</div>' +
        '<div class="v">' + (item.raw ? item.v : esc(item.v)) + '</div></div>';
    }).join('');

    var hint = document.getElementById('stateHint');
    if (hint) {
      if (!state.configured) {
        hint.innerHTML = '<span class="tag bad">缺少环境变量</span> ' +
          esc((state.missing || []).join(', ')) + ' —— 在 Vercel 项目设置里补齐后重新部署。';
      } else if (state.running) {
        hint.textContent = '正在执行，请稍候…';
      } else if (state.lastRun) {
        hint.textContent = '上次结果：' + (state.lastRun.summary || '—');
      } else {
        hint.textContent = '还没有执行记录，点击「立即执行」试一下。';
      }
    }

    var badge = document.getElementById('domainBadge');
    if (badge) badge.textContent = state.domain || '未配置域名';
  }

  function renderLogs(state) {
    var box = document.getElementById('logBox');
    var hint = document.getElementById('logHint');
    if (!box) return;

    var lines = (state.lines && state.lines.length) ? state.lines : [];
    var usingCache = false;

    if (lines.length === 0 && model.cache.lines.length > 0) {
      lines = model.cache.lines;
      usingCache = true;
    }

    if (lines.length > 0) {
      box.innerHTML = lines.map(function (line) {
        var cls = 'ln';
        if (line.indexOf('>>>成功') >= 0) cls += ' ok';
        else if (line.indexOf('>>>失败') >= 0 || line.indexOf('执行异常') >= 0) cls += ' bad';
        else if (line.indexOf('>>>无变化') >= 0) cls += ' mut';
        return '<span class="' + cls + '">' + esc(line) + '</span>';
      }).join('');
    } else {
      box.innerHTML = '';
    }

    if (hint) {
      hint.textContent = usingCache
        ? '服务器内存已重置（冷启动/新实例），下面是浏览器缓存的最近日志。'
        : (lines.length ? '共 ' + lines.length + ' 条；日志保存在函数内存中，冷启动会清空。' : '暂无日志，执行一次即可看到每一步的记录。');
    }

    if (!usingCache && lines.length > 0) {
      saveCache(lines, state.lastRun);
    }
  }

  function setBusy(busy, label) {
    model.busy = busy;
    ['runBtn', 'checkBtn', 'refreshBtn', 'clearBtn'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.disabled = busy;
      if (id === 'runBtn') el.textContent = busy ? (label || '执行中…') : '立即执行';
    });
  }

  function runAction(path, okMessage) {
    if (model.busy) return;
    setBusy(true);
    toast(path === '/api/run' ? '正在执行，请稍候…' : '正在检查…');

    // 立刻切到每秒轮询，日志会随着服务端每写一行就冒出来
    startPolling(FAST_POLL_MS);

    api(path, { method: 'POST' })
      .then(function (res) {
        if (res.status === 401) {
          renderLogin('登录已过期，请重新输入密码');
          return;
        }

        var logs = res.data.logs;
        if (Array.isArray(logs) && logs.length) {
          var reversed = logs.slice().reverse();
          model.cache = { lines: reversed, lastRun: model.cache.lastRun };
          saveCache(reversed, model.cache.lastRun);
        }

        if (res.data.error) {
          toast(res.data.error, true);
        } else if (res.data.ok) {
          toast(res.data.summary || okMessage);
        } else {
          toast(res.data.summary || '执行完成，但有失败项', true);
        }

        return refresh();
      })
      .catch(function () {
        toast('请求失败，请检查网络', true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  /* ------------------------------------------------------------------ */
  /* 数据刷新                                                            */
  /* ------------------------------------------------------------------ */

  function refresh() {
    return api('/api/state').then(function (res) {
      if (res.status === 401) {
        renderLogin('请先登录');
        return;
      }
      if (res.status !== 200) {
        toast(res.data.error || '读取状态失败', true);
        return;
      }

      model.state = res.data;
      if (!document.getElementById('statGrid')) {
        renderDashboard();
        return;
      }

      renderStats(res.data);
      renderLogs(res.data);

      // 执行中每秒刷新（日志逐步出现），空闲时回到 8 秒
      startPolling((res.data.running || model.busy) ? FAST_POLL_MS : POLL_MS);

      if (res.data.lastRun) {
        model.cache.lastRun = res.data.lastRun;
        saveCache(model.cache.lines, res.data.lastRun);
      }
    });
  }

  function startPolling(interval) {
    var next = interval || POLL_MS;
    // 间隔没变就不重建定时器，避免每次刷新都重置
    if (pollTimer && next === pollInterval) return;

    stopPolling();
    pollInterval = next;
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      refresh().catch(function () { /* 忽略轮询错误 */ });
    }, pollInterval);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    refresh().catch(function () {
      main.innerHTML = '<div class="card loading">无法连接服务端，请刷新页面重试</div>';
    });
  }

  boot();
})();
