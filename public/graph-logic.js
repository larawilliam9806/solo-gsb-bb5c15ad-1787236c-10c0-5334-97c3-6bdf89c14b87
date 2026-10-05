/*
 * 有向供电图的纯逻辑：供服务端 Node 与浏览器同时使用。
 * 节点 { id, kind: 'source'|'switch'|'device', enabled, tagged, switch_open, ... }
 * 边   { id, u, v, seq }
 *
 * 隔离规则（挂牌上锁 LOTO）：
 *   从任一「启用电源」到目标设备的每一条供电路径，都必须经过一个「已挂牌」开关，
 *   目标设备才算被有效隔离。物理断开但未挂牌的开关不被视作可靠隔离点。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GraphLogic = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // 构建邻接表：adj[u] = [{ edgeId, v }]，按 seq 排序保证路径顺序稳定
  function buildAdj(nodes, edges) {
    const byId = new Map();
    nodes.forEach((n) => byId.set(n.id, n));
    const adj = new Map();
    nodes.forEach((n) => adj.set(n.id, []));
    edges.forEach((e) => {
      if (adj.has(e.u) && byId.has(e.v)) {
        adj.get(e.u).push({ edgeId: e.id, v: e.v });
      }
    });
    adj.forEach((list) => list.sort((a, b) => (a.v - b.v)));
    return { byId, adj };
  }

  /**
   * 枚举从「启用电源」到 targetId 的未切断路径。
   * 一条路径被认为「未切断」= 沿途没有任何已挂牌开关。
   * - blockTagged=true 时，已挂牌开关不可穿越（用于隔离判定）
   * - blockTagged=false 且要求物理有电时，可另用 physicalOpen 过滤物理断开
   * 返回：[[nodeId, nodeId, ...], ...]，最多 maxPaths 条，长度不超过 maxDepth
   */
  function findPaths(nodes, edges, targetId, opts) {
    opts = opts || {};
    const blockTagged = opts.blockTagged !== false;
    const requirePhysical = !!opts.requirePhysical;
    const maxPaths = opts.maxPaths || 30;
    const maxDepth = opts.maxDepth || 14;
    const { byId, adj } = buildAdj(nodes, edges);
    if (!byId.has(targetId)) return [];

    const sources = nodes.filter(
      (n) => n.kind === 'source' && (n.enabled === undefined || n.enabled === 1 || n.enabled === true)
    );
    const results = [];

    function blocked(n) {
      if (n.kind !== 'switch') return false;
      if (blockTagged && (n.tagged === 1 || n.tagged === true)) return true;
      if (requirePhysical && (n.switch_open === 1 || n.switch_open === true)) return true;
      return false;
    }

    function dfs(nodeId, path, edgePath) {
      if (results.length >= maxPaths || path.length > maxDepth) return;
      const node = byId.get(nodeId);
      if (!node || blocked(node)) return;
      // 同一路径内不允许绕圈
      if (path.indexOf(nodeId) !== -1) return;
      path.push(nodeId);
      if (nodeId === targetId) {
        results.push({ nodes: path.slice(), edges: edgePath.slice() });
      } else {
        for (const next of adj.get(nodeId) || []) {
          edgePath.push(next.edgeId);
          dfs(next.v, path, edgePath);
          edgePath.pop();
          if (results.length >= maxPaths) break;
        }
      }
      path.pop();
    }

    for (const s of sources) {
      if (results.length >= maxPaths) break;
      if (s.id === targetId) continue;
      dfs(s.id, [], []);
    }
    return results;
  }

  // 未切断路径（挂牌视为切断点）——许可生效判定与失败提示共用
  function findUncutPaths(nodes, edges, targetId) {
    return findPaths(nodes, edges, targetId, { blockTagged: true });
  }

  // 设备是否已被有效隔离：所有启用电源 -> 设备 的路径均经过已挂牌开关
  function isIsolated(nodes, edges, targetId) {
    return findUncutPaths(nodes, edges, targetId).length === 0;
  }

  // 物理有电：存在未被挂牌、且沿途开关都处于合闸状态的路径
  function isPowered(nodes, edges, targetId) {
    return (
      findPaths(nodes, edges, targetId, {
        blockTagged: true,
        requirePhysical: true,
      }).length > 0
    );
  }

  // 校验所有仍有效的检修许可；返回不再满足隔离条件的许可列表
  function violatedPermits(nodes, edges, permits) {
    const active = permits.filter((p) => p.status === 'active');
    return active.filter((p) => !isIsolated(nodes, edges, p.device_id));
  }

  // 把数字 id 路径转成名称，便于界面与审计展示：["S1","SW1","D1"]
  function pathToNames(pathNodes, nodes) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return pathNodes.map((id) => (byId.get(id) ? byId.get(id).name : '#' + id));
  }

  return {
    buildAdj,
    findPaths,
    findUncutPaths,
    isIsolated,
    isPowered,
    violatedPermits,
    pathToNames,
  };
});
