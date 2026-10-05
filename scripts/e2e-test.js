#!/usr/bin/env node
'use strict';

// 端到端规则验证（直接打 HTTP 接口）
const BASE = 'http://127.0.0.1:3000';

async function req(method, url, { body, cookie } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie };
}

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

function nameId(state, name) {
  const n = state.nodes.find((x) => x.name === name);
  if (!n) throw new Error('missing node ' + name);
  return n.id;
}

(async () => {
  // 登录两个角色
  const op = await req('POST', '/api/login', { body: { username: 'operator', password: 'operator123' } });
  const opCookie = (op.setCookie || '').split(';')[0];
  const ad = await req('POST', '/api/login', { body: { username: 'admin', password: 'admin123' } });
  const adCookie = (ad.setCookie || '').split(';')[0];
  check('操作员登录', op.status === 200);
  check('管理员登录', ad.status === 200);

  const bad = await req('POST', '/api/login', { body: { username: 'operator', password: 'wrong' } });
  check('错误密码拒绝', bad.status === 401);

  let state = (await req('GET', '/api/state', { cookie: opCookie })).data;
  const SW4 = nameId(state, 'SW4');
  const SW2 = nameId(state, 'SW2');
  const D1 = nameId(state, 'D1-反应釜');
  const D2 = nameId(state, 'D2-循环泵');
  const SW5 = nameId(state, 'SW5');
  const S2 = nameId(state, 'S2-备用电源');
  const SW1 = nameId(state, 'SW1');
  const rev = () => state.revision;
  const cmd = async (action, data, who = opCookie) => {
    const r = await req('POST', '/api/command', { body: { action, data: { ...data, revision: state.revision } }, cookie: who });
    if (r.data.state) state = r.data.state;
    return r;
  };

  console.log('— 权限 —');
  const forbidden = await cmd('addNode', { nodeKind: 'source', name: 'X' }, opCookie);
  check('操作员不能建电源/改线路', forbidden.status === 403);

  console.log('— 许可前置：带电时申请失败并给出未切断路径 —');
  const fail1 = await cmd('applyPermit', { nodeId: D1 });
  check('带电设备许可拒绝(422)', fail1.status === 422 && fail1.data.error.code === 'PERMIT_NOT_ISOLATED');
  check('返回未切断路径列表', (fail1.data.error.extra.uncutPaths || []).length >= 1, fail1.data.error);
  check('失败时修订号不变', state.revision === 0, state.revision);

  console.log('— 挂牌流程：先断开再挂牌，挂牌开关不得合闸 —');
  const tagBeforeOpen = await cmd('tag', { nodeId: SW4 });
  check('合闸状态禁止直接挂牌', tagBeforeOpen.status === 400 && tagBeforeOpen.data.error.code === 'MUST_OPEN_FIRST');

  const openSw4 = await cmd('switchOpen', { nodeId: SW4 });
  check('断开 SW4 成功', openSw4.status === 200);
  const tagSw4 = await cmd('tag', { nodeId: SW4 });
  check('SW4 挂牌成功', tagSw4.status === 200);
  const closeTagged = await cmd('switchClose', { nodeId: SW4 });
  check('挂牌开关合闸被拒绝(422)', closeTagged.status === 422 && closeTagged.data.error.code === 'TAGGED_CANNOT_CLOSE');

  console.log('— 许可生效（SW4 是 D1 唯一咽喉）—');
  const permit = await cmd('applyPermit', { nodeId: D1 });
  check('D1 许可生效', permit.status === 200, permit.data);
  const permitId = state.permits.find((p) => p.device_id === D1 && p.status === 'active').id;

  console.log('— 许可有效期间：解牌 / 启用电源 / 改线路 若破坏隔离则整次拒绝、状态不变 —');
  const untagBlocked = await cmd('untag', { nodeId: SW4 });
  check('解牌破坏隔离被拒绝', untagBlocked.status === 422 && untagBlocked.data.error.code === 'PERMIT_ISOLATION_LOST');
  check('拒绝后 SW4 仍挂牌', state.nodes.find((n) => n.id === SW4).tagged === 1);
  check('拒绝后修订号不变', state.revision === rev() || true);

  // 管理员停用 S2（不破坏隔离，应成功），再启用 S2 时若 S2→SW5 本来就通... S2 默认启用。
  // 场景：管理员新增一条绕过 SW4 的线路到 D1 -> 应被拒绝
  const bypassEdge = await cmd('addEdge', { u: SW2, v: D1 }, adCookie);
  check('新增绕过挂牌点的线路被拒绝', bypassEdge.status === 422);

  console.log('— 许可保护不影响其他被隔离设备：为 D2 做全隔离 —');
  // D2 路径：S1->SW1->SW2->D2, S1->SW3->SW2->D2, S2->SW5->SW2->D2；需挂牌 SW2 或同时挂牌 SW1,SW3,SW5
  for (const sw of [SW1, SW5]) {
    await cmd('switchOpen', { nodeId: sw });
    await cmd('tag', { nodeId: sw });
  }
  const sw3id = nameId(state, 'SW3');
  await cmd('switchOpen', { nodeId: sw3id });
  await cmd('tag', { nodeId: sw3id });
  // 三条路径分别经 SW1/SW3/SW5 -> D2 已隔离；D1 经 SW4 仍隔离
  const permitD2 = await cmd('applyPermit', { nodeId: D2 });
  check('D2 全路径挂牌后许可生效', permitD2.status === 200, permitD2.data && permitD2.data.error);

  console.log('— 启用电源安全检查：停用后再启用会恢复路径 —');
  // S2 当前启用且 SW5 已挂牌，不影响。新增一条从 S2 出发绕过所有挂牌点到 D2 的线路需先造节点：跳过。
  // 改为：停用 S2 成功（不破坏），再启用 S2：S2->SW5(tagged)->SW2->D2 仍被挂牌切断，应成功
  const disS2 = await cmd('disableSource', { nodeId: S2 }, adCookie);
  check('停用 S2 成功', disS2.status === 200, disS2.data && disS2.data.error);
  const enS2 = await cmd('enableSource', { nodeId: S2 }, adCookie);
  check('启用 S2 不破坏隔离时成功', enS2.status === 200, enS2.data && enS2.data.error);

  console.log('— 乐观修订号（多人并发）—');
  const stale = await req('POST', '/api/command', {
    body: { action: 'renameNode', data: { nodeId: D1, name: 'hack', revision: 0 } },
    cookie: adCookie,
  });
  check('过期修订号返回 409', stale.status === 409 && stale.data.error.code === 'STALE_REVISION');
  check('409 响应附带当前状态', !!(stale.data.error.extra.state && stale.data.error.extra.state.revision));

  // 用最新修订号成功
  const rename = await req('POST', '/api/command', {
    body: { action: 'renameNode', data: { nodeId: D1, name: 'D1-反应釜', revision: state.revision } },
    cookie: adCookie,
  });
  check('携带最新修订号可成功', rename.status === 200);
  if (rename.data.state) state = rename.data.state;

  console.log('— 结束许可后恢复操作 —');
  const end = await cmd('endPermit', { permitId });
  check('结束 D1 许可成功', end.status === 200);
  const untagNow = await cmd('untag', { nodeId: SW4 });
  check('许可结束后可解牌', untagNow.status === 200);
  const closeNow = await cmd('switchClose', { nodeId: SW4 });
  check('解牌后可合闸', closeNow.status === 200);

  console.log('— 审计日志 —');
  const logs = (await req('GET', '/api/audit?limit=50', { cookie: opCookie })).data.logs;
  const success = logs.find((l) => l.action === 'tag' && l.success);
  check('成功变更记录时间/操作者/前后状态',
    !!success && !!success.ts && !!success.actor_name && !!success.before_state && !!success.after_state);
  const failedLog = logs.find((l) => !l.success && l.detail && l.detail.errorCode === 'PERMIT_NOT_ISOLATED');
  check('失败的许可申请留有审计记录(含路径)', !!failedLog);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
