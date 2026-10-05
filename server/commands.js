'use strict';

// 网络变更命令：统一做权限校验、乐观修订号校验、隔离安全不变量校验与审计留存。

const G = require('../public/graph-logic.js');
const { db, loadState, snapshot, getRevision } = require('./db');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const PERMISSIONS = {
  // 管理员：维护电源 / 开关 / 设备及有向供电线路
  addNode: ['admin'],
  renameNode: ['admin'],
  deleteNode: ['admin'],
  addEdge: ['admin'],
  deleteEdge: ['admin'],
  enableSource: ['admin'],
  disableSource: ['admin'],
  // 操作员（管理员亦可）：断开 / 合闸、挂牌 / 解牌、申请 / 结束检修许可
  switchOpen: ['admin', 'operator'],
  switchClose: ['admin', 'operator'],
  tag: ['admin', 'operator'],
  untag: ['admin', 'operator'],
  applyPermit: ['admin', 'operator'],
  endPermit: ['admin', 'operator'],
};

const ACTION_LABELS = {
  addNode: '新增节点',
  renameNode: '重命名节点',
  deleteNode: '删除节点',
  addEdge: '新增供电线路',
  deleteEdge: '删除供电线路',
  enableSource: '启用电源',
  disableSource: '停用电源',
  switchOpen: '断开开关',
  switchClose: '合闸开关',
  tag: '开关挂牌',
  untag: '开关解牌',
  applyPermit: '申请检修许可',
  endPermit: '结束检修许可',
};

// ---------- 基础工具 ----------
function getNode(id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
}
function requireNode(id) {
  const n = getNode(id);
  if (!n) throw new HttpError(400, 'NODE_NOT_FOUND', `节点 #${id} 不存在`);
  return n;
}
function activePermitForDevice(deviceId) {
  return db
    .prepare("SELECT * FROM permits WHERE device_id = ? AND status = 'active'")
    .get(deviceId);
}
function activePermit(permitId) {
  return db
    .prepare("SELECT * FROM permits WHERE id = ? AND status = 'active'")
    .get(permitId);
}

// 列出某设备当前「未切断路径」（不经过已挂牌开关的路径），带名称
function uncutPathReport(deviceId) {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all();
  const edges = db.prepare('SELECT * FROM edges ORDER BY seq, id').all();
  return G.findUncutPaths(nodes, edges, deviceId).map((p) => ({
    pathIds: p.nodes,
    pathNames: G.pathToNames(p.nodes, nodes).join(' → '),
    edgeIds: p.edges,
  }));
}

// 通用安全不变量：所有有效许可仍须满足隔离条件
function assertAllActivePermitsIsolated() {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all();
  const edges = db.prepare('SELECT * FROM edges ORDER BY seq, id').all();
  const permits = db.prepare('SELECT * FROM permits').all();
  const violated = G.violatedPermits(nodes, edges, permits);
  if (violated.length > 0) {
    const details = violated.map((p) => {
      const device = nodes.find((n) => n.id === p.device_id);
      return {
        permitId: p.id,
        deviceId: p.device_id,
        deviceName: device ? device.name : '#' + p.device_id,
        uncutPaths: uncutPathReport(p.device_id).map((r) => r.pathNames),
      };
    });
    throw new HttpError(
      422,
      'PERMIT_ISOLATION_LOST',
      `操作被拒绝：将使 ${violated.length} 个有效检修许可失去隔离，状态保持不变`,
      { violated: details, stateUnchanged: true }
    );
  }
}

// ---------- 各动作处理（在事务中执行，已通过权限与修订号校验） ----------
const handlers = {
  switchOpen(data) {
    const n = requireNode(data.nodeId);
    if (n.kind !== 'switch') throw new HttpError(400, 'NOT_SWITCH', '目标不是开关');
    if (n.switch_open === 1) throw new HttpError(400, 'ALREADY_OPEN', '开关已处于断开状态');
    db.prepare('UPDATE nodes SET switch_open = 1 WHERE id = ?').run(n.id);
    assertAllActivePermitsIsolated();
  },

  switchClose(data) {
    const n = requireNode(data.nodeId);
    if (n.kind !== 'switch') throw new HttpError(400, 'NOT_SWITCH', '目标不是开关');
    // 硬性安全规则：挂牌开关不得合闸
    if (n.tagged === 1) {
      throw new HttpError(
        422,
        'TAGGED_CANNOT_CLOSE',
        `开关「${n.name}」已挂牌上锁，禁止合闸；请先解除检修许可并解牌`,
        { stateUnchanged: true }
      );
    }
    if (n.switch_open === 0) throw new HttpError(400, 'ALREADY_CLOSED', '开关已处于合闸状态');
    db.prepare('UPDATE nodes SET switch_open = 0 WHERE id = ?').run(n.id);
    assertAllActivePermitsIsolated();
  },

  tag(data) {
    const n = requireNode(data.nodeId);
    if (n.kind !== 'switch') throw new HttpError(400, 'NOT_SWITCH', '目标不是开关');
    if (n.tagged === 1) throw new HttpError(400, 'ALREADY_TAGGED', '开关已挂牌');
    if (n.switch_open === 0) {
      throw new HttpError(
        400,
        'MUST_OPEN_FIRST',
        `挂牌前必须先断开开关「${n.name}」`,
        { stateUnchanged: true }
      );
    }
    db.prepare('UPDATE nodes SET tagged = 1 WHERE id = ?').run(n.id);
    // 挂牌只会增强隔离，不变量必然满足
  },

  untag(data) {
    const n = requireNode(data.nodeId);
    if (n.kind !== 'switch') throw new HttpError(400, 'NOT_SWITCH', '目标不是开关');
    if (n.tagged === 0) throw new HttpError(400, 'NOT_TAGGED', '开关未挂牌');
    db.prepare('UPDATE nodes SET tagged = 0 WHERE id = ?').run(n.id);
    // 解牌可能让有效许可失去隔离
    assertAllActivePermitsIsolated();
  },

  enableSource(data) {
    const n = requireNode(data.nodeId);
    if (n.kind !== 'source') throw new HttpError(400, 'NOT_SOURCE', '目标不是电源');
    if (n.enabled === 1) throw new HttpError(400, 'ALREADY_ENABLED', '电源已启用');
    db.prepare('UPDATE nodes SET enabled = 1 WHERE id = ?').run(n.id);
    // 启用电源可能产生新的供电路径，必须复核所有有效许可
    assertAllActivePermitsIsolated();
  },

  disableSource(data) {
    const n = requireNode(data.nodeId);
    if (n.kind !== 'source') throw new HttpError(400, 'NOT_SOURCE', '目标不是电源');
    if (n.enabled === 0) throw new HttpError(400, 'ALREADY_DISABLED', '电源已停用');
    db.prepare('UPDATE nodes SET enabled = 0 WHERE id = ?').run(n.id);
    assertAllActivePermitsIsolated();
  },

  addNode(data) {
    const kind = data.nodeKind;
    const name = (data.name || '').trim();
    if (!['source', 'switch', 'device'].includes(kind)) {
      throw new HttpError(400, 'BAD_KIND', '节点类型必须是 source / switch / device');
    }
    if (!name) throw new HttpError(400, 'BAD_NAME', '节点名称不能为空');
    const info = db
      .prepare(
        'INSERT INTO nodes (kind, name, enabled, tagged, switch_open, x, y) VALUES (?,?,1,0,0,?,?)'
      )
      .run(kind, name, data.x ?? 120, data.y ?? 120);
    return { nodeId: info.lastInsertRowid };
  },

  renameNode(data) {
    const n = requireNode(data.nodeId);
    const name = (data.name || '').trim();
    if (!name) throw new HttpError(400, 'BAD_NAME', '节点名称不能为空');
    db.prepare('UPDATE nodes SET name = ? WHERE id = ?').run(name, n.id);
  },

  deleteNode(data) {
    const n = requireNode(data.nodeId);
    if (n.kind === 'device' && activePermitForDevice(n.id)) {
      throw new HttpError(
        400,
        'ACTIVE_PERMIT_EXISTS',
        `设备「${n.name}」存在有效检修许可，请先结束许可后再删除`,
        { stateUnchanged: true }
      );
    }
    // 边上的外键 ON DELETE CASCADE 会一并删除相关线路
    db.prepare('DELETE FROM nodes WHERE id = ?').run(n.id);
    assertAllActivePermitsIsolated();
  },

  addEdge(data) {
    const u = requireNode(data.u);
    const v = requireNode(data.v);
    if (u.id === v.id) throw new HttpError(400, 'SELF_LOOP', '不允许节点连接自身');
    if (u.kind === 'device') throw new HttpError(400, 'BAD_EDGE', '电力不能从设备流出');
    if (v.kind === 'source') throw new HttpError(400, 'BAD_EDGE', '电力不能流入电源');
    const dup = db.prepare('SELECT id FROM edges WHERE u = ? AND v = ?').get(u.id, v.id);
    if (dup) throw new HttpError(400, 'EDGE_EXISTS', '该供电线路已存在');
    const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) + 1 AS s FROM edges').get().s);
    db.prepare('INSERT INTO edges (u, v, seq) VALUES (?,?,?)').run(u.id, v.id, seq);
    // 新增线路可能恢复对在修设备的供电
    assertAllActivePermitsIsolated();
  },

  deleteEdge(data) {
    const edge = db.prepare('SELECT * FROM edges WHERE id = ?').get(data.edgeId);
    if (!edge) throw new HttpError(400, 'EDGE_NOT_FOUND', '线路不存在');
    db.prepare('DELETE FROM edges WHERE id = ?').run(edge.id);
    assertAllActivePermitsIsolated();
  },

  applyPermit(data, user) {
    const n = requireNode(data.nodeId);
    if (n.kind !== 'device') throw new HttpError(400, 'NOT_DEVICE', '许可只能签发给设备');
    if (activePermitForDevice(n.id)) {
      throw new HttpError(400, 'PERMIT_EXISTS', `设备「${n.name}」已有有效检修许可`);
    }
    const paths = uncutPathReport(n.id);
    if (paths.length > 0) {
      throw new HttpError(
        422,
        'PERMIT_NOT_ISOLATED',
        `许可未生效：设备「${n.name}」仍存在 ${paths.length} 条由启用电源到达的未切断路径`,
        {
          deviceId: n.id,
          deviceName: n.name,
          uncutPaths: paths,
          stateUnchanged: true,
          loggable: true,
        }
      );
    }
    const newRevision = getRevision() + 1; // 与本次变更的修订号一致
    db.prepare(
      `INSERT INTO permits (device_id, status, revision, created_at, created_by)
       VALUES (?, 'active', ?, ?, ?)`
    ).run(n.id, newRevision, new Date().toISOString(), user.id);
  },

  endPermit(data, user) {
    let permit;
    if (data.permitId) permit = activePermit(data.permitId);
    else if (data.nodeId) permit = activePermitForDevice(data.nodeId);
    if (!permit) throw new HttpError(400, 'PERMIT_NOT_FOUND', '没有找到有效的检修许可');
    db.prepare('UPDATE permits SET status = ?, ended_at = ?, ended_by = ? WHERE id = ?').run(
      'ended',
      new Date().toISOString(),
      user.id,
      permit.id
    );
  },
};

// ---------- 审计 ----------
const insertAudit = db.prepare(
  `INSERT INTO audit_logs
     (ts, actor_id, actor_name, actor_role, action, success, revision, new_revision,
      detail, before_state, after_state)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
);

function writeAudit(entry) {
  insertAudit.run(
    entry.ts,
    entry.actorId,
    entry.actorName,
    entry.actorRole,
    entry.action,
    entry.success ? 1 : 0,
    entry.revision,
    entry.newRevision,
    entry.detail ? JSON.stringify(entry.detail) : null,
    entry.before ? JSON.stringify(entry.before) : null,
    entry.after ? JSON.stringify(entry.after) : null
  );
}

/**
 * 执行一条网络变更命令。
 * data.revision 必须等于当前网络修订号，否则返回 409 与当前状态。
 */
function execute(action, data, user) {
  if (!handlers[action]) throw new HttpError(400, 'UNKNOWN_ACTION', `未知操作：${action}`);
  const roles = PERMISSIONS[action];
  if (!roles.includes(user.role)) {
    throw new HttpError(403, 'FORBIDDEN', `${user.role} 角色无权执行「${ACTION_LABELS[action]}」`);
  }

  const before = snapshot();
  if (Number(data.revision) !== before.revision) {
    throw new HttpError(
      409,
      'STALE_REVISION',
      `修订号已过期（你提交的是 ${data.revision}，当前为 ${before.revision}），请刷新后重试`,
      { state: loadState() }
    );
  }

  let output;
  const tx = db.transaction(() => {
    output = handlers[action](data, user);
    db.prepare('UPDATE meta SET revision = revision + 1 WHERE id = 1').run();
    const after = snapshot();
    writeAudit({
      ts: new Date().toISOString(),
      actorId: user.id,
      actorName: user.display_name,
      actorRole: user.role,
      action,
      success: true,
      revision: before.revision,
      newRevision: after.revision,
      detail: { label: ACTION_LABELS[action], output: output || null },
      before,
      after,
    });
  });

  try {
    tx();
  } catch (err) {
    if (err instanceof HttpError) {
      // 失败的许可申请留痕（含未切断路径）；其余安全拒绝按同样方式记录，便于演练复盘
      const shouldLog =
        action === 'applyPermit' ||
        ['PERMIT_ISOLATION_LOST', 'TAGGED_CANNOT_CLOSE'].includes(err.code);
      if (shouldLog) {
        writeAudit({
          ts: new Date().toISOString(),
          actorId: user.id,
          actorName: user.display_name,
          actorRole: user.role,
          action,
          success: false,
          revision: before.revision,
          newRevision: null,
          detail: {
            label: ACTION_LABELS[action],
            errorCode: err.code,
            message: err.message,
            ...err.extra,
          },
          before,
          after: null,
        });
      }
      // 把最新状态一并带回（事务已回滚，状态未改变）
      err.extra.state = loadState();
    }
    throw err;
  }

  return { state: loadState(), output: output || null };
}

module.exports = { execute, HttpError, ACTION_LABELS };
