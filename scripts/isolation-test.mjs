const BASE = 'http://localhost:8790';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + ' ' + extra);
  }
};

async function login(code) {
  const r = await fetch(BASE + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) throw new Error('login failed ' + r.status);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function get(path, cookie) {
  const r = await fetch(BASE + path, { headers: { Cookie: cookie } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function post(path, body, cookie) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

console.log('\n[登录与隔离]');
const a = await login('alpha');
const b = await login('beta');
ok('alpha 登录', Boolean(a));
ok('beta 登录', Boolean(b));

const cfg = await get('/api/config', '');
ok('config 不返回租户数据', cfg.body && cfg.body.documents === undefined);

let stateA = await get('/api/state', a);
let stateB = await get('/api/state', b);
ok('默认技能已复制给租户', stateA.body.skills.length >= 3, JSON.stringify(stateA.body.skills.length));
ok('初始文档为空', stateA.body.documents.length === 0 && stateB.body.documents.length === 0);

console.log('\n[文档隔离]');
const fd = new FormData();
fd.append('file', new Blob(['ALPHA_SECRET_TOKEN 这是 alpha 的机密文档'], { type: 'text/plain' }), 'alpha.txt');
const up = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: a }, body: fd });
ok('alpha 上传成功', up.status === 200);

stateA = await get('/api/state', a);
stateB = await get('/api/state', b);
ok('alpha 能看到自己的文档', stateA.body.documents.length === 1);
ok('beta 看不到 alpha 的文档', stateB.body.documents.length === 0, JSON.stringify(stateB.body.documents));

const sa = await post('/api/search', { query: 'ALPHA_SECRET_TOKEN' }, a);
const sb = await post('/api/search', { query: 'ALPHA_SECRET_TOKEN' }, b);
ok('alpha 检索命中', sa.body.length > 0);
ok('beta 检索不到', sb.body.length === 0);

console.log('\n[RAG 与 run 隔离]');
const chatA = await post('/api/chat', { messages: [{ role: 'user', content: 'ALPHA_SECRET_TOKEN 是什么' }], useRag: true }, a);
const chatB = await post('/api/chat', { messages: [{ role: 'user', content: 'ALPHA_SECRET_TOKEN 是什么' }], useRag: true }, b);
ok('alpha 的 RAG 有来源', chatA.body.sources.length > 0);
ok('beta 的 RAG 没有来源', chatB.body.sources.length === 0);

const cross = await fetch(`${BASE}/api/chat/${chatA.body.runId}/stream`, { headers: { Cookie: b } });
ok('beta 读不到 alpha 的 run', cross.status === 404);

console.log('\n[技能隔离]');
const sk = await post('/api/skills', { name: 'beta-only', description: '仅 beta', body: '# x' }, b);
ok('beta 建技能成功', sk.status === 200);
const listA = await get('/api/skills', a);
const listB = await get('/api/skills', b);
ok('alpha 看不到 beta 的技能', !listA.body.some((s) => s.name === 'beta-only'));
ok('beta 能看到自己的技能', listB.body.some((s) => s.name === 'beta-only'));

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
