import fs from 'node:fs';

const KNOWN = new Set([
  'PORT', 'DATA_DIR',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODELS', 'PROVIDER_ID',
  'PROVIDERS_JSON', 'PROVIDERS_FILE',
  'DASHSCOPE_API_KEY',
  'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL',
  'RERANK_BASE_URL', 'RERANK_API_KEY', 'RERANK_MODEL',
  'OCR_BASE_URL', 'OCR_API_KEY', 'OCR_MODEL',
  'MOCK', 'ALLOW_PRIVATE_MCP', 'EXA_API_KEY',
  'HOST', 'TRUST_PROXY', 'SKILLS_DIR',
  'ACCESS_CODE', 'RATE_LIMIT_PER_HOUR', 'DAILY_LIMIT',
  'AUTH_MAX_FAILS', 'AUTH_LOCK_MINUTES',
]);

const raw = fs.readFileSync('.env', 'utf8');
const issues = [];
if (raw.charCodeAt(0) === 0xfeff) issues.push('文件开头有 BOM（可能导致第一个变量读不到）');

const seen = new Map();
const rows = [];

raw.split(/\r?\n/).forEach((line, i) => {
  const n = i + 1;
  const t = line.trim();
  if (!t || t.startsWith('#')) return;

  const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) {
    issues.push(`第 ${n} 行不是合法的 KEY=VALUE：${t.slice(0, 40)}`);
    return;
  }

  const [, key, valueRaw] = m;
  if (seen.has(key)) issues.push(`第 ${n} 行重复定义 ${key}（前一次在第 ${seen.get(key)} 行）`);
  seen.set(key, n);

  let status = [];
  if (!KNOWN.has(key)) status.push('未知变量（代码里没用到）');

  const v = valueRaw.trim();
  if (v === '') status.push('空');
  if (valueRaw !== valueRaw.trimEnd()) status.push('行尾有空格');
  if (/^["'].*["']$/.test(v)) status.push('值被引号包住（dotenv 会保留引号）');
  if (/\s/.test(v) && key !== 'LLM_MODELS') status.push('值里有空格');

  if (key.endsWith('KEY') && v) {
    if (/^\s|\s$/.test(v)) issues.push(`${key} 首尾有空格`);
    if (/\.\.\.|xxxx|your[-_]?key/i.test(v)) issues.push(`${key} 看起来是占位符，不是真 key`);
  }

  rows.push({ n, key, status: status.join('，') || '正常' });
});

console.log('变量检查：');
for (const r of rows) console.log(`  ${String(r.n).padStart(2)}  ${r.key.padEnd(22)} ${r.status}`);
console.log(`\n共 ${rows.length} 个变量，${issues.length} 个问题`);
for (const x of issues) console.log('  ✗ ' + x);
