# CFDNS 云端控制台（Vercel 版）

把原来跑在 OpenWrt 上的"优选 IP → DNSHE 解析记录"搬到了 Vercel：
打开网页输入密码就能操作，也可以由 GitHub Actions 定时调用 API 触发。

- 抓取 BestCF 的移动 / 联通 / 电信 优选 IPv4、IPv6，各取前 2 个
- 通过 DNSHE API 写入 `ipv4-1~6`（A 记录）与 `ipv6-1~6`（AAAA 记录）
- 记录不存在则新增、存在则修改、地址不变则跳过
- 抓取失败时**完全不修改**任何记录
- 页面可手动执行、测试连接、看倒序日志；另提供带密钥的执行 API 供定时任务调用

## 目录结构

```
vercel/
├── api/
│   └── cfdns.js              # 唯一后端函数（登录/执行/状态/清空都在这）
├── lib/
│   ├── auth.js               # 密码校验、Cookie 签名、登录限流
│   ├── config.js             # 环境变量读取与打码
│   ├── dnshe.js              # DNSHE API 客户端（带 429/5xx 重试）
│   ├── source.js             # BestCF 列表抓取与解析
│   ├── store.js              # 内存日志环形缓冲（最多 100 条）
│   └── sync.js               # 一轮同步的编排与日志
├── index.html                # 面板（放根目录，Vercel 无框架项目从根目录提供静态文件）
├── app.js
├── style.css
├── tests/
│   ├── serve.js              # 本地起服务（模拟 Vercel 的 rewrite）
│   ├── e2e.js                # 端到端测试（会真实写 DNSHE）
│   ├── cleanup.js            # 清理测试写入的记录
│   └── diag.js               # 只读诊断：看域名下现有记录
├── env.example               # 环境变量示例（复制成 .env 本地用）
├── github-actions-cron.yml   # 定时任务模板，复制到 .github/workflows/
├── vercel.json               # rewrite + maxDuration
└── package.json
```

## 部署（关键一步）

Vercel 已连接你的 GitHub 仓库，导入时**必须把 Root Directory 设成 `vercel`**，
否则它会把这个仓库根目录当成静态站，面板和接口都找不到。

**新建项目**

1. Vercel → Add New → Project → 选 `YourName/CFDNS`
2. **Root Directory** 点 Edit，选 `vercel`
3. Framework Preset：`Other`（不要选 Next.js）
4. Build Command / Output Directory：**全部留空**
5. 在 Environment Variables 里填下表 5 个变量
6. Deploy → 打开分配的域名 → 输入 PW 登录

**改现有项目**：Project → Settings → General → Root Directory 改成 `vercel` → Redeploy。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PW` | 是 | 面板访问密码，登录后 7 天免登录 |
| `Key` | 是 | DNSHE API Key（`cfsd_` 开头） |
| `Secret` | 是 | DNSHE API Secret |
| `YM` | 是 | 操作主域名，如 `xxx.com` |
| `CRON_SECRET` | 建议 | 外部执行接口的密钥；不设置则只能面板手动执行 |
| `SOURCE_IPV6` / `SOURCE_IPV4` | 否 | 自定义优选地址来源 |

> 改完环境变量要 **Redeploy** 才生效（Vercel 的变量在构建时注入）。

## 使用

- 打开域名 → 输入 `PW` → 进入控制台
- **立即执行**：抓取 + 写入，结果直接出现在日志里
- **测试连接**：只校验 Key/Secret/域名，不写任何记录
- **刷新 / 清空日志**：日志最多 100 条，倒序显示，页面每 8 秒自动刷新

## 定时执行（GitHub Actions）

1. 在 Vercel 拿到站点域名，比如 `https://cfdns-xxx.vercel.app`
2. GitHub 仓库 → Settings → Secrets and variables → Actions，加两个 Secret：
   - `CFDNS_URL` = `https://cfdns-xxx.vercel.app`
   - `CRON_SECRET` = 与 Vercel 里相同的值
3. 把 [github-actions-cron.yml](github-actions-cron.yml) 复制到仓库的 `.github/workflows/cfdns-cron.yml`
4. Actions 里可以手动 Run 一次验证

接口契约：

```bash
curl -fsS -X POST "https://<你的域名>/api/run" \
  -H "Authorization: Bearer $CRON_SECRET"
```

返回：

```json
{ "ok": true, "summary": "新增 0，更新 3，无变化 9，失败 0",
  "counts": { "created": 0, "updated": 3, "skipped": 9, "failed": 0 },
  "durationMs": 8123, "trigger": "action", "logs": ["2026-10-28 17:23:12.212：开始执行>>>..."] }
```

鉴权失败返回 401，上一轮还没跑完返回 409。`ok` 为 `false` 表示有失败项，
Actions 里用 `jq -e '.ok'` 可以让工作流变红。

## 关于日志存储

你选择了不接外部存储，所以日志存在**函数实例的内存**里：

- 冷启动、扩容、多实例并存时会分别持有各自的日志
- 外部（GitHub Actions）触发的那次执行，如果面板请求落到别的实例，页面可能看不到
- 页面会把见过的日志存进浏览器 `localStorage`，服务端内存空了就显示缓存并提示

想真正持久化，后面可以接 Vercel Blob：把 `lib/store.js` 换成读写一个
`cfdns/logs.json` 即可，其他代码不用动（`addLines` / `snapshot` / `clear` 三个接口保持不变）。

执行结果同时会出现在 GitHub Actions 的日志里，作为兜底的查看途径。

## 本地调试

不需要 Vercel CLI，直接跑：

```bash
cd vercel
cp env.example .env      # 填好变量（或用命令行 export）
node tests/serve.js      # http://127.0.0.1:3001
```

**离线测试（不碰真实接口，推荐先跑这个）**：

```bash
node tests/mock-e2e.js
```

用本地 mock 覆盖：列表解析、12 条新增、写响应丢失（500 但其实已写入）→ 重新查询确认、
真正失败（400）→ 记失败且不重试、限流（429）→ 不重试并提示冷却时间、
地址变化 → 更新、缺失 → 补建、未变 → 跳过、日志格式与 100 条上限。

**真实接口端到端测试**（会真的写 DNSHE，跑完记得清理）：

```bash
PW=xxx Key=xxx Secret=xxx YM=y1s1.cc.cd CRON_SECRET=xxx node tests/e2e.js
Key=xxx Secret=xxx YM=y1s1.cc.cd node tests/cleanup.js   # 清理测试记录
Key=xxx Secret=xxx YM=y1s1.cc.cd node tests/diag.js      # 只读查看现有记录
```

> 调试脚本都支持 `DNSHE_BASE` 环境变量指向 mock 或代理，不设则走真实接口。

## 安全提醒

- 所有密钥只放 Vercel 环境变量，不要写进仓库
- 登录状态是无状态 Cookie（HMAC 签名，7 天），改 `PW` 会让所有已登录会话立即失效
- 连续输错密码 10 次后，同一 IP 会被封 10 分钟
- `vercel.json` 里 `maxDuration` 设的是 60 秒（Fluid Compute 默认开启）。
  如果部署时报超过套餐上限，把它改成 `10`，正常一轮同步大约 8–20 秒

## 关于 DNSHE 限流

DNSHE 对写接口有突发限流，触发后返回 `429` 并给出冷却时间（实测约 25 分钟）。
代码里的处理是：

- 429 **不会重试**（重试只会继续撞墙），直接记失败并在日志里写明"约 N 分钟后再试"
- 5xx / 连接中断这类"结果不确定"的错误，先重新查询确认记录是否已写入，确认没写才重试一次
- 12 条写入以 3 并发 + 200ms 错峰执行，正常一轮不会触发限流

如果日志里出现 429，等冷却后再点一次「立即执行」即可，下一轮定时任务也会自动补齐。
