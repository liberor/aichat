import { memo, useEffect, useState, type AnchorHTMLAttributes, type ImgHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Msg, ToolCall } from '../types';
import { BrandIcon, BRAND_COLORS } from './brandIcons';

const LETTERS: Record<string, string> = {
  qwen: 'Q',
  deepseek: 'D',
  gemini: 'G',
  openai: 'O',
};

function providerOf(model?: string) {
  if (!model) return '';
  const i = model.indexOf('/');
  return i > 0 ? model.slice(0, i) : '';
}

/** 从消息正文和工具结果里找出视频链接（万相返回的是 ...mp4?Expires=... 临时地址） */
const VIDEO_RE = /https?:\/\/[^\s<>"'`)\]]+\.mp4(?:\?[^\s<>"'`)\]]*)?/gi;
/** 文生图返回的是 ...png/jpg?Expires=... */
const IMAGE_RE = /https?:\/\/[^\s<>"'`)\]]+\.(?:png|jpe?g|webp)(?:\?[^\s<>"'`)\]]*)?/gi;

function collectMedia(msg: Msg) {
  const videos = new Set<string>();
  const images = new Set<string>();

  const scan = (text?: string) => {
    if (!text) return;
    for (const m of text.matchAll(VIDEO_RE)) videos.add(m[0]);
    for (const m of text.matchAll(IMAGE_RE)) images.add(m[0]);
  };

  // 只扫工具结果，不扫 msg.content：
  // 流式过程中 URL 是一段段到达的，先匹配到 "...png"（还缺 ?Expires=... 签名）会闪一个裂图。
  // tool_result 是整条事件原子到达的，URL 一定完整。
  for (const t of msg.tools || []) {
    if (/^(generate|check)_(video|image)$/.test(t.name)) scan(t.result);
  }

  return { videos: [...videos], images: [...images] };
}

function Avatar({ msg }: { msg: Msg }) {
  if (msg.role === 'user') return <div className="avatar">你</div>;

  const provider = providerOf(msg.model);
  const color = BRAND_COLORS[provider];

  if (!color) return <div className="avatar">✦</div>;

  return (
    <div
      className="avatar brand"
      title={msg.model}
      style={{ background: `${color}22`, color, borderColor: `${color}55` }}
    >
      <BrandIcon provider={provider} />
      <span className="sr-only">{LETTERS[provider]}</span>
    </div>
  );
}

const TOOL_HINTS: Record<string, string> = {
  generate_video: '视频生成通常需要 1–5 分钟，请保持页面打开。',
  check_video: '正在查询视频任务状态。',
  generate_image: '图片生成通常需要 10–30 秒。',
  check_image: '正在查询图片任务状态。',
  rag_search: '正在检索文档库。',
  use_skill: '正在加载 Skill 流程。',
};

/** 每秒刷新一次，用来显示工具已等待时长 */
function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function fmtElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function ToolCard({ tool }: { tool: ToolCall }) {
  const running = tool.status === 'running';
  const now = useTick(running);
  const end = running ? now : tool.finishedAt || now;
  const elapsed = tool.startedAt ? fmtElapsed(end - tool.startedAt) : '';

  return (
    <div className={`tool ${tool.status}`}>
      <div className="tool-head">
        <span className="dot" />
        <code>{tool.name}</code>
        {running ? (
          <span className="tool-status running">{elapsed ? `执行中 ${elapsed}` : '执行中…'}</span>
        ) : (
          <span className="tool-status">
            {tool.status === 'error' ? '失败' : `完成${elapsed ? ` · 用时 ${elapsed}` : ''}`}
          </span>
        )}
      </div>

      {running && (
        <>
          <div className="tool-hint">{TOOL_HINTS[tool.name] || '正在执行工具…'}</div>
          <div className="tool-progress" />
        </>
      )}

      {!running && tool.result && <pre className="tool-result">{tool.result.slice(0, 1200)}</pre>}

      <details className="tool-args">
        <summary>参数</summary>
        <pre>{JSON.stringify(tool.args, null, 2)}</pre>
      </details>
    </div>
  );
}

/** 判断一个媒体 URL 是否还没收全（流式过程中） */
function isBrokenMediaUrl(url: string | undefined, pending: boolean) {
  if (!url) return false;
  if (!/\.(png|jpe?g|webp|gif|mp4|mov|webm)(\?|$)/i.test(url)) return false;
  // OSS 签名链接一定带 Signature；没有就说明还没收全
  if (/aliyuncs\.com/i.test(url) && !/[?&]Signature=/i.test(url)) return true;
  // 还在流式输出，且连查询串都没到
  if (pending && !url.includes('?')) return true;
  return false;
}

function StreamLink({
  pending,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { pending: boolean }) {
  if (isBrokenMediaUrl(rest.href, pending)) return <span className="pending-media">{children}</span>;
  return (
    <a {...rest} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function StreamImage({
  pending,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { pending: boolean }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [rest.src]);

  // 流式期间 URL 没到齐：先不渲染，避免闪裂图
  if (isBrokenMediaUrl(rest.src, pending)) return null;
  if (failed) return <span className="media-failed">图片加载失败（链接可能已过期）</span>;

  return <img {...rest} loading="lazy" onError={() => setFailed(true)} />;
}

function MediaImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="media-failed">
        图片加载失败，链接可能已过期
        <a href={src} target="_blank" rel="noreferrer">打开原链接</a>
      </div>
    );
  }

  return (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt="生成的图片" loading="lazy" onError={() => setFailed(true)} />
    </a>
  );
}

function MediaVideo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="media-failed">
        视频加载失败，链接可能已过期
        <a href={src} target="_blank" rel="noreferrer">打开原链接</a>
      </div>
    );
  }

  return <video src={src} controls playsInline preload="metadata" onError={() => setFailed(true)} />;
}

function Markdown({ text, pending }: { text: string; pending: boolean }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <StreamLink {...props} pending={pending} />,
          img: ({ node: _node, ...props }) => <StreamImage {...props} pending={pending} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** 流式时只有最后一个 text 块在变，前面的块不会重复解析 */
const TextBlock = memo(Markdown);

function ToolPart({ msg, callId }: { msg: Msg; callId: string }) {
  const tool = msg.tools?.find((t) => t.id === callId);
  return tool ? <ToolCard tool={tool} /> : null;
}

export function Message({ msg }: { msg: Msg }) {
  const isUser = msg.role === 'user';
  const { videos, images } = isUser ? { videos: [], images: [] } : collectMedia(msg);
  const parts = msg.parts || [];
  const hasText = parts.some((p) => p.type === 'text' && p.text);
  // 过期/无法恢复的回答不再展示 token，避免看起来像一次完整计费
  const expired = Boolean(msg.error?.includes('记录已过期'));
  const hasUsage = Boolean(
    msg.usage && (msg.usage.prompt_tokens != null || msg.usage.completion_tokens != null)
  );

  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      <Avatar msg={msg} />
      <div className="bubble">
        {isUser ? (
          <div className="plain">{msg.content || ''}</div>
        ) : (
          <>
            {parts.map((p, i) =>
              p.type === 'text' ? (
                <TextBlock key={`text-${i}`} text={p.text} pending={Boolean(msg.pending)} />
              ) : (
                <ToolPart key={`tool-${p.callId}`} msg={msg} callId={p.callId} />
              )
            )}

            {msg.pending && !hasText && (
              <div className="typing">
                <span />
                <span />
                <span />
              </div>
            )}
          </>
        )}

        {!!videos.length && (
          <div className="videos">
            {videos.map((src) => (
              <MediaVideo key={src} src={src} />
            ))}
            <div className="video-hint">视频链接约 24 小时有效，需要长期保存请及时下载。</div>
          </div>
        )}

        {!!images.length && (
          <div className="images">
            {images.map((src) => (
              <MediaImage key={src} src={src} />
            ))}
            <div className="image-hint">图片链接约 24 小时有效，需要长期保存请及时下载。</div>
          </div>
        )}

        {msg.error && <div className="error">{msg.error}</div>}
        {msg.stopped && !msg.error && <div className="stopped">已停止生成</div>}

        {!!msg.sources?.length && (
          <details className="sources">
            <summary>{msg.sources.length} 条参考资料</summary>
            {msg.sources.map((s, i) => (
              <div key={s.id} className="source">
                <div className="source-head">
                  [{i + 1}] {s.docName} · {s.score}
                </div>
                <div className="source-body">{s.text.slice(0, 400)}</div>
              </div>
            ))}
          </details>
        )}

        {hasUsage && !expired && (
          <div className="usage" title="输入 / 输出 tokens">
            <span className="label">tokens</span>
            <span className="in">↑ {msg.usage?.prompt_tokens ?? 0}</span>
            <span className="out">↓ {msg.usage?.completion_tokens ?? 0}</span>
          </div>
        )}
      </div>
    </div>
  );
}
