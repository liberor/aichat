import { randomUUID } from 'node:crypto';
import { streamChat } from './llm.mjs';
import { executeTool } from './tools.mjs';

const runs = new Map();
const TTL = 30 * 60 * 1000;

export function createRun(params) {
  const run = {
    id: randomUUID(),
    tenant: params.tenant || 'public',
    events: [],
    done: false,
    subs: new Set(),
    startedAt: Date.now(),
    abort: new AbortController(),
    // 本次 run 的累计 usage（多个 Agent step 相加）
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };
  runs.set(run.id, run);

  execute(run, params)
    .catch((err) => {
      if (err?.name === 'AbortError') return;
      emit(run, { type: 'error', message: err?.message || String(err) });
    })
    .finally(() => {
      emit(run, { type: 'done' });
      run.done = true;
      setTimeout(() => runs.delete(run.id), TTL).unref?.();
    });

  return run.id;
}

export function getRun(id) {
  return runs.get(id);
}

export function cancelRun(id) {
  const run = runs.get(id);
  if (!run || run.done) return false;
  run.abort.abort();
  return true;
}

function emit(run, event) {
  // id 必须是事件序号（用于 SSE 的 Last-Event-ID 续传），放在最后避免被 payload 覆盖
  const e = { ...event, id: run.events.length + 1 };
  run.events.push(e);
  for (const sub of run.subs) {
    try {
      sub.send(e);
    } catch {}
  }
  // done 之后服务端主动关流，避免连接悬着
  if (e.type === 'done') {
    for (const sub of run.subs) {
      try {
        sub.end();
      } catch {}
    }
    run.subs.clear();
  }
}

/** SSE 订阅：先回放 lastEventId 之后的事件，再持续推送 */
export function subscribe(run, lastEventId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (e) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  const sub = {
    send,
    end: () => {
      try {
        res.end();
      } catch {}
    },
  };

  let lastSent = lastEventId;
  let forwardedDone = false;
  const forward = (e) => {
    send(e);
    lastSent = Math.max(lastSent, e.id);
    if (e.type === 'done') forwardedDone = true;
  };

  /** run 已经结束：保证客户端收到的最后一条一定是 done，否则 EventSource 会一直重连 */
  const finish = () => {
    if (!forwardedDone) {
      const final = run.events.at(-1);
      // 回放里还没带 done：先把最后一条补上（通常是 done），再兜底补终止信号
      if (final && final.id > lastSent) forward(final);
      if (!forwardedDone) send({ type: 'done', id: lastSent });
    }
    res.end();
  };

  for (const e of run.events) {
    if (e.id > lastEventId) forward(e);
  }

  if (run.done) {
    finish();
    return () => {};
  }

  run.subs.add(sub);

  // 回放和订阅之间 run 可能刚好结束，这里补一次，避免这次连接永远收不到 done
  if (run.done) {
    run.subs.delete(sub);
    finish();
    return () => {};
  }

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 15000);
  const cleanup = () => {
    clearInterval(ping);
    run.subs.delete(sub);
  };
  res.on('close', cleanup);
  return cleanup;
}

/* ---------------- Agent 循环 ---------------- */

async function execute(run, { provider, model, messages, tools, apiKey, mock, tenant }) {
  const convo = [...messages];
  const MAX_STEPS = 6;
  // 本次 run 在 POST 时快照下来的工具白名单：没声明过的工具一律不执行
  const allowed = new Set((tools || []).map((t) => t?.function?.name).filter(Boolean));

  for (let step = 0; step < MAX_STEPS; step++) {
    if (run.abort.signal.aborted) return;
    let content = '';
    /** @type {Map<number, {id:string,name:string,args:string}>} */
    const acc = new Map();
    let stepUsage = null;

    for await (const ev of streamChat({ provider, model, messages: convo, tools, signal: run.abort.signal, apiKey, mock })) {
      if (ev.type === 'delta') {
        content += ev.text;
        emit(run, { type: 'delta', text: ev.text });
      } else if (ev.type === 'tool_delta') {
        // tool_call 参数是流式碎片，按 index 累加，流结束后才能 JSON.parse
        const d = ev.tc;
        const idx = d.index ?? 0;
        const slot = acc.get(idx) || { id: '', name: '', args: '' };
        if (d.id) slot.id += d.id;
        if (d.function?.name) slot.name += d.function.name;
        if (d.function?.arguments) slot.args += d.function.arguments;
        acc.set(idx, slot);
      } else if (ev.type === 'usage') {
        // 一次 completion 可能发多次 usage，只取最后一次，避免重复累加
        stepUsage = ev.usage;
      }
    }

    // 每个 step 结束后发一次累计值：前端仍然是覆盖，回放也幂等
    if (stepUsage) {
      if (!run.usage) run.usage = { prompt_tokens: 0, completion_tokens: 0 };
      run.usage.prompt_tokens += Number(stepUsage.prompt_tokens) || 0;
      run.usage.completion_tokens += Number(stepUsage.completion_tokens) || 0;

      emit(run, {
        type: 'usage',
        usage: {
          ...stepUsage,
          prompt_tokens: run.usage.prompt_tokens,
          completion_tokens: run.usage.completion_tokens,
          total_tokens: run.usage.prompt_tokens + run.usage.completion_tokens,
        },
      });
    }

    const pending = [...acc.values()].filter((c) => c.name);
    if (!pending.length) break;

    const calls = pending.map((c, i) => ({
      id: c.id || `call_${step}_${i}_${randomUUID().slice(0, 8)}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));

    convo.push({ role: 'assistant', content: content || null, tool_calls: calls });

    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      emit(run, { type: 'tool_call', callId: call.id, name: call.function.name, args, at: Date.now() });

      let result;
      if (!allowed.has(call.function.name)) {
        result = `工具未启用: ${call.function.name}`;
      } else {
        try {
          result = await executeTool(tenant, call.function.name, args, { signal: run.abort.signal });
        } catch (err) {
          // 用户取消：不要包装成工具失败，让 createRun 的 catch 静默结束
          if (err?.name === 'AbortError' || run.abort.signal.aborted) throw err;
          result = `工具执行失败: ${err.message}`;
        }
      }
      emit(run, { type: 'tool_result', callId: call.id, name: call.function.name, result, at: Date.now() });

      convo.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }
}
