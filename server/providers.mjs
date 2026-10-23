import fs from 'node:fs';
import 'dotenv/config';

/**
 * 多 provider 支持。
 * 优先级：PROVIDERS_JSON 环境变量 > providers.json 文件 > LLM_* 单家配置
 *
 * providers.json 格式：
 * [
 *   { "id": "deepseek", "baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-...", "models": ["deepseek-chat"] },
 *   { "id": "openai",   "baseUrl": "https://api.openai.com/v1",   "apiKey": "sk-...", "models": ["gpt-4o-mini"] }
 * ]
 */

function fromEnv() {
  return [
    {
      id: process.env.PROVIDER_ID || 'default',
      baseUrl: process.env.LLM_BASE_URL || '',
      apiKey: process.env.LLM_API_KEY || '',
      models: (process.env.LLM_MODELS || 'deepseek-flash')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
  ];
}

function readConfig() {
  if (process.env.PROVIDERS_JSON) {
    try {
      return JSON.parse(process.env.PROVIDERS_JSON);
    } catch (err) {
      console.warn('[providers] bad PROVIDERS_JSON:', err.message);
    }
  }
  const file = process.env.PROVIDERS_FILE || 'providers.json';
  if (fs.existsSync(file)) {
    try {
      // 去掉可能的 BOM，否则 JSON.parse 会失败
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[providers] failed to parse ${file}:`, err.message);
    }
  }
  return null;
}

function resolveKey(value) {
  if (typeof value !== 'string' || !value) return '';
  // 支持 "env:OPENAI_API_KEY"，避免把密钥写进 providers.json
  if (value.startsWith('env:')) return process.env[value.slice(4)] || '';
  return value;
}

function normalize(list) {
  return list
    .map((p) => ({
      id: String(p.id || 'default')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-'),
      baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
      apiKey: resolveKey(p.apiKey),
      models: (p.models || []).map(String).filter(Boolean),
    }))
    .filter((p) => p.baseUrl && p.models.length);
}

const raw = readConfig();
export const providers = normalize(Array.isArray(raw) && raw.length ? raw : fromEnv());

// 一个 provider 都没配时仍然允许 Mock 演示，避免 resolveModel 直接崩
if (!providers.length) {
  providers.push({
    id: 'mock',
    baseUrl: 'http://mock.local/v1',
    apiKey: '',
    models: ['mock'],
  });
  console.warn('[providers] no provider configured, using mock provider');
}

export const hasAnyKey = providers.some((p) => p.apiKey);

/** 给前端用的扁平模型列表：多 provider 时用 provider/model 区分 */
export function modelIds() {
  return providers.flatMap((p) => p.models.map((m) => (p.id === 'default' ? m : `${p.id}/${m}`)));
}

/**
 * 把 "openai/gpt-4o-mini" 解析成 { provider, model }
 * 注意：只按第一个 / 切，兼容 openrouter 这种 "openrouter/anthropic/claude" 的写法。
 */
export function resolveModel(id) {
  if (id) {
    const slash = id.indexOf('/');
    if (slash > 0) {
      const pid = id.slice(0, slash);
      const p = providers.find((x) => x.id === pid);
      if (p) return { provider: p, model: id.slice(slash + 1) };
    }
    for (const p of providers) {
      if (p.models.includes(id)) return { provider: p, model: id };
    }
  }
  const p = providers[0];
  return { provider: p, model: p.models[0] };
}
