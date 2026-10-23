import { config } from './config.mjs';
import { submitTask, queryTask, waitTask } from './dashscope-task.mjs';

/**
 * 阿里云百炼「万相」文生图（异步任务）。
 *
 * 推荐的两个免费额度模型：
 *   - wanx2.1-t2i-turbo：默认，速度快
 *   - wanx-v1          ：老版，支持 style，出图风格更多
 *
 * 和视频共用 /api/v1/tasks/{task_id} 查询协议，但提交接口是 text2image。
 */

const IMAGE_SIZES = {
  'wanx2.1-t2i-turbo': ['1024*1024', '720*1280', '1280*720', '768*1152'],
  'wanx-v1': ['1024*1024', '720*1280', '1280*720', '768*1152'],
  'wanx2.0-t2i-turbo': ['1024*1024', '720*1280', '1280*720', '768*1152'],
};

/** wanx-v1 的 n 默认是 4，必须显式传 1，否则一次吃掉 4 张额度 */
const recentTasks = new Map();

export function rememberImageTask(tenant, taskId) {
  if (tenant && taskId) recentTasks.set(tenant, taskId);
}

export function latestImageTask(tenant) {
  return recentTasks.get(tenant || 'public') || '';
}

export function imageReady() {
  const v = config.image;
  return Boolean(v.baseUrl && v.apiKey);
}

export function imageModelId(requested) {
  const id = String(requested || config.image.model || '').trim();
  return config.image.models.includes(id) ? id : config.image.model;
}

export function imageSizes() {
  const all = config.image.models.flatMap((m) => IMAGE_SIZES[m] || []);
  return [...new Set(all.length ? all : [config.image.size])];
}

export function imageInfo() {
  return {
    model: imageModelId(),
    models: config.image.models,
    size: config.image.size,
    sizes: imageSizes(),
    n: config.image.n,
  };
}

function pickSize(model, size) {
  const allowed = IMAGE_SIZES[model] || [config.image.size];
  if (size && allowed.includes(size)) return size;
  if (allowed.includes(config.image.size)) return config.image.size;
  return allowed[0];
}

export async function submitImage({ prompt, model, size, n, signal } = {}) {
  if (!imageReady()) throw new Error('未配置图片服务：需要 DASHSCOPE_API_KEY 或 IMAGE_API_KEY');

  const text = String(prompt || '').trim();
  if (!text) throw new Error('缺少 prompt');

  const id = imageModelId(model);
  const count = Math.min(4, Math.max(1, Number(n) || config.image.n || 1));

  return submitTask({
    baseUrl: config.image.baseUrl,
    apiKey: config.image.apiKey,
    path: '/api/v1/services/aigc/text2image/image-synthesis',
    body: {
      model: id,
      input: { prompt: text.slice(0, 800) },
      parameters: {
        size: pickSize(id, size),
        n: count,
      },
    },
    signal,
    label: '图片服务',
    model: id,
  });
}

function toImageResult(t) {
  const out = t.output || {};
  const urls = [
    // wanx 系列
    ...(out.results || []).map((r) => r.url).filter(Boolean),
    // 部分新模型走 choices/message/content
    ...(out.choices || []).flatMap((c) =>
      (c.message?.content || [])
        .map((x) => x.image || x.image_url?.url || '')
        .filter(Boolean)
    ),
  ];

  return {
    taskId: t.taskId,
    status: t.status,
    urls: [...new Set(urls)],
    message: t.message || '',
    usage: t.usage,
  };
}

export async function queryImage(taskId, { signal } = {}) {
  const t = await queryTask({
    baseUrl: config.image.baseUrl,
    apiKey: config.image.apiKey,
    taskId,
    signal,
    label: '图片服务',
    model: imageModelId(),
  });
  return toImageResult(t);
}

export async function waitImage(taskId, { maxWaitMs = 60_000, intervalMs = 3_000, signal } = {}) {
  const t = await waitTask({
    baseUrl: config.image.baseUrl,
    apiKey: config.image.apiKey,
    taskId,
    maxWaitMs,
    intervalMs,
    signal,
    label: '图片服务',
    model: imageModelId(),
  });
  return toImageResult(t);
}
