import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';

/**
 * 只支持 HTTP 类型（Streamable HTTP）。
 * 浏览器不能 spawn 进程，所以 stdio 需要 BFF 桥接——本项目不做。
 *
 * 连接按 tenant 隔离：A 连的 server 只有 A 能看到和调用。
 */
const servers = new Map(); // tenant -> Map<id, { id, name, url, client, tools }>
const connecting = new Map(); // `${tenant}|${url}` -> Promise，防重复/并发连接
const ensuring = new Map(); // tenant -> Promise，防并发探活/重连

function bucket(tenant) {
  const key = tenant || 'public';
  if (!servers.has(key)) servers.set(key, new Map());
  return servers.get(key);
}

async function sdk() {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  return { Client, StreamableHTTPClientTransport };
}

function cleanHeaders(input) {
  if (!input || typeof input !== 'object') return {};
  const blocked = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade']);
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(input).slice(0, 10)) {
    const key = String(rawKey).trim();
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue;
    if (blocked.has(key.toLowerCase())) continue;
    if (typeof rawVal !== 'string') continue;
    // 非 ASCII 会让底层 fetch 抛 ByteString 错误，提前给出明确提示
    if (!/^[\x20-\x7e]*$/.test(rawVal)) {
      throw new Error(`请求头 ${key} 的值只能包含 ASCII 字符`);
    }
    out[key] = rawVal.slice(0, 4096);
  }
  return out;
}

function normalizeHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
}

function isPrivateIp(ip) {
  const v = String(ip || '').toLowerCase();

  if (v.includes(':')) {
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10
    if (v.startsWith('::ffff:')) return true; // IPv4-mapped，保守拒绝
    return false;
  }

  const parts = v.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** 防 SSRF：拒绝 localhost/私网/链路本地/元数据地址，并校验 DNS 解析结果 */
async function assertPublicTarget(target) {
  const host = normalizeHost(target.hostname);
  if (!host) throw new Error('地址格式不对');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('这个地址不可用，请填写公网可访问的 MCP 地址');
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('无法解析 MCP 地址');
  }

  // 只要有一个解析结果落在内网就拒绝，防止域名指向 127.0.0.1 / 169.254
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('这个地址不可用，请填写公网可访问的 MCP 地址');
  }
}

export function connect(tenant, opts = {}) {
  const { url = '', headers } = opts;
  // 只有不带自定义请求头的连接才去重：预设 MCP 都属于这一类
  const dedupe = Object.keys(cleanHeaders(headers)).length === 0;
  const key = `${tenant || 'public'}|${url}`;

  if (dedupe) {
    const inflight = connecting.get(key);
    if (inflight) return inflight;
  }

  const task = doConnect(tenant, opts).finally(() => {
    if (dedupe) connecting.delete(key);
  });
  if (dedupe) connecting.set(key, task);
  return task;
}

async function doConnect(tenant, { url, name, headers, id: reuseId }) {
  const { Client, StreamableHTTPClientTransport } = await sdk();

  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('地址格式不对，请填写以 http:// 或 https:// 开头的地址');
  }
  if (target.username || target.password) {
    throw new Error('地址不能包含账号密码');
  }

  // Exa 免费 MCP 有速率限制；服务端有 key 时自动附加，
  // 不要把 key 写进 MCP URL，因为 URL 会通过 /api/state 返回给前端。
  if (
    target.hostname === 'mcp.exa.ai' &&
    process.env.EXA_API_KEY &&
    !target.searchParams.has('exaApiKey')
  ) {
    target.searchParams.set('exaApiKey', process.env.EXA_API_KEY);
  }
  // 公网部署时的 SSRF 防护（本地开发可设 ALLOW_PRIVATE_MCP=1）
  if (process.env.ALLOW_PRIVATE_MCP !== '1') {
    await assertPublicTarget(target);
  }

  const customHeaders = cleanHeaders(headers);
  const hasHeaders = Object.keys(customHeaders).length > 0;

  // 同一个 URL 只保留一条连接：自动连接、重复点击、多标签页都可能撞上
  if (!hasHeaders) {
    const existing = [...bucket(tenant).values()].find((s) => s.url === url && !s.hasHeaders);
    if (existing) {
      return { id: existing.id, name: existing.name, url: existing.url, tools: existing.tools };
    }
  }

  let label = String(name || 'mcp')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'mcp';

  // 同一租户里 label 不能重复，否则工具名会撞
  const used = new Set([...bucket(tenant).values()].map((s) => s.label));
  if (used.has(label)) {
    const base = label;
    let n = 2;
    while (used.has(`${base}${n}`)) n++;
    label = `${base}${n}`;
  }

  const transport = new StreamableHTTPClientTransport(target, {
    requestInit: { headers: customHeaders },
  });
  const client = new Client({ name: 'ai-chat-mvp', version: '0.1.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    const listed = await client.listTools();

    const id = reuseId || randomUUID();
    const tools = (listed.tools || []).map((t) => ({
      name: `${label}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
      originalName: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));

    bucket(tenant).set(id, {
      id,
      label,
      name: name || url,
      url,
      hasHeaders,
      headers: customHeaders,
      client,
      tools,
      activeCalls: 0,
    });
    return { id, name: name || url, url, tools };
  } catch (err) {
    // 连接或 listTools 失败时把半开的 client 收掉，避免连接泄漏
    try {
      await client.close();
    } catch {}
    throw err;
  }
}

export function listServers(tenant) {
  return [...bucket(tenant).values()].map(({ id, name, url, tools }) => ({
    id,
    name,
    url,
    tools: tools.map((t) => ({ name: t.originalName, description: t.description })),
  }));
}

export async function disconnect(tenant, id) {
  const b = bucket(tenant);
  const s = b.get(id);
  if (!s) return;
  try {
    await s.client.close();
  } catch {}
  b.delete(id);
}

const HEALTH_TIMEOUT = 1500;

/** 先 ping；服务端不支持 ping 时退回 listTools，并顺手刷新工具列表 */
async function probe(server) {
  try {
    await server.client.ping({ timeout: HEALTH_TIMEOUT });
    return true;
  } catch {}

  try {
    const listed = await server.client.listTools(undefined, { timeout: HEALTH_TIMEOUT });
    server.tools = (listed.tools || []).map((t) => ({
      name: `${server.label}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
      originalName: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 探活当前租户所有 MCP 连接：
 * - 活的保留；
 * - 失活的关闭并按原 id / url / name / headers 重连；
 * - 重连失败则移除，避免把死工具继续交给模型。
 * 同一个 tenant 的并发调用会合并成一个 Promise。
 */
export function ensureAlive(tenant) {
  const key = tenant || 'public';
  const inflight = ensuring.get(key);
  if (inflight) return inflight;

  const task = doEnsureAlive(tenant).finally(() => ensuring.delete(key));
  ensuring.set(key, task);
  return task;
}

async function doEnsureAlive(tenant) {
  const current = [...bucket(tenant).values()];
  const result = { checked: current.length, alive: [], reconnected: [], failed: [] };

  await Promise.all(
    current.map(async (server) => {
      // 正在被工具调用使用时不探活/重连，避免把进行中的请求掐断
      if ((server.activeCalls || 0) > 0) {
        result.alive.push(server.name);
        return;
      }

      if (await probe(server)) {
        result.alive.push(server.name);
        return;
      }

      const snapshot = {
        id: server.id,
        name: server.name,
        url: server.url,
        headers: server.headers,
      };

      await disconnect(tenant, server.id);

      try {
        const fresh = await connect(tenant, snapshot);
        result.reconnected.push(fresh.name);
      } catch (err) {
        result.failed.push({ name: snapshot.name, error: err.message });
      }
    })
  );

  result.servers = listServers(tenant);
  return result;
}

export function allMcpTools(tenant) {
  return [...bucket(tenant).values()].flatMap((s) =>
    s.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
  );
}

export async function callMcpTool(tenant, fullName, args) {
  for (const s of bucket(tenant).values()) {
    const tool = s.tools.find((t) => t.name === fullName);
    if (!tool) continue;

    s.activeCalls = (s.activeCalls || 0) + 1;
    try {
      const result = await s.client.callTool({ name: tool.originalName, arguments: args });
      const text = flatten(result);

      // MCP 用 isError 表示工具执行失败；当成成功回填会让卡片显示“完成”
      if (result?.isError) {
        throw new Error(text || `${fullName} 执行失败`);
      }

      return text;
    } finally {
      s.activeCalls = Math.max(0, (s.activeCalls || 1) - 1);
    }
  }
  throw new Error(`未找到 MCP 工具: ${fullName}`);
}

/** 把 MCP 的 content 数组拼成纯文本；导出是为了单测 isError 分支 */
export function flatten(result) {
  const parts = result?.content || [];
  return parts
    .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
    .join('\n')
    .slice(0, 8000);
}
