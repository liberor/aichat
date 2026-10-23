import type { AppConfig, Doc, McpServer, Skill } from './types';

async function json<T>(url: string, init?: RequestInit, retry = true): Promise<T> {
  let res = await fetch(url, init);

  // 服务重启后内存会话会失效：用本地保存的访问码自动重登一次
  if (res.status === 401 && retry) {
    const code = localStorage.getItem('accessCode');
    if (code) {
      const ok = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }).catch(() => null);
      if (ok?.ok) {
        res = await fetch(url, init);
      }
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error((body as any).error || `${res.status} ${res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  config: () => json<AppConfig>('/api/config'),

  state: () =>
    json<Pick<AppConfig, 'tenant' | 'skills' | 'documents' | 'mcpServers'>>('/api/state'),

  auth: (code: string) =>
    json<{ ok: boolean; authRequired: boolean }>('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }),

  session: () => json<{ authenticated: boolean; tenant: string }>('/api/session'),

  // 不走 json() 的 401 自动重登，否则退出会被重新登回去
  logout: async () => {
    const res = await fetch('/api/logout', { method: 'POST' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as { ok: boolean };
  },

  chat: (body: unknown) =>
    json<{ runId: string; sources: any[]; tools: string[] }>('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  run: (id: string) => json<{ id: string; done: boolean; lastEventId: number }>(`/api/chat/${id}`),
  cancel: (id: string) => json<{ ok: boolean }>(`/api/chat/${id}/cancel`, { method: 'POST' }),

  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return json<{ docId: string; name: string; chunks: number; embedded: boolean }>('/api/upload', {
      method: 'POST',
      body: fd,
    });
  },

  documents: () => json<Doc[]>('/api/documents'),
  deleteDoc: (id: string) => json<{ ok: boolean }>(`/api/documents/${id}`, { method: 'DELETE' }),

  keyList: () => json<{ providers: string[] }>('/api/keys'),
  saveKey: (provider: string, key: string) =>
    json<{ ok: boolean; providers: string[] }>('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    }),
  deleteKey: (provider: string) =>
    json<{ ok: boolean; providers: string[] }>(`/api/keys/${provider}`, { method: 'DELETE' }),

  skills: () => json<Skill[]>('/api/skills'),
  skill: (name: string) => json<{ name: string; description: string; body: string }>(`/api/skills/${name}`),
  saveSkill: (body: { name: string; description: string; body: string }) =>
    json<Skill>('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteSkill: (name: string) => json<{ ok: boolean }>(`/api/skills/${name}`, { method: 'DELETE' }),

  mcpServers: () => json<McpServer[]>('/api/mcp/servers'),
  ensureMcp: () =>
    json<{
      checked: number;
      alive: string[];
      reconnected: string[];
      failed: { name: string; error: string }[];
      servers: McpServer[];
    }>('/api/mcp/ensure', { method: 'POST' }),
  connectMcp: (body: { url: string; name?: string; headers?: Record<string, string> }) =>
    json<McpServer>('/api/mcp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  disconnectMcp: (id: string) => json<{ ok: boolean }>(`/api/mcp/servers/${id}`, { method: 'DELETE' }),
};

export type StreamEvent =
  | { id: number; type: 'delta'; text: string }
  | { id: number; type: 'tool_call'; callId: string; name: string; args: unknown; at?: number }
  | { id: number; type: 'tool_result'; callId: string; name: string; result: string; at?: number }
  | { id: number; type: 'usage'; usage: { prompt_tokens?: number; completion_tokens?: number } }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'done' };

/**
 * GET + EventSource：
 * - 首次连接用 ?last= 从指定位置回放
 * - 断线后浏览器会自动重连，并带上 Last-Event-ID，实现真正的续传
 */
export function openStream(runId: string, last: number, onEvent: (e: StreamEvent) => void) {
  const es = new EventSource(`/api/chat/${runId}/stream?last=${last}`);
  let errors = 0;
  // 收到 done/error 后连接马上会被关闭，忽略随后可能补发的 error 事件，
  // 否则会给已经正常结束的回答挂上一条“中断”提示。
  let finished = false;

  es.onmessage = (ev) => {
    errors = 0;
    try {
      const e = JSON.parse(ev.data) as StreamEvent;
      if (e.type === 'done' || e.type === 'error') finished = true;
      onEvent(e);
    } catch {
      /* ignore */
    }
  };

  // 浏览器会自动重连并带上 Last-Event-ID。
  // readyState === CLOSED 表示浏览器不会再重连（典型情况：run 已过期返回 404），
  // 这时必须立刻上报终止，否则 UI 会一直停在“生成中”。
  es.onerror = () => {
    if (finished) return;

    if (es.readyState === EventSource.CLOSED) {
      finished = true;
      onEvent({
        id: -1,
        type: 'error',
        message: '回答已中断：服务端记录已过期，请重新发送',
      });
      return;
    }

    errors += 1;
    if (errors >= 5) {
      finished = true;
      es.close();
      onEvent({ id: -1, type: 'error', message: '流式连接中断：多次重连失败，请重新发送' });
    }
  };

  return es;
}
