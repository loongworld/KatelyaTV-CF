<div align="center">

# KatelyaTV CF

**基于 Cloudflare Pages + D1 的影视聚合播放器 · 重构版**

[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)](https://pages.cloudflare.com/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

基于 [katelya77/KatelyaTV](https://github.com/katelya77/KatelyaTV)（MoonTV / LunaTV 系）二次开发，
**针对 Cloudflare 部署链路完全重构**：修复上游在 Workers 运行时无法部署的核心缺陷。

> **本仓库零影视源、零敏感凭据。**

</div>

---

## 特性

- **聚合搜索**：并发检索采集源，常规/成人结果分组展示；源数量超过单次请求上限时自动分片补齐
- **秒开播放**：ArtPlayer + HLS，自动优选测速、多源一键切换
- **观影体验**：断点续播、自动跳过片头片尾、画中画、网页全屏
- **数据同步**：收藏、播放记录、搜索历史基于 D1 跨设备同步
- **多用户**：站长（环境变量鉴权）+ 注册用户体系，角色区分 owner/admin/user
- **成人内容分级**：`is_adult` 站点级标记 + 用户级过滤开关（默认开启；关掉后成人源以独立分组展示）
- **TVBox 兼容**：`/api/tvbox` 输出 JSON / TXT（Base64）订阅，配合 OrionTV 上电视
- **图片代理**：内置 `/api/image-proxy` 边缘代理，破解豆瓣防盗链，边缘与浏览器各缓存 7 天

## 架构

```
Next.js 14 (App Router, TypeScript, Tailwind)
        │  @cloudflare/next-on-pages
        ▼
Cloudflare Pages Functions  ←─ nodejs_compat v2 (compatibility_date ≥ 2024-09-23)
        │
        ├── D1 (SQLite)        用户 / 收藏 / 播放记录 / 搜索历史 / 跳过配置 / 站点配置 / 采集源清单
        ├── /api/image-proxy   图片边缘代理
        └── Pages CDN          静态资源 + 边缘缓存
```

## 快速部署

### 前置要求

| 工具 | 版本 |
|---|---|
| Node.js | ≥ 18.12（推荐 20+） |
| pnpm | 10.x（corepack 会按 `packageManager` 字段自动对齐） |
| wrangler | 4.x |

### 1. 获取代码并安装依赖

```bash
git clone https://github.com/wooxi/KatelyaTV-CF.git
cd KatelyaTV-CF
pnpm install --frozen-lockfile
```

### 2. 登录 Cloudflare 并创建 D1

```bash
wrangler login
wrangler d1 create katelyatv-db
wrangler d1 execute katelyatv-db --remote --file=./scripts/d1-init.sql -y
```

将上一步输出的 `database_id` 填入 `wrangler.toml` 的 **三处** `d1_databases` 配置中。

### 3. 导入视频源

本仓库 `config.json` 的 `api_site` 为空，源清单在运行时存于 D1，任选其一导入：

| 方式 | 操作 | 特点 |
|---|---|---|
| **后台热更新（推荐）** | `/admin` → 配置管理 → 上传源清单 JSON | 免重新构建，立即生效 |
| **D1 直写** | 将源清单合并进 `main_config` 后 `wrangler d1 execute` | 适合批量脚本化 |
| **构建期内联** | 构建前把源清单覆盖 `config.json` 再 `pnpm run pages:build` | 仅 D1 尚无配置时必需 |

> 首次部署没有源时，站点功能正常但搜索为空——导入源后即可使用。

### 4. 配置站点凭据（Cloudflare Dashboard）

所有敏感凭据均通过 **Cloudflare Dashboard → Pages 项目 → Settings → Environment variables** 添加，不落入代码仓库：

| 变量 | 类型 | 说明 |
|---|---|---|
| `USERNAME` | Secret（加密） | 站长用户名 |
| `AUTH_PASSWORD` | Secret（加密） | 站长密码 |
| `SESSION_SECRET` | Secret（加密） | 会话签名密钥，≥32 位随机串（不配也能跑，但会退化用 `AUTH_PASSWORD` 派生） |

> ⚠️ 不要使用 `PASSWORD` 作为变量名，它是 Cloudflare 保留绑定名（上游已知的坑）。

### 5. 构建与部署

```bash
export NEXT_PUBLIC_STORAGE_TYPE=d1
export NEXT_PUBLIC_SITE_NAME=KatelyaTV
export NEXT_PUBLIC_IMAGE_PROXY='/api/image-proxy?url='
export NEXTAUTH_URL='https://<你的-pages-子域>.pages.dev'

pnpm run pages:build          # 末尾会自动执行 Node 兼容性补丁（fix-worker-imports.js）
wrangler pages deploy .vercel/output/static --project-name katelyatv --branch main
```

### 6. Git 集成自动部署

在 Cloudflare Dashboard 创建 Git 连接的 Pages 项目绑定本仓库（Direct Upload 项目也支持在项目设置中切换为 Git 集成），构建设置：

| 配置项 | 值 |
|---|---|
| 构建命令 | `pnpm install --frozen-lockfile && pnpm run pages:build` |
| 构建输出目录 | `.vercel/output/static` |
| 生产分支 | `main` |

绑定后推送 `main` 即自动构建部署，无需额外 CI——本仓库不包含 GitHub Actions 部署工作流（Cloudflare Git 集成已覆盖该职责，避免双流水线）。

## 环境变量

| 变量 | 生效阶段 | 配置位置 | 说明 |
|---|---|---|---|
| `NEXT_PUBLIC_STORAGE_TYPE` | 构建 | Dashboard 或 shell | 存储后端，固定 `d1` |
| `NEXT_PUBLIC_IMAGE_PROXY` | 构建 + 运行 | Dashboard 或 shell | 图片代理前缀，默认 `/api/image-proxy?url=` |
| `NEXT_PUBLIC_SITE_NAME` | 构建 | Dashboard 或 shell | 站点名称 |
| `NEXT_PUBLIC_ENABLE_REGISTER` | 构建 | Dashboard | 是否开放注册（`true`/`false`） |
| `NEXTAUTH_URL` | 构建 + 运行 | Dashboard 或 shell | 站点完整 URL |
| `USERNAME` | 运行 | Dashboard（Secret） | 站长用户名 |
| `AUTH_PASSWORD` | 运行 | Dashboard（Secret） | 站长密码（登录校验用） |
| `SESSION_SECRET` | 运行 | Dashboard（Secret） | 会话签名密钥，**建议配置**：≥32 位随机串。缺失时退化为由 `AUTH_PASSWORD` 直接派生（无 KDF，可被离线爆破） |
| `CRON_SECRET` | 运行 | Dashboard（Secret） | `/api/cron` 的 Bearer 密钥；未配置时该接口返回 503（默认禁用） |

> 站点名称、站点公告、图片代理前缀、豆瓣代理地址支持在 `/admin` 后台直接修改（保存至 D1 即时生效）；
> 环境变量仅在后台未设置对应值时作为初始回退。

## 视频源管理

**源清单与代码分离**。运行时生效的源清单 = **D1 `main_config` 存量 ∪ 代码仓库 `config.json` 新增项**：

- D1 里已有的 key 以 D1 为准；文件里新出现的 key 自动追加
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
- 源站失效属常态：用 `/admin` 后台增删，或维护一份私有源仓库（格式即 `config.json`），批量更新时后台重新上传
- 改动 `config.json` 的方式需要重新构建部署；后台方式即时生效

## 相对上游的修复

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 部署后全站 500 | next-on-pages 产物含裸 `async_hooks` 导入，Workers 无法解析；且 `compatibility_date` 低于 nodejs_compat v2 门槛 | 新增构建后处理 `scripts/fix-worker-imports.js`（裸内置模块重写为 `node:` 前缀）；`compatibility_date` 提升至 `2025-04-01`；升级 `@cloudflare/next-on-pages` 1.13.16 |
| 2 | 图片代理不生效、豆瓣海报裂图 | `wrangler.toml` 配置了错误的变量名 `IMAGE_PROXY_ENABLED`，代码实际读取 `NEXT_PUBLIC_IMAGE_PROXY` | 变量名修正，三处 `[vars]` 块统一 |
| 3 | 无 Cookie 客户端（OrionTV 等）图片失败 | middleware 未放行 `/api/image-proxy` | 加入 `shouldSkipAuth` 白名单 |
| 4 | 设置页报「获取用户设置失败」 | `d1-init.sql` 的 `user_settings` 表结构与运行时代码（JSON 列 `settings`）不一致，查询报 no such column | 表结构按运行时代码重建，初始化脚本同步修正 |
| 5 | 站长账号保存设置报「用户不存在」 | 环境变量登录的站长不会写入 `users` 表，而设置写入强制查表 | `user/settings` 路由对 `process.env.USERNAME` 豁免存在性检查 |
| 6 | 内置采集源全部失效 | 上游随仓库硬编码源清单，域名停摆即全灭 | 源配置与代码解耦，运行时经 D1 / 后台管理 |
| 7 | 站点公告含上游推广且后台不可修改 | layout 在 D1 模式跳过站点配置、面板在 D1 模式禁用编辑 | 所有存储模式统一读取站点配置；面板解除锁定；环境变量降级为初始回退值 |

## 目录结构

```
├── config.json                 # 采集源配置（本仓库 api_site 为空，运行时以 D1 为准）
├── wrangler.toml               # Cloudflare Pages / D1 绑定与环境变量
├── scripts/
│   ├── d1-init.sql             # D1 初始化（7 张表，与运行时代码严格一致）
│   ├── fix-worker-imports.js   # 构建后处理：Node 内置模块导入补丁
│   ├── convert-config.js       # config.json → src/lib/runtime.ts
│   └── generate-manifest.js    # PWA manifest 生成
├── src/
│   ├── app/                    # 页面与 API 路由（Edge Runtime）
│   ├── components/             # 播放器 / 设置 / 过滤器等组件
│   ├── lib/                    # 存储（D1）、鉴权、配置合并、工具
│   └── middleware.ts           # 认证中间件（含放行白名单）
└── .github/workflows/deploy.yml
```

## 常见问题

<details>
<summary>部署后全站 500 怎么排查？</summary>

执行 `wrangler pages deployment tail <deployment-id> --project-name katelyatv --format pretty` 后访问站点，
若出现 `No such module "__next-on-pages-dist__/.../async_hooks"`，说明构建后处理未执行——
请确认使用本仓库的 `pnpm run pages:build`（其中已串联 `fix-worker-imports.js`）。
</details>

<details>
<summary>绑定 D1 后接口仍报错？</summary>

`wrangler.toml` 必须保留 `pages_build_output_dir` 字段，`wrangler pages deploy` 才会把 `[[d1_databases]]`
绑定（binding 为 `DB`）一并提交。用 `wrangler d1 list` 核对 `database_id` 是否为本账号资源。
</details>

<details>
<summary>搜索没有结果？</summary>

先确认已导入采集源（见「快速部署 · 第 3 步」）；再检查源是否存活——苹果 CMS 采集站域名更迭频繁，
建议在 `/admin` 后台删旧换新。
</details>

<details>
<summary>为什么搜索不到成人内容？</summary>

用户级「成人内容过滤」默认开启（`/settings` 可关）。开启时 `is_adult` 源不参与常规结果；关闭后以独立分组展示。
</details>

## 致谢

- [MoonTV](https://github.com/MoonTechLab/LunaTV) / [LunaTV](https://github.com/sjnhnp/LunaTV) — 原始项目
- [katelya77/KatelyaTV](https://github.com/katelya77/KatelyaTV) — 二次开发上游
- [OrionTV](https://github.com/zimplexing/OrionTV) — 生态参考

## 免责声明

本项目仅供个人学习与研究使用，不存储、不分发任何视频资源，所有内容均来自第三方公开站点。
使用者需自行承担使用行为的法律责任，请勿将部署实例公开传播。影视信息数据来源：豆瓣。

## License

[MIT](./LICENSE)
