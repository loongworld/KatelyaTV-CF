-- KatelyaTV D1 初始化脚本
-- 与 src/lib/d1.db.ts 的查询逐列对齐（2026-10-18 依据线上库 sqlite_master 核对）
--
-- 用法：
--   wrangler d1 execute katelyatv-db --remote --file=./scripts/d1-init.sql
--
-- ⚠️ 本脚本的列名必须与 d1.db.ts 保持一致。历史上这里用的是
-- user_id / record_key / video_id 等列名，而代码查的是 username / key，
-- 结果收藏、播放记录、搜索历史、跳过配置四个接口全部 500
--（2026-09-15 的线上事故，当时是手工在线上执行 DDL 才修好）。
-- 改这个文件之前，请先 grep 一遍 src/lib/d1.db.ts 里对应的列名。

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,              -- PBKDF2-SHA256 哈希串，见 src/lib/password.ts
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 播放记录
CREATE TABLE IF NOT EXISTS play_records (
  username TEXT NOT NULL,
  key TEXT NOT NULL,                   -- `${source}+${id}`
  title TEXT,
  source_name TEXT,
  cover TEXT,
  year TEXT,
  index_episode INTEGER DEFAULT 0,
  total_episodes INTEGER DEFAULT 0,
  play_time REAL DEFAULT 0,
  total_time REAL DEFAULT 0,
  save_time INTEGER,
  search_title TEXT,
  PRIMARY KEY (username, key)
);

-- 收藏
CREATE TABLE IF NOT EXISTS favorites (
  username TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT,
  source_name TEXT,
  cover TEXT,
  year TEXT,
  total_episodes INTEGER DEFAULT 0,
  save_time INTEGER,
  search_title TEXT,
  PRIMARY KEY (username, key)
);

-- 搜索历史
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_search_history_username ON search_history(username);

-- 跳过配置（片头片尾）
CREATE TABLE IF NOT EXISTS skip_configs (
  username TEXT NOT NULL,
  key TEXT NOT NULL,
  source TEXT,
  video_id TEXT,
  title TEXT,
  segments TEXT,                       -- JSON 数组，见 EpisodeSkipConfig.segments
  updated_time INTEGER,
  PRIMARY KEY (username, key)
);

-- 用户设置（整个 UserSettings 以 JSON 存放）
CREATE TABLE IF NOT EXISTS user_settings (
  username TEXT PRIMARY KEY,
  settings TEXT,
  updated_time INTEGER
);

-- 管理员配置：运行时代码只读写 config_key = 'main_config' 这一行
CREATE TABLE IF NOT EXISTS admin_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT UNIQUE NOT NULL,
  config_value TEXT,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO admin_configs (config_key, config_value, description)
  VALUES ('main_config', '{}', '主要管理员配置');

-- 登录失败限速（src/lib/loginLimiter.ts 会在运行时自建，这里预建可省掉那次 DDL）
CREATE TABLE IF NOT EXISTS login_attempts (
  scope_key TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

-- 索引说明：
-- play_records / favorites / skip_configs 的主键是 (username, key)，其左前缀
-- 已经能服务 WHERE username = ?，不要再给 username 单独建索引——那是纯写入负担。
-- 如果将来单用户记录数上万、ORDER BY save_time 开始变慢，再加：
--   CREATE INDEX IF NOT EXISTS idx_play_records_user_save ON play_records(username, save_time DESC);
--   CREATE INDEX IF NOT EXISTS idx_favorites_user_save ON favorites(username, save_time DESC);

-- 从更早的 user_id / record_key 结构升级（会丢这四张表的旧数据，请先备份）：
--   DROP VIEW  IF EXISTS user_stats;   -- 旧结构遗留的坏视图，引用已不存在的 user_id 列
--   DROP TABLE IF EXISTS play_records;
--   DROP TABLE IF EXISTS favorites;
--   DROP TABLE IF EXISTS search_history;
--   DROP TABLE IF EXISTS skip_configs;
-- 然后重新执行本脚本。
