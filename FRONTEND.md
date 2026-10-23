# AI Chat MVP 前端核心逻辑

本文讲清楚前端最关键的 5 件事：

0. **断流续传**
1. **前端状态机**
2. **IndexedDB 与浏览器存储（Cookie / localStorage）**
3. **流式渲染性能**
4. **SSE 的前端边界**

再加数据结构、调试清单和自测题。

> 对应源码：`src/App.tsx`、`src/api.ts`、`src/db.ts`、`src/components/Message.tsx`、`src/types.ts`。

---

## 目录

- [0. 总览](#0-总览)
- [1. 断流续传](#1-断流续传)
- [2. 前端状态机](#2-前端状态机)
- [3. IndexedDB 与浏览器存储](#3-indexeddb-与浏览器存储)
- [4. 流式渲染性能](#4-流式渲染性能)
- [5. SSE 的前端边界](#5-sse-的前端边界)
- [6. 数据结构](#6-数据结构)
- [7. 调试清单](#7-调试清单)
- [8. 自测题](#8-自测题)

---

## 0. 总览

前端只做三件事：

```
① 发请求：POST /api/chat  → 拿 runId
② 接流：  EventSource     → 收 delta / tool / usage / done
③ 落本地：IndexedDB       → 对话、草稿、设置、断点
```

### 0.1 文件职责

| 文件 | 职责 |
|---|---|
| `src/App.tsx` | 会话状态机、流生命周期、草稿、离线、语音、主题 |
| `src/api.ts` | REST 封装 + `openStream`（EventSource） |
| `src/db.ts` | IndexedDB 读写 |
| `src/components/Message.tsx` | 消息、工具卡片、Markdown、媒体、引用 |
| `src/components/RightPanel.tsx` | 模型、人设、Skill、RAG/视频/图片开关、MCP |
| `src/types.ts` | `Conv` / `Msg` / `ToolCall` / `Source` |

### 0.2 前端所有存储

| 存储 | 存什么 | JS 可读 | 刷新后 | 清理 |
|---|---|---|---|---|
| React state / refs | 当前会话、busy、离线、输入框、EventSource | ✅（内存） | ❌ | 组件卸载 |
| IndexedDB | 对话、草稿、设置、runId/lastEventId | ✅ | ✅ | 用户删除 / 浏览器清理 |
| localStorage | `accessCode`、`theme`、`composerHeight` | ✅ | ✅ | 手动 / 退出登录清 code |
| Cookie（HttpOnly） | 登录 token `access_token` | ❌ | ✅ | 7 天 / 退出（服务重启后失效） |
| sessionStorage / Cache Storage | 未使用 | — | — | — |

一句话：

- **IndexedDB** 存业务数据；
- **localStorage** 存少量 UI 偏好和自动重登用的访问码；
- **HttpOnly cookie** 存会话 token，JS 读不到；
- **React state/refs** 只是当前视图。

服务端只保存：

- 运行中的 run（30 分钟）；
- 登录 session / BYOK key（7 天）；
- 文档索引、Skill、MCP 连接。

### 0.3 一条消息的完整时序

```
用户输入
  ↓
send()
  ├─ 插入 userMsg + pending botMsg
  ├─ 立即写 IndexedDB
  ├─ POST /api/chat
  │     ↓ { runId, sources }
  ├─ 写 sources、runId
  └─ attach(runId, 0)
        ↓
   EventSource
        ↓
   onmessage → applyEvent → patch → IndexedDB（400ms）
        ↓
   done / error
        ↓
   关闭 EventSource，pending=false，清 runId
```

---

## 1. 断流续传

### 1.1 问题

回答可能持续几十秒。期间用户可能：

- 刷新页面；
- 切 Wi-Fi / 断网；
- 手机锁屏；
- 切到别的会话。

如果“断了就重发”，会重复计费、重复输出。前端的解法是：

> 不重发，凭 `runId + lastEventId` 接回原来的流。

### 1.2 事件类型

`src/api.ts`：

```ts
export type StreamEvent =
  | { id: number; type: 'delta'; text: string }
  | { id: number; type: 'tool_call'; callId: string; name: string; args: unknown; at?: number }
  | { id: number; type: 'tool_result'; callId: string; name: string; result: string; at?: number }
  | { id: number; type: 'usage'; usage: { prompt_tokens?: number; completion_tokens?: number } }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'done' };
```

`id` 是服务端分配的事件序号，从 1 递增。

### 1.3 `applyEvent`：事件 → 消息

`src/App.tsx`：

```ts
function applyEvent(c: Conv, msgId: string, e: StreamEvent): Conv {
  const touch = (fn: (m: Msg) => Msg): Conv => ({
    ...c,
    lastEventId: e.id > 0 ? e.id : c.lastEventId,
    updatedAt: Date.now(),
    messages: c.messages.map(m => (m.id === msgId ? fn(m) : m)),
  });

  switch (e.type) {
    case 'delta':
      return touch(m => {
        const parts = [...(m.parts || [])];
        const last = parts[parts.length - 1];

        if (last?.type === 'text') {
          parts[parts.length - 1] = { ...last, text: last.text + e.text };
        } else {
          parts.push({ type: 'text', text: e.text });
        }

        return { ...m, parts };
      });

    case 'tool_call':
      return touch(m => {
        const exists = (m.tools || []).some(t => t.id === e.callId);

        const tools = exists
          ? (m.tools || []).map(t =>
              t.id === e.callId
                ? { ...t, name: e.name, args: e.args, status: 'running', startedAt: t.startedAt || e.at || Date.now() }
                : t
            )
          : [...(m.tools || []), { id: e.callId, name: e.name, args: e.args, status: 'running', startedAt: e.at || Date.now() }];

        const parts = [...(m.parts || [])];
        if (!parts.some(p => p.type === 'tool' && p.callId === e.callId)) {
          parts.push({ type: 'tool', callId: e.callId });
        }

        return { ...m, tools, parts };
      });

    case 'tool_result':
      return touch(m => ({
        ...m,
        tools: (m.tools || []).map(t =>
          t.id === e.callId ? { ...t, result: e.result, status: 'done', finishedAt: e.at || Date.now() } : t
        ),
      }));

    case 'usage':
      return touch(m => ({ ...m, usage: e.usage }));

    case 'error':
      return { ...touch(m => ({ ...m, error: e.message, pending: false })), runId: undefined };

    case 'done':
      return {
        ...c,
        lastEventId: e.id > 0 ? e.id : c.lastEventId,
        runId: undefined,
        updatedAt: Date.now(),
        messages: c.messages.map(m => (m.id === msgId ? { ...m, pending: false } : m)),
      };

    default:
      return c;
  }
}
```

关键点：

- **assistant 的正文用 `parts` 表示**，`content` 只给 user 消息；
- `delta` 追加到最后一个 text part；如果最后是 tool part，就新建一个 text part；
- `tool_call` 更新/创建工具，并在当前位置追加一个 `{ type: 'tool', callId }`，顺序由 parts 保证；
- 回放时同一个 `callId` 不重复插入 part；
- `tool_result` 只更新 `tools`，不动 parts；
- `done` 清 `runId`，但保留 `lastEventId`；
- `error` 也清 `runId`。

### 1.4 为什么不会重复 token

`applyEvent` 返回的新 `Conv` 里，**parts 和 `lastEventId` 在同一个对象**：

```ts
{
  ...c,
  lastEventId: e.id,
  messages: [...],   // 最后一个 text part 已经追加过
}
```

`patch` 会把这整条 `Conv` 一次 `put` 进 IndexedDB：

```
最后一个 text part += token
lastEventId = e.id
→ 同一条记录、同一次写入
```

刷新后：

```
从 IndexedDB 读 lastEventId = 41
→ EventSource(?last=41)
→ 服务端只回放 id > 41 的事件
→ 不会重新发 1..41
```

不存在“内容写了、断点没写”的中间态，所以不会重复。

### 1.5 `send`：先落盘，再发请求

```ts
async function send() {
  const text = input.trim();
  if (!text || !current || busy || offline || sendingRef.current) return;

  sendingRef.current = true;

  const userMsg = { id: uid(), role: 'user', content: text, createdAt: Date.now() };
  const botMsg = { id: uid(), role: 'assistant', parts: [], model: settings.model, pending: true, createdAt: Date.now() };

  const history = [...current.messages, userMsg]
    .filter(m => (m.role === 'user' || m.role === 'assistant') && msgText(m))
    .map(m => ({ role: m.role, content: msgText(m) }));

  const convId = current.id;

  patch(convId, c => ({
    ...c,
    title: c.messages.length ? c.title : text.slice(0, 20),
    messages: [...c.messages, userMsg, botMsg],
    draft: '',
    runId: undefined,
    lastEventId: 0,
  }), true);   // ← 立即写 IndexedDB

  try {
    const res = await api.chat({ messages: history, model: settings.model, ... });

    if (res.sources?.length) {
      patchMsg(convId, botMsg.id, m => ({ ...m, sources: res.sources }));
    }

    patch(convId, c => ({ ...c, runId: res.runId, lastEventId: 0 }), true);

    if (currentIdRef.current === convId) {
      attach(convId, res.runId, botMsg.id, 0);
    }
  } catch (e) {
    patchMsg(convId, botMsg.id, m => ({ ...m, error: e.message, pending: false }), true);
    setBusy(false);
  } finally {
    sendingRef.current = false;
  }
}
```

顺序很重要：

1. 先把 user + pending assistant 写进本地；
2. 再 POST；
3. POST 返回后写 `runId`；
4. 如果用户还在这个会话，才 `attach`。

如果 POST 期间用户切走了：

- `runId` 仍然写到**原会话**；
- `currentIdRef.current !== convId`，不接流；
- 切回来时 `onSelect` 看到 `runId`，调用 `resume`。

### 1.6 `attach`：建立流

```ts
function attach(convId: string, runId: string, msgId: string, last = 0) {
  esRef.current?.close();   // 同一时刻只保留一个 EventSource

  const es = openStream(runId, last, e => {
    if (e.type === 'done' || e.type === 'error') {
      es.close();
      if (esRef.current === es) esRef.current = null;
      setBusy(false);
      patch(convId, c => applyEvent(c, msgId, e), true);
      return;
    }

    patch(convId, c => applyEvent(c, msgId, e));
  });

  esRef.current = es;
  setBusy(true);
}
```

- `last` 是断点；
- `done/error` 立即落盘；
- 普通事件走 400ms debounce。

### 1.7 `resume`：刷新 / 切回 / 联网后接流

```ts
function resume(conv: Conv) {
  if (!conv.runId) return;

  const lastMsg =
    [...conv.messages].reverse().find(m => m.role === 'assistant' && m.pending) ||
    [...conv.messages].reverse().find(m => m.role === 'assistant');

  if (!lastMsg) {
    patch(conv.id, c => ({ ...c, runId: undefined, lastEventId: undefined }), true);
    return;
  }

  patchMsg(conv.id, lastMsg.id, m => ({ ...m, error: undefined, pending: true }), true);

  attach(conv.id, conv.runId, lastMsg.id, conv.lastEventId || 0);
}
```

要点：

- 找最后一条 **pending 的 assistant**，没有就找最后一条 assistant；
- 清掉上次失败留下的 `error`；
- 从 `conv.lastEventId` 接流；
- **不先查 run 状态**。

为什么不先查 `/api/chat/:id`：

```
查状态 ──→ 建立 SSE
        ↑
   这中间会漏事件
```

而且 run 即使已经结束，30 分钟内也能完整回放，服务端会补 `done`。

### 1.8 刷新恢复时序

```
页面刷新
  ↓
init()
  ├─ GET /api/config
  ├─ GET /api/session（有访问码时）
  ├─ GET /api/state
  ├─ 读 IndexedDB：settings / currentId / allConvs
  ↓
找到 currentId 对应的 Conv
  ↓
Conv.runId 存在？
  ├─ 否 → 正常显示
  └─ 是 → resume(conv)
           ├─ patchMsg(pending = true)
           └─ attach(runId, lastEventId)
                 ↓
           EventSource(?last=N)
                 ↓
           服务端回放 N 之后的事件
                 ↓
           继续实时推送
```

### 1.9 离线 / 恢复

```ts
const goOffline = () => {
  setOffline(true);
  if (!esRef.current) return;
  esRef.current.close();   // 主动断开，保留 runId
  esRef.current = null;
};

const goOnline = () => {
  setOffline(false);
  const conv = convsRef.current.find(c => c.id === currentIdRef.current);
  if (conv?.runId) resume(conv);
  void autoConnectPresets();
};
```

- 离线时保留 `runId` / `lastEventId`；
- 恢复联网后只恢复**当前会话**；
- 其他会话切回去时，`onSelect` 也会 `resume`。

### 1.10 停止

```ts
async function stop() {
  const convId = currentId;
  const runId = current?.runId;

  esRef.current?.close();
  esRef.current = null;
  setBusy(false);

  patch(convId, c => ({
    ...c,
    runId: undefined,
    lastEventId: undefined,
    messages: c.messages.map(m =>
      m.role === 'assistant' && m.pending ? { ...m, pending: false, stopped: true } : m
    ),
  }), true);

  if (runId) await api.cancel(runId).catch(() => {});
}
```

为什么本地要先收尾：

- 前端已经关闭 EventSource；
- 服务端虽然会在 `finally` 里写 `done`，但前端收不到；
- 不本地收尾，空白的 assistant 消息会一直显示“三个点”。

### 1.11 服务端契约（前端需要知道的）

| 契约 | 含义 |
|---|---|
| 事件 `id` 从 1 递增 | 断点用 |
| `?last=N` 回放 `id > N` | 续传 |
| 结束时一定发 `done` | 前端关闭流 |
| run 保留 30 分钟 | 过期后 404 |
| 404 | 前端提示“记录已过期，请重新发送” |

---

## 2. 前端状态机

### 2.1 状态定义

| 状态 | 判定 | UI |
|---|---|---|
| `boot` | `config === null` | 加载中 |
| `gate` | `authRequired && !authed` | 访问码页 |
| `idle` | 无 run、无 pending | 正常输入 |
| `sending` | `sendingRef.current === true` | assistant 已插入，等待 runId |
| `streaming` | `busy === true` | 停止按钮、工具卡片 |
| `stopped` | `msg.stopped` | 「已停止生成」 |
| `error` | `msg.error` | 错误文案 |
| `offline` | `offline === true` | 顶部提示、禁用发送 |
| `expired` | run 404 / EventSource CLOSED | 提示重新发送 |
| `switching` | 切会话瞬间 | 关闭旧流、`busy=false` |
| `loggingOut` | 退出中 | flush + reload |

### 2.2 关键变量

| 变量 | 类型 | 作用 | 何时 true / false |
|---|---|---|---|
| `busy` | state | 当前会话是否在流 | `attach` 时 true；done/error/stop/切会话时 false |
| `sendingRef` | ref | POST 是否在途 | `send` 开始 true；`finally` false |
| `offline` | state | 浏览器是否离线 | `offline` / `online` 事件 |
| `esRef` | ref | 当前唯一的 EventSource | `attach` 创建；done/切会话/卸载关闭 |
| `runId` | Conv 字段 | 服务端 run | POST 后写入；done/error/stop 清空 |
| `lastEventId` | Conv 字段 | 断点 | 每个事件更新；stop 清空 |
| `pending` | Msg 字段 | 是否还在生成 | send 时 true；done/error/stop false |

### 2.3 为什么需要三个守卫

```ts
if (!text || !current || busy || offline || sendingRef.current) return;
```

- `busy`：流已经接上，防止并发发送；
- `offline`：没网，防止必然失败；
- `sendingRef`：POST 在途，堵住 `busy` 还没变 true 的空窗。

时间线：

```
t0 点击发送
   sendingRef = true      ← 同步
   POST ...               ← busy 仍是 false
t1 收到 runId
   attach → busy = true
   finally → sendingRef = false
t2 流中
   busy = true
t3 done
   busy = false
```

没有 `sendingRef`，t0 到 t1 之间双击会发两个 POST，创建两个 run，双倍计费。

### 2.4 状态迁移表

| 事件 | 从 | 到 | 动作 |
|---|---|---|---|
| 点击发送 | idle | sending | 插入消息、`sendingRef=true`、立即落盘 |
| POST 返回 | sending | streaming | 写 runId、`attach`、`busy=true` |
| 收到 done | streaming | idle | `pending=false`、清 runId、关流 |
| 收到 error | streaming | error | 写 error、清 runId、关流 |
| 点击停止 | streaming | stopped | 关流、本地收尾、调 cancel |
| 切会话 | streaming | switching | 关流、`busy=false`，服务端 run 继续 |
| 切回来 | switching | streaming | `resume`、`busy=true` |
| 离线 | streaming | offline | 关流、保留 runId |
| 恢复联网 | offline | streaming | 当前会话 `resume` |
| 刷新 | any | boot → streaming/idle | init 读 IndexedDB，必要时 resume |
| run 过期 | streaming | expired | 提示重新发送 |
| 退出登录 | any | loggingOut | flush、关流、删本地码、reload |

### 2.5 关键不变量

1. **同一时刻只有一个 EventSource**（`esRef` 单例）；
2. **`sendingRef` 只覆盖 POST 窗口**，不代表流；
3. **`busy` 是全局的，但语义是“当前正在看的会话是否在流”**；
4. **`runId + lastEventId` 是恢复的唯一依据**；
5. **切走不取消后台 run**，只有点“停止”才取消；
6. **`pending` 只标记正在生成的 assistant 消息**。

### 2.6 竞态与处理

| 竞态 | 处理 |
|---|---|
| 双击发送 | `sendingRef` |
| POST 期间切会话 | runId 写到原会话；不 attach 到新会话 |
| done 后 onerror 补发 | `finished` 标记，忽略 |
| resume 时 run 刚好结束 | 服务端 double-check + 补 done |
| 取消时事件还在路上 | 本地先收尾，关闭流 |
| 刷新时 run 已结束 | 回放全部 + done |
| 刷新时 run 已过期 | 404，提示重发 |
| 离线时切会话 | 不 resume，等 online |

### 2.7 每会话 vs 全局

`busy` 是全局 state，但切会话时会 `setBusy(false)`：

```
会话 A 正在流
  → 切到 B
  → 关闭 A 的 EventSource
  → setBusy(false)
  → A 的 run 继续在服务端跑
  → 在 B 可以发消息
  → 切回 A
  → onSelect 看到 A.runId
  → resume(A) → busy = true
```

这是有意设计：`busy` 只表示“当前视图是否在流”，不是“系统里有没有 run”。

### 2.8 状态图

```
                 ┌─────────┐
                 │  boot   │
                 └────┬────┘
              authRequired?
             ┌────────┴────────┐
             ▼                 ▼
        ┌─────────┐       ┌─────────┐
        │  gate   │       │  idle   │
        └────┬────┘       └────┬────┘
             │ 登录成功          │ 发送
             └──────────────▶ ┌─────────┐
                              │ sending │
                              └────┬────┘
                         POST 返回 │
                                   ▼
                              ┌───────────┐
              ┌───────────────│ streaming │───────────────┐
              │               └─────┬─────┘               │
        切会话/离线                 │ done/error        点停止
              ▼                     ▼                     ▼
        ┌──────────┐          ┌─────────┐          ┌─────────┐
        │switching │          │  idle   │          │ stopped │
        │/offline  │          │ / error │          └─────────┘
        └────┬─────┘          └─────────┘
             │ 切回/联网
             └──────────────▶ streaming
```

### 2.9 MCP 状态同步

MCP 连接只存在服务端内存，服务端重启后会清空；前端如果不刷新，`config.mcpServers` 会一直显示旧的“已连接”。

两个同步点：

1. **打开 MCP 面板时**
   ```
   POST /api/mcp/ensure
     → ping / listTools 探活
     → 失活的按原 URL / headers 重连
     → 重连失败的移除
     → refresh() 拉最新 /api/state
   ```
2. **窗口重新获得焦点 / 从后台切回**
   ```
   refresh()   // 5 秒内最多一次
   ```

聊天时不需要前端额外调用：`POST /api/chat` 内部会在 `buildTools` 之前做同样的探活和重连。

---

## 3. IndexedDB 与浏览器存储

### 3.1 数据库结构

`src/db.ts`：

```ts
const DB_NAME = 'ai-chat-mvp';
const VERSION = 1;

// objectStore('conversations', { keyPath: 'id' })
// objectStore('kv',            { keyPath: 'k' })
```

只有两个 store，没有索引。

### 3.2 一条 `Conv` 的结构

```ts
{
  id: 'a1b2c3d4',
  title: '前端面试题',
  tenant: '9ec3dba24543d8f1',
  messages: [
    {
      id: 'x9y8z7',
      role: 'assistant',
      parts: [
        { type: 'text', text: '我先查一下合同条款。' },
        { type: 'tool', callId: 'call_1' },
        { type: 'text', text: '根据资料，试用期为六个月。' }
      ],
      model: 'qwen/qwen-flash',
      tools: [
        {
          id: 'call_1',
          name: 'rag_search',
          args: { query: '试用期' },
          result: '[1] 来源：劳动合同.pdf……',
          status: 'done',
          startedAt: 1729500000000,
          finishedAt: 1729500000500
        }
      ],
      sources: [
        { id: 'uuid:0', docName: '劳动合同.pdf', text: '……', score: 0.8123 }
      ],
      usage: { prompt_tokens: 812, completion_tokens: 96 },
      pending: false,
      createdAt: 1729500000000
    }
  ],
  draft: '还没发出去的内容',
  runId: 'uuid',
  lastEventId: 42,
  settings: { model: '...', system: '...', skills: [], useRag: true },
  createdAt: 1729490000000,
  updatedAt: 1729500000000
}
```

`kv` store：

| key | value |
|---|---|
| `settings:<tenant>` | 全局默认设置 |
| `currentId:<tenant>` | 上次打开的会话 id |
| `providerKeys` | 旧版本遗留，启动时被写成 `null` |

### 3.3 事务封装

```ts
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
```

- `open()` 缓存 `dbPromise`，只开一次；
- 每个操作一个事务；
- 没有 `oncomplete` 等待，单请求足够。

### 3.4 写路径

```ts
function persist(conv: Conv, immediate = false) {
  clearTimeout(saveTimers.current[conv.id]);

  if (immediate) {
    putConv(conv).catch(() => {});
    return;
  }

  saveTimers.current[conv.id] = window.setTimeout(
    () => putConv(conv).catch(() => {}),
    400
  );
}

function patch(id: string, fn: (c: Conv) => Conv, immediate = false) {
  const next = convsRef.current.map(c => (c.id === id ? fn(c) : c));
  convsRef.current = next;
  setConvs(next);

  const target = next.find(c => c.id === id);
  if (target) persist(target, immediate);
}
```

- `convsRef` 是唯一真源；
- 每次 `patch` 生成新的 `convs` 数组；
- 默认 400ms debounce；
- `immediate` 直接 `putConv`。

### 3.5 立即写 vs debounce

| 时机 | 模式 | 原因 |
|---|---|---|
| 发送消息 | 立即 | 刷新后能看到 user + pending assistant |
| `done` / `error` | 立即 | 结束状态必须落盘 |
| 点停止 | 立即 | 清 runId、标记 stopped |
| 切会话 | `flushConv` | 不把最后 400ms 丢在 debounce 里 |
| `pagehide` | `flushConv` | 关页面前保存 |
| `visibilitychange` → hidden | `flushConv` | 手机切后台 |
| 退出登录 | `flushConv` | 草稿先落盘 |
| 普通 delta / 工具事件 | 400ms | 减少写放大 |
| 输入框草稿 | 400ms | 每次按键都写太频繁 |

### 3.6 读路径

初始化：

```ts
const [saved, list, legacy] = await Promise.all([
  kvGet<Settings>(`settings:${tenant}`),
  allConvs(tenant),
  legacyConvs(),
]);

const lastId = await kvGet<string>(`currentId:${tenant}`);
const target = list.find(c => c.id === lastId) || list[0];
```

- 先用 tenant 过滤；
- 按 `updatedAt` 倒序；
- `currentId` 找上次会话，找不到就取第一个；
- 没有会话就新建。

### 3.7 租户隔离

```ts
export async function allConvs(tenant: string): Promise<Conv[]> {
  const list = await tx<Conv[]>('conversations', 'readonly', s => s.getAll());
  return list
    .filter(c => c.tenant === tenant)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
```

- 数据库是 origin 共享的；
- 没有按租户分库；
- 靠 `Conv.tenant` 过滤；
- 设置和 `currentId` 用 `tenant` 做 key 前缀。

**这不是强隔离**：DevTools 仍能读到所有记录。真正的隔离在服务端。

### 3.8 旧数据认领

旧版本没有 `tenant` 字段：

```ts
export async function legacyConvs(): Promise<Conv[]> {
  const list = await tx<Conv[]>('conversations', 'readonly', s => s.getAll());
  return list.filter(c => !c.tenant);
}
```

前端侧栏提示：

- 「归到当前」→ `claimLegacyConvs(tenant)`：
  - 补 `tenant`；
  - 清 `runId` / `lastEventId`；
  - `pending` 置 false。
- 「删除」→ `deleteLegacyConvs()`。

注意：有旧 `tenant` 但不匹配当前租户的数据，**不会**出现在认领列表里，只会“看不见”。

### 3.9 原子性与重复 token

IndexedDB 的 `put` 是单记录原子操作。

`applyEvent` 把 `parts` 和 `lastEventId` 放在同一个 `Conv` 对象里，所以：

```
put(整个 Conv)
  ├─ 最后一个 text part 追加 token
  └─ lastEventId 更新
```

要么都成功，要么都不写。

### 3.10 代价

| 问题 | 说明 |
|---|---|
| 整条会话重写 | 每次最多 400ms 写一次完整 `messages` |
| 无索引 | `getAll()` 后 JS 过滤 |
| 流式写放大 | 回答越长，序列化越贵 |
| 单记录很大 | 长对话可能几 MB |
| 无版本迁移 | 只有 v1，加字段靠可选 |

### 3.11 所有存储对比

| 数据 | React state/refs | IndexedDB | localStorage | HttpOnly cookie | 服务端 session |
|---|---|---|---|---|---|
| 对话 | 当前视图 | ✅ | ❌ | ❌ | ❌ |
| 草稿 | 输入框 | ✅ | ❌ | ❌ | ❌ |
| 设置 | 当前设置 | ✅ 按租户 | ❌ | ❌ | ❌ |
| runId / lastEventId | ✅ | ✅ | ❌ | ❌ | ✅（run 内存） |
| accessCode | ❌ | ❌ | ✅ | ❌ | ❌（只存派生的 tenant） |
| 登录 token | ❌ | ❌ | ❌ | ✅ | ✅（token → session） |
| BYOK key | ❌ | ❌ | ❌ | ❌ | ✅ |
| theme | ✅ | ❌ | ✅ | ❌ | ❌ |
| 输入框高度 | ✅ | ❌ | ✅ | ❌ | ❌ |

### 3.12 调试

DevTools → **Application** → **IndexedDB** → `ai-chat-mvp`：

- `conversations`：看每条会话的 `runId`、`lastEventId`、`pending`；
- `kv`：看 `settings:<tenant>`、`currentId:<tenant>`。

常用操作：

```js
// 控制台查看当前库
indexedDB.open('ai-chat-mvp')
```

或在 Application 面板直接改 `lastEventId`，然后刷新，观察续传行为。

### 3.13 HttpOnly Cookie

| 项 | 值 |
|---|---|
| 名称 | `access_token` |
| 设置方 | 服务端 `createSession()` |
| 标志 | `HttpOnly`、`SameSite=Lax`、`Path=/`、`Max-Age=7 天` |
| 内容 | 24 字节随机 token（48 位 hex） |
| JS 可读 | ❌ |
| 谁发送 | 浏览器自动带在同源请求上 |

服务端：

```js
const token = crypto.randomBytes(24).toString('hex');
const session = { tenant, exp: Date.now() + TTL, keys: {} };

sessions.set(token, session);

res.cookie('access_token', token, {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: TTL,
  path: '/',
});
```

- cookie 里**只有随机 token**；
- tenant、BYOK key 都在服务端 session 内存里；
- 浏览器每次请求自动带 cookie，包括 `EventSource`；
- 服务端 `requireAccess` 用 token 查 session，得到 `tenant`。

退出：

```js
sessions.delete(token);
res.clearCookie('access_token', { path: '/' });
```

浏览器收到过期的 `Set-Cookie` 后删除。

服务重启不会删除浏览器里的 cookie，只是服务端 `sessions` Map 没了。下次 `/api/session` 会返回 `authenticated: false`，前端用 localStorage 里的 `accessCode` 静默重登，换一个新 token。

为什么用 HttpOnly：

- XSS 读不到 token，不能直接把会话偷走；
- 但 XSS 仍然可以“借刀杀人”，用当前 cookie 调接口，所以 XSS 防护仍然重要。

为什么 token 里不放 tenant / key：

- cookie 每个请求都会带，越少越好；
- cookie 有 4KB 限制；
- key 放 cookie 等于暴露给浏览器；
- 服务端 session 可以随时撤销。

DevTools 查看：

```
Application → Cookies → 你的域名 → access_token
```

能看到 HttpOnly 勾选；在控制台 `document.cookie` 里看不到它。

### 3.14 localStorage

只有三个 key：

| key | 内容 | 写入时机 | 清除时机 |
|---|---|---|---|
| `accessCode` | 访问码原文 | 登录框提交成功 | 退出登录 |
| `theme` | `'dark'` / `'light'` | 切换主题 | 用户手动清 |
| `composerHeight` | 输入框高度（如 `'120px'`） | 拖动结束后 | 用户手动清 |

#### `accessCode`

```ts
// 登录成功
localStorage.setItem('accessCode', gateInput.trim());

// 退出
localStorage.removeItem('accessCode');
```

用途：

1. 页面初始化时判断“要不要尝试恢复登录”；
2. 服务端重启、session 丢失后，用它在后台静默重登；
3. `api.ts` 遇到 401 时自动重登一次。

为什么放 localStorage 而不是 cookie：

- HttpOnly cookie 由服务端管理，前端写不了；
- 服务端 session 在内存，重启就没了，需要一个本地凭证做静默重登；
- 放 localStorage 才能在刷新/重启后自动恢复。

代价：

- `accessCode` 是登录凭证，XSS 可以读；
- 它是“恢复用”的，不是主会话；主会话仍然是 HttpOnly cookie；
- 不建议再往 localStorage 放 key、token、对话内容。

#### `theme`

```ts
const [theme, setTheme] = useState(() => {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
});

useEffect(() => {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
}, [theme]);
```

#### `composerHeight`

```ts
// 初始化
const h = localStorage.getItem('composerHeight');
if (h && inputRef.current) inputRef.current.style.height = h;

// 拖动结束
localStorage.setItem('composerHeight', el.style.height);
```

#### localStorage 里**没有**的东西

| 数据 | 实际位置 |
|---|---|
| 对话 / 草稿 / 设置 | IndexedDB |
| 当前会话 id | IndexedDB `kv` |
| provider key | 服务端 session 内存 |
| 登录 token | HttpOnly cookie |
| runId / lastEventId | IndexedDB |

### 3.15 刷新时登录态怎么恢复

```
GET /api/config
  ↓
authRequired?
  ├─ 否 → GET /api/state → 进主界面
  └─ 是
       ↓
     localStorage.accessCode 存在?
       ├─ 否 → 显示访问码框
       └─ 是
            ↓
          GET /api/session
            ├─ authenticated: true  → 复用 cookie / 保留 BYOK key
            └─ authenticated: false → POST /api/auth(code)
                                        ├─ 成功 → Set-Cookie → /api/state
                                        └─ 失败 → 显示访问码框
```

两种凭证分工：

| 凭证 | 位置 | 作用 |
|---|---|---|
| `access_token` | HttpOnly cookie | 真正的会话，服务端认它 |
| `accessCode` | localStorage | 恢复会话用的“备用钥匙” |

一个细节：

- cookie 有效但 `accessCode` 被清 → 前端仍会显示访问码框，因为它只检查 localStorage；
- cookie 失效但 `accessCode` 在 → 自动重登，用户无感。

### 3.16 其他存储

| 存储 | 是否使用 | 说明 |
|---|---|---|
| `sessionStorage` | ❌ | 没有用；刷新会丢，不适合存会话 |
| `Cache Storage` | ❌ | 没有 Service Worker / 离线缓存 |
| `document.cookie` | ❌ | 只有 HttpOnly cookie，JS 读不到 |
| `window.name` | ❌ | 没有用 |
| React refs | ✅ | `esRef`、`convsRef`、`saveTimers` 等，只在内存 |
| 服务端 session | ✅ | 不属于浏览器存储，但和 cookie 配对 |

几个原则：

1. **业务数据放 IndexedDB**：对话、草稿、设置；
2. **UI 偏好放 localStorage**：theme、输入框高度；
3. **凭证优先 HttpOnly cookie**：JS 读不到；
4. **accessCode 是恢复凭证**：放 localStorage 是便利性和安全性的折中；
5. **不要往 localStorage 放 key/token/对话**。

---

## 4. 流式渲染性能

### 4.1 每个 delta 的渲染链

```
EventSource.onmessage
  ↓
JSON.parse(ev.data)
  ↓
onEvent → applyEvent
  ↓
patch → setConvs(next)
  ↓
React 重新渲染 App
  ↓
messages.map → <Message>
  ↓
parts.map → 最后一个 TextBlock
  ↓
ReactMarkdown 重新解析最后一个 text 块
  ↓
DOM 更新 → Layout → Paint
  ↓
useEffect 自动滚动
```

### 4.2 成本拆解

| 成本 | 说明 |
|---|---|
| `JSON.parse` | 每 token 一次，通常很小 |
| `applyEvent` | 复制 `messages` 数组，通常很小 |
| `setConvs` | 触发 App + 侧栏 + 消息列表重渲染 |
| `ReactMarkdown` | **最大头**：但只解析最后一个 text 块，前面的 TextBlock 被 memo |
| Layout | 自动滚动、消息高度变化 |
| IndexedDB | 每 400ms 序列化整条会话 |

### 4.3 当前实现的特点

`Message.tsx`：

```tsx
{current?.messages.map(m => <Message key={m.id} msg={m} />)}
```

`Message` 本身没有 `React.memo`，所以父组件每次渲染，所有 `Message` 都会重渲染。

但正文拆成了 `parts`：

```tsx
{parts.map((p, i) =>
  p.type === 'text'
    ? <TextBlock key={`text-${i}`} text={p.text} pending={Boolean(msg.pending)} />
    : <ToolPart key={`tool-${p.callId}`} msg={msg} callId={p.callId} />
)}
```

- `TextBlock` 是 `React.memo(Markdown)`；
- 流式时只有最后一个 text 块在变，前面的块不会重复解析；
- `ToolPart` 只是从 `msg.tools` 里查一次，开销很小。

`patch` 每次都会：

```ts
const next = convsRef.current.map(c => c.id === id ? fn(c) : c);
setConvs(next);
```

- `convs` 数组是新的；
- 侧栏 `convs.map` 也会重渲染；
- 目标 `Conv` 的 `messages` 数组是新的；
- 其他消息对象引用没变，但 `Message` 没有 memo，仍会重渲染；
- 真正省下的是它们内部的 Markdown 解析。

### 4.4 自动滚动

```ts
useEffect(() => {
  const el = messagesRef.current;
  if (!el || !stickRef.current) return;
  el.scrollTop = el.scrollHeight;
}, [current?.messages]);
```

每个 delta 都会：

- 读取 `scrollHeight`；
- 写 `scrollTop`；
- 触发布局。

如果用户往上翻，`stickRef` 为 false，不打扰。

「回到底部」按钮由 `showJump` 控制：

- 只有向底部方向滚动（`delta > 2`）时才显示；
- 往回滚（`delta < -2`）或接近底部时立即隐藏；
- 内容自动变长、程序滚动不会把按钮弹出来。

### 4.5 怎么测

#### Performance 面板

1. 开始录制；
2. 发一个长回答；
3. 停止；
4. 看：

- 红色长任务（>50ms）；
- Bottom-Up 里 `ReactMarkdown`、`remark`、`parse` 的自身耗时；
- `Recalculate Style` / `Layout` 频率；
- Event Log 过滤 `EventSourceMessageReceived`。

#### React DevTools Profiler

1. 打开 Profiler；
2. 录制一次流式回答；
3. 看：

- 哪些组件重渲染；
- `Message` 的渲染次数；
- 每次渲染耗时；
- 为什么渲染（props/state/context）。

#### Performance Monitor

`⋮` → More tools → Performance Monitor：

- Layouts / sec；
- DOM nodes；
- JS heap；
- CPU。

流式时 Layouts/sec 很高，说明每帧都在重排。

### 4.6 优化菜单

| 优化 | 收益 | 代价 |
|---|---|---|
| `React.memo(Message)` | 已完成消息不重渲染 | 需要稳定的 props 比较 |
| 只更新流式消息 | 大幅减少消息列表工作 | 需要拆分状态 |
| 50ms / rAF 节流 | 减少渲染次数 | 打字机效果变粗 |
| TextBlock memo（已做） | 前面的 text 块不重复解析 | parts 拆分，跨块 Markdown 可能退化 |
| 增量 Markdown | 最彻底 | 需要自己维护 AST/块 |
| 虚拟列表 | 长对话只渲染可视区 | 自动滚动和高度估算复杂 |
| 侧栏/面板 memo | 避免跟着 token 重渲染 | 需要拆分组件 |
| `content-visibility: auto` | 跳过屏外布局 | 兼容性和滚动高度问题 |
| Worker 解析 | 不阻塞主线程 | 通信和状态同步复杂 |

### 4.7 推荐的渐进路线

1. **先测量**，确认瓶颈在 Markdown 还是别的；
2. 给 `Message` 加 `React.memo`，比较 `msg` 引用；
3. 把侧栏拆成独立组件并 memo；
4. 对流式消息做 50ms 节流；
5. 再考虑增量渲染或虚拟列表。
6. 最后才考虑虚拟列表。

不要一上来就上虚拟列表，自动滚动和流式高度变化会让问题更复杂。

### 4.8 一个容易忽略的点

`Message.tsx` 每次渲染都会：

- 扫工具结果里的视频/图片 URL；
- 计算 `collectMedia`；
- 渲染 `ToolCard`（运行中的每秒 tick）；
- 渲染 sources / usage。

这些在长对话里也会累积。优化时不要只盯 Markdown。

---

## 5. SSE 的前端边界

### 5.1 EventSource 能力

| 能力 | 支持 |
|---|---|
| 自定义请求头 | ❌ |
| GET 以外的方法 | ❌ |
| 读取 status / headers | ❌ |
| 自动重连 | ✅ |
| 自动带 `Last-Event-ID` | ✅ |
| 同源自动带 cookie | ✅ |
| 跨域带 cookie | 需要 `withCredentials` + CORS |
| 设置超时 | ❌ |

所以：

- 鉴权只能靠 HttpOnly cookie；
- 断点只能靠 `Last-Event-ID` 或 `?last=`；
- 不能用 `Authorization` 头。

### 5.2 `openStream`

`src/api.ts`：

```ts
export function openStream(runId: string, last: number, onEvent: (e: StreamEvent) => void) {
  const es = new EventSource(`/api/chat/${runId}/stream?last=${last}`);
  let errors = 0;
  let finished = false;

  es.onmessage = ev => {
    errors = 0;
    try {
      const e = JSON.parse(ev.data) as StreamEvent;
      if (e.type === 'done' || e.type === 'error') finished = true;
      onEvent(e);
    } catch {}
  };

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
```

### 5.3 三个标记

| 变量 | 作用 |
|---|---|
| `errors` | 连续失败次数；收到任何消息就清零 |
| `finished` | 已收到 done/error；忽略后续 onerror |
| `readyState` | `CONNECTING` / `OPEN` / `CLOSED` |

为什么需要 `finished`：

```
服务端发 done → res.end()
浏览器触发 onerror（连接关闭）
如果不忽略，会给正常结束的回答挂一条“中断”
```

### 5.4 `readyState === CLOSED`

- `CONNECTING (0)`：正在连/重连；
- `OPEN (1)`：已连接；
- `CLOSED (2)`：浏览器不会再重连。

`CLOSED` 通常意味着：

- 服务端返回 404（run 过期）；
- 服务端返回非 200；
- 连接被永久关闭。

所以代码直接上报“记录已过期”。

### 5.5 自动重连

浏览器默认行为：

- 连接断开后自动重连；
- 重连时带 `Last-Event-ID`；
- `onerror` 在每次失败时触发；
- 重连间隔由浏览器决定（通常几秒）。

前端不需要自己写重连循环，但要：

- 区分“临时断线”和“永久失败”；
- 限制连续失败次数；
- 收到 `done` 后主动 `close()`，防止继续重连。

### 5.6 生命周期清理

| 场景 | 是否关闭 EventSource |
|---|---|
| 收到 `done` | ✅ |
| 收到 `error` | ✅ |
| 点「停止」 | ✅ |
| 切会话 | ✅ |
| 新建会话 | ✅ |
| 删除会话 | ✅ |
| 退出登录 | ✅ |
| 组件卸载 | ✅ |
| 浏览器离线 | ✅（保留 runId） |
| 恢复联网 | 重新 `resume` |

### 5.7 鉴权

cookie：

```ts
{ httpOnly: true, sameSite: 'lax', maxAge: TTL, path: '/' }
```

- 同源 EventSource 自动带 cookie；
- JS 读不到；
- 服务端 `requireAccess` 校验；
- 401 时 EventSource 会失败，前端显示错误。

不能用 `Authorization` 头，这是 EventSource 的硬限制。

### 5.8 代理与部署

SSE 需要：

```nginx
proxy_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

服务端还发了：

```js
'X-Accel-Buffering': 'no'
```

如果代理缓冲，症状是：

- 前端很久收不到 token；
- 最后一次性收到一大段；
- 或者连接被提前关闭。

开发环境 Vite 代理一般会透传 SSE，但长连接仍要确认超时。

### 5.9 连接数限制

HTTP/1.1 下，同一域名通常最多 **6 个连接**。

如果同时开很多标签页，每个标签页一条 SSE，可能占满连接，导致普通请求排队。

HTTP/2 多路复用可以缓解，但代理和浏览器实现要支持。

### 5.10 背压

服务端 `res.write()` 的返回值被忽略：

```js
res.write(`id: ...\n\n`);
```

如果前端渲染很慢，事件会在浏览器队列里堆积：

- 内存上涨；
- UI 看起来“卡一下，然后突然刷出一大段”。

所以流式渲染性能不只是体验问题，也会影响 SSE 消费。

### 5.11 常见失败现象

| 现象 | 可能原因 |
|---|---|
| 一直“生成中” | 没收到 done；检查 SSE 是否建立、服务端是否结束 |
| 回答重复 | lastEventId 没更新；检查 IndexedDB 写入 |
| 刷新后从头开始 | runId/lastEventId 没落盘 |
| 刷新后提示过期 | run 超过 30 分钟，或服务端重启 |
| 收到一大段才显示 | Nginx/代理缓冲 |
| 连接反复重连 | 服务端没发 done，或 404 被当成可重试 |
| 多个标签页互相影响 | 每个标签页有自己的 ES，不应共享；检查 cookie/session |

---

## 6. 数据结构

### 6.1 前端类型

```ts
type Role = 'user' | 'assistant' | 'system';

interface Conv {
  id: string;
  title: string;
  tenant?: string;
  messages: Msg[];
  draft?: string;
  runId?: string;
  lastEventId?: number;
  settings: Settings;
  createdAt: number;
  updatedAt: number;
}

interface Msg {
  id: string;
  role: Role;
  /** user 消息的正文 */
  content?: string;
  /** assistant 消息的正文与工具顺序 */
  parts?: MsgPart[];
  model?: string;
  sources?: Source[];
  tools?: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: string;
  pending?: boolean;
  stopped?: boolean;
  createdAt: number;
}

type MsgPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; callId: string };

/** assistant 拼 parts，user 用 content */
function msgText(m: Msg): string {
  if (m.role === 'assistant') {
    return (m.parts || [])
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('');
  }
  return m.content || '';
}

interface ToolCall {
  id: string;              // 对应 SSE 的 callId
  name: string;
  args: unknown;
  result?: string;
  status: 'running' | 'done' | 'error';
  startedAt?: number;
  finishedAt?: number;
}

interface Source {
  id: string;
  docName: string;
  text: string;
  score: number;
}

interface Settings {
  model: string;
  system: string;
  skills: string[];
  useRag: boolean;
  useVideo?: boolean;
  useImage?: boolean;
}
```

### 6.2 事件 → 字段

| SSE 事件 | 影响 |
|---|---|
| `delta` | 最后一个 text part 追加；如果最后是 tool part，就新建 text part |
| `tool_call` | `Msg.tools` 更新/追加 running；同时在 `parts` 追加 `{type:'tool', callId}` |
| `tool_result` | 对应 tool 写 `result` / `done`，不动 parts |
| `usage` | `Msg.usage` |
| `error` | `Msg.error`，`pending=false`，清 `Conv.runId` |
| `done` | `Msg.pending=false`，清 `Conv.runId` |

顶栏的 token 统计：对当前 `Conv.messages` 里所有 `usage.prompt_tokens` / `usage.completion_tokens` 求和。注意这是**按轮相加**，每轮的 `prompt_tokens` 都包含当时的历史，所以它接近真实计费口径，不等于“去重后的输入字数”。同一轮里如果有多个 Agent step（工具调用），服务端会把每个 step 的 usage 累加后再发，前端仍是覆盖；没有 `usage` 的消息跳过。

### 6.3 字段归属

| 字段 | 来源 | 是否落 IndexedDB |
|---|---|---|
| `Conv.id` | 前端生成 | ✅ |
| `Conv.title` | 第一条用户消息 | ✅ |
| `Conv.tenant` | 服务端 `/api/state` | ✅ |
| `Conv.runId` | `/api/chat` 响应 | ✅ |
| `Conv.lastEventId` | SSE 事件 | ✅ |
| `Msg.content` | user 消息正文 | ✅ |
| `Msg.parts` | assistant 的正文顺序（text / tool 引用） | ✅ |
| `Msg.tools` | tool 事件 | ✅ |
| `Msg.sources` | `/api/chat` 响应 | ✅ |
| `Msg.usage` | usage 事件 | ✅ |
| `Msg.pending` | 发送/结束 | ✅ |
| `Msg.stopped` | 点停止 | ✅ |

渲染时如果 `Msg.error` 包含「记录已过期」，即使 `usage` 还在，也不显示 token 行。手动停止只在收到 usage 时显示；没有 usage 就整行不显示，不显示问号。

---

## 7. 调试清单

### 7.1 看流

DevTools → Network → 过滤 **EventStream**：

- 看请求是否一直处于 pending；
- 点开 → EventStream 标签；
- 看每条 `data:` 的 `id` 和 `type`。

### 7.2 看断点

Application → IndexedDB → `ai-chat-mvp` → `conversations`：

- `runId` 是否还在；
- `lastEventId` 是否在增长；
- `pending` 是否正确。

### 7.3 模拟异常

| 场景 | 操作 |
|---|---|
| 断网 | DevTools Network → Offline |
| 刷新续传 | 长回答中途 F5 |
| 服务端重启 | `Ctrl+C` 重启，再刷新 |
| run 过期 | 等 30 分钟，或重启服务端 |
| 双击发送 | 快速按两次 Enter |
| 切会话 | 流式中点另一个会话，再切回 |

### 7.4 性能

- Performance 录制一次长回答；
- React Profiler 看 `Message`；
- Performance Monitor 看 Layouts/sec。

### 7.5 症状 → 先查

| 症状 | 先查 |
|---|---|
| 一直生成中 | EventStream 是否建立、是否收到 done |
| 刷新后从头开始 | IndexedDB 的 `runId` / `lastEventId` |
| 刷新后提示过期 | 服务端是否重启、run 是否超 30 分钟 |
| 回答重复 | `lastEventId` 是否和 parts 同一次写 |
| 切会话后原会话不更新 | 切回来是否 `resume` |
| 点停止还在生成 | 是否调了 `/cancel`、是否关闭 ES |
| 保存 key 失败 | 服务端能否访问厂商 `/models` |
| 长回答卡顿 | 最后一个 TextBlock 的 Markdown 解析、自动滚动 |

---

## 8. 自测题

**断流续传**

1. `lastEventId` 存在哪一层？为什么不是 `Msg`？
2. 为什么 `parts` 和 `lastEventId` 要同一次写 IndexedDB？
3. 刷新后前端怎么决定从哪个事件继续？
4. 为什么 `resume` 不先查 `/api/chat/:id`？
5. 工具卡片的位置由什么决定？回放时怎么避免重复？
6. 点停止后，服务端还会写 `done` 吗？前端为什么看不到？

**状态机**

7. `busy`、`offline`、`sendingRef` 各防什么？
8. 为什么 POST 在途时按钮还是「发送」？
9. 切会话时 `busy` 为什么要置 false？
10. 切走再切回，怎么恢复原来的流？
11. 双击发送会产生什么后果？

**IndexedDB**

12. 数据库有几个 store？key 分别是什么？
13. 哪些操作立即写，哪些 400ms debounce？
14. `flushConv` 在哪些时机调用？
15. 租户隔离靠什么字段？
16. 旧数据认领做了什么清理？
17. 为什么整条 `Conv` 覆盖写能保证原子性？

**Cookie / localStorage**

18. localStorage 存了哪些 key？退出登录会清哪个？
19. `accessCode` 为什么放 localStorage，而不是 cookie？
20. HttpOnly cookie 里存的是什么？JS 能读吗？
21. 为什么 cookie 里不直接放 tenant 和 BYOK key？
22. 刷新时登录态是怎么恢复的？

**流式渲染**

23. 每个 delta 触发了哪些渲染工作？
24. 为什么长回答会越来越卡？
25. 怎么用 Performance 证明瓶颈在 Markdown？
26. `TextBlock` 的 memo 能解决什么？`Message` 本身没 memo 会怎样？
27. 自动滚动为什么也会触发布局？

**SSE**

28. EventSource 为什么不能加 `Authorization` 头？
29. `finished` 标记解决什么问题？
30. `readyState === CLOSED` 代表什么？
31. 连续 5 次失败后为什么要放弃？
32. 为什么收到 `done` 后要主动 `close()`？
33. 代理缓冲会导致什么现象？

---

## 附：一句话总结

> 前端用 `runId + lastEventId` 接 SSE；assistant 正文用 `parts`（text / tool 引用）保存顺序，每个事件同时更新 parts 和断点并整条写入 IndexedDB，刷新后从断点回放；`busy` / `sendingRef` / `offline` 三个守卫负责并发和网络状态；登录态由 HttpOnly cookie 承载，localStorage 里的 `accessCode` 只用于服务端重启后的静默重登；流式渲染的主要成本是最后一个 TextBlock 的 Markdown 解析和自动滚动；EventSource 只能 GET + cookie，断线自动重连带 `Last-Event-ID`，收到 done 必须主动关闭。
