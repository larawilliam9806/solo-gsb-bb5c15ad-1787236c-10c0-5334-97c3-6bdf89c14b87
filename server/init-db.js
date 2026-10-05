#!/usr/bin/env node
'use strict';

// 建库脚本：创建表结构，并在空库中写入演练演示数据与默认账号。
// 可重复执行：已有数据时只补建表，不覆盖既有数据。

const fs = require('fs');
const path = require('path');
const { db, hashPassword } = require('./db');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

const metaRow = db.prepare('SELECT id FROM meta WHERE id = 1').get();
if (metaRow) {
  console.log('[init-db] 数据库已初始化，跳过种子数据。');
  process.exit(0);
}

const now = new Date().toISOString();
const seed = db.transaction(() => {
  db.prepare('INSERT INTO meta (id, revision, seeded_at) VALUES (1, 0, ?)').run(now);

  function addUser(username, password, displayName, role) {
    const { salt, hash } = hashPassword(password);
    const info = db
      .prepare(
        'INSERT INTO users (username, password_hash, salt, display_name, role) VALUES (?,?,?,?,?)'
      )
      .run(username, hash, salt, displayName, role);
    return info.lastInsertRowid;
  }
  addUser('admin', 'admin123', '系统管理员', 'admin');
  addUser('operator', 'operator123', '值班操作员', 'operator');

  function addNode(kind, name, x, y, extra) {
    extra = extra || {};
    const info = db
      .prepare(
        `INSERT INTO nodes (kind, name, enabled, tagged, switch_open, x, y)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        kind,
        name,
        extra.enabled ?? 1,
        extra.tagged ?? 0,
        extra.switch_open ?? 0,
        x,
        y
      );
    return info.lastInsertRowid;
  }
  function addEdge(u, v, seq) {
    db.prepare('INSERT INTO edges (u, v, seq) VALUES (?,?,?)').run(u, v, seq);
  }

  // 演示供电网（x/y 为界面画布坐标）
  // S1 ─ SW1 ─ SW2 ─┬─ SW4 ─ D1
  //  │              └─ D2
  //  └─ SW3 ─ SW2
  // S2 ─ SW5 ───────┘
  const S1 = addNode('source', 'S1-主电源', 80, 140);
  const S2 = addNode('source', 'S2-备用电源', 80, 330);
  const SW1 = addNode('switch', 'SW1', 280, 90);
  const SW3 = addNode('switch', 'SW3', 280, 200);
  const SW5 = addNode('switch', 'SW5', 280, 360);
  const SW2 = addNode('switch', 'SW2', 500, 150);
  const SW4 = addNode('switch', 'SW4', 720, 110);
  const D1 = addNode('device', 'D1-反应釜', 920, 110);
  const D2 = addNode('device', 'D2-循环泵', 720, 260);

  addEdge(S1, SW1, 1);
  addEdge(S1, SW3, 2);
  addEdge(SW1, SW2, 3);
  addEdge(SW3, SW2, 4);
  addEdge(S2, SW5, 5);
  addEdge(SW5, SW2, 6);
  addEdge(SW2, SW4, 7);
  addEdge(SW2, D2, 8);
  addEdge(SW4, D1, 9);
});

seed();
console.log('[init-db] 建库与种子数据完成。');
console.log('  默认账号: admin / admin123 (管理员)');
console.log('            operator / operator123 (操作员)');
process.exit(0);
