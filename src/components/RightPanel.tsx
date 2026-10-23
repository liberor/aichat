import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import type { AppConfig, Settings } from '../types';

type Tab = 'agent' | 'skills' | 'docs' | 'mcp';

const SKILL_TEMPLATE = `# 目标

一句话说明这个 Skill 要完成什么。

## 适用场景

- 用户要求……
- 输入包含……
- 不适用：……

## 步骤

1. 确认输入、范围和约束
2. 按顺序处理，必要时引用资料
3. 自检后按输出格式给出结果

## 规则

- 必须……
- 禁止……
- 信息不足时明确说明，不要编造

## 输出格式

1. 结论：一句话
2. 依据：分条列出
3. 建议：下一步做什么

## 示例

输入：……
输出：……
`;

interface Props {
  open: boolean;
  onClose: () => void;
  config: AppConfig | null;
  settings: Settings;
  onChange: (s: Settings) => void;
  keys: string[];
  onSaveKey: (provider: string, key: string) => Promise<void>;
  onDeleteKey: (provider: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function RightPanel({ open, onClose, config, settings, onChange, keys, onSaveKey, onDeleteKey, refresh }: Props) {
  const [tab, setTab] = useState<Tab>('agent');

  if (!open) return null;

  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="tabs">
          <button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}>助手</button>
          <button className={tab === 'skills' ? 'on' : ''} onClick={() => setTab('skills')}>Skill</button>
          <button className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>知识库</button>
          <button className={tab === 'mcp' ? 'on' : ''} onClick={() => setTab('mcp')}>MCP</button>
        </div>
        <button className="icon" onClick={onClose} title="关闭">×</button>
      </div>

      <div className="panel-body">
        {tab === 'agent' && (
          <AgentTab
            config={config}
            settings={settings}
            onChange={onChange}
            keys={keys}
            onSaveKey={onSaveKey}
            onDeleteKey={onDeleteKey}
          />
        )}
        {tab === 'skills' && <SkillsTab config={config} settings={settings} onChange={onChange} refresh={refresh} />}
        {tab === 'docs' && <DocsTab config={config} refresh={refresh} />}
        {tab === 'mcp' && <McpTab config={config} refresh={refresh} />}
      </div>
    </aside>
  );
}

function AgentTab({
  config,
  settings,
  onChange,
  keys,
  onSaveKey,
  onDeleteKey,
}: {
  config: AppConfig | null;
  settings: Settings;
  onChange: (s: Settings) => void;
  keys: string[];
  onSaveKey: (provider: string, key: string) => Promise<void>;
  onDeleteKey: (provider: string) => Promise<void>;
}) {
  const providers = config?.providers || [];
  const slash = settings.model.indexOf('/');
  const provider =
    slash > 0
      ? providers.find((p) => p.id === settings.model.slice(0, slash))
      : providers.find((p) => p.models.includes(settings.model));

  const needsKey = Boolean(provider && !provider.hasKey);
  const hasUserKey = Boolean(provider && keys.includes(provider.id));

  /**
   * 统一状态：当前模型到底能不能用、key 从哪来。
   * 判断顺序和服务端 /api/chat 保持一致：强制 Mock > 用户 key > 服务端 key。
   */
  const status = (() => {
    if (!settings.model) {
      return { tone: 'idle', label: '未选择模型', hint: '先选择一个模型。' };
    }
    if (!provider) {
      return {
        tone: 'error',
        label: '未找到 provider',
        hint: `模型 ${settings.model} 不在 providers.json 里，检查配置后重启服务。`,
      };
    }
    if (config?.forceMock) {
      return { tone: 'mock', label: 'Mock 模式', hint: '服务端设置了 MOCK=1，回复是模拟数据。' };
    }
    if (hasUserKey) {
      return {
        tone: 'ok',
        label: '已就绪 · 你的 key',
        hint: `${provider.id} 使用你本次会话填写的 key，只存在服务端内存，浏览器不保存。`,
      };
    }
    if (provider.hasKey) {
      return {
        tone: 'ok',
        label: '已就绪 · 服务端 key',
        hint: `${provider.id} 使用服务端配置的 key。`,
      };
    }
    if (!config?.hasAnyKey) {
      return {
        tone: 'mock',
        label: 'Mock 模式',
        hint: '服务端没有任何可用的 provider key，回复是模拟数据；填入自己的 key 后可调用真实模型。',
      };
    }
    return {
      tone: 'warn',
      label: '需要 key',
      hint: `服务端没有 ${provider.id} 的 key，填入你自己的 key 才能发送。`,
    };
  })();

  const keyHint =
    provider?.id === 'gemini'
      ? 'AIza...'
      : provider?.id === 'openrouter'
        ? 'sk-or-v1-...'
        : provider?.id === 'azure'
          ? '32 位十六进制'
          : 'sk-...';

  return (
    <>
      <label className="field">
        <span>模型</span>
        <select value={settings.model} onChange={(e) => onChange({ ...settings, model: e.target.value })}>
          {(config?.models || []).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </label>

      <div className={`provider-status ${status.tone}`}>
        <span className="dot" />
        <div>
          <b>{status.label}</b>
          <span>{status.hint}</span>
        </div>
      </div>

      {needsKey && provider && !hasUserKey && (
        <KeyInput provider={provider.id} placeholder={keyHint} onSave={(k) => onSaveKey(provider.id, k)} />
      )}
      {needsKey && hasUserKey && provider && (
        <div className="key-saved">
          <span>已保存 {provider.id} 的 key（服务端会话）</span>
          <button onClick={() => onDeleteKey(provider.id)}>删除</button>
        </div>
      )}

      <label className="field">
        <span>System Prompt</span>
        <textarea
          className="system-input"
          rows={6}
          value={settings.system}
          placeholder="你是一个严谨的技术助手。回答前先确认概念边界……"
          onChange={(e) => onChange({ ...settings, system: e.target.value })}
        />
      </label>

      <div className="field">
        <span>Skill</span>
        <div className="skill-picker">
          {(config?.skills || []).map((s) => {
            const on = settings.skills.includes(s.name);
            return (
              <label key={s.name} className={`skill-opt ${on ? 'on' : ''}`} title={s.description}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && settings.skills.length >= 5}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? settings.skills.length >= 5
                        ? settings.skills
                        : [...settings.skills, s.name]
                      : settings.skills.filter((x) => x !== s.name);
                    onChange({ ...settings, skills: next });
                  }}
                />
                {s.name}
              </label>
            );
          })}
          {!config?.skills?.length && <p className="hint">还没有 Skill</p>}
          {settings.skills.length >= 5 && <p className="hint">最多同时加载 5 个</p>}
        </div>
      </div>

      <div className="toggles">
        <label className={config?.documents.length ? '' : 'disabled'}>
          <input
            type="checkbox"
            disabled={!config?.documents.length}
            checked={settings.useRag}
            onChange={(e) => onChange({ ...settings, useRag: e.target.checked })}
          />
          文档检索（RAG）{config?.documents.length ? '' : ' · 知识库为空'}
        </label>

        <label className={config?.video ? '' : 'disabled'}>
          <input
            type="checkbox"
            disabled={!config?.video}
            checked={Boolean(settings.useVideo && config?.video)}
            onChange={(e) => onChange({ ...settings, useVideo: e.target.checked })}
          />
          视频生成{config?.video ? `（${(config.videoModels || []).join(' / ') || config.videoModel}）` : ' · 未配置 DASHSCOPE_API_KEY'}
        </label>

        <label className={config?.image ? '' : 'disabled'}>
          <input
            type="checkbox"
            disabled={!config?.image}
            checked={Boolean(settings.useImage && config?.image)}
            onChange={(e) => onChange({ ...settings, useImage: e.target.checked })}
          />
          图片生成{config?.image ? `（${(config.imageModels || []).join(' / ') || config.imageModel}）` : ' · 未配置 DASHSCOPE_API_KEY'}
        </label>
      </div>

      {((settings.useVideo && config?.video) || (settings.useImage && config?.image)) && (
        <div className="hint warn media-hints">
          {settings.useVideo && config?.video && (
            <p>视频：分辨率 480P/720P，总时长 5 秒。需要 1-5 分钟。</p>
          )}
          {settings.useImage && config?.image && (
            <p>
              图片：一次可生成 1-4 张，默认 {config.imageSize || '1024*1024'}，需要 10-30 秒。
            </p>
          )}
        </div>
      )}
    </>
  );
}

function SkillsTab({
  config,
  settings,
  onChange,
  refresh,
}: {
  config: AppConfig | null;
  settings: Settings;
  onChange: (s: Settings) => void;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [msg, setMsg] = useState('');

  async function load(n: string) {
    const s = await api.skill(n);
    setName(s.name);
    setDescription(s.description);
    setBody(s.body);
    setMsg('');
  }

  async function save() {
    const n = name.trim();
    const d = description.trim();

    // 名称/描述为空时直接提示，不发请求
    if (!n || !d) {
      setMsg('请先填写名称和描述');
      return;
    }

    try {
      await api.saveSkill({ name: n, description: d, body });
      await refresh();
      setMsg('已保存');
    } catch (e: any) {
      setMsg(e.message);
    }
  }

  async function remove(n: string) {
    await api.deleteSkill(n);
    if (settings.skills.includes(n)) {
      onChange({ ...settings, skills: settings.skills.filter((x) => x !== n) });
    }
    await refresh();
  }

  return (
    <>
      <div className="list">
        {(config?.skills || []).map((s) => (
          <div key={s.name} className="row">
            <button className="row-main" onClick={() => load(s.name)} title={s.description || s.name}>
              <b>{s.name}</b>
              <small>{s.description || '无描述'}</small>
            </button>
            <button className="icon" onClick={() => remove(s.name)}>×</button>
          </div>
        ))}
        {!config?.skills?.length && <p className="hint">还没有 Skill。新建一个试试。</p>}
      </div>

      <div className="divider" />

      <label className="field">
        <span>名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="contract-review" />
      </label>
      <label className="field">
        <span>描述</span>
        <textarea
          className="skill-desc"
          rows={3}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="审查合同风险。当用户要求审查合同时使用。"
        />
      </label>
      <div className="field">
        <div className="field-head">
          <span>正文（SKILL.md）</span>
          <div className="editor-tabs">
            <button
              type="button"
              className={mode === 'edit' ? 'on' : ''}
              onClick={() => setMode('edit')}
            >
              编辑
            </button>
            <button
              type="button"
              className={mode === 'preview' ? 'on' : ''}
              onClick={() => setMode('preview')}
            >
              预览
            </button>
          </div>
        </div>

        {mode === 'edit' ? (
          <textarea
            className="skill-body"
            rows={12}
            value={body}
            spellCheck={false}
            placeholder={
              '# 目标\n\n## 适用场景\n- 用户要求……\n- 输入包含……\n\n## 步骤\n1. ……\n2. ……\n\n## 规则\n- 必须……\n- 禁止……\n\n## 输出格式\n……\n\n## 示例\n输入：……\n输出：……'
            }
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const start = el.selectionStart;
                const end = el.selectionEnd;
                const next = body.slice(0, start) + '  ' + body.slice(end);
                setBody(next);
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = start + 2;
                });
                return;
              }
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void save();
              }
            }}
          />
        ) : body.trim() ? (
          <div className="skill-preview markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
              }}
            >
              {body}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="skill-preview empty">
            <div className="empty-icon">✦</div>
            <b>还没有正文</b>
            <span>按「适用场景 → 步骤 → 规则 → 输出格式 → 示例」来写，也可以先插入一个模板。</span>
            <div className="empty-actions">
              <button type="button" onClick={() => setMode('edit')}>去编辑</button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setBody(SKILL_TEMPLATE);
                  setMode('edit');
                }}
              >
                插入模板
              </button>
            </div>
          </div>
        )}

        <span className="editor-meta">{body.length} / 50000</span>
      </div>
      <div className="actions">
        <button className="primary" onClick={save}>保存</button>
        <button onClick={() => { setName(''); setDescription(''); setBody(''); setMode('edit'); setMsg(''); }}>清空</button>
        {msg && <span className="hint">{msg}</span>}
      </div>
    </>
  );
}

function DocsTab({ config, refresh }: { config: AppConfig | null; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const timer = useRef<number | null>(null);

  function flash(text: string) {
    setMsg(text);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(''), 6000);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setMsg('解析 + 切块 + 向量化…');
    try {
      const r = await api.upload(file);
      flash(`${r.name}：${r.chunks} 块，${r.embedded ? '已向量化' : '关键词索引'}`);
      await refresh();
    } catch (err: any) {
      flash(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label className={`upload ${busy ? 'busy' : ''}`}>
        <input type="file" accept=".txt,.md,.pdf" onChange={onFile} disabled={busy} />
        {busy ? '处理中…' : '上传到知识库（txt / md / pdf）'}
      </label>
      {msg && <p className="hint">{msg}</p>}

      <div className="list">
        {(config?.documents || []).map((d) => (
          <div key={d.id} className="row">
            <div className="row-main">
              <b>{d.name}</b>
              <small>{d.chunks} 块 · {d.embedded ? `${d.embedded} 已向量化` : '无向量'}</small>
            </div>
            <button
              className="icon"
              onClick={async () => {
                setMsg('');
                await api.deleteDoc(d.id);
                await refresh();
              }}
            >
              ×
            </button>
          </div>
        ))}
        {!config?.documents?.length && <p className="hint">知识库还是空的。</p>}
      </div>
    </>
  );
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function McpTab({ config, refresh }: { config: AppConfig | null; refresh: () => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectingAll, setConnectingAll] = useState(false);
  const [checking, setChecking] = useState(true);
  const [checkMsg, setCheckMsg] = useState('');

  // 打开 MCP 面板时先探活：服务端重启/远端断开后，列表不会一直显示旧的“已连接”
  useEffect(() => {
    let alive = true;

    (async () => {
      setChecking(true);
      const r = await api.ensureMcp().catch(() => null);

      if (!alive) return;

      if (r?.reconnected.length) {
        setCheckMsg(`已自动重连 ${r.reconnected.length} 个 MCP`);
      } else if (r?.failed.length) {
        setCheckMsg(`重连失败：${r.failed.map((f) => f.name).join('、')}`);
      } else {
        setCheckMsg('');
      }

      await refresh();
      if (alive) setChecking(false);
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function stateTotals() {
    try {
      const s = await api.state();
      return {
        servers: s.mcpServers.length,
        tools: s.mcpServers.reduce((n, x) => n + x.tools.length, 0),
      };
    } catch {
      return null;
    }
  }

  async function usePreset(p: { id: string; name: string; url: string }) {
    setConnecting(p.id);
    setMsg('');
    try {
      const s = await api.connectMcp({ url: p.url, name: p.name });
      const total = await stateTotals();
      setMsg(
        total
          ? `已连接 ${p.name}：共 ${total.servers} 个 MCP，${total.tools} 个工具`
          : `已连接 ${p.name}：${s.tools.length} 个工具`
      );
      await refresh();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setConnecting(null);
    }
  }

  async function connect() {
    setBusy(true);
    setMsg('连接中…');
    try {
      const s = await api.connectMcp({ url, name: name || undefined, headers: parseHeaders(headersText) });
      const total = await stateTotals();
      setMsg(
        total
          ? `已连接：共 ${total.servers} 个 MCP，${total.tools} 个工具`
          : `已连接：${s.tools.length} 个工具`
      );
      setUrl('');
      setName('');
      setHeadersText('');
      await refresh();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function connectAll() {
    const presets = config?.mcpPresets || [];
    if (!presets.length) return;

    setConnectingAll(true);
    setMsg('');
    try {
      const connected = new Set((config?.mcpServers || []).map((s) => s.url));
      const todo = presets.filter((p) => !connected.has(p.url));
      if (!todo.length) {
        setMsg('所有预设都已连接');
        return;
      }

      const results = await Promise.allSettled(
        todo.map((p) => api.connectMcp({ url: p.url, name: p.name }))
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      const total = await stateTotals();
      setMsg(
        failed
          ? `有 ${failed} 个 MCP 连接失败`
          : total
            ? `已连接：共 ${total.servers} 个 MCP，${total.tools} 个工具`
            : ''
      );
      await refresh();
    } finally {
      setConnectingAll(false);
    }
  }

  const presets = config?.mcpPresets || [];
  const connectedUrls = new Set((config?.mcpServers || []).map((s) => s.url));
  const allConnected = presets.length > 0 && presets.every((p) => connectedUrls.has(p.url));
  const remaining = presets.filter((p) => !connectedUrls.has(p.url)).length;
  const connectedTools = (config?.mcpServers || []).reduce((n, s) => n + s.tools.length, 0);

  return (
    <>
      <div className="presets">
        {presets.map((p) => {
          const connected = connectedUrls.has(p.url);
          return (
            <button
              key={p.id}
              className="preset"
              disabled={connected || connecting !== null || connectingAll}
              onClick={() => usePreset(p)}
            >
              <b>{p.name}</b>
              <small>{connected ? '已连接' : connecting === p.id ? '连接中…' : p.desc}</small>
            </button>
          );
        })}
      </div>

      {!!presets.length && (
        <button
          className="primary preset-all"
          onClick={connectAll}
          disabled={connectingAll || connecting !== null || allConnected}
        >
          {connectingAll ? '连接中…' : allConnected ? '已全部连接' : `一键连接全部（${remaining}）`}
        </button>
      )}

      <div className="divider" />

      <p className="hint">支持远程 MCP 服务（http/https 地址）。本地命令类 MCP（如文件系统、Git）暂不支持。</p>

      <label className="field">
        <span>名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="deepwiki" />
      </label>
      <label className="field">
        <span>MCP Server URL</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.deepwiki.com/mcp" />
      </label>

      <label className="field">
        <span>请求头（可选，服务要求鉴权时才填）</span>
        <textarea
          className="headers-input"
          rows={2}
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          placeholder={'x-api-key: sk-...\nAuthorization: Bearer ...'}
        />
      </label>

      <div className="actions">
        <button className="primary" onClick={connect} disabled={busy || !url}>连接</button>
      </div>

      <div className="divider" />

      <div className="list">
        {(config?.mcpServers || []).map((s) => (
          <div key={s.id} className="row">
            <div className="row-main">
              <b>{s.name}</b>
              <small>{s.tools.length} 个工具：{s.tools.map((t) => t.name).join(', ').slice(0, 80)}</small>
            </div>
            <button
              className="icon"
              onClick={async () => {
                await api.disconnectMcp(s.id);
                await refresh();
              }}
            >
              ×
            </button>
          </div>
        ))}
        {!config?.mcpServers?.length && <p className="hint">还没有连接任何 server。</p>}
      </div>

      <div className="mcp-status-area">
        {!!config?.mcpServers?.length && (
          <p className="hint">
            已连接 {config.mcpServers.length} 个 MCP，{connectedTools} 个工具
          </p>
        )}
        {msg && (
          <p className="mcp-status" role="status" aria-live="polite">
            {msg}
          </p>
        )}
        {!msg && checkMsg && <p className="hint">{checkMsg}</p>}
        {checking && <p className="hint">正在检查已连接的 MCP…</p>}
      </div>
    </>
  );
}

function KeyInput({
  provider,
  placeholder,
  onSave,
}: {
  provider: string;
  placeholder: string;
  onSave: (key: string) => Promise<void>;
}) {
  const [val, setVal] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <>
      <label className="field">
        <span>{provider} API Key（存在服务端会话，浏览器不保存）</span>
        <input
          type="password"
          autoComplete="off"
          value={val}
          placeholder={placeholder}
          onChange={(e) => setVal(e.target.value)}
        />
      </label>
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !val.trim()}
          onClick={async () => {
            setBusy(true);
            setMsg('');
            try {
              await onSave(val.trim());
              setVal('');
              setMsg('已保存并验证通过');
            } catch (e: any) {
              setMsg(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '校验中…' : '保存'}
        </button>
        {msg && <span className="hint">{msg}</span>}
      </div>
    </>
  );
}
