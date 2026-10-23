/**
 * 冒烟测试：需要先启动 server（默认 http://localhost:8787）
 *   node server/index.mjs   然后   node scripts/smoke.mjs
 */
import fs from 'node:fs';
import 'dotenv/config';

const BASE = process.env.BASE || 'http://localhost:8787';

// 如果开了访问码，用第一个码登录，后续请求自动带 cookie
const CODES = (process.env.ACCESS_CODE || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let cookie = '';
if (CODES.length) {
  const r = await fetch(BASE + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: CODES[0] }),
  });
  if (!r.ok) {
    console.error('访问码登录失败，检查 ACCESS_CODE');
    process.exit(1);
  }
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  console.log('已用访问码登录');
}

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function req(path, init = {}) {
  const headers = { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) };
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const post = (path, body) =>
  req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function readStream(runId, last = 0) {
  const res = await fetch(`${BASE}/api/chat/${runId}/stream?last=${last}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) {
          try {
            events.push(JSON.parse(line.slice(5).trim()));
          } catch {}
        }
      }
    }
  }
  return events;
}

console.log('\n[1] 基础接口');
const cfg = await req('/api/config');
ok('GET /api/config', cfg.status === 200 && Array.isArray(cfg.body.models));

console.log('\n[2] 对话 + 流式');
const chat = await post('/api/chat', { messages: [{ role: 'user', content: '你好' }], model: cfg.body.models[0] });
ok('POST /api/chat 返回 runId', chat.status === 200 && !!chat.body.runId);

const ev1 = await readStream(chat.body.runId);
ok('事件 id 连续递增', ev1.every((e, i) => e.id === i + 1), JSON.stringify(ev1.map((e) => e.id)));
ok('有 delta 事件', ev1.some((e) => e.type === 'delta'));
ok('最后是 done', ev1.at(-1)?.type === 'done');

const mid = Math.max(1, Math.floor(ev1.length / 2));
const ev2 = await readStream(chat.body.runId, mid);
ok('从中间续传只返回后续事件', ev2.length === ev1.length - mid, `${ev2.length} vs ${ev1.length - mid}`);
ok('续传首条 id 正确', ev2[0]?.id === mid + 1);

const evAll = await readStream(chat.body.runId, ev1.length);
ok('已追平也收到 done（不会无限重连）', evAll.length === 1 && evAll[0].type === 'done');

const evReplay = await readStream(chat.body.runId, 0);
ok('run 结束后仍能完整回放', evReplay.length === ev1.length && evReplay.at(-1)?.type === 'done');

console.log('\n[3] 取消');
const chat2 = await post('/api/chat', { messages: [{ role: 'user', content: '写一篇长文' }], model: cfg.body.models[0] });
await new Promise((r) => setTimeout(r, 300));
const cancel = await post(`/api/chat/${chat2.body.runId}/cancel`, {});
ok('POST cancel', cancel.status === 200 && cancel.body.ok === true);
const ev3 = await readStream(chat2.body.runId);
ok('取消后流会结束', ev3.at(-1)?.type === 'done');

console.log('\n[4] 文档 / RAG');
const form = new FormData();
form.append('file', new Blob(['劳动合同期限为三年。试用期六个月，试用期工资为转正工资的百分之八十。'], { type: 'text/plain' }), 'labor.txt');
const up = await req('/api/upload', { method: 'POST', body: form });
ok('上传文本入库', up.status === 200 && up.body.chunks >= 1);

const search = await post('/api/search', { query: '试用期多久', topK: 3 });
ok('检索命中', search.status === 200 && search.body.length > 0);

const chatRag = await post('/api/chat', {
  messages: [{ role: 'user', content: '试用期多久' }],
  model: cfg.body.models[0],
  useRag: true,
});
ok('开启 RAG 后返回 sources', chatRag.body.sources?.length > 0);

const pdfB64 = fs.existsSync('scripts/fixtures/sample.pdf.b64')
  ? fs.readFileSync('scripts/fixtures/sample.pdf.b64', 'utf8').trim()
  : null;
if (pdfB64) {
  const pdf = Buffer.from(pdfB64, 'base64');
  const form2 = new FormData();
  form2.append('file', new Blob([pdf], { type: 'application/pdf' }), 'test.pdf');
  const upPdf = await req('/api/upload', { method: 'POST', body: form2 });
  ok('PDF 解析', upPdf.status === 200 && upPdf.body.chunks >= 1, JSON.stringify(upPdf.body).slice(0, 160));
} else {
  console.log('  - 跳过 PDF（缺少 fixture）');
}

const del = await req(`/api/documents/${up.body.docId}`, { method: 'DELETE' });
ok('删除文档', del.status === 200);

console.log('\n[5] Skills');
const saved = await post('/api/skills', { name: 'smoke-test', description: '测试用', body: '# 步骤\n1. 测试' });
ok('创建 skill', saved.status === 200 && saved.body.name === 'smoke-test');
const list = await req('/api/skills');
ok('列表包含 skill', list.body.some((s) => s.name === 'smoke-test'));
const bad = await post('/api/skills', { name: '../evil', description: 'x', body: 'x' });
ok('非法 skill 名被拒', bad.status === 400);
await req('/api/skills/smoke-test', { method: 'DELETE' });
const list2 = await req('/api/skills');
ok('删除 skill', !list2.body.some((s) => s.name === 'smoke-test'));

console.log('\n[6] 异常处理');
const badJson = await fetch(BASE + '/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: '{oops',
});
ok('非法 JSON 返回 400', badJson.status === 400);
const missing = await req('/api/chat/not-exist/stream');
ok('不存在的 run 返回 404', missing.status === 404);
const blocked = await post('/api/mcp/connect', { url: 'http://127.0.0.1:1234/mcp', name: 'local' });
ok('内网 MCP 默认被拒', blocked.status === 500 && String(blocked.body.error).includes('公网'));

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
