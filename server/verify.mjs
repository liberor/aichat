/**
 * 校验 provider 的 API key（OpenAI 兼容的 GET /models）。
 *
 * 返回 kind：
 * - ok          200，key 有效
 * - invalid     401/403、空 key、含非法字符 → 明确不可用，拒绝保存
 * - unsupported 404/405，网关没有 /models → 无法确认，拒绝保存
 * - unverified  429/5xx 等其他状态 → 无法确认，拒绝保存
 * - unreachable 超时 / 网络错误 → 无法确认，拒绝保存
 *
 * 只有 ok 才能入库：避免“随便填一个 key 也显示已就绪”。
 */
const TIMEOUT_MS = 8000;
/** 可打印 ASCII，不含空格：HTTP header 和绝大多数厂商的 key 都符合 */
const KEY_RE = /^[\x21-\x7e]+$/;

function errorText(body) {
  try {
    const json = JSON.parse(body);
    return String(json?.error?.message || json?.message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}

export async function verifyKey(provider, apiKey) {
  if (!provider?.baseUrl) {
    return { ok: false, verified: false, kind: 'unsupported', status: 0, reason: '未配置 baseUrl' };
  }
  if (!apiKey) {
    return { ok: false, verified: true, kind: 'invalid', status: 0, reason: 'key 为空' };
  }
  if (!KEY_RE.test(apiKey)) {
    return { ok: false, verified: true, kind: 'malformed', status: 0, reason: 'key 含空格、中文或控制字符' };
  }

  try {
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      // 不让一个慢网关把保存按钮卡住
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.ok) return { ok: true, verified: true, kind: 'ok', status: res.status, reason: '' };

    const body = await res.text().catch(() => '');
    // 厂商一般会打码，但少数网关会回显 key，返回前统一抹掉
    const detail = (errorText(body) || `HTTP ${res.status}`).replaceAll(apiKey, '***');

    if (res.status === 401 || res.status === 403) {
      return { ok: false, verified: true, kind: 'invalid', status: res.status, reason: detail };
    }
    if (res.status === 404 || res.status === 405) {
      return { ok: false, verified: false, kind: 'unsupported', status: res.status, reason: detail };
    }
    return {
      ok: false,
      verified: false,
      kind: 'unverified',
      status: res.status,
      reason: `HTTP ${res.status} ${detail}`,
    };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      verified: false,
      kind: 'unreachable',
      status: 0,
      reason: timeout ? '请求超时' : `网络错误：${err?.message || 'unknown'}`,
    };
  }
}
