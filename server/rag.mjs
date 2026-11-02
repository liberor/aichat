import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';

const ROOT = path.resolve(config.dataDir);

/** tenant -> { file, data:{chunks:[]}, timer } */
const stores = new Map();

function storeFor(tenant) {
  const key = tenant || 'public';
  if (stores.has(key)) return stores.get(key);

  const dir = path.join(ROOT, 'tenants', key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.json');

  let data = { chunks: [] };
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      data = { chunks: [] };
    }
  }
  if (!Array.isArray(data.chunks)) data.chunks = [];

  const s = { file, data, timer: null };
  stores.set(key, s);
  return s;
}

function writeStore(s) {
  const tmp = `${s.file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(s.data));
    fs.renameSync(tmp, s.file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    console.warn('[rag] persist failed:', err.message);
  }
}

function persist(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    writeStore(s);
  }, 200);
}

/** 进程退出前把 debounce 中的索引刷盘 */
export function flushRag() {
  for (const s of stores.values()) {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    writeStore(s);
  }
}

/* ---------------- 切块 ---------------- */

/** 句末/换行边界；英文句点、问号、感叹号、分号、中文标点都算 */
const BOUNDARY = /[。！？!?；;.\n]/;

/**
 * 把一个超长段落切成不超过 size 的片段。
 * 优先在句末/换行处切，其次在空白处切，最后才硬切。
 * 这里产出的片段互不重叠，overlap 由调用方统一添加一次。
 */
function splitLong(text, size) {
  const out = [];
  let rest = text;
  const minCut = Math.floor(size * 0.6);

  while (rest.length > size) {
    const head = rest.slice(0, size);
    let cut = -1;

    // 1) 句末 / 换行：从后往前找，尽量切在完整句子后
    for (let i = head.length - 1; i >= minCut; i--) {
      if (BOUNDARY.test(head[i])) {
        cut = i + 1;
        break;
      }
    }

    // 2) 空白：英文单词、代码行
    if (cut < 0) {
      for (let i = head.length - 1; i >= minCut; i--) {
        if (/\s/.test(head[i])) {
          cut = i + 1;
          break;
        }
      }
    }

    // 3) 没有任何边界（例如超长无标点中文/代码），只能硬切
    if (cut < 0) cut = size;

    const piece = rest.slice(0, cut).trimEnd();
    if (piece) out.push(piece);
    rest = rest.slice(cut);
  }

  const tail = rest.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 取上一块尾部作为 overlap。
 * 如果尾部从单词/句子中间开始，尽量向后挪到最近的边界，
 * 避免参考资料一打开就是 "ct，ref..." 这种断词。
 */
function overlapTail(text, max) {
  if (!max) return '';
  const tail = text.slice(-max);
  for (let i = 0; i < tail.length; i++) {
    if (BOUNDARY.test(tail[i]) || /\s/.test(tail[i])) {
      const start = i + 1;
      // 边界太靠后就不截了，否则 overlap 会几乎消失
      if (tail.length - start >= 20) return tail.slice(start).trimStart();
      break;
    }
  }
  return tail;
}

export function chunkText(text, { size = 600, overlap = 100 } = {}) {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];

  const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const raw = [];
  let buf = '';

  for (const p of paras) {
    // 单段超长：先 flush 当前缓冲，再按边界切
    if (p.length > size) {
      if (buf) {
        raw.push(buf);
        buf = '';
      }
      raw.push(...splitLong(p, size));
      continue;
    }

    if (!buf) {
      buf = p;
      continue;
    }

    if (buf.length + 2 + p.length <= size) {
      buf = `${buf}\n\n${p}`;
    } else {
      raw.push(buf);
      buf = p;
    }
  }
  if (buf.trim()) raw.push(buf);

  // overlap 只在最后加一次：取上一块尾部，不参与切分
  const step = Math.max(0, Math.min(overlap, Math.floor(size / 2)));
  return raw.map((c, i) => (i === 0 || !step ? c : `${overlapTail(raw[i - 1], step)}\n${c}`));
}

/* ---------------- 向量化 ---------------- */

export async function embed(texts) {
  const { baseUrl, apiKey, model } = config.embedding;
  if (!baseUrl || !apiKey || !texts.length) return null;

  // 百炼/OpenAI 的 embeddings 接口对单次批量大小有限制，分批请求
  const BATCH = 10;
  const out = [];

  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: batch }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const vectors = (json.data || []).map((d) => d.embedding);
      if (vectors.length !== batch.length) throw new Error('返回数量不匹配');
      out.push(...vectors);
    }
    return out;
  } catch (err) {
    console.warn('[rag] embedding failed, falling back to keyword search:', err.message);
    return null;
  }
}

/* ---------------- 入库 ---------------- */

export async function ingest(tenant, { name, text }) {
  const pieces = chunkText(text);
  if (!pieces.length) throw new Error('文档内容为空');

  const s = storeFor(tenant);
  const docId = randomUUID();
  const vectors = await embed(pieces);

  pieces.forEach((piece, i) => {
    s.data.chunks.push({
      id: `${docId}:${i}`,
      docId,
      docName: name,
      text: piece,
      vec: vectors?.[i] ?? null,
    });
  });
  persist(s);

  return { docId, name, chunks: pieces.length, embedded: Boolean(vectors) };
}

export function listDocuments(tenant) {
  const s = storeFor(tenant);
  const map = new Map();
  for (const c of s.data.chunks) {
    const d = map.get(c.docId) || { id: c.docId, name: c.docName, chunks: 0, embedded: 0 };
    d.chunks += 1;
    if (c.vec) d.embedded += 1;
    map.set(c.docId, d);
  }
  return [...map.values()];
}

export function removeDocument(tenant, docId) {
  const s = storeFor(tenant);
  s.data.chunks = s.data.chunks.filter((c) => c.docId !== docId);
  persist(s);
}

/* ---------------- 检索 ---------------- */

/**
 * DashScope 重排（gte-rerank）。不是 OpenAI 兼容接口。
 * 失败时返回 null，调用方降级到原始排序。
 */
export async function rerank(query, docs, topN) {
  const { baseUrl, apiKey, model } = config.rerank;
  if (!baseUrl || !apiKey || docs.length < 2) return null;

  try {
    const res = await fetch(`${baseUrl}/api/v1/services/rerank/text-rerank/text-rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: { query, documents: docs.map((d) => d.text) },
        parameters: { return_documents: false, top_n: Math.min(topN, docs.length) },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const results = json.output?.results;
    if (!Array.isArray(results) || !results.length) throw new Error('empty result');

    return results
      .map((r) => ({ ...docs[r.index], score: Number(r.relevance_score ?? 0) }))
      .filter((d) => d.text);
  } catch (err) {
    console.warn('[rag] rerank failed, using original order:', err.message);
    return null;
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function tokenize(text) {
  const lower = String(text).toLowerCase();
  const latin = lower.match(/[a-z0-9_]+/g) || [];
  const cjk = lower.match(/[\u4e00-\u9fa5]/g) || [];
  const bigrams = [];
  for (let i = 0; i < cjk.length - 1; i++) bigrams.push(cjk[i] + cjk[i + 1]);
  return [...latin, ...bigrams];
}

function bm25(query, docs) {
  const qTokens = tokenize(query);
  const docTokens = docs.map((d) => tokenize(d.text));
  const avgdl = docTokens.reduce((s, t) => s + t.length, 0) / Math.max(1, docTokens.length);
  const df = new Map();
  for (const t of qTokens) {
    df.set(t, docTokens.filter((d) => d.includes(t)).length);
  }
  const N = docs.length;
  const k1 = 1.5;
  const b = 0.75;

  return docs.map((doc, i) => {
    const toks = docTokens[i];
    const dl = toks.length || 1;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);

    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
    }
    return { ...doc, score };
  });
}

export async function search(tenant, query, topK = 5) {
  topK = Math.min(Math.max(1, Number(topK) || 5), 20);
  const s = storeFor(tenant);
  if (!s.data.chunks.length) return [];

  const qVec = await embed([query]);
  const qv = qVec?.[0];
  let scored;

  const hasVec = (c) => Array.isArray(c.vec) && c.vec.length > 0;
  const sameDim = (c) => hasVec(c) && (!qv || c.vec.length === qv.length);
  // 维度不一致的旧向量按“无向量”处理，走 BM25，避免 NaN 后整篇消失
  const noVec = s.data.chunks.filter((c) => !sameDim(c));

  if (qv) {
    const withVec = s.data.chunks.filter(sameDim);
    scored = withVec.map((c) => ({ ...c, score: cosine(qv, c.vec) }));

    if (noVec.length) {
      const kw = bm25(query, noVec);
      const max = Math.max(...kw.map((k) => k.score), 1e-9);
      scored.push(...kw.map((k) => ({ ...k, score: (k.score / max) * 0.85 })));
    }
  } else {
    scored = bm25(query, s.data.chunks);
  }

  // 先宽召回，再重排
  const candidates = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(topK * 5, 20));

  if (!candidates.length) return [];

  const reranked = await rerank(query, candidates, topK);
  const final = reranked || candidates.slice(0, topK);

  return final
    .slice(0, topK)
    .map(({ id, docName, text, score }) => ({ id, docName, text, score: Number(score.toFixed(4)) }));
}
