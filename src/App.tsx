import { useEffect, useRef, useState } from 'react';
import { api, openStream, type StreamEvent } from './api';
import { allConvs, claimLegacyConvs, delConv, deleteLegacyConvs, kvGet, kvSet, legacyConvs, putConv } from './db';
import { Message } from './components/Message';
import { RightPanel } from './components/RightPanel';
import type { AppConfig, Conv, Msg, Settings } from './types';
import { msgText } from './types';

const DEFAULT_SETTINGS: Settings = {
  model: '',
  system: '',
  skills: [],
  useRag: true,
  useVideo: false,
  useImage: false,
};

const uid = () => Math.random().toString(36).slice(2, 10);

/** 历史会话时间：今天 HH:mm，昨天「昨天」，今年 M月D日，更早 YYYY/M/D */
function formatConvTime(ts: number) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';

  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(d, now)) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return '昨天';

  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function providerOfModel(model: string, config: AppConfig | null) {
  const providers = config?.providers || [];
  const i = model.indexOf('/');
  return i > 0 ? providers.find((p) => p.id === model.slice(0, i)) : providers.find((p) => p.models.includes(model));
}

/** 顶栏 token 展示：1234 → 1.2k，1234567 → 1.2M */
function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function newConv(settings: Settings, tenant: string): Conv {
  const now = Date.now();
  return {
    id: uid(),
    title: '新对话',
    tenant,
    messages: [],
    settings: { ...settings },
    createdAt: now,
    updatedAt: now,
  };
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [authed, setAuthed] = useState(true);
  const [gateInput, setGateInput] = useState('');
  const [gateError, setGateError] = useState('');
  const [convs, setConvs] = useState<Conv[]>([]);
  const [legacyCount, setLegacyCount] = useState(0);
  const [currentId, setCurrentId] = useState('');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keys, setKeys] = useState<string[]>([]);
  const [panelOpen, setPanelOpen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > 1100 : true
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const [showJump, setShowJump] = useState(false);
  const draftRef = useRef('');
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false
  );
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState('');
  const recRef = useRef<any>(null);
  const speechBase = useRef('');
  const speechText = useRef('');
  const speechSession = useRef(0);
  const speechConvRef = useRef('');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  const esRef = useRef<EventSource | null>(null);
  const convsRef = useRef<Conv[]>([]);
  const currentIdRef = useRef('');
  // 当前正在 POST 的请求号，0 = 空闲。用序号而不是布尔：旧请求返回时不能解除新请求的锁
  const sendingRef = useRef(0);
  const sendSeqRef = useRef(0);
  const mcpAutoRef = useRef(false);
  const saveTimers = useRef<Record<string, number>>({});
  // 已删除的会话：迟到的 debounce / flush 不能把它们重新写回 IndexedDB
  const deletedRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastRefreshRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const current = convs.find((c) => c.id === currentId) || null;
  const activeTool =
    current?.messages.flatMap((m) => m.tools || []).find((t) => t.status === 'running') || null;

  // 当前会话累计 token：按轮相加（每轮的 prompt 都包含历史，属于真实计费口径）
  const usageTotal = (current?.messages || []).reduce(
    (acc, m) => {
      acc.input += m.usage?.prompt_tokens || 0;
      acc.output += m.usage?.completion_tokens || 0;
      return acc;
    },
    { input: 0, output: 0 }
  );
  const inputHistory = current
    ? current.messages
        .filter((m) => m.role === 'user' && msgText(m))
        .map((m) => msgText(m))
    : [];

  const activeProvider = providerOfModel(settings.model, config);
  const keyAvailable = Boolean(activeProvider && (activeProvider.hasKey || keys.includes(activeProvider.id)));
  const isMock = Boolean(config && (config.forceMock || (!keyAvailable && !config.hasAnyKey)));
  const speechSupported =
    typeof window !== 'undefined' &&
    Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  /* ---------------- 初始化 ---------------- */

  useEffect(() => {
    (async () => {
      const cfg = await api.config();

      // 先认证，再按 tenant 加载本地会话，避免把上一个访问码的历史读进来
      let authorized = true;
      let state: Pick<AppConfig, 'tenant' | 'skills' | 'documents' | 'mcpServers'> = {
        tenant: 'public',
        skills: [],
        documents: [],
        mcpServers: [],
      };

      if (cfg.authRequired) {
        const stored = localStorage.getItem('accessCode') || '';
        if (stored) {
          try {
            // 先探会话：cookie 有效就直接复用（保留 BYOK key）；
            // cookie 失效（例如服务重启）再静默重登，避免首屏先打一条 401。
            const session = await api.session();
            if (!session.authenticated) await api.auth(stored);
            state = await api.state();
            authorized = true;
          } catch {
            authorized = false;
          }
        } else {
          authorized = false;
        }
        setAuthed(authorized);
      } else {
        try {
          state = await api.state();
        } catch {
          /* 公开模式首次启动失败时保持空状态 */
        }
      }

      const tenant = state.tenant || 'public';
      let saved: Settings | undefined;
      let list: Conv[] = [];
      let legacy: Conv[] = [];
      let keyProviders: string[] = [];

      if (authorized) {
        [saved, list, legacy] = await Promise.all([
          kvGet<Settings>(`settings:${tenant}`),
          allConvs(tenant),
          legacyConvs(),
        ]);
        try {
          keyProviders = (await api.keyList()).providers;
        } catch {
          /* ignore */
        }
      }

      const init = { ...DEFAULT_SETTINGS, ...(saved || {}) };
      // 兼容旧版本的单选 skill
      const legacySkill = (saved as any)?.skill;
      if (!Array.isArray(init.skills)) init.skills = legacySkill ? [legacySkill] : [];
      // 保存的模型可能已经不在列表里（改过 providers.json），回退到第一个
      if (!init.model || !cfg.models.includes(init.model)) init.model = cfg.models[0] || '';
      // 服务端没配视频服务时，别让旧的 true 一直留着
      if (!cfg.video) init.useVideo = false;
      if (!cfg.image) init.useImage = false;

      // 设置迁移按租户各做一次
      if (authorized && saved?.v !== 2) {
        init.useRag = state.documents.length > 0;
        init.v = 2;
        kvSet(`settings:${tenant}`, init);
      }

      setConfig({ ...cfg, ...state, tenant });
      setSettings(init);
      setKeys(keyProviders);
      setLegacyCount(legacy.length);
      // 清理旧版本存在 IndexedDB 里的明文 key
      kvSet('providerKeys', null).catch(() => {});

      if (!authorized) {
        setConvs([]);
        convsRef.current = [];
        setCurrentId('');
        currentIdRef.current = '';
        return;
      }

      setConvs(list);
      convsRef.current = list;

      const lastId = await kvGet<string>(`currentId:${tenant}`);
      const target = list.find((c) => c.id === lastId) || list[0];
      if (target) {
        setCurrentId(target.id);
        currentIdRef.current = target.id;
        setInput(target.draft || '');
        // 恢复该会话自己的设置（否则会沿用上一个会话的 useVideo/useImage）
        if (target.settings) setSettings(target.settings);
        kvSet(`currentId:${tenant}`, target.id);
        // 启动时如果本来就没网，等 online 事件再续传，避免 EventSource 空转报错
        if (target.runId && navigator.onLine !== false) resume(target);
      } else {
        const c = newConv(init, tenant);
        setConvs([c]);
        convsRef.current = [c];
        setCurrentId(c.id);
        currentIdRef.current = c.id;
        kvSet(`currentId:${tenant}`, c.id);
        await putConv(c);
      }

      // 预设 MCP 默认自动连接（只补还没连上的，失败不影响正常聊天）
      void autoConnectPresets();
    })();
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 只有用户停在底部时才自动跟随；往上翻就不打扰
    const el = messagesRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [current?.messages]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  // 恢复上次手动拖拽的输入框高度
  useEffect(() => {
    const h = localStorage.getItem('composerHeight');
    if (h && inputRef.current) inputRef.current.style.height = h;
  }, []);

  // 让 window 事件回调拿到最新的 currentId
  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  // 移动端断点：关闭时直接卸载侧栏，不依赖 CSS transform 才能保证关得掉
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) setSidebarOpen(false);
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  useEffect(() => {
    const goOffline = () => {
      setOffline(true);
      if (!esRef.current) return;
      // DevTools 的 Offline 不会主动断开已经建立的 SSE，
      // 这里主动关掉；runId / lastEventId 保留，恢复联网后从断点续传。
      esRef.current.close();
      esRef.current = null;
    };

    const goOnline = () => {
      setOffline(false);
      const conv = convsRef.current.find((c) => c.id === currentIdRef.current);
      if (conv?.runId) resume(conv);
      void autoConnectPresets();
    };

    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
    // resume 内部只通过 ref 读取最新对话，首次渲染的闭包可以安全复用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 页面隐藏/关闭前把草稿和流式进度立刻落盘，不等 400ms debounce
  useEffect(() => {
    const flush = () => {
      if (currentIdRef.current) flushConv(currentIdRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 存储 ---------------- */

  function persist(conv: Conv, immediate = false) {
    clearTimeout(saveTimers.current[conv.id]);
    if (immediate) {
      if (!deletedRef.current.has(conv.id)) putConv(conv).catch(() => {});
      return;
    }
    saveTimers.current[conv.id] = window.setTimeout(() => {
      // 定时器可能在删除之后才触发，落盘前再确认一次
      if (deletedRef.current.has(conv.id)) return;
      putConv(conv).catch(() => {});
    }, 400);
  }

  function patch(id: string, fn: (c: Conv) => Conv, immediate = false) {
    // 用 ref 作为唯一真源，避免在 setState 的 updater 里做副作用
    const next = convsRef.current.map((c) => (c.id === id ? fn(c) : c));
    convsRef.current = next;
    setConvs(next);
    const target = next.find((c) => c.id === id);
    if (target) persist(target, immediate);
  }

  function patchMsg(convId: string, msgId: string, fn: (m: Msg) => Msg, immediate = false) {
    patch(
      convId,
      (c) => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)),
      }),
      immediate
    );
  }

  /** 更新输入框，并把草稿写回对应会话（默认当前会话） */
  function setComposer(value: string, convId = currentId) {
    setInput(value);
    if (!convId) return;
    patch(convId, (c) => (c.draft === value ? c : { ...c, draft: value }));
  }

  /** 切走之前立刻落盘，别把最后 400ms 的输入丢在 debounce 里 */
  function flushConv(id: string): Promise<void> {
    clearTimeout(saveTimers.current[id]);
    delete saveTimers.current[id];

    const conv = convsRef.current.find((c) => c.id === id);
    if (!conv || deletedRef.current.has(id)) return Promise.resolve();
    return putConv(conv).catch(() => {});
  }

  /* ---------------- 流式 ---------------- */

  function applyEvent(c: Conv, msgId: string, e: StreamEvent): Conv {
    const touch = (fn: (m: Msg) => Msg): Conv => ({
      ...c,
      lastEventId: e.id > 0 ? e.id : c.lastEventId,
      updatedAt: Date.now(),
      messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)),
    });

    switch (e.type) {
      case 'delta':
        return touch((m) => {
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
        return touch((m) => {
          const exists = (m.tools || []).some((t) => t.id === e.callId);

          const tools = exists
            ? (m.tools || []).map((t) =>
                t.id === e.callId
                  ? {
                      ...t,
                      name: e.name,
                      args: e.args,
                      status: 'running' as const,
                      startedAt: t.startedAt || e.at || Date.now(),
                    }
                  : t
              )
            : [
                ...(m.tools || []),
                {
                  id: e.callId,
                  name: e.name,
                  args: e.args,
                  status: 'running' as const,
                  startedAt: e.at || Date.now(),
                },
              ];

          const parts = [...(m.parts || [])];
          if (!parts.some((p) => p.type === 'tool' && p.callId === e.callId)) {
            parts.push({ type: 'tool', callId: e.callId });
          }

          return { ...m, tools, parts };
        });
      case 'tool_result':
        return touch((m) => ({
          ...m,
          tools: (m.tools || []).map((t) =>
            t.id === e.callId
              ? {
                  ...t,
                  result: e.result,
                  status: e.ok === false ? ('error' as const) : ('done' as const),
                  finishedAt: e.at || Date.now(),
                  interrupted: false,
                }
              : t
          ),
        }));
      case 'usage':
        return touch((m) => ({ ...m, usage: e.usage }));
      case 'error':
        return {
          ...touch((m) => ({
            ...m,
            error: e.message,
            pending: false,
            // 运行级错误（例如模型 500）也要收尾，避免工具卡片永远停在“执行中”
            tools: (m.tools || []).map((t) =>
              t.status === 'running'
                ? {
                    ...t,
                    status: 'error' as const,
                    result: t.result || '执行中断',
                    finishedAt: Date.now(),
                  }
                : t
            ),
          })),
          runId: undefined,
        };
      case 'done':
        return {
          ...c,
          lastEventId: e.id > 0 ? e.id : c.lastEventId,
          runId: undefined,
          updatedAt: Date.now(),
          messages: c.messages.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  pending: false,
                  // 兜底：正常流程工具都会先收到 tool_result；万一没收到也不能卡住
                  tools: (m.tools || []).map((t) =>
                    t.status === 'running'
                      ? {
                          ...t,
                          status: 'error' as const,
                          result: t.result || '工具未返回结果',
                          finishedAt: Date.now(),
                        }
                      : t
                  ),
                }
              : m
          ),
        };
      default:
        return c;
    }
  }

  function attach(convId: string, runId: string, msgId: string, last = 0) {
    esRef.current?.close();
    const es = openStream(runId, last, (e) => {
      if (e.type === 'done' || e.type === 'error') {
        es.close();
        if (esRef.current === es) esRef.current = null;
        setBusy(false);
        patch(convId, (c) => applyEvent(c, msgId, e), true);
        return;
      }
      // 内容与 lastEventId 在同一次更新里落库，避免续传时重复 token
      patch(convId, (c) => applyEvent(c, msgId, e));
    });
    esRef.current = es;
    setBusy(true);
  }

  /**
   * 接回一个还在服务端的 run。
   *
   * 不要先查 /api/chat/:id 再决定接不接：那个请求和真正建立 SSE 之间会漏事件，
   * 而且一旦 info.done 就放弃回放，服务端明明还留着 30 分钟的事件也拿不回来。
   * 这里一律从本地 lastEventId 接流，由服务端回放；run 已结束时服务端会补一个 done。
   */
  function resume(conv: Conv) {
    if (!conv.runId) return;

    const lastMsg =
      [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.pending) ||
      [...conv.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastMsg) {
      patch(conv.id, (c) => ({ ...c, runId: undefined, lastEventId: undefined }), true);
      return;
    }

    // 清掉上次恢复失败留下的提示；pending 让用户看到还在继续
    patchMsg(conv.id, lastMsg.id, (m) => ({ ...m, error: undefined, pending: true }), true);
    attach(conv.id, conv.runId, lastMsg.id, conv.lastEventId || 0);
  }

  /* ---------------- 操作 ---------------- */

  async function send() {
    const text = input.trim();
    // sendingRef 挡住 POST 返回前（busy 还没置 true）的第二次点击/Enter
    if (!text || !current || busy || offline || sendingRef.current) return;
    const seq = ++sendSeqRef.current;
    sendingRef.current = seq;

    const userMsg: Msg = { id: uid(), role: 'user', content: text, createdAt: Date.now() };
    const botMsg: Msg = {
      id: uid(),
      role: 'assistant',
      parts: [],
      model: settings.model,
      pending: true,
      createdAt: Date.now(),
    };

    const history = [...current.messages, userMsg]
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && msgText(m))
      .map((m) => ({ role: m.role, content: msgText(m) }));

    const convId = current.id;
    speechBase.current = '';
    speechSession.current += 1;
    speechConvRef.current = '';
    recRef.current?.stop();
    setInput('');
    setHistIdx(-1);
    draftRef.current = '';
    stickRef.current = true;
    setShowJump(false);

    patch(
      convId,
      (c) => ({
        ...c,
        title: c.messages.length ? c.title : text.slice(0, 20),
        updatedAt: Date.now(),
        messages: [...c.messages, userMsg, botMsg],
        draft: '',
        runId: undefined,
        lastEventId: 0,
      }),
      true
    );

    try {
      const res = await api.chat({
        messages: history,
        model: settings.model,
        system: settings.system,
        skills: settings.skills,
        useRag: settings.useRag,
        useVideo: settings.useVideo,
        useImage: settings.useImage,
      });

      if (!convsRef.current.some((c) => c.id === convId)) {
        // 会话在 POST 期间被删了：服务端 run 已经没人接，顺手取消，别白烧 token
        api.cancel(res.runId).catch(() => {});
        return;
      }

      if (res.sources?.length) {
        patchMsg(convId, botMsg.id, (m) => ({ ...m, sources: res.sources }));
      }
      patch(convId, (c) => ({ ...c, runId: res.runId, lastEventId: 0 }), true);
      // 如果用户在 POST 期间切走了，不要把流接到新会话上；
      // runId 已经写到原会话，切回去时 resume 会从 0 回放。
      if (currentIdRef.current === convId) {
        attach(convId, res.runId, botMsg.id, 0);
      }
    } catch (e: any) {
      if (e?.status === 401) {
        setAuthed(false);
        setGateError('访问码已失效，请重新输入');
      }
      patchMsg(convId, botMsg.id, (m) => ({ ...m, error: e.message, pending: false }), true);
      // 迟到的失败不能关掉别的会话正在进行的 busy
      if (currentIdRef.current === convId && sendingRef.current === seq) setBusy(false);
    } finally {
      // A 的请求返回时 B 可能已经在发，只清自己这把锁
      if (sendingRef.current === seq) sendingRef.current = 0;
    }
  }

  async function stop() {
    const convId = currentId;
    const runId = current?.runId;

    esRef.current?.close();
    esRef.current = null;
    setBusy(false);
    // 停流后允许立刻再发一条（POST 已返回才会走到这里，重置无副作用）
    sendingRef.current = 0;

    // 取消后服务端不会再补 done，必须在这里收尾：
    // 否则 content 还是空的 assistant 消息会一直渲染三个点
    patch(
      convId,
      (c) => ({
        ...c,
        runId: undefined,
        lastEventId: undefined,
        updatedAt: Date.now(),
        messages: c.messages.map((m) =>
          m.role === 'assistant'
            ? {
                ...m,
                ...(m.pending ? { pending: false, stopped: true } : {}),
                tools: (m.tools || []).map((t) =>
                  t.status === 'running'
                    ? {
                        ...t,
                        status: 'error' as const,
                        interrupted: true,
                        result: t.result || '已中断',
                        finishedAt: Date.now(),
                      }
                    : t
                ),
              }
            : m
        ),
      }),
      true
    );

    if (runId) await api.cancel(runId).catch(() => {});
  }

  function onCreate() {
    if (currentId) flushConv(currentId);
    setSidebarOpen(false);
    esRef.current?.close();
    setBusy(false);
    speechBase.current = '';
    speechSession.current += 1;
    speechConvRef.current = '';
    recRef.current?.stop();
    setInput('');
    setHistIdx(-1);
    stickRef.current = true;
    setShowJump(false);
    const c = newConv(settings, config?.tenant || 'public');
    setConvs((prev) => [c, ...prev]);
    convsRef.current = [c, ...convsRef.current];
    setCurrentId(c.id);
    currentIdRef.current = c.id;
    kvSet(`currentId:${config?.tenant || 'public'}`, c.id);
    putConv(c).catch(() => {});
  }

  /** 切到某个会话：恢复它的草稿、设置，并接回还没结束的流 */
  function activateConv(c: Conv) {
    speechBase.current = '';
    speechSession.current += 1;
    speechConvRef.current = '';
    recRef.current?.stop();
    setHistIdx(-1);
    stickRef.current = true;
    setShowJump(false);

    setInput(c.draft || '');
    // 每个会话保存了自己的设置，切过去时要恢复，避免沿用上一个会话的开关
    if (c.settings) setSettings(c.settings);

    setCurrentId(c.id);
    currentIdRef.current = c.id;
    kvSet(`currentId:${config?.tenant || 'public'}`, c.id);

    // 离线时先不接流，等 online 事件统一恢复；否则 EventSource 会连续失败并误报“记录过期”
    if (c.runId && !offline) resume(c);
  }

  function onSelect(id: string) {
    if (currentId && currentId !== id) flushConv(currentId);
    setSidebarOpen(false);
    esRef.current?.close();
    esRef.current = null;
    setBusy(false);

    const c = convsRef.current.find((x) => x.id === id);
    if (!c) return;
    activateConv(c);
  }

  async function onDelete(id: string) {
    const isCurrent = id === currentIdRef.current;
    const target = convsRef.current.find((c) => c.id === id);

    // 只取消被删会话自己的 run；当前会话的 SSE 不能因为删别的会话被关掉
    if (target?.runId) api.cancel(target.runId).catch(() => {});

    // 顺序很重要：先掐掉 400ms debounce，再打墓碑，最后才删
    clearTimeout(saveTimers.current[id]);
    delete saveTimers.current[id];
    deletedRef.current.add(id);

    if (isCurrent) {
      esRef.current?.close();
      esRef.current = null;
      setBusy(false);
      // 只放开被删会话的发送锁；它那个 POST 返回时不会影响下一条会话
      sendingRef.current = 0;
    }

    await delConv(id);

    const rest = convsRef.current.filter((c) => c.id !== id);
    convsRef.current = rest;
    setConvs(rest);

    // 删的不是当前会话：当前流、输入框、busy 都不动
    if (!isCurrent) return;

    const next = rest[0] || newConv(settings, config?.tenant || 'public');
    if (!rest.length) {
      convsRef.current = [next];
      setConvs([next]);
      putConv(next).catch(() => {});
    }

    // 和手动切会话走同一条路径：恢复设置、草稿，并 resume 下一条还在跑的 run
    activateConv(next);
  }

  function updateSettings(s: Settings) {
    setSettings(s);
    kvSet(`settings:${config?.tenant || 'public'}`, s);
    if (currentId) patch(currentId, (c) => ({ ...c, settings: s }));
  }

  async function claimLegacy() {
    const tenant = config?.tenant || 'public';
    const n = await claimLegacyConvs(tenant);
    if (!n) {
      setLegacyCount(0);
      return;
    }
    const list = await allConvs(tenant);
    setConvs(list);
    convsRef.current = list;
    setLegacyCount(0);
    const stillThere = list.some((c) => c.id === currentId);
    if (!stillThere && list[0]) {
      setCurrentId(list[0].id);
      currentIdRef.current = list[0].id;
      setInput(list[0].draft || '');
      kvSet(`currentId:${tenant}`, list[0].id);
    }
  }

  async function deleteLegacy() {
    await deleteLegacyConvs();
    setLegacyCount(0);
  }

  async function logout() {
    esRef.current?.close();
    esRef.current = null;
    setBusy(false);
    // 退出前把当前草稿同步落盘；即使 IndexedDB 写失败也不能卡住退出
    try {
      if (currentIdRef.current) await flushConv(currentIdRef.current);
    } catch {}
    await api.logout().catch(() => {});
    localStorage.removeItem('accessCode');
    window.location.reload();
  }

  async function saveProviderKey(provider: string, key: string) {
    const r = await api.saveKey(provider, key);
    setKeys(r.providers);
  }

  async function deleteProviderKey(provider: string) {
    const r = await api.deleteKey(provider);
    setKeys(r.providers);
  }

  async function submitGate(e: React.FormEvent) {
    e.preventDefault();
    setGateError('');
    try {
      await api.auth(gateInput.trim());
      localStorage.setItem('accessCode', gateInput.trim());
      // 重新走 init，按新租户加载会话/设置，避免复用上一个码的内存状态
      window.location.reload();
    } catch (err: any) {
      setGateError(err.message || '访问码不正确');
    }
  }

  function flashSpeechError(text: string) {
    setSpeechError(text);
    window.setTimeout(() => setSpeechError(''), 4000);
  }

  function toggleSpeech() {
    if (!speechSupported) return;

    if (listening) {
      recRef.current?.stop();
      return;
    }

    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;

    speechBase.current = input;
    speechText.current = input;
    const convId = currentId;
    const session = ++speechSession.current;
    speechConvRef.current = convId;
    let ended = false;

    rec.onresult = (e: any) => {
      if (speechSession.current !== session || speechConvRef.current !== convId) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) speechBase.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      const text = speechBase.current + interim;
      speechText.current = text;
      setComposer(text, convId);
    };

    rec.onerror = (e: any) => {
      const map: Record<string, string> = {
        'not-allowed': '麦克风权限被拒绝，检查浏览器或系统设置',
        'service-not-allowed': '麦克风权限被拒绝',
        'no-speech': '没听到声音，再试一次',
        network:
          navigator.onLine === false
            ? '网络已断开，语音识别需要联网'
            : '浏览器语音服务不可达：Chrome 依赖 Google 在线识别，可换 Edge 或配置服务端识别',
        aborted: '',
      };
      const msg = map[e.error] ?? `语音识别失败：${e.error}`;
      if (msg) flashSpeechError(msg);
    };

    rec.onend = () => {
      if (ended) return;
      ended = true;
      setListening(false);
      recRef.current = null;
      if (speechSession.current !== session || speechConvRef.current !== convId) return;

      // Chrome 有时在 onend 之后才补最后一条 result。
      // 先把当前可见内容（含 interim）落下来，并留 500ms 接收尾包；
      // 不能立刻清 speechConvRef，否则尾包会被 guard 丢掉，表现为输入框被清空。
      const text = speechText.current || inputRef.current?.value || speechBase.current;
      speechText.current = text;
      setComposer(text, convId);

      window.setTimeout(() => {
        if (speechSession.current === session && speechConvRef.current === convId) {
          speechConvRef.current = '';
        }
      }, 500);
    };

    recRef.current = rec;
    setSpeechError('');
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      flashSpeechError('无法启动语音识别');
    }
  }

  /** 从输入框上边缘拖动调整高度（向上拖变高） */  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    const el = inputRef.current;
    if (!el) return;

    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const max = window.innerHeight * 0.6;

    const onMove = (ev: PointerEvent) => {
      const h = Math.min(max, Math.max(76, startH - (ev.clientY - startY)));
      el.style.height = `${h}px`;
    };
    const onUp = () => {
      localStorage.setItem('composerHeight', el.style.height);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** 预设 MCP 默认自动连接：只补没连上的，失败不阻塞页面 */
  async function autoConnectPresets() {
    if (mcpAutoRef.current || navigator.onLine === false) return;

    mcpAutoRef.current = true;
    try {
      const [cfg, state] = await Promise.all([api.config(), api.state()]);
      const connected = new Set(state.mcpServers.map((s) => s.url));
      const missing = (cfg.mcpPresets || []).filter((p) => !connected.has(p.url));
      if (!missing.length) return;

      await Promise.allSettled(missing.map((p) => api.connectMcp({ url: p.url, name: p.name })));

      const fresh = await api.state();
      setConfig((prev) => (prev ? { ...prev, mcpServers: fresh.mcpServers } : prev));
    } catch {
      // 某个预设不可达就静默跳过，MCP 面板里仍可手动连接
    } finally {
      mcpAutoRef.current = false;
    }
  }

  const refresh = async () => {
    const cfg = await api.config();
    try {
      const state = await api.state();
      setConfig({ ...cfg, ...state });
    } catch {
      setConfig(cfg);
    }
  };

  // 服务端重启/切标签页回来时，同步一次 state，避免 MCP 面板一直显示旧连接
  useEffect(() => {
    const maybeRefresh = () => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastRefreshRef.current < 5000) return;
      lastRefreshRef.current = Date.now();
      void refresh();
    };

    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', maybeRefresh);
    return () => {
      window.removeEventListener('focus', maybeRefresh);
      document.removeEventListener('visibilitychange', maybeRefresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 渲染 ---------------- */

  if (!config) {
    return <div className="boot">加载中…</div>;
  }

  if (config.authRequired && !authed) {
    return (
      <div className="gate">
        <form className="gate-card" onSubmit={submitGate}>
          <div className="gate-logo">✦</div>
          <h1>AI Chat MVP</h1>
          <p>请输入访问码</p>
          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={gateInput}
            placeholder="访问码"
            onChange={(e) => setGateInput(e.target.value)}
          />
          {gateError && <div className="gate-error">{gateError}</div>}
          <button className="send" type="submit">进入</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      {(!isMobile || sidebarOpen) && (
        <aside
          className={`sidebar ${sidebarOpen ? 'open' : ''}`}
          style={
            isMobile
              ? {
                  position: 'fixed',
                  top: 56,
                  left: 0,
                  bottom: 0,
                  zIndex: 30,
                  width: 'min(84vw, 280px)',
                  transform: 'translateX(0)',
                  background: 'var(--panel)',
                }
              : undefined
          }
        >
          <div className="brand">
            <span className="logo">✦</span>
            <div>
              <b>AI Chat MVP</b>
              <small title={settings.model || ''}>
                {isMock ? 'Mock · ' : ''}
                {settings.model || '未选择模型'}
              </small>
            </div>
            <button
              className="icon sidebar-close"
              style={isMobile ? { display: 'block' } : undefined}
              onClick={() => setSidebarOpen(false)}
              aria-label="关闭会话列表"
            >
              ×
            </button>
          </div>

        <button className="new" onClick={onCreate}>+ 新对话</button>

        {legacyCount > 0 && (
          <div className="legacy" title="旧版本会话没有租户信息，可能属于另一个访问码">
            <span>{legacyCount} 个旧会话未归属</span>
            <div className="legacy-actions">
              <button onClick={claimLegacy}>归到当前</button>
              <button onClick={deleteLegacy}>删除</button>
            </div>
          </div>
        )}

        <div className="conv-list">
          {convs.map((c) => {
            const ts = c.updatedAt || c.createdAt || 0;
            return (
              <div key={c.id} className={`conv ${c.id === currentId ? 'on' : ''}`}>
                <button
                  className="conv-main"
                  onClick={() => onSelect(c.id)}
                  title={`最后更新：${new Date(ts).toLocaleString('zh-CN', { hour12: false })}`}
                >
                  <span className="conv-title">{c.title}</span>
                  {c.runId && <i className="live" />}
                  <time className="conv-time" dateTime={new Date(ts).toISOString()}>
                    {formatConvTime(ts)}
                  </time>
                </button>
                <button className="icon" onClick={() => onDelete(c.id)}>×</button>
              </div>
            );
          })}
        </div>

        <div className="sidebar-foot">
          <span>{config?.documents.length || 0} 文档</span>
          <span>{config?.skills.length || 0} Skill</span>
          <span>{config?.mcpServers.length || 0} MCP</span>
          {config?.authRequired && (
            <button className="logout" onClick={logout} title="退出当前访问码">退出</button>
          )}
        </div>
        </aside>
      )}

      {isMobile && sidebarOpen && (
        <div
          className="sidebar-backdrop"
          style={{
            position: 'fixed',
            top: 56,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 20,
            background: 'rgba(0, 0, 0, .45)',
            display: 'block',
          }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="main">
        <header className="topbar">
          {isMobile && (
            <button
              className="ghost icon-btn menu-btn"
              style={{ display: 'grid' }}
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? '关闭会话列表' : '打开会话列表'}
              aria-expanded={sidebarOpen}
            >
              {sidebarOpen ? '×' : '☰'}
            </button>
          )}
          <div className="topbar-title">
            <b>{current?.title || '新对话'}</b>
            <small>
              {settings.model || '未选模型'}
              {settings.useRag ? ' · RAG' : ''}
              {settings.useVideo ? ' · 视频' : ''}
              {settings.useImage ? ' · 图片' : ''}
              {settings.skills.length ? ` · ${settings.skills.length} 个 Skill` : ''}
            </small>
          </div>
          <div className="topbar-actions">
            {usageTotal.input + usageTotal.output > 0 && (
              <div
                className="topbar-usage"
                title={`本会话累计（按轮相加）：输入 ${usageTotal.input.toLocaleString('en-US')} tokens，输出 ${usageTotal.output.toLocaleString('en-US')} tokens`}
                aria-label={`本会话累计输入 ${usageTotal.input} tokens，输出 ${usageTotal.output} tokens`}
              >
                <span className="label">tokens</span>
                <span className="in">↑ {formatTokens(usageTotal.input)}</span>
                <span className="out">↓ {formatTokens(usageTotal.output)}</span>
              </div>
            )}
            <button
              className="ghost icon-btn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? '切换到白天' : '切换到黑夜'}
              aria-label="切换主题"
            >
              {theme === 'dark' ? '☀' : '🌙'}
            </button>
            <button className="ghost" onClick={() => setPanelOpen((v) => !v)}>
              {panelOpen ? '收起设置' : '打开设置'}
            </button>
          </div>
        </header>

        <div className="messages-wrap">
          <div
            className="messages"
            ref={messagesRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const top = el.scrollTop;
              const delta = top - lastScrollTopRef.current;
              lastScrollTopRef.current = top;

              const near = el.scrollHeight - top - el.clientHeight < 80;
              stickRef.current = near;

              // 接近底部：不显示
              if (near) {
                setShowJump(false);
                return;
              }

              // 只有向底部方向滚动（滚轮向下）才显示；
              // 往回滚立即隐藏，内容自动变长也不会弹出。
              if (delta > 2) setShowJump(true);
              else if (delta < -2) setShowJump(false);
            }}
          >
            {!current?.messages.length && (
              <div className="empty">
                <h2>开始一段对话</h2>
                <p>上传文档 → 打开 RAG → 选一个 Skill，试试「按合同审查流程看这份协议」。</p>
              </div>
            )}

            {current?.messages.map((m) => <Message key={m.id} msg={m} />)}
          </div>

          {showJump && (
            <button
              className="jump-bottom"
              onClick={() => {
                stickRef.current = true;
                setShowJump(false);
                const el = messagesRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
            >
              ↓ 回到底部
            </button>
          )}
        </div>

        <div className="composer-wrap">
          {offline && (
            <div className="offline-hint">
              网络已断开{current?.runId ? '，恢复后会自动续传' : ''}
            </div>
          )}
          {activeTool && (
            <div className="run-hint">
              <span className="run-dot" />
              正在执行 <code>{activeTool.name}</code>
              {/^generate_(video|image)$/.test(activeTool.name) ? ' · 长任务，请勿关闭页面' : ''}
            </div>
          )}
          <div className="drag-handle" onPointerDown={startDrag} title="拖动调整输入框高度" />
          <div className="composer">
            <textarea
              ref={inputRef}
              value={input}
              rows={3}
              placeholder="输入问题，Enter 发送，Shift+Enter 换行"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              onChange={(e) => {
                setComposer(e.target.value);
                setHistIdx(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' && (input === '' || histIdx >= 0)) {
                  if (!inputHistory.length) return;
                  e.preventDefault();
                  if (histIdx === -1) draftRef.current = input;
                  const next = Math.min(inputHistory.length - 1, histIdx + 1);
                  const text = inputHistory[inputHistory.length - 1 - next];
                  setHistIdx(next);
                  setComposer(text);
                  requestAnimationFrame(() => inputRef.current?.setSelectionRange(text.length, text.length));
                  return;
                }
                if (e.key === 'ArrowDown' && histIdx >= 0) {
                  e.preventDefault();
                  if (histIdx === 0) {
                    setHistIdx(-1);
                    setComposer(draftRef.current);
                  } else {
                    const next = histIdx - 1;
                    const text = inputHistory[inputHistory.length - 1 - next];
                    setHistIdx(next);
                    setComposer(text);
                    requestAnimationFrame(() => inputRef.current?.setSelectionRange(text.length, text.length));
                  }
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {speechSupported && (
              <button
                className={`mic ${listening ? 'on' : ''}`}
                onClick={toggleSpeech}
                title={listening ? '停止语音输入' : '语音输入'}
                aria-label="语音输入"
              >
                {listening ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="7" y="7" width="10" height="10" rx="2" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="2" width="6" height="12" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                    <line x1="8" y1="22" x2="16" y2="22" />
                  </svg>
                )}
              </button>
            )}
            {busy ? (
              <button className="stop" onClick={stop}>停止</button>
            ) : (
              <button className="send" onClick={send} disabled={!input.trim() || offline}>发送</button>
            )}
          </div>
          {speechError && <div className="speech-error">{speechError}</div>}
        </div>
      </main>

      <RightPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        config={config}
        settings={settings}
        onChange={updateSettings}
        keys={keys}
        onSaveKey={saveProviderKey}
        onDeleteKey={deleteProviderKey}
        refresh={refresh}
      />
    </div>
  );
}
