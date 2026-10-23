/**
 * 百炼异步任务通用客户端。
 *
 * 视频（video-synthesis）和图片（image-synthesis）用的是同一套任务协议：
 *   POST 创建 → { output: { task_id } }
 *   GET  /api/v1/tasks/{task_id} → PENDING / RUNNING / SUCCEEDED / FAILED ...
 *
 * 这里只负责「提交 / 查询 / 轮询 / 错误翻译」，具体参数由 video.mjs / image.mjs 组装。
 */

const TASK_RE = /^[A-Za-z0-9-]{6,80}$/;
export const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN']);

export function abortError() {
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

/** 单次请求的超时 + 外部取消信号合并 */
export function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function readError(res, { label = '百炼服务', model = '' } = {}) {
  const text = await res.text().catch(() => '');
  let code = '';
  let message = text.slice(0, 300);

  try {
    const json = JSON.parse(text);
    code = json.code || '';
    message = json.message || message;
  } catch {
    /* 非 JSON 错误体，保留原文 */
  }

  const both = `${code} ${message}`;
  if (res.status === 401 || res.status === 403) {
    return `${label}鉴权失败（${res.status}）：请检查 DASHSCOPE_API_KEY`;
  }
  if (res.status === 429) {
    return `${label}限流（429）：${message || '请稍后再试'}`;
  }
  if (/DataInspectionFailed|data_inspection_failed/i.test(both)) {
    return '提示词未通过内容审核，换一种描述再试';
  }
  if (/synchronous calls/i.test(both)) {
    return `${label}只支持异步调用（缺少 X-DashScope-Async 头）`;
  }
  if (/Model not exist|model_not_found/i.test(both)) {
    return `${label}模型不可用${model ? `：${model}` : ''}。检查模型 ID 或 VIDEO_MODEL / IMAGE_MODEL`;
  }
  return `${label}返回 ${res.status}：${message || '未知错误'}`;
}

/** 提交异步任务，立刻返回 task_id */
export async function submitTask({ baseUrl, apiKey, path, body, signal, label, model }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(body),
    signal: withTimeout(signal, 60_000),
  });

  if (!res.ok) throw new Error(await readError(res, { label, model }));

  const json = await res.json();
  const taskId = json.output?.task_id;
  if (!taskId) throw new Error(json.message || '提交任务失败');

  return {
    taskId,
    status: json.output?.task_status || 'PENDING',
    requestId: json.request_id,
  };
}

/** 查一次任务状态，返回完整 output，由调用方解释 */
export async function queryTask({ baseUrl, apiKey, taskId, signal, label, model }) {
  const id = String(taskId || '').trim();
  if (!TASK_RE.test(id)) throw new Error('task_id 格式不正确');

  const res = await fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: withTimeout(signal, 30_000),
  });

  if (!res.ok) throw new Error(await readError(res, { label, model }));

  const json = await res.json();
  const output = json.output || {};

  return {
    taskId: output.task_id || id,
    status: output.task_status || 'UNKNOWN',
    output,
    usage: json.usage,
    message: output.message || '',
  };
}

/**
 * 在 maxWaitMs 内轮询，直到成功/失败。
 * 超时仍然返回最后一次状态（通常是 RUNNING），由调用方决定怎么告诉模型。
 */
export async function waitTask({ maxWaitMs = 120_000, intervalMs = 5_000, ...args }) {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  let last = await queryTask(args);

  while (!TERMINAL.has(last.status) && Date.now() < deadline) {
    const left = deadline - Date.now();
    await sleep(Math.min(intervalMs, Math.max(250, left)), args.signal);
    last = await queryTask(args);
  }

  return last;
}
