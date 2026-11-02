import { config } from './config.mjs';

/** 每 IP 每小时 + 全局每日，两层都放内存里（单机够用） */
const hits = new Map();
const HOUR = 60 * 60 * 1000;
let dayKey = '';
let dayCount = 0;

export function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  // 顺手清理过期桶，避免长期运行时内存一直涨
  if (hits.size > 1000) {
    for (const [key, v] of hits) {
      if (v.reset < now) hits.delete(key);
    }
  }

  let bucket = hits.get(ip);
  if (!bucket || bucket.reset < now) {
    bucket = { count: 0, reset: now + HOUR };
    hits.set(ip, bucket);
  }
  bucket.count += 1;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  dayCount += 1;

  if (bucket.count > config.rateLimitPerHour) {
    const mins = Math.ceil((bucket.reset - now) / 60000);
    return res.status(429).json({
      error: `请求过于频繁：每小时最多 ${config.rateLimitPerHour} 次，请 ${mins} 分钟后再试`,
      code: 'rate_limited',
    });
  }

  if (dayCount > config.dailyLimit) {
    return res.status(429).json({
      error: `今日全站额度已用完（${config.dailyLimit} 次），明天再来`,
      code: 'daily_limit',
    });
  }

  next();
}

/* ---------------- 访问码暴力试错 ---------------- */

/**
 * 登录失败单独计数，不占用聊天/上传的配额。
 * 同一 IP 连续失败 authMaxFails 次后锁定 authLockMinutes 分钟，登录成功清零。
 * 状态只放内存，重启即失效——单机部署够用。
 */
const authFails = new Map(); // ip -> { count, reset, blockedUntil }

export function authLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  // 供 login 记录失败/成功，避免它再算一遍 IP
  req.authIp = ip;

  if (authFails.size > 1000) {
    for (const [key, v] of authFails) {
      if (v.reset < now) authFails.delete(key);
    }
  }

  const bucket = authFails.get(ip);
  if (bucket?.blockedUntil > now) {
    const secs = Math.ceil((bucket.blockedUntil - now) / 1000);
    res.set('Retry-After', String(secs));
    return res.status(429).json({
      error: `访问码尝试次数过多，请在 ${Math.ceil(secs / 60)} 分钟后重试`,
      code: 'auth_limited',
    });
  }

  next();
}

/**
 * 当前 IP 是否处于访问码锁定中，返回剩余秒数（0 = 未锁定）。
 * X-Access-Code 头和 /api/auth 共用同一张失败表，任何一个入口试错都会锁同一 IP。
 */
export function authRetryAfter(ip) {
  const now = Date.now();

  if (authFails.size > 1000) {
    for (const [key, v] of authFails) {
      if (v.reset < now) authFails.delete(key);
    }
  }

  const bucket = authFails.get(ip);
  if (!bucket?.blockedUntil || bucket.blockedUntil <= now) return 0;
  return Math.ceil((bucket.blockedUntil - now) / 1000);
}

export function noteAuthFailure(ip) {
  const now = Date.now();
  const windowMs = config.authLockMinutes * 60 * 1000;

  let bucket = authFails.get(ip);
  if (!bucket || bucket.reset < now) {
    bucket = { count: 0, reset: now + windowMs, blockedUntil: 0 };
  }

  bucket.count += 1;
  if (bucket.count >= config.authMaxFails) {
    bucket.blockedUntil = now + windowMs;
    bucket.reset = bucket.blockedUntil;
  }

  authFails.set(ip, bucket);
  return bucket;
}

export function clearAuthFailures(ip) {
  authFails.delete(ip);
}
