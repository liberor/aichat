import 'dotenv/config';
import { providers, hasAnyKey, modelIds } from './providers.mjs';

const env = process.env;

/**
 * Express trust proxy：
 * - 默认 false：不信任 X-Forwarded-For，直连客户端无法伪造 req.ip
 * - loopback：信任同机反代（nginx 在本机）
 * - 数字（如 1）：信任前面 N 跳反代
 * - true：信任所有（危险，仅内网/调试）
 */
function parseTrustProxy(raw) {
  const value = String(raw || '').trim();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/** "a, b ,c" → ['a','b','c'] */
function csv(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const videoDefaultModel = env.VIDEO_MODEL || 'wanx2.1-t2v-turbo';
const videoModels = [...new Set([videoDefaultModel, ...csv(env.VIDEO_MODELS || 'wanx2.1-t2v-turbo,wanx2.1-t2v-plus')])];

const imageDefaultModel = env.IMAGE_MODEL || 'wanx2.1-t2i-turbo';
const imageModels = [...new Set([imageDefaultModel, ...csv(env.IMAGE_MODELS || 'wanx2.1-t2i-turbo,wanx-v1')])];

export const config = {
  port: Number(env.PORT || 8787),
  host: env.HOST || '0.0.0.0',
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  dataDir: env.DATA_DIR || 'data',
  providers,
  hasAnyKey,
  // 强制 mock（真正的降级判断在 chat 路由里，会结合用户自带的 key）
  forceMock: env.MOCK === '1',
  embedding: {
    baseUrl: (env.EMBEDDING_BASE_URL || '').replace(/\/+$/, ''),
    apiKey:
      env.EMBEDDING_API_KEY ||
      ((env.EMBEDDING_BASE_URL || '').includes('dashscope') ? env.DASHSCOPE_API_KEY : '') ||
      '',
    model: env.EMBEDDING_MODEL || 'text-embedding-3-small',
  },
  rerank: {
    baseUrl: (
      env.RERANK_BASE_URL ||
      (env.EMBEDDING_BASE_URL || '').replace(/\/compatible-mode\/v1\/?$/, '')
    ).replace(/\/+$/, ''),
    apiKey:
      env.RERANK_API_KEY ||
      env.EMBEDDING_API_KEY ||
      ((env.RERANK_BASE_URL || env.EMBEDDING_BASE_URL || '').includes('dashscope') ? env.DASHSCOPE_API_KEY : '') ||
      '',
    model: env.RERANK_MODEL || 'gte-rerank-v2',
  },
  ocr: {
    baseUrl: (env.OCR_BASE_URL || env.EMBEDDING_BASE_URL || '').replace(/\/+$/, ''),
    apiKey:
      env.OCR_API_KEY ||
      ((env.OCR_BASE_URL || env.EMBEDDING_BASE_URL || '').includes('dashscope')
        ? env.DASHSCOPE_API_KEY
        : '') ||
      '',
    model: env.OCR_MODEL || 'qwen-vl-ocr',
  },
  /**
   * 文生视频（阿里云百炼 · 万相）。
   * 和聊天接口不是同一套协议：异步任务（提交 → task_id → 轮询）。
   * 默认选最便宜的 480P 5 秒规格，避免误用高价档位。
   */
  video: {
    baseUrl: (env.VIDEO_BASE_URL || 'https://dashscope.aliyuncs.com').replace(/\/+$/, ''),
    apiKey: env.VIDEO_API_KEY || env.DASHSCOPE_API_KEY || '',
    model: videoDefaultModel,
    models: videoModels,
    size: env.VIDEO_SIZE || '832*480',
    // 0 = 不传 duration，交给模型默认值（部分模型固定 5 秒且不接受该参数）
    duration: Number(env.VIDEO_DURATION) || 0,
    promptExtend: env.VIDEO_PROMPT_EXTEND === '1',
    watermark: env.VIDEO_WATERMARK === '1',
    // 单次工具调用里最多等多久；超时就返回 task_id，让模型稍后用 check_video 查
    pollSeconds: Math.min(300, Math.max(10, Number(env.VIDEO_POLL_SECONDS) || 120)),
  },
  /** 文生图（万相），同样走异步任务 */
  image: {
    baseUrl: (env.IMAGE_BASE_URL || 'https://dashscope.aliyuncs.com').replace(/\/+$/, ''),
    apiKey: env.IMAGE_API_KEY || env.DASHSCOPE_API_KEY || '',
    model: imageDefaultModel,
    models: imageModels,
    size: env.IMAGE_SIZE || '1024*1024',
    n: Math.min(4, Math.max(1, Number(env.IMAGE_N) || 1)),
    pollSeconds: Math.min(180, Math.max(10, Number(env.IMAGE_POLL_SECONDS) || 60)),
  },
  accessCodes: (env.ACCESS_CODE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitPerHour: Number(env.RATE_LIMIT_PER_HOUR || 100),
  dailyLimit: Number(env.DAILY_LIMIT || 1000),
  // 访问码连续输错后的锁：默认 10 次 / 15 分钟
  authMaxFails: Math.max(1, Number(env.AUTH_MAX_FAILS) || 10),
  authLockMinutes: Math.max(1, Number(env.AUTH_LOCK_MINUTES) || 15),
};

export const capabilities = () => ({
  mock: config.forceMock || !hasAnyKey,
  forceMock: config.forceMock,
  hasAnyKey,
  authRequired: config.accessCodes.length > 0,
  models: modelIds(),
  providers: providers.map((p) => ({
    id: p.id,
    hasKey: Boolean(p.apiKey),
    models: p.models,
  })),
  embeddings: Boolean(config.embedding.apiKey && config.embedding.baseUrl),
  rerank: Boolean(config.rerank.apiKey && config.rerank.baseUrl),
  ocr: Boolean(config.ocr.apiKey && config.ocr.baseUrl),
  video: Boolean(config.video.apiKey && config.video.baseUrl),
  videoModel: config.video.model,
  videoModels: config.video.models,
  videoSize: config.video.size,
  image: Boolean(config.image.apiKey && config.image.baseUrl),
  imageModel: config.image.model,
  imageModels: config.image.models,
  imageSize: config.image.size,
});
