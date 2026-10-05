'use strict';

// 有向供电图与隔离判定逻辑。
// 供电方向: edges from_node -> to_node。
// 只有 enabled=1 的电源为有效电源; 经过 tagged=1 的开关的路径视为已被切断。
// 开关物理分合位(open_pos)是现场状态, 挂牌要求先分闸, 但隔离只认挂牌。

const MAX_PATHS = 200; // 限制搜索规模, 防止含环图上组合爆炸
const MAX_PATH_LEN = 64;

/**
 * 从所有启用电源出发, 找到 target 设备的全部“未切断”供电路径。
 * 路径遇到已挂牌开关立即终止(该分支已隔离)。
 * 返回形如 [{ nodes:[id,...], edges:[id,...], tagged:[id...] }],
 * tagged 为路径末端被挂牌而挡住去路的开关(若有)。未切断路径不含 tagged。
 */
function findPathsToTarget(graph, targetId) {
  const enabledSources = graph.nodes
    .filter((n) => n.kind === 'source' && n.enabled)
    .map((n) => n.id);

  const results = [];
  for (const src of enabledSources) {
    dfs(graph, src, targetId, new Set(), [src], new Set(), [], results);
  }
  return results;
}

function dfs(graph, cur, target, nodeSeen, nodePath, edgeSeen, edgePath, out) {
  if (out.length >= MAX_PATHS) return;
  if (nodePath.length > MAX_PATH_LEN) return;

  if (cur === target) {
    out.push({ nodes: nodePath.slice(), edges: edgePath.slice(), tagged: [] });
    return;
  }
  // 已挂牌开关: 通路在此被切断, 不再向下游走
  const curNode = graph.nodeById.get(cur);
  if (curNode && curNode.kind === 'switch' && curNode.tagged) {
    out.push({
      nodes: nodePath.slice(),
      edges: edgePath.slice(),
      blockedByTag: true,
      tagged: [cur]
    });
    return;
  }

  const outs = graph.outAdj.get(cur) || [];
  for (const e of outs) {
    // 防止环导致的无限递归: 节点与边都不重复
    if (nodeSeen.has(e.to) || edgeSeen.has(e.id)) continue;
    nodeSeen.add(e.to);
    edgeSeen.add(e.id);
    nodePath.push(e.to);
    edgePath.push(e.id);
    dfs(graph, e.to, target, nodeSeen, nodePath, edgeSeen, edgePath, out);
    edgePath.pop();
    nodePath.pop();
    edgeSeen.delete(e.id);
    nodeSeen.delete(e.to);
  }
}

/**
 * 判定设备是否满足隔离条件: 不存在任何从启用电源到设备的未切断路径。
 * @returns {{ isolated:boolean, livePaths:Array, blockedPaths:Array }}
 */
function evaluateIsolation(graph, deviceId) {
  const paths = findPathsToTarget(graph, deviceId);
  const livePaths = paths.filter((p) => !p.blockedByTag);
  const blockedPaths = paths.filter((p) => p.blockedByTag);
  return { isolated: livePaths.length === 0, livePaths, blockedPaths };
}

/**
 * 对所有有效检修许可重新校验隔离条件。
 * @returns 不满足隔离的许可数组 [{ permit, livePaths }]
 */
function validateActivePermits(graph, permits) {
  const violations = [];
  for (const p of permits) {
    const { livePaths } = evaluateIsolation(graph, p.device_id);
    if (livePaths.length > 0) violations.push({ permit: p, livePaths });
  }
  return violations;
}

function serializePath(graph, path) {
  return {
    nodes: path.nodes.map((id) => {
      const n = graph.nodeById.get(id);
      return { id, kind: n.kind, name: n.name, tagged: !!n.tagged };
    }),
    edges: path.edges,
    blockedByTag: !!path.blockedByTag
  };
}

module.exports = {
  findPathsToTarget,
  evaluateIsolation,
  validateActivePermits,
  serializePath,
  MAX_PATHS
};
