'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { db, verifyPassword, loadState } = require('./db');
const { execute, HttpError } = require('./commands');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.scryptSync(crypto.randomBytes(16).toString('hex'), 'loto', 32).toString('hex');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

// ---------- 会话（签名 Cookie，无状态） ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function sign(payloadB64) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
}
function createToken(user) {
  const payload = b64url(
    JSON.stringify({ uid: user.id, exp: Date.now() + SESSION_TTL_MS })
  );
  return `${payload}.${sign(payload)}`;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  });
  return out;
}
function currentUser(req) {
  const token = parseCookies(req)['loto_session'];
  if (!token) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || sig !== sign(payloadB64)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
  req.user = user;
  next();
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'loto_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

// ---------- 认证接口 ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: { code: 'BAD_INPUT', message: '请输入账号和密码' } });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
  if (!user || !verifyPassword(String(password), user.salt, user.password_hash)) {
    return res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: '账号或密码错误' } });
  }
  const token = createToken(user);
  res.setHeader(
    'Set-Cookie',
    `loto_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`
  );
  res.json({
    user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name },
  });
});

app.post('/api/logout', (req, res) => {
  clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------- 网络状态 ----------
app.get('/api/state', requireAuth, (req, res) => {
  res.json(loadState());
});

// 画布坐标仅为界面展示属性，不改变网络拓扑，不占用修订号、不写审计
app.put('/api/nodes/:id/position', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const x = Number(req.body && req.body.x);
  const y = Number(req.body && req.body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: { code: 'BAD_POSITION', message: '坐标无效' } });
  }
  const info = db.prepare('UPDATE nodes SET x = ?, y = ? WHERE id = ?').run(x, y, id);
  if (info.changes === 0) return res.status(404).json({ error: { code: 'NODE_NOT_FOUND', message: '节点不存在' } });
  res.json({ ok: true });
});

// ---------- 变更命令 ----------
app.post('/api/command', requireAuth, (req, res) => {
  const action = req.body && req.body.action;
  const data = (req.body && req.body.data) || {};
  try {
    const result = execute(action, data, req.user);
    res.json({ ok: true, output: result.output, state: result.state });
  } catch (err) {
    if (err instanceof HttpError) {
      return res
        .status(err.status)
        .json({ error: { code: err.code, message: err.message, extra: err.extra } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  }
});

// ---------- 审计日志 ----------
app.get('/api/audit', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const rows = db
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({
      ...r,
      success: !!r.success,
      detail: r.detail ? JSON.parse(r.detail) : null,
      before_state: r.before_state ? JSON.parse(r.before_state) : null,
      after_state: r.after_state ? JSON.parse(r.after_state) : null,
    }));
  res.json({ logs: rows });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// 兜底返回首页（避免静态资源 404 影响直接访问）
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`[loto-drill] 服务已启动: http://${HOST}:${PORT}`);
});
