/**
 * 统一的 LLM 流式接口。
 * yield: {type:'delta', text} | {type:'tool_delta', tc} | {type:'usage', usage}
 *
 * 说明：tool_calls 的 arguments 是流式碎片到达的，必须按 index 累加，
 * 由调用方在流结束后再 JSON.parse。
 */
export async function* streamChat({ provider, model, messages, tools, signal, apiKey, mock }) {
  if (mock || !apiKey) {
    yield* mockStream(messages, signal);
    return;
  }

  // 兜底：非 ASCII 会让 fetch 在构造 header 时抛 ByteString 错误，先给出可读提示
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('API key 含非法字符（中文或空格），请在右侧面板重新填写');
  }

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || provider.models[0],
      messages,
      tools: tools && tools.length ? tools : undefined,
      tool_choice: tools && tools.length ? 'auto' : undefined,
      stream: true,
      stream_options: provider.id === 'gemini' ? undefined : { include_usage: true },
      temperature: 0.7,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      // 原始 JSON 里通常带 request_id / 打码 key，对用户没意义；留在服务端排查
      console.warn(`[llm] ${provider.id} auth failed (${res.status}):`, body.slice(0, 400));
      throw new Error('模型鉴权失败：key 无效、已过期，或没有该模型的权限');
    }
    throw new Error(`LLM ${res.status}: ${body.slice(0, 400)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) yield { type: 'usage', usage: json.usage };

      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: 'delta', text: delta.content };
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) yield { type: 'tool_delta', tc };
      }
    }
  }
}

/** 没有 API key 时的假流，用于跑通 UI 与断流续传 */
async function* mockStream(messages, signal) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const q = typeof last?.content === 'string' ? last.content : '(空)';
  const hasContext = messages.some((m) => m.role === 'system' && m.content.includes('<context>'));

  const text = [
    `（Mock 模式：未配置 LLM_API_KEY，以下是假回答）\n\n`,
    `你问的是：**${q}**\n\n`,
    hasContext
      ? `我看到上下文里带了检索到的资料，说明 **RAG 链路已经跑通**。\n\n`
      : `这次没有检索到资料，走的是普通对话。\n\n`,
    `配置 \`.env\` 里的 \`LLM_API_KEY\` 后重启，就会替换成真实模型输出。`,
  ].join('');

  for (const piece of text.match(/.{1,4}/gs) || []) {
    if (signal?.aborted) return;
    await new Promise((r) => setTimeout(r, 18));
    yield { type: 'delta', text: piece };
  }
}
