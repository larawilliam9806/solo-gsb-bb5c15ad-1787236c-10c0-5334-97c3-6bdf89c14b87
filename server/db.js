'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'loto.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- 密码散列 ----------
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 修订号 ----------
function getRevision() {
  return db.prepare('SELECT revision FROM meta WHERE id = 1').get().revision;
}

// ---------- 状态读取 ----------
function loadNodes() {
  return db.prepare('SELECT * FROM nodes ORDER BY id').all();
}
function loadEdges() {
  return db.prepare('SELECT * FROM edges ORDER BY seq, id').all();
}
function loadPermits() {
  return db
    .prepare(
      `SELECT p.*, u.username AS created_by_name, e.username AS ended_by_name
       FROM permits p
       JOIN users u ON u.id = p.created_by
       LEFT JOIN users e ON e.id = p.ended_by
       ORDER BY p.id`
    )
    .all();
}

// 完整网络状态快照（用于审计留存与接口返回）
function loadState() {
  return {
    revision: getRevision(),
    nodes: loadNodes(),
    edges: loadEdges(),
    permits: loadPermits(),
  };
}

// 供审计保存的紧凑快照
function snapshot() {
  return {
    revision: getRevision(),
    nodes: loadNodes().map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      enabled: n.enabled,
      tagged: n.tagged,
      switch_open: n.switch_open,
    })),
    edges: loadEdges().map((e) => ({ id: e.id, u: e.u, v: e.v })),
    permits: loadPermits().map((p) => ({
      id: p.id,
      device_id: p.device_id,
      status: p.status,
      revision: p.revision,
    })),
  };
}

module.exports = {
  db,
  DB_PATH,
  hashPassword,
  verifyPassword,
  getRevision,
  loadNodes,
  loadEdges,
  loadPermits,
  loadState,
  snapshot,
};
