'use strict';

/* 厂内检修断电挂牌演练 —— 浏览器端 */

const $ = (sel) => document.querySelector(sel);

const state = {
  revision: 0,
  nodes: [],
  edges: [],
  permits: [],
};
let user = null;
let selectedNodeId = null;
let selectedEdgeId = null;
let connectMode = false;
let connectFromId = null;
let highlight = null; // { deviceId, edgeIds: number[], ts }
let dragging = null;

const NODE_W = 116;
const NODE_H = 52;
const ROLE_NAME = { admin: '管理员', operator: '操作员' };
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

// ---------- API ----------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.code = data.error && data.error.code;
    err.extra = (data.error && data.error.extra) || {};
    throw err;
  }
  return data;
}

function applyState(next) {
  state.revision = next.revision;
  state.nodes = next.nodes || [];
  state.edges = next.edges || [];
  state.permits = next.permits || [];
  $('#rev-value').textContent = state.revision;
  if (selectedNodeId !== null && !nodeById(selectedNodeId)) selectedNodeId = null;
  if (selectedEdgeId !== null && !edgeById(selectedEdgeId)) selectedEdgeId = null;
  renderAll();
}

async function loadState() {
  applyState(await api('GET', '/api/state'));
}

// 执行变更：自动携带所见修订号；统一处理过期/拒绝/失败路径
async function run(action, data, opts) {
  opts = opts || {};
  hideToast();
  try {
    const res = await api('POST', '/api/command', {
      action,
      data: Object.assign({ revision: state.revision }, data),
    });
    applyState(res.state);
    if (!opts.silent) toast(`已完成：${ACTION_LABELS[action] || action}`, 'ok');
    return res;
  } catch (err) {
    if (err.status === 401) {
      showLogin();
      return;
    }
    if (err.status === 409) {
      // 过期提交：服务器返回当前状态，直接采纳
      if (err.extra.state) applyState(err.extra.state);
      toast(`${err.message}。界面已同步为他人更新后的最新网络。`, 'error');
      return;
    }
    if (err.status === 422) {
      // 安全拒绝：整次操作拒绝、状态不变
      if (err.extra.state) applyState(err.extra.state);
      showRejection(err);
      return;
    }
    toast(err.message, 'error');
  }
}

function showRejection(err) {
  const extra = err.extra || {};
  let html = `<div>⛔ ${err.message}</div>`;

  if (err.code === 'PERMIT_NOT_ISOLATED' && extra.uncutPaths) {
    html += `<div style="margin-top:6px">设备「${extra.deviceName}」仍有以下未切断路径（均须被已挂牌开关切断）：</div>`;
    extra.uncutPaths.forEach((p) => {
      html += `<div class="fail-path">▸ ${escapeHtml(p.pathNames)}</div>`;
    });
    highlight = {
      deviceId: extra.deviceId,
      edgeIds: new Set(extra.uncutPaths.flatMap((p) => p.edgeIds)),
    };
  } else if (err.code === 'PERMIT_ISOLATION_LOST' && extra.violated) {
    extra.violated.forEach((v) => {
      html += `<div class="fail-path">许可 #${v.permitId}（${escapeHtml(v.deviceName)}）重新出现供电路径：</div>`;
      (v.uncutPaths || []).forEach((p) => {
        html += `<div class="fail-path">▸ ${escapeHtml(p)}</div>`;
      });
    });
    const allEdges = new Set();
    extra.violated.forEach((v) => {
      const paths = G.findUncutPaths(state.nodes, state.edges, v.deviceId);
      paths.forEach((p) => p.edges.forEach((e) => allEdges.add(e)));
    });
    highlight = { deviceId: null, edgeIds: allEdges };
  }
  renderEdges();
  toastHtml(html, 'error');
}

// ---------- 登录 / 初始化 ----------
function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}
function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const res = await api('POST', '/api/login', {
      username: $('#login-username').value.trim(),
      password: $('#login-password').value,
    });
    user = res.user;
    enterApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  user = null;
  showLogin();
});

function enterApp() {
  showApp();
  $('#user-name').textContent = user.display_name;
  const roleEl = $('#user-role');
  roleEl.textContent = ROLE_NAME[user.role];
  roleEl.className = 'role-tag' + (user.role === 'admin' ? ' admin' : '');
  $('#admin-tools').classList.toggle('hidden', user.role !== 'admin');
  selectedNodeId = selectedEdgeId = null;
  highlight = null;
  loadState();
}

async function boot() {
  try {
    const res = await api('GET', '/api/me');
    user = res.user;
    enterApp();
  } catch {
    showLogin();
  }
}

// ---------- 图查询辅助 ----------
function nodeById(id) {
  return state.nodes.find((n) => n.id === id);
}
function edgeById(id) {
  return state.edges.find((e) => e.id === id);
}
function activePermitForDevice(deviceId) {
  return state.permits.find((p) => p.device_id === deviceId && p.status === 'active');
}

// 物理可达：启用电源出发，挂牌或物理断开的开关不可穿越
function computePower() {
  const adj = G.buildAdj(state.nodes, state.edges).adj;
  const reachable = new Set();
  const fedEdges = new Set();
  const queue = state.nodes
    .filter((n) => n.kind === 'source' && n.enabled === 1)
    .map((n) => n.id);
  queue.forEach((id) => reachable.add(id));
  while (queue.length) {
    const u = queue.shift();
    for (const { edgeId, v } of adj.get(u) || []) {
      const vn = nodeById(v);
      const blocked =
        vn && vn.kind === 'switch' && (vn.tagged === 1 || vn.switch_open === 1);
      if (!blocked && !reachable.has(v)) {
        reachable.add(v);
        queue.push(v);
      }
      if (reachable.has(u) && !blocked) fedEdges.add(edgeId);
    }
  }
  return { reachable, fedEdges };
}

// ---------- 渲染 ----------
function renderAll() {
  renderEdges();
  renderNodes();
  renderInspector();
  renderPermits();
  renderPaths();
}

const svg = $('#grid');
const edgeLayer = $('#edge-layer');
const nodeLayer = $('#node-layer');

function rectIntersection(cx, cy, tx, ty) {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = NODE_W / 2 + 4;
  const hh = NODE_H / 2 + 4;
  const scale = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return [cx + dx * scale, cy + dy * scale];
}

function renderEdges() {
  const { fedEdges } = computePower();
  edgeLayer.innerHTML = '';
  state.edges.forEach((e) => {
    const u = nodeById(e.u);
    const v = nodeById(e.v);
    if (!u || !v) return;
    const [x1, y1] = rectIntersection(u.x, u.y, v.x, v.y);
    const [x2, y2] = rectIntersection(v.x, v.y, u.x, u.y);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.dataset.edgeId = e.id;

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('class', 'edge-hit');
    hit.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
    g.appendChild(hit);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let cls = 'edge-line';
    if (highlight && highlight.edgeIds.has(e.id)) cls += ' fail';
    else if (fedEdges.has(e.id)) cls += ' fed';
    if (selectedEdgeId === e.id) cls += ' selected';
    line.setAttribute('class', cls);
    line.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
    g.appendChild(line);

    hit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectedEdgeId = e.id;
      selectedNodeId = null;
      renderAll();
    });
    edgeLayer.appendChild(g);
  });
}

function renderNodes() {
  nodeLayer.innerHTML = '';
  state.nodes.forEach((n) => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const classes = ['node-g', n.kind];
    if (n.kind === 'source' && n.enabled === 0) classes.push('off');
    if (n.kind === 'switch') {
      if (n.tagged === 1) classes.push('tagged');
      else if (n.switch_open === 1) classes.push('open');
    }
    if (n.kind === 'device' && activePermitForDevice(n.id)) classes.push('permitted');
    if (selectedNodeId === n.id) classes.push('selected');
    if (connectFromId === n.id) classes.push('selected');
    g.setAttribute('class', classes.join(' '));
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    g.dataset.nodeId = n.id;

    const body = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    body.setAttribute('class', 'node-body');
    body.setAttribute('x', -NODE_W / 2);
    body.setAttribute('y', -NODE_H / 2);
    body.setAttribute('width', NODE_W);
    body.setAttribute('height', NODE_H);
    body.setAttribute('rx', n.kind === 'switch' ? 8 : 10);
    g.appendChild(body);

    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    glyph.setAttribute('class', 'node-sub');
    glyph.setAttribute('y', -7);
    glyph.textContent =
      n.kind === 'source' ? (n.enabled ? '⚡ 启用电源' : '停用电源')
      : n.kind === 'switch' ? (n.tagged ? '🔒 已挂牌' : n.switch_open ? '断开' : '合闸')
      : activePermitForDevice(n.id) ? '🛠 检修中' : '设备';
    g.appendChild(glyph);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('class', 'node-label');
    label.setAttribute('y', 12);
    label.textContent = n.name.length > 9 ? n.name.slice(0, 9) + '…' : n.name;
    g.appendChild(label);

    attachNodeEvents(g, n);
    nodeLayer.appendChild(g);
  });
}

// ---------- 节点拖拽 / 点击 / 连线 ----------
function svgPoint(ev) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

function attachNodeEvents(g, n) {
  g.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const start = svgPoint(ev);
    let moved = false;
    dragging = { node: n, dx: start.x - n.x, dy: start.y - n.y, moved: false };
    g.classList.add('dragging');
    g.setPointerCapture(ev.pointerId);

    const onMove = (mv) => {
      const p = svgPoint(mv);
      if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 4) moved = true;
      if (!moved) return;
      dragging.moved = true;
      n.x = Math.max(20, p.x - dragging.dx);
      n.y = Math.max(20, p.y - dragging.dy);
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      renderEdges();
    };
    const onUp = () => {
      g.classList.remove('dragging');
      g.removeEventListener('pointermove', onMove);
      g.removeEventListener('pointerup', onUp);
      const wasDrag = dragging && dragging.moved;
      dragging = null;
      if (wasDrag) {
        api('PUT', `/api/nodes/${n.id}/position`, { x: n.x, y: n.y }).catch(() => {});
      } else {
        onNodeClicked(n);
      }
    };
    g.addEventListener('pointermove', onMove);
    g.addEventListener('pointerup', onUp);
  });
}

function onNodeClicked(n) {
  highlight = null;
  if (connectMode) {
    if (connectFromId === null) {
      connectFromId = n.id;
      toast(`已选择起点「${n.name}」，请点击目标节点（电力流向：起点 → 目标）`, 'ok');
      renderNodes();
    } else if (connectFromId === n.id) {
      connectFromId = null;
      renderNodes();
    } else {
      const u = connectFromId;
      connectMode = false;
      connectFromId = null;
      updateConnectButton();
      run('addEdge', { u, v: n.id });
    }
    return;
  }
  selectedNodeId = n.id;
  selectedEdgeId = null;
  renderAll();
}

svg.addEventListener('click', (ev) => {
  if (ev.target === svg || ev.target.id === 'edge-layer' || ev.target.id === 'node-layer') {
    selectedNodeId = null;
    selectedEdgeId = null;
    if (connectMode) {
      connectMode = false;
      connectFromId = null;
      updateConnectButton();
    }
    highlight = null;
    renderAll();
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && connectMode) {
    connectMode = false;
    connectFromId = null;
    updateConnectButton();
    renderNodes();
  }
});

// ---------- 侧栏：节点详情 ----------
function actionBtn(label, action, data, opts) {
  opts = opts || {};
  const b = document.createElement('button');
  b.className = 'btn small ' + (opts.cls || '');
  b.textContent = label;
  b.disabled = !!opts.disabled;
  b.addEventListener('click', () => run(action, data));
  return b;
}

function row(label, valueHtml) {
  return `<div class="panel-row"><span class="muted">${label}</span><span>${valueHtml}</span></div>`;
}

function renderInspector() {
  const body = $('#inspector-body');
  body.classList.remove('muted');

  if (selectedEdgeId !== null) {
    const e = edgeById(selectedEdgeId);
    if (e) {
      const u = nodeById(e.u);
      const v = nodeById(e.v);
      body.innerHTML =
        `<div style="font-weight:600;margin-bottom:6px">供电线路 #${e.id}</div>` +
        row('电力流向', `🔌 ${escapeHtml(u.name)} → ${escapeHtml(v.name)}`);
      const acts = document.createElement('div');
      acts.className = 'panel-actions';
      if (user.role === 'admin') {
        acts.appendChild(deleteEdgeButton(e.id, `${u.name} → ${v.name}`));
      }
      body.appendChild(acts);
      return;
    }
  }

  const n = selectedNodeId !== null ? nodeById(selectedNodeId) : null;
  if (!n) {
    body.classList.add('muted');
    body.textContent = connectMode
      ? '连线模式：先点击起点节点，再点击目标节点；按 Esc 或点空白处取消。'
      : '点击图中的节点查看详情与操作。';
    return;
  }

  body.innerHTML = '';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:4px';
  title.textContent = n.name;
  body.appendChild(title);
  body.insertAdjacentHTML(
    'beforeend',
    row('编号', '#' + n.id) +
      row('类型', { source: '电源', switch: '开关', device: '设备' }[n.kind])
  );

  const acts = document.createElement('div');
  acts.className = 'panel-actions';

  if (n.kind === 'source') {
    body.insertAdjacentHTML(
      'beforeend',
      row('状态', n.enabled === 1
        ? '<span class="status-chip chip-ok">启用</span>'
        : '<span class="status-chip chip-muted">停用</span>')
    );
    if (user.role === 'admin') {
      acts.appendChild(
        n.enabled === 1
          ? actionBtn('停用电源', 'disableSource', { nodeId: n.id }, { cls: 'warn' })
          : actionBtn('启用电源', 'enableSource', { nodeId: n.id }, { cls: 'ok' })
      );
    }
  }

  if (n.kind === 'switch') {
    const open = n.switch_open === 1;
    const tagged = n.tagged === 1;
    body.insertAdjacentHTML(
      'beforeend',
      row('物理状态', open
        ? '<span class="status-chip chip-warn">已断开</span>'
        : '<span class="status-chip chip-ok">合闸中</span>') +
      row('挂牌状态', tagged
        ? '<span class="status-chip chip-warn">🔒 已挂牌上锁</span>'
        : '<span class="status-chip chip-muted">未挂牌</span>')
    );
    if (tagged) {
      body.insertAdjacentHTML(
        'beforeend',
        '<div class="audit-fail-msg">挂牌开关不得合闸。如需恢复供电，请先结束相关检修许可、解牌后再合闸。</div>'
      );
    }
    // 断开
    acts.appendChild(
      open
        ? disabledBtn('已断开')
        : actionBtn('断开开关', 'switchOpen', { nodeId: n.id }, { cls: 'warn' })
    );
    // 合闸：挂牌时禁止
    acts.appendChild(
      open && !tagged
        ? actionBtn('合闸', 'switchClose', { nodeId: n.id }, { cls: 'ok' })
        : !open
          ? disabledBtn('已合闸')
          : disabledBtn('挂牌禁合闸')
    );
    // 挂牌 / 解牌：挂牌前必须先断开
    acts.appendChild(
      tagged
        ? actionBtn('解除挂牌', 'untag', { nodeId: n.id }, { cls: 'warn' })
        : actionBtn('挂牌上锁', 'tag', { nodeId: n.id }, { cls: 'danger', disabled: !open })
    );
  }

  if (n.kind === 'device') {
    const permit = activePermitForDevice(n.id);
    const uncut = G.findUncutPaths(state.nodes, state.edges, n.id);
    const powered = G.isPowered(state.nodes, state.edges, n.id);
    body.insertAdjacentHTML(
      'beforeend',
      row('物理带电', powered
        ? '<span class="status-chip chip-danger">带电</span>'
        : '<span class="status-chip chip-ok">无电</span>') +
      row('隔离判定', uncut.length === 0
        ? '<span class="status-chip chip-ok">已隔离</span>'
        : `<span class="status-chip chip-danger">未隔离（${uncut.length} 条路径）</span>`)
    );
    if (permit) {
      body.insertAdjacentHTML(
        'beforeend',
        `<div class="permit-item active" style="margin-top:8px">
           <b>🛠 有效检修许可 #${permit.id}</b><br/>
           生效修订号：${permit.revision}<br/>
           签发：${escapeHtml(permit.created_by_name || '')} · ${fmtTime(permit.created_at)}
         </div>`
      );
      acts.appendChild(actionBtn('结束检修许可', 'endPermit', { nodeId: n.id }, { cls: 'warn' }));
    } else {
      acts.appendChild(
        actionBtn('申请检修许可', 'applyPermit', { nodeId: n.id }, { cls: 'primary' })
      );
    }
  }

  if (user.role === 'admin') {
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn small';
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', async () => {
      const name = prompt('新名称：', n.name);
      if (name && name.trim()) await run('renameNode', { nodeId: n.id, name: name.trim() });
    });
    acts.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger';
    delBtn.textContent = '删除节点';
    delBtn.addEventListener('click', async () => {
      if (confirm(`确认删除节点「${n.name}」？相关供电线路将一并删除。`)) {
        await run('deleteNode', { nodeId: n.id });
      }
    });
    acts.appendChild(delBtn);
  }

  if (acts.children.length) body.appendChild(acts);
}

function disabledBtn(text) {
  const b = document.createElement('button');
  b.className = 'btn small';
  b.textContent = text;
  b.disabled = true;
  return b;
}

function deleteEdgeButton(edgeId, label) {
  const b = document.createElement('button');
  b.className = 'btn small danger';
  b.textContent = '删除该线路';
  b.addEventListener('click', async () => {
    if (confirm(`确认删除供电线路（${label}）？`)) await run('deleteEdge', { edgeId });
  });
  return b;
}

// ---------- 侧栏：许可 / 路径 ----------
function renderPermits() {
  const body = $('#permits-body');
  const active = state.permits.filter((p) => p.status === 'active');
  const ended = state.permits.filter((p) => p.status === 'ended').slice(-5).reverse();
  if (!active.length && !ended.length) {
    body.innerHTML = '<div class="muted">当前没有检修许可记录。</div>';
    return;
  }
  body.innerHTML = '';
  active.forEach((p) => {
    const d = nodeById(p.device_id);
    const div = document.createElement('div');
    div.className = 'permit-item active';
    div.innerHTML =
      `🛠 <b>许可 #${p.id}</b> · ${escapeHtml(d ? d.name : '#' + p.device_id)}<br/>` +
      `修订号 ${p.revision} · ${escapeHtml(p.created_by_name || '')} · ${fmtTime(p.created_at)}`;
    body.appendChild(div);
  });
  ended.forEach((p) => {
    const d = nodeById(p.device_id);
    const div = document.createElement('div');
    div.className = 'permit-item ended';
    div.innerHTML =
      `✓ #${p.id} · ${escapeHtml(d ? d.name : '#' + p.device_id)} · ` +
      `结束于 ${fmtTime(p.ended_at)}（${escapeHtml(p.ended_by_name || '')}）`;
    body.appendChild(div);
  });
}

function renderPaths() {
  const body = $('#paths-body');
  const n = selectedNodeId !== null ? nodeById(selectedNodeId) : null;
  if (!n || n.kind !== 'device') {
    body.className = 'muted';
    body.innerHTML = '选择设备后，在此查看启用电源到设备的路径分析。';
    return;
  }
  body.className = '';
  const paths = G.findUncutPaths(state.nodes, state.edges, n.id);
  if (paths.length === 0) {
    body.innerHTML =
      `<div><span class="status-chip chip-ok">隔离满足</span></div>
       <div class="path-item ok">所有启用电源到「${escapeHtml(n.name)}」的路径均经过已挂牌开关，许可可以生效。</div>`;
  } else {
    body.innerHTML =
      `<div><span class="status-chip chip-danger">未切断路径 ${paths.length} 条</span></div>` +
      paths
        .map((p) => `<div class="path-item">${escapeHtml(G.pathToNames(p.nodes, state.nodes).join(' → '))}</div>`)
        .join('');
  }
}

// ---------- 管理员工具栏 ----------
function updateConnectButton() {
  const btn = $('#btn-connect');
  btn.classList.toggle('warn', connectMode);
  btn.textContent = connectMode ? '🔗 连线中…（Esc 取消）' : '🔗 连线模式';
  svg.classList.toggle('connecting', connectMode);
}

async function addNode(kind) {
  const label = { source: '电源', switch: '开关', device: '设备' }[kind];
  const name = prompt(`新${label}名称：`, `${label}-${state.nodes.filter((n) => n.kind === kind).length + 1}`);
  if (!name || !name.trim()) return;
  const x = 200 + Math.random() * 500;
  const y = 120 + Math.random() * 280;
  await run('addNode', { nodeKind: kind, name: name.trim(), x: Math.round(x), y: Math.round(y) });
}
$('#btn-add-source').addEventListener('click', () => addNode('source'));
$('#btn-add-switch').addEventListener('click', () => addNode('switch'));
$('#btn-add-device').addEventListener('click', () => addNode('device'));
$('#btn-connect').addEventListener('click', () => {
  connectMode = !connectMode;
  connectFromId = null;
  updateConnectButton();
  if (connectMode) toast('连线模式：先点击电力流出的起点，再点击流入目标。', 'ok');
});

// ---------- Tab ----------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const audit = t.dataset.tab === 'audit';
    $('#network-pane').classList.toggle('hidden', audit);
    $('#audit-pane').classList.toggle('hidden', !audit);
    if (audit) loadAudit();
  });
});

// ---------- 审计日志 ----------
async function loadAudit() {
  const res = await api('GET', '/api/audit?limit=100');
  $('#audit-count').textContent = res.logs.length;
  const list = $('#audit-list');
  list.innerHTML = '';
  res.logs.forEach((log) => {
    const item = document.createElement('div');
    item.className = 'audit-item';
    const head = document.createElement('div');
    head.className = 'audit-head';
    head.innerHTML = `
      <span class="audit-mark">${log.success ? '✅' : '⛔'}</span>
      <span class="audit-title">${ACTION_LABELS[log.action] || log.action}</span>
      <span class="audit-rev">${log.success ? `r${log.revision} → r${log.new_revision}` : `r${log.revision} 被拒绝`}</span>
      <span class="audit-meta">${escapeHtml(log.actor_name)}（${ROLE_NAME[log.actor_role] || log.actor_role}） · ${fmtTime(log.ts)}</span>`;
    item.appendChild(head);

    const detail = document.createElement('div');
    detail.className = 'audit-detail hidden';
    let detailHtml = '';
    if (log.detail) {
      if (log.detail.message) detailHtml += `<div class="audit-fail-msg">${escapeHtml(log.detail.message)}</div>`;
      detailHtml += `<pre>${escapeHtml(JSON.stringify(log.detail, null, 2))}</pre>`;
    }
    if (log.before_state) detailHtml += `<div class="muted" style="margin:6px 0 2px">变更前（修订号 ${log.before_state.revision}）：</div><pre>${escapeHtml(JSON.stringify(log.before_state, null, 2))}</pre>`;
    if (log.after_state) detailHtml += `<div class="muted" style="margin:6px 0 2px">变更后（修订号 ${log.after_state.revision}）：</div><pre>${escapeHtml(JSON.stringify(log.after_state, null, 2))}</pre>`;
    detail.innerHTML = detailHtml || '<span class="muted">无附加信息</span>';
    item.appendChild(detail);

    head.addEventListener('click', () => detail.classList.toggle('hidden'));
    list.appendChild(item);
  });
}
$('#btn-refresh-audit').addEventListener('click', loadAudit);

// ---------- 工具 ----------
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function toastHtml(html, kind) {
  const t = $('#toast');
  t.innerHTML = html;
  t.className = 'toast ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? 9000 : 3500);
}
function toast(msg, kind) {
  toastHtml(escapeHtml(msg), kind);
}
function hideToast() {
  $('#toast').classList.add('hidden');
}

boot();
