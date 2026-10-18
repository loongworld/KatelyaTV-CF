# Changelog

本仓库自 katelya77/KatelyaTV 分叉后针对 Cloudflare 部署链路完全重构。以下仅记录本仓库自身的变更。

## [1.3.0] - 2026-10-18

### 新增

- **会话吊销机制（`session_version`）**：封禁 / 改密 / 角色变更后，该用户名下的旧会话最多 30 秒内全部失效。
  此前被封禁的用户在凭据自然到期（7 天）前仍可继续使用站点。鉴权层对版本号做 30 秒内存缓存，
  每次 API 调用最多摊薄为 30 秒一次 D1 点查；D1 异常时 fail-open（不误伤全站），用户被删除时立即拒绝。
  已有库需执行一次迁移（未迁移自动降级，不报错）：
  `ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;`
- **`TVBOX_TOKEN` 独立订阅令牌**：TVBox 订阅可与登录会话解耦，单独轮换吊销，不再必须轮换全站签名密钥。

### 修复

- **豆瓣海报全部回退占位图**：根因是 Referer 策略搞反了——此前注释断言「豆瓣对带 `movie.douban.com`
  Referer 返回 403，因此不发送 Referer」，实测恰好相反：不带 Referer 时豆瓣返回 418 + 13 字节
  `cdn error 001`（Content-Type 谎报 `image/jpeg`，被魔数校验拦成 502）；带上 Referer 则是正常的真图。
  现在仅对豆瓣域（`*.doubanio.com` / `*.douban.com`）发送 `Referer: https://movie.douban.com/`，
  其他图源维持不发送。
- **选集面板溢出裁切**：`lg` 视口下集数网格（10 行 × 5 列，约 532px）超出固定高度容器且没有滚动，
  第 39 集之后被 `overflow-hidden` 直接裁掉、无法点击。网格改为 `flex-1 min-h-0 overflow-y-auto`。
- **换源测速风暴**：切到「换源」Tab 会瞬时对全部源并发探测。改为 4 并发 worker 池，逐个取队探测。
- **换源列表原地排序**：`availableSources.sort()` 直接修改父组件 props，改为拷贝后排序。
- **ScrollableRow 抖动**：`MutationObserver` 监听了 `class` / `style` 属性变化，鼠标划过卡片
  （hover 态切换 class）即持续触发无效的滚动检查。改为只监听子节点增删。
- **搜索请求强制穿透浏览器缓存**：上一版移除了时间戳参数，但残留的 `Cache-Control: no-cache`
  请求头仍使浏览器每次都发起网络请求。移除，信任服务端 `max-age`。
- **登录页版本按钮**：默认跳转地址仍是上游仓库（现改为本仓库，可用 `NEXT_PUBLIC_REPO_URL` 覆盖）；
  按钮被 iPhone 底部手势条遮挡（补 `env(safe-area-inset-bottom)`）；扩大点击热区。
- **触控目标偏小**：搜索历史删除按钮 16×16 → 20×20 且触屏设备常显；
  `CapsuleSwitch` 移动端纵向内边距加大。

### 变更

- `wrangler.toml` 清理 10 个零引用的历史变量（`CACHE_TTL` / `CORS_ORIGIN` / `RATE_LIMIT_*` /
  `HEALTH_CHECK_*` / `LOG_*` / `NEXT_PUBLIC_SITE_DESCRIPTION` / `NEXTAUTH_URL`）。
- 修正文档与代码的变量名漂移：站点名回退值实际读 `SITE_NAME`，此前文档一直教用户配置无人读取的
  `NEXT_PUBLIC_SITE_NAME`。
- `[env.preview]` 的 D1 绑定修正为实际存在的 `katelyatv-db-preview`（此前指向生产库，与 Dashboard 脱节）。
- `middleware.ts` 清理已随 PWA 一并删除的 `sw.js` / `workbox-*` / `swe-worker` 等白名单残留。
- `@types/react-dom` 由 19.x 修正为与 React 18 匹配的 18.x。
- README 全面重写；`docs/TVBOX.md` 按真实实现重写（格式参数、令牌机制、缓存时长等此前多处漂移）。

## [1.2.0] - 2026-10-18

本版本来自一次完整审计（安全 / 前端 / Cloudflare 平台 / 线上实测四条线）。

### 修复

- **图片代理同源 XSS**：`/api/image-proxy` 原先只要 `Content-Type` 以 `image/` 开头就原样回传，`image/svg+xml` 因此能携带脚本在站点自身源上执行。现在只放行位图 MIME，并补 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: default-src 'none'; sandbox`；另按文件头魔数二次校验，避免把上游伪装成图片的错误响应（豆瓣对异常出口 IP 返回的 13 字节 `cdn error 001`）当图片缓存 7 天。
- **无 Cookie 客户端海报全裂**：`82305d2` 重写 middleware 时把 `/api/image-proxy` 移出了白名单，OrionTV / TVBox 请求一律 401。现已放回，并把静态资源改为按扩展名放行（`screenshot1-4.png`、`wechat.jpg` 此前被 302 到登录页）。
- **搜索子请求超限**：线上 56 个源，一次搜索至少 56 次上游 fetch，而 Workers 免费版单请求子请求上限是 50，超限抛出的异常被 `catch` 静默吞掉（表现为结果静默缺失）。现在单次最多检索 40 个源并支持 `?offset=` 分片，前端自动补齐剩余分片。
- **成人结果分组恒为空**：`getAvailableApiSites` 的映射把 `is_adult` 丢掉了，加上 `finalShouldFilter` 因前端不传 `include_adult` 而恒为 true、`adult_results` 硬编码空数组——线上实配的 20 个成人源在任何设置下都搜不出内容。三处一并修好。
- **CORS 预检被拦**：middleware 对 OPTIONS 也要求会话，跨域客户端（OrionTV）的预检全部 401。现在无条件放行 OPTIONS。
- **收藏 `search_title` 只读不写**：写入路径漏了这一列，收藏的「当初搜的什么词」永远为空。
- **登录限速非原子**：原实现读-改-写计数，并发下 5 次锁定阈值被稀释；改为单条 UPSERT。
- **重置用户设置会绕过管理员托管字段**：`PUT /api/user/settings` 直接写默认值，把 `managed_by_admin` / `can_disable_filter` 一并清掉。
- **版本检查向第三方泄露访客 IP**：客户端每页都请求 `ghfast.top` 代理拉上游 `VERSION.txt`，而检查的是 katelya77 仓库的版本号，与本 fork 无关。默认不再发起任何外部请求。
- **前端**：`VideoCard` 整卡不可聚焦（键盘与电视遥控器无法选片、触屏没有收藏入口）、片尾倒计时「取消」1 秒后自动重启、豆瓣页请求失败永久停在骨架屏、播放页 `timeupdate` 每秒约 4 次触发整页重渲染、播放错误零反馈、四个弹窗缺对话框语义。
- **构建期读 D1**：`layout.tsx` 在构建阶段也会尝试读配置，现已跳过，避免把一次失败固化进模块缓存。

### 变更

- 去掉在 Cloudflare 上无效的 `Vercel-CDN-Cache-Control`；图片代理改为浏览器与边缘各缓存 7 天。
- 删除 16 个死文件（三个永不执行的存储后端实现、7 个孤儿脚本、PWA 产物、模板残留 CSS 等）与 14 个无用依赖，dependencies 由 26 项降到 12 项。
- `next-pwa` 在纯 App Router 项目上从未生效（线上 `getRegistrations()` 为空），已移除依赖与产物。
- `scripts/d1-init.sql` 按线上真实表结构重写：此前脚本用 `user_id` / `record_key` 建表，而运行时代码查 `username` / `key`，照文档初始化会直接报 `no such column`（2026-09-15 已因此线上四表接口 500）。
- `scripts/fix-worker-imports.js`：正则覆盖 `from` / `require` / `import()` / side-effect import 与单双引号、可选空格；产物缺失时以非零码退出。零命中只警告（精简依赖后产物可能本就没有裸 Node 内置模块），避免误杀正常构建。
- 环境变量示例与 README 按实际读取的变量重写，新增 `SESSION_SECRET` 说明。

### 运维

- 线上 D1 清理：删除引用已不存在列的 `user_stats` 视图、3 个与主键左前缀重复的索引、`admin_configs` 中 5 行无人读取的历史默认值。
- 生产环境补齐 `SESSION_SECRET`（此前缺失，会话签名密钥退化为 `"derived:" + AUTH_PASSWORD`，无 KDF）。

## [1.1.1] - 2026-09-06

### 修复

- **站点配置支持后台编辑**：解除 `/admin` 站点配置在 D1 / Upstash 模式下的整体禁用；站点名称、公告、图片代理、豆瓣代理保存至存储后端即时生效，环境变量降级为初始回退值。
- **站点公告去除上游推广尾巴**（`Link Me TG：@katelya77`）：默认文案清理，且公告改为后台可编辑。

### 变更

- 移除 GitHub Actions 部署工作流：Cloudflare Git 集成已在推送时自动构建部署，双流水线冗余且需额外维护 API Token secrets。

## [1.1.0] - 2026-09-06

### 变更

- **源配置与代码分离**：仓库 `config.json` 的 `api_site` 置空，运行时源清单存于 D1 `main_config`，通过 `/admin` 后台上传或 D1 直写维护；公开仓库不再携带任何影视源。
- **敏感凭据全部迁移至 Cloudflare Dashboard 环境变量**（`USERNAME` / `AUTH_PASSWORD` 以 Secret 类型添加），代码与 CI 中零凭据。
- README 同步更新：新增「导入视频源」步骤、Git 集成自动部署指引（构建设置与 Dashboard 变量清单）、源管理语义说明。

## [1.0.0] - 2026-09-06

### 修复（相对上游）

- **修复 Cloudflare Pages 部署后全站 500**：`@cloudflare/next-on-pages` 产物将 Node 内置模块编译为裸标识符（如 `import "async_hooks"`），Workers 运行时无法解析。新增构建后处理脚本 `scripts/fix-worker-imports.js` 统一重写为 `node:` 前缀，并串联进 `pages:build`；`compatibility_date` 提升至 `2025-04-01` 以启用 nodejs_compat v2；`@cloudflare/next-on-pages` 升级至 1.13.16。
- **修复图片代理不生效（豆瓣海报裂图）**：`wrangler.toml` 使用了错误变量名 `IMAGE_PROXY_ENABLED`，代码实际读取 `NEXT_PUBLIC_IMAGE_PROXY`，已统一修正并注入构建环境。
- **修复无 Cookie 客户端图片加载失败**：middleware 放行白名单加入 `/api/image-proxy`。
- **修复设置页「获取用户设置失败」**：`scripts/d1-init.sql` 的 `user_settings` 表结构与运行时代码不一致（缺 `settings` JSON 列），按运行时代码重建表结构并修正初始化脚本。
- **修复站长账号保存设置报「用户不存在」**：`/api/user/settings` 的 PATCH/PUT 对 `process.env.USERNAME` 豁免 users 表存在性检查（与登录鉴权语义对齐）。
- **替换全部失效采集源**：上游自带 5 个源域名已停摆，替换为 54 个实测存活源（34 常规 + 20 成人，`is_adult` 正确标记）。

### 变更

- 移除 Docker / Kvrocks 部署链路及其文档，聚焦 Cloudflare Pages + D1 单一形态。
- 新增 GitHub Actions 自动部署工作流（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets 触发）。
- 重写 README 与配置文档。
