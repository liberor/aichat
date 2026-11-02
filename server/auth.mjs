import crypto from 'node:crypto';
import { config } from './config.mjs';
import { noteAuthFailure, clearAuthFailures, authRetryAfter } from './ratelimit.mjs';

/**
 * 会话：token -> { tenant, exp, keys }
 * keys 里存用户自带的 provider key（只存在服务端内存，浏览器拿不到原文）。
 */
const sessions = new Map();
const TTL = 7 * 24 * 60 * 60 * 1000;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      // 畸形百分号编码不能让鉴权中间件抛 500
      out[key] = raw;
    }
  }
  return out;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

export function tenantFor(code) {
  if (!config.accessCodes.length) return 'public';
  return crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16);
}

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', maxAge: TTL, path: '/' };
}

function createSession(res, tenant = 'public') {
  const token = crypto.randomBytes(24).toString('hex');
  const session = { tenant, exp: Date.now() + TTL, keys: {} };
  sessions.set(token, session);
  res.cookie('access_token', token, cookieOptions());
  return session;
}

export function getSession(req) {
  const token = parseCookies(req.headers.cookie).access_token;
  const session = token ? sessions.get(token) : null;
  if (!session || session.exp < Date.now()) return null;
  return session;
}

/** 没有会话就建一个（用于无访问码时保存 BYOK key） */
export function ensureSession(req, res, tenant = 'public') {
  return getSession(req) || createSession(res, tenant);
}

export async function login(req, res) {
  if (!config.accessCodes.length) return res.json({ ok: true, authRequired: false });

  const code = String(req.body?.code || '').trim();
  const ip = req.authIp || req.ip || req.socket.remoteAddress || 'unknown';
  const matched = code && config.accessCodes.find((c) => safeEqual(code, c));

  if (!matched) {
    const bucket = noteAuthFailure(ip);

    // 第 authMaxFails 次失败当场锁定，后续请求由 authLimit 直接 429
    if (bucket.blockedUntil > Date.now()) {
      const secs = Math.ceil((bucket.blockedUntil - Date.now()) / 1000);
      res.set('Retry-After', String(secs));
      return res.status(429).json({
        error: `访问码错误次数过多，请在 ${Math.ceil(secs / 60)} 分钟后重试`,
        code: 'auth_limited',
      });
    }

    // 固定延迟，把在线试错的速度压到 ~5 次/秒/IP
    await new Promise((r) => setTimeout(r, 200));
    return res.status(401).json({ error: '访问码不正确', code: 'bad_code' });
  }

  clearAuthFailures(ip);

  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.exp < now) sessions.delete(token);
  }

  createSession(res, tenantFor(matched));
  res.json({ ok: true, authRequired: true });
}

export function logout(req, res) {
  // 真正注销服务端 session，旧 cookie 不能继续用
  const token = parseCookies(req.headers.cookie).access_token;
  if (token) sessions.delete(token);
  res.clearCookie('access_token', { path: '/' });
  res.json({ ok: true });
}

function limited(res, secs) {
  res.set('Retry-After', String(secs));
  return res.status(429).json({
    error: `访问码尝试次数过多，请在 ${Math.ceil(secs / 60)} 分钟后重试`,
    code: 'auth_limited',
  });
}

export function requireAccess(req, res, next) {
  const session = getSession(req);
  req.session = session || null;

  if (!config.accessCodes.length) {
    req.tenant = 'public';
    return next();
  }

  if (session) {
    req.tenant = session.tenant;
    return next();
  }

  const header = req.headers['x-access-code'];

  // 没带头的普通未登录请求不计失败，否则 cookie 过期会把正常用户锁死
  if (!header) {
    return res.status(401).json({ error: '需要访问码', code: 'unauthorized' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  // 和 /api/auth 共用失败计数：header 方式不能绕过锁定
  const lockedFor = authRetryAfter(ip);
  if (lockedFor) return limited(res, lockedFor);

  const matched = config.accessCodes.find((c) => safeEqual(header, c));
  if (matched) {
    clearAuthFailures(ip);
    req.tenant = tenantFor(matched);
    return next();
  }

  const bucket = noteAuthFailure(ip);
  const left = bucket.blockedUntil - Date.now();
  if (left > 0) return limited(res, Math.ceil(left / 1000));

  return res.status(401).json({ error: '访问码不正确', code: 'bad_code' });
}
