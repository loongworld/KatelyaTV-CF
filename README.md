<div align="center">

# KatelyaTV CF

**跑在 Cloudflare 上的影视聚合播放器**

聚合搜索 · 秒开播放 · 多用户 · 数据自持

[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)](https://pages.cloudflare.com/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Version](https://img.shields.io/badge/version-1.3.0-blue)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

基于 [katelya77/KatelyaTV](https://github.com/katelya77/KatelyaTV)（MoonTV / LunaTV 系）二次开发，
**针对 Cloudflare 部署链路完全重构**：修复上游在 Workers 运行时无法部署的核心缺陷，并将源配置与代码彻底分离。

> **本仓库零影视源、零敏感凭据。** 克隆 → 建库 → 配两个 Secret，即可拥有一个完全属于自己的影视站。

</div>

---

## 特性

| | 能力 | 说明 |
|---|---|---|
| 🔍 | **聚合搜索** | 并发检索采集源，常规 / 成人结果分组展示；源超过单次子请求上限时自动分片补齐 |
| ▶️ | **秒开播放** | ArtPlayer + HLS，自动优选测速、多源一键切换、断点续播、片头片尾自动跳过 |
| 👥 | **多用户** | 站长（环境变量凭据）+ 注册用户（PBKDF2 哈希），角色区分 owner / admin / user |
| 🔐 | **会话吊销** | 封禁 / 改密 / 角色变更后旧会话 ≤30 秒失效；TVBox 订阅令牌可独立轮换 |
| 📺 | **TVBox 兼容** | `/api/tvbox` 输出 JSON / TXT（Base64）订阅，配合 OrionTV 等直接上电视 |
| 🖼️ | **图片边缘代理** | 内置 `/api/image-proxy`：破解豆瓣防盗链、SSRF 防护、文件头魔数校验，浏览器与边缘各缓存 7 天 |
| 🗄️ | **数据自持** | 收藏、播放记录、搜索历史、跳过配置、用户体系全部存在你自己的 D1 里 |

## 架构

```
┌──────────────────────────────────────────────────────┐
│   Next.js 14（App Router · TypeScript · Tailwind）     │
│              @cloudflare/next-on-pages                │
└──────────────────────────┬───────────────────────────┘
                           ▼
        Cloudflare Pages Functions（nodejs_compat v2）
        │
        ├── D1（SQLite）     用户 / 收藏 / 播放记录 / 搜索历史 /
        │                    跳过配置 / 站点配置 / 采集源清单
        ├── /api/image-proxy 图片边缘代理（SSRF + MIME 白名单 + 魔数校验）
        ├── /api/tvbox       TVBox 订阅（独立令牌）
        └── Pages CDN        静态资源
```

单站运行成本：**0 元**。Pages Functions 每天 10 万次请求、D1 每天 500 万行读的免费额度，
对个人 / 家庭规模的使用绰绰有余。

## 快速开始

### 前置要求

| 工具 | 版本 |
|---|---|
| Node.js | ≥ 18.12（推荐 20+） |
| pnpm | 10.x（corepack 按 `packageManager` 字段自动对齐） |
| wrangler | 4.x（`pnpm add -g wrangler` 或 `npx wrangler`） |

### 1. 克隆并安装依赖

```bash
git clone https://github.com/wooxi/KatelyaTV-CF.git
cd KatelyaTV-CF
pnpm install --frozen-lockfile
```

### 2. 创建 D1 并初始化表结构

```bash
wrangler login
wrangler d1 create katelyatv-db
wrangler d1 execute katelyatv-db --remote --file=./scripts/d1-init.sql -y
```

把 `wrangler d1 create` 输出的 `database_id` 填入 `wrangler.toml` 的三处 `d1_databases`。

> 初始化脚本与运行时代码逐列对齐（`scripts/d1-init.sql` 头部有详细说明）。
> 历史上曾因脚本与代码分叉导致新部署必崩，修改脚本前请先对照 `src/lib/d1.db.ts`。

### 3. 导入视频源

本仓库 `config.json` 的 `api_site` 为空，源清单运行时存于 D1 `main_config`，任选一种导入：

| 方式 | 操作 | 特点 |
|---|---|---|
| **后台热更新（推荐）** | 访问 `/admin` → 配置管理 → 上传源清单 JSON | 免重新构建，立即生效 |
| **D1 直写** | 将源清单合并进 `main_config` 后 `wrangler d1 execute` | 适合批量脚本化 |
| **构建期内联** | 构建前把源清单覆盖 `config.json` 再 `pnpm run pages:build` | 仅 D1 尚无配置时必需 |

> 首次部署没有源时，站点功能正常但搜索为空——导入源后即可使用。

### 4. 配置环境变量（Cloudflare Dashboard）

所有敏感凭据通过 **Pages 项目 → Settings → Environment variables** 添加，不进入代码仓库。
生产环境至少配置：

| 变量 | 类型 | 说明 |
|---|---|---|
| `USERNAME` | Secret | 站长用户名 |
| `AUTH_PASSWORD` | Secret | 站长密码（建议高强度随机串） |
| `SESSION_SECRET` | Secret | 会话签名密钥，≥32 位随机串（**强烈建议**，见下文） |

> ⚠️ 不要使用 `PASSWORD` 作为变量名——它是 Cloudflare 保留绑定名（上游已知的坑）。

### 5. 部署

#### 方式 A：Git 集成自动部署（推荐）

在 Dashboard 创建绑定本仓库的 Pages 项目（Direct Upload 项目也可在设置中切换为 Git 集成）：

| 配置项 | 值 |
|---|---|
| 构建命令 | `pnpm install --frozen-lockfile && pnpm run pages:build` |
| 构建输出目录 | `.vercel/output/static` |
| 生产分支 | `main` |

绑定后推送 `main` 即自动构建部署。本仓库不含 GitHub Actions 部署工作流——Cloudflare Git 集成已覆盖，避免双流水线。

#### 方式 B：命令行部署

```bash
export NEXT_PUBLIC_STORAGE_TYPE=d1
export NEXT_PUBLIC_IMAGE_PROXY='/api/image-proxy?url='

pnpm run pages:build   # 产物末尾会自动执行 Node 兼容性补丁脚本
wrangler pages deploy .vercel/output/static --project-name katelyatv --branch main
```

### 已有部署升级到 1.3.0（会话吊销）

```bash
wrangler d1 execute katelyatv-db --remote \
  --command "ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;"
```

未执行迁移也不会报错：
新机制会自动降级为「只校验用户是否存在」，但**封禁 / 改密不会撤销旧会话**。
新建库无需手动执行（`d1-init.sql` 已包含该列）。

## 环境变量总表

| 变量 | 生效阶段 | 必填 | 说明 |
|---|---|---|---|
| `NEXT_PUBLIC_STORAGE_TYPE` | 构建 | ✅ | 存储后端，固定 `d1` |
| `NEXT_PUBLIC_IMAGE_PROXY` | 构建 | ✅ | 图片代理前缀，默认 `/api/image-proxy?url=` |
| `USERNAME` | 运行 | ✅ | 站长用户名 |
| `AUTH_PASSWORD` | 运行 | ✅ | 站长密码 |
| `SESSION_SECRET` | 运行 | 强烈建议 | 会话签名密钥，≥32 随机字符。缺失时退化为由 `AUTH_PASSWORD` 派生（无 KDF，会话 Cookie 泄漏即可离线爆破） |
| `SITE_NAME` | 运行 | 可选 | 站点名回退值（后台配置优先） |
| `ANNOUNCEMENT` | 运行 | 可选 | 站点公告回退值（后台配置优先） |
| `TVBOX_TOKEN` | 运行 | 可选 | TVBox 订阅专用令牌（≥16 字符）。配置后与登录会话解耦，可单独轮换 |
| `CRON_SECRET` | 运行 | 可选 | `/api/cron` 的 Bearer 密钥；未配置时该接口返回 503（默认禁用） |
| `NEXT_PUBLIC_ENABLE_REGISTER` | 构建 | 可选 | 是否开放注册（后台 `AllowRegister` 优先） |
| `NEXT_PUBLIC_DOUBAN_PROXY` | 构建 | 可选 | 豆瓣数据代理前缀（留空走内置 `/api/douban`） |
| `NEXT_PUBLIC_SEARCH_MAX_PAGE` | 构建 | 可选 | 搜索最大翻页数，默认 5 |
| `NEXT_PUBLIC_REPO_URL` | 构建 | 可选 | 登录页版本按钮跳转地址，默认本仓库 |
| `NEXT_PUBLIC_VERSION_URL_PRIMARY` / `_BACKUP` | 构建 | 可选 | 自定义版本检查地址；**不配置则不发起任何外部请求** |

> 站点名称、公告、图片代理前缀、豆瓣代理地址均可在 `/admin` 后台直接修改（保存至 D1 即时生效）；
> 环境变量仅在后台未设置对应值时作为初始回退。

## 数据与安全设计

把用户数据放在自己手里，也意味着安全底座要自己扛。本仓库在重构中确立了以下机制：

- **会话**：HMAC-SHA256 签名的无状态令牌（7 天）；密钥优先取 `SESSION_SECRET`，缺失时才退回派生，绝不硬编码。
- **会话吊销**：`users.session_version` 随封禁 / 改密 / 角色变更自增，令牌内携带签发时的版本号，
  API 鉴权时比对（30 秒缓存），旧凭据立即失效——这是上游完全缺失的一环。
- **登录防爆破**：IP + 用户名双维度限速，计数用单条原子 UPSERT（并发下不会少记）。
- **图片代理**：协议白名单 + 内网地址拦截（含 `*.nip.io` 等通配 DNS 绕过）+ 仅放行位图 MIME +
  文件头魔数二次校验 + 2MB 流式截断 + `nosniff` / CSP 响应头，杜绝同源 XSS 与内存放大。
- **数据隔离**：所有数据接口的用户名强制取自签名 Cookie，不接受请求参数传入，不存在水平越权。
- **SQL**：全量参数化（`prepare().bind()`），无字符串拼接。
- **凭据分离**：仓库内零密钥；站长密码只存在于 Cloudflare 加密环境变量。

## 视频源管理

运行时生效的源清单 = **D1 `main_config` 存量 ∪ 仓库 `config.json` 新增项**：

- D1 已有的 key 以 D1 为准；文件里新出现的 key 自动追加
- 源格式（苹果 CMS v10 接口）：

```json
{
  "cache_time": 7200,
  "api_site": {
    "dyttzyapi": {
      "api": "https://caiji.dyttzyapi.com/api.php/provide/vod",
      "name": "TV-电影天堂资源",
      "is_adult": false
    }
  }
}
```

- `is_adult: true` 的源受用户级成人过滤管控（默认隔离到独立分组）
- 源站失效属常态：在 `/admin` 后台增删，或维护私有源仓库（格式即 `config.json`），批量更新时后台重新上传
- 改 `config.json` 需重新构建部署；后台方式即时生效
- 单次搜索最多检索 40 个源（Workers 免费版单请求子请求上限 50），源更多时前端自动分片补齐

## TVBox / OrionTV

1. 订阅地址：`https://<你的域名>/api/tvbox?token=<TVBOX_TOKEN 或派生令牌>&format=json`
   （`format=txt` 输出 Base64 编码文本；令牌也可放在 `x-tvbox-token` 请求头）
2. 令牌获取：后台 `/config` 页可直接复制带令牌的完整订阅链接
3. 详情参阅 [docs/TVBOX.md](./docs/TVBOX.md)

## 常见问题

<details>
<summary>部署后全站 500 怎么排查？</summary>

执行 `wrangler pages deployment tail <deployment-id> --project-name katelyatv --format pretty` 后访问站点。
若出现 `No such module "__next-on-pages-dist__/.../async_hooks"`，说明构建后处理未执行——
请确认使用本仓库的 `pnpm run pages:build`（已串联 `scripts/fix-worker-imports.js`）。
</details>

<details>
<summary>绑定 D1 后接口仍报错？</summary>

确认 `wrangler.toml` 保留 `pages_build_output_dir` 字段（`wrangler pages deploy` 才会提交绑定），
再用 `wrangler d1 list` 核对 `database_id` 是否为本账号资源。绑定名必须是 `DB`。
</details>

<details>
<summary>搜索没有结果？</summary>

1. 确认已导入采集源（见「快速开始 · 第 3 步」）；
2. 检查源是否存活——采集站域名更迭频繁，建议在 `/admin` 后台删旧换新；
3. 若源很多仍缺结果，留意是否命中免费版子请求上限（本仓库已按 40 源/请求自动分片，正常不会再撞）。
</details>

<details>
<summary>为什么搜索不到成人内容？</summary>

用户级「成人内容过滤」默认开启（`/settings` 可关）。开启时 `is_adult` 源不参与常规结果；
关闭后以独立分组展示。
</details>

<details>
<summary>海报显示占位图？</summary>

`/api/image-proxy` 只放行位图，且对豆瓣会携带其校验所需的 Referer；
若上游图床本身对服务器出口 IP 返回错误内容（而非图片），会被魔数校验拦下并回退占位图——
这属于上游限制，前端不再展示裂图。
</details>

<details>
<summary>封禁用户 / 改密后，对方还能继续用吗？</summary>

不能。1.3.0 起 `session_version` 机制会让旧会话在 ≤30 秒内失效
（需已执行一次 D1 迁移，见「升级」一节）。
</details>

## 相对上游的主要修复

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 部署后全站 500 | 构建产物含裸 `async_hooks` 导入；`compatibility_date` 低于 nodejs_compat v2 门槛 | 构建后处理重写为 `node:` 前缀；提升兼容日期 |
| 2 | 图片代理失效 / 豆瓣裂图 | 变量名错配；后又不发送 Referer（方向搞反） | 变量名对齐；对豆瓣域携带 `movie.douban.com` Referer |
| 3 | 无 Cookie 客户端图片 401 | middleware 白名单漏掉 `/api/image-proxy` | 放回白名单；静态资源改按扩展名放行 |
| 4 | 照文档初始化 D1 必崩 | 两份初始化脚本的列名与运行时代码分叉 | 以代码为准重写 `scripts/d1-init.sql` |
| 5 | 成人结果分组恒为空 | 映射丢掉 `is_adult` + 布尔短路 + 硬编码空数组 | 三处一并修复，20 个成人源恢复可见 |
| 6 | 被封禁用户会话不失效 | 无任何会话撤销机制 | 新增 `session_version` 吊销机制（1.3.0） |
| 7 | 搜索子请求超限静默丢结果 | 单请求检索全部源，超限异常被吞 | 40 源/请求分片 + 前端自动补齐 |
| 8 | 源清单硬编码随仓库发版 | 上游把源写死在仓库 | 源配置与代码分离，运行时经 D1 / 后台管理 |

完整修复与变更历史见 [CHANGELOG.md](./CHANGELOG.md)。

## 目录结构

```
├── config.json                  # 采集源配置（本仓库 api_site 为空，运行时以 D1 为准）
├── wrangler.toml                # Pages / D1 绑定与环境变量
├── scripts/
│   ├── d1-init.sql              # D1 初始化（与运行时代码逐列对齐）
│   ├── fix-worker-imports.js    # 构建后处理：Node 内置模块补丁
│   ├── convert-config.js        # config.json → src/lib/runtime.ts
│   └── generate-manifest.js     # PWA manifest 生成
├── src/
│   ├── app/                     # 页面与 API 路由（Edge Runtime）
│   ├── components/              # 播放器 / 选集 / 设置等组件
│   ├── lib/                     # 存储（D1）、鉴权、会话、配置合并、工具
│   └── middleware.ts            # 认证中间件（含放行白名单）
├── docs/TVBOX.md                # TVBox 订阅接入指南
└── src/__tests__/               # 安全相关单元测试（jest）
```

## 本地开发

```bash
pnpm install
pnpm dev            # 本地开发（默认 localstorage 模式，无 D1 也可预览界面）
pnpm typecheck      # tsc --noEmit
pnpm lint:strict    # eslint --max-warnings=0
pnpm test           # jest
pnpm pages:build    # 构建 Cloudflare Pages 产物
```

## 免责声明

本项目仅供个人学习与研究使用，不存储、不分发任何视频资源，所有内容均来自第三方公开站点。
使用者需自行承担使用行为的法律责任，请勿将部署实例公开传播。影视信息数据来源：豆瓣。

## 致谢

- [MoonTV](https://github.com/MoonTechLab/LunaTV) / [LunaTV](https://github.com/sjnhnp/LunaTV) — 原始项目
- [katelya77/KatelyaTV](https://github.com/katelya77/KatelyaTV) — 二次开发上游
- [OrionTV](https://github.com/zimplexing/OrionTV) — 生态参考

## License

[MIT](./LICENSE)
