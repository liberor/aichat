import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const ROOT = path.resolve(process.env.SKILLS_DIR || 'skills');
const DEFAULTS = path.join(ROOT, '_defaults');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

fs.mkdirSync(ROOT, { recursive: true });

/** 每个租户一个目录，首次访问时把 _defaults 里的技能复制过去 */
function tenantDir(tenant) {
  const key = tenant || 'public';
  const dir = path.join(ROOT, key);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(DEFAULTS)) {
      for (const d of fs.readdirSync(DEFAULTS, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        fs.cpSync(path.join(DEFAULTS, d.name), path.join(dir, d.name), { recursive: true });
      }
    }
  }
  return dir;
}

function skillPath(tenant, name) {
  if (!NAME_RE.test(name)) throw new Error('skill 名称只能是 a-z0-9-');
  return path.join(tenantDir(tenant), name, 'SKILL.md');
}

export function listSkills(tenant) {
  const dir = tenantDir(tenant);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const file = path.join(dir, d.name, 'SKILL.md');
      if (!fs.existsSync(file)) return null;
      try {
        const { data } = matter(fs.readFileSync(file, 'utf8'));
        // 统一用目录名作为技能名，避免 frontmatter 里手写的 name 与路径不一致
        return { name: d.name, description: data.description || '' };
      } catch {
        return { name: d.name, description: '(解析失败)' };
      }
    })
    .filter(Boolean);
}

export function getSkill(tenant, name) {
  try {
    const file = skillPath(tenant, name);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const { data, content } = matter(raw);
    return { name, description: data.description || '', body: content.trim() };
  } catch {
    // 非法名称（大写、路径片段等）按不存在处理，别让 chat 路由 500
    return null;
  }
}

export function saveSkill(tenant, { name, description, body }) {
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  const text = String(body || '');
  if (desc.length > 500) throw new Error('描述最多 500 字符');
  if (text.length > 50000) throw new Error('正文最多 50000 字符');

  const file = skillPath(tenant, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // JSON.stringify 产出合法的 YAML 双引号字符串，描述里出现冒号/井号也不会写坏
  const fm = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${text}\n`;
  fs.writeFileSync(file, fm);
  return getSkill(tenant, name);
}

export function deleteSkill(tenant, name) {
  fs.rmSync(path.dirname(skillPath(tenant, name)), { recursive: true, force: true });
}

/** 渐进式披露的第二层：只有被选中时才把正文注入 system */
export function skillToPrompt(skill) {
  const body =
    skill.body.length > 20000
      ? `${skill.body.slice(0, 20000)}\n\n[内容过长，已截断]`
      : skill.body;

  // 描述来自 SKILL.md 的 frontmatter；压成一行，并和保存时的 500 字符上限对齐
  const desc = String(skill.description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  return `\n\n<skill name="${skill.name}">\n${desc ? `描述：${desc}\n\n` : ''}${body}\n</skill>`;
}
