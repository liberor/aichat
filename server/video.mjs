import { config } from './config.mjs';
import { submitTask, queryTask, waitTask } from './dashscope-task.mjs';

/**
 * 阿里云百炼「万相」文生视频（异步任务）。
 *
 * 推荐的两个免费额度模型：
 *   - wanx2.1-t2v-turbo：480P/720P，速度快，默认
 *   - wanx2.1-t2v-plus ：仅 720P，画质更好
 *
 * 注意：文档模型列表里写的是 wan2.1-*，但接口只认 wanx2.1-*（带 x）。
 */

const ALIASES = {
  'wan2.1-t2v-turbo': 'wanx2.1-t2v-turbo',
  'wan2.1-t2v-plus': 'wanx2.1-t2v-plus',
};

/** 各模型支持的 size；不在表里的模型退回到配置默认值 */
const VIDEO_SIZES = {
  'wanx2.1-t2v-turbo': ['832*480', '480*832', '624*624', '1280*720', '720*1280', '960*960'],
  'wanx2.1-t2v-plus': ['1280*720', '720*1280', '960*960'],
  'wan2.2-t2v-plus': ['832*480', '480*832', '624*624', '1920*1080', '1080*1920', '1440*1440'],
  'wan2.5-t2v-preview': [
    '832*480', '480*832', '624*624',
    '1280*720', '720*1280', '960*960',
    '1920*1080', '1080*1920', '1440*1440',
  ],
  'wan2.6-t2v': ['1280*720', '720*1280', '960*960', '1920*1080', '1080*1920', '1440*1440'],
};

const recentTasks = new Map();

export function rememberVideoTask(tenant, taskId) {
  if (tenant && taskId) recentTasks.set(tenant, taskId);
}

export function latestVideoTask(tenant) {
  return recentTasks.get(tenant || 'public') || '';
}

export function videoReady() {
  const v = config.video;
  return Boolean(v.baseUrl && v.apiKey);
}

/** 把文档别名映射成真实模型 ID；不在白名单里的回退到默认模型 */
export function videoModelId(requested) {
  const raw = String(requested || config.video.model || '').trim();
  const id = ALIASES[raw] || raw;
  return config.video.models.includes(id) ? id : config.video.model;
}

/** 当前配置下可选的分辨率（所有模型的并集），用于工具参数枚举 */
export function videoSizes() {
  const all = config.video.models.flatMap((m) => VIDEO_SIZES[m] || []);
  return [...new Set(all.length ? all : [config.video.size])];
}

export function videoInfo() {
  return {
    model: videoModelId(),
    models: config.video.models,
    size: config.video.size,
    sizes: videoSizes(),
    duration: config.video.duration || null,
  };
}

function pickSize(model, size) {
  const allowed = VIDEO_SIZES[model] || [config.video.size];
  if (size && allowed.includes(size)) return size;
  if (allowed.includes(config.video.size)) return config.video.size;
  return allowed[0];
}

export async function submitVideo({ prompt, model, size, duration, signal } = {}) {
  if (!videoReady()) throw new Error('未配置视频服务：需要 DASHSCOPE_API_KEY 或 VIDEO_API_KEY');

  const text = String(prompt || '').trim();
  if (!text) throw new Error('缺少 prompt');

  const id = videoModelId(model);
  const v = config.video;
  const parameters = {
    size: pickSize(id, size),
    prompt_extend: v.promptExtend,
    watermark: v.watermark,
  };
  // 部分模型固定 5 秒且不接受 duration，所以只有显式配置时才传
  if (duration || v.duration) parameters.duration = Number(duration || v.duration);

  return submitTask({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    path: '/api/v1/services/aigc/video-generation/video-synthesis',
    body: {
      model: id,
      input: { prompt: text.slice(0, 1500) },
      parameters,
    },
    signal,
    label: '视频服务',
    model: id,
  });
}

function toVideoResult(t) {
  return {
    taskId: t.taskId,
    status: t.status,
    videoUrl: t.output?.video_url || '',
    message: t.message || '',
    usage: t.usage,
  };
}

export async function queryVideo(taskId, { signal } = {}) {
  const v = config.video;
  const t = await queryTask({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    taskId,
    signal,
    label: '视频服务',
    model: videoModelId(),
  });
  return toVideoResult(t);
}

export async function waitVideo(taskId, { maxWaitMs = 120_000, intervalMs = 5_000, signal } = {}) {
  const v = config.video;
  const t = await waitTask({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    taskId,
    maxWaitMs,
    intervalMs,
    signal,
    label: '视频服务',
    model: videoModelId(),
  });
  return toVideoResult(t);
}
