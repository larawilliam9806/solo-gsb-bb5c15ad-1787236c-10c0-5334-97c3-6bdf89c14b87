-- 厂内检修断电挂牌演练：数据库结构
-- 所有会改变网络状态的操作共用同一个 revision（乐观锁）。

PRAGMA foreign_keys = ON;

-- 电源 / 开关 / 设备 三种节点
CREATE TABLE IF NOT EXISTS nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('source', 'switch', 'device')),
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,   -- 仅对电源有意义：1=启用 0=停用
  tagged      INTEGER NOT NULL DEFAULT 0,   -- 仅对开关有意义：1=已挂牌 0=未挂牌
  switch_open INTEGER NOT NULL DEFAULT 0,   -- 仅对开关有意义：1=断开(物理分闸) 0=合闸
  x           REAL NOT NULL DEFAULT 80,
  y           REAL NOT NULL DEFAULT 80
);

-- 有向供电边：u -> v 表示电力可由 u 流向 v
CREATE TABLE IF NOT EXISTS edges (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  u   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  v   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE (u, v),
  CHECK (u <> v)
);

-- 全局单例行：网络修订号 + 建库时间
CREATE TABLE IF NOT EXISTS meta (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  revision  INTEGER NOT NULL DEFAULT 0,
  seeded_at TEXT NOT NULL
);

-- 用户（管理员 admin / 操作员 operator）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'operator'))
);

-- 检修许可（设备隔离许可）
CREATE TABLE IF NOT EXISTS permits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  revision   INTEGER NOT NULL,            -- 生效时的网络修订号
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  ended_at   TEXT,
  ended_by   INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_permits_device_status ON permits(device_id, status);

-- 审计日志：成功变更留存时间、操作者、动作与前后状态快照
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  actor_id    INTEGER NOT NULL REFERENCES users(id),
  actor_name  TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  action      TEXT NOT NULL,
  success     INTEGER NOT NULL,
  revision    INTEGER,                   -- 操作基线修订号
  new_revision INTEGER,                  -- 成功后的修订号
  detail      TEXT,                      -- 失败原因 / 未切断路径等（JSON）
  before_state TEXT,                     -- 操作前完整网络快照（JSON）
  after_state  TEXT                      -- 操作后完整网络快照（JSON）
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
