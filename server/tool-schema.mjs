import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * 工具参数校验。
 *
 * 工具定义里的 parameters 本身就是 JSON Schema；MCP 的 inputSchema 也是。
 * 这里用 AJV 在服务端执行前再校验一次，避免模型少传字段、传错类型或瞎编参数。
 *
 * 说明：
 * - strict: false 容忍 MCP schema 里的未知关键字和不同 draft；
 * - 不做隐式类型转换：模型传错类型时应让模型修正，而不是悄悄改数据；
 * - useDefaults: true 填充 schema 里的 default；
 * - 编译失败时降级为“不校验”，不能因为某个 MCP schema 不兼容就阻断聊天。
 */

const options = {
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: true,
};

const ajv = new Ajv(options);
const ajv2020 = new Ajv2020(options);
addFormats(ajv);
addFormats(ajv2020);

/** name + schema 作为 key；MCP 重连后 schema 变了会重新编译 */
const cache = new Map();
const MAX_CACHE = 200;

function keyOf(name, schema) {
  try {
    return `${name}\n${JSON.stringify(schema)}`;
  } catch {
    return name;
  }
}

function compile(schema, name) {
  // 先按 draft-07 编译，失败再尝试 2020-12
  try {
    return ajv.compile(schema);
  } catch (first) {
    try {
      return ajv2020.compile(schema);
    } catch (second) {
      console.warn(`[tool] schema compile failed (${name}): ${first.message}; ${second.message}`);
      return null;
    }
  }
}

/**
 * @param {string} name 工具名
 * @param {object} schema 工具的 JSON Schema
 * @param {object} args 模型生成的参数
 * @returns {{ ok: true, args: object } | { ok: false, error: string }}
 */
export function validateToolArgs(name, schema, args) {
  if (!schema || typeof schema !== 'object') return { ok: true, args };

  const key = keyOf(name, schema);
  let validate = cache.get(key);

  if (validate === undefined) {
    validate = compile(schema, name);
    cache.set(key, validate);

    // 简单 LRU 上限，避免长期运行时无限增长
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  // 编译失败的 schema 不阻断执行，交给工具/MCP 自己处理
  if (!validate) return { ok: true, args };

  const valid = validate(args);
  if (!valid) {
    const detail = ajv.errorsText(validate.errors, { separator: '; ' }).slice(0, 400);
    return { ok: false, error: detail || '参数不合法' };
  }

  return { ok: true, args };
}
