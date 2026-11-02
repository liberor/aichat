export type Role = 'user' | 'assistant' | 'system';

export interface Source {
  id: string;
  docName: string;
  text: string;
  score: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  status: 'running' | 'done' | 'error';
  /** 客户端收到 tool_call 的时间，用于显示已等待时长 */
  startedAt?: number;
  finishedAt?: number;
  /** 用户主动停止时标记，卡片显示「已中断」而不是「失败」 */
  interrupted?: boolean;
}

/** assistant 消息的有序内容：文字块或工具引用 */
export type MsgPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; callId: string };

export interface Msg {
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

/** 取消息的完整文本：assistant 拼 parts，user 用 content */
export function msgText(m: Msg): string {
  if (m.role === 'assistant') {
    return (m.parts || [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  return m.content || '';
}

export interface Conv {
  id: string;
  title: string;
  messages: Msg[];
  /** 所属租户；旧版本数据可能没有，需要手动认领 */
  tenant?: string;
  /** 输入框里还没发出去的内容 */
  draft?: string;
  runId?: string;
  lastEventId?: number;
  settings: Settings;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  model: string;
  system: string;
  skills: string[];
  useRag: boolean;
  useVideo?: boolean;
  useImage?: boolean;
  v?: number;
}

export interface Doc {
  id: string;
  name: string;
  chunks: number;
  embedded: number;
}

export interface Skill {
  name: string;
  description: string;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  tools: { name: string; description: string }[];
}

export interface ProviderInfo {
  id: string;
  hasKey: boolean;
  models: string[];
}

export interface McpPreset {
  id: string;
  name: string;
  url: string;
  desc: string;
}

export interface AppConfig {
  mock: boolean;
  forceMock: boolean;
  hasAnyKey: boolean;
  authRequired: boolean;
  tenant?: string;
  models: string[];
  providers: ProviderInfo[];
  embeddings: boolean;
  rerank: boolean;
  ocr: boolean;
  video: boolean;
  videoModel?: string;
  videoModels?: string[];
  videoSize?: string;
  image: boolean;
  imageModel?: string;
  imageModels?: string[];
  imageSize?: string;
  skills: Skill[];
  documents: Doc[];
  mcpServers: McpServer[];
  mcpPresets: McpPreset[];
}
