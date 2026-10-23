import { config } from './config.mjs';

const MAX_PAGES = 20;

/**
 * 图片型 PDF 的兜底：把每页渲染成 PNG，交给 qwen-vl-ocr 识别。
 * 只在前面的文字层提取失败时调用。
 */
export async function ocrPdf(buffer) {
  const { baseUrl, apiKey, model } = config.ocr;
  if (!baseUrl || !apiKey) throw new Error('未配置 OCR');

  const { pdf } = await import('pdf-to-img');
  const doc = await pdf(buffer, { scale: 2 });

  const pages = [];
  for await (const page of doc) {
    pages.push(page);
    if (pages.length >= MAX_PAGES) break;
  }

  const texts = [];
  for (let i = 0; i < pages.length; i++) {
    const b64 = pages[i].toString('base64');
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '提取图片中的全部文字，保持原有顺序和换行，表格用 Markdown 表示。只输出文字，不要总结或解释。',
                },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content || '';
      if (text.trim()) texts.push(text.trim());
    } catch (err) {
      console.warn(`[ocr] page ${i + 1} failed:`, err.message);
    }
  }

  return texts.join('\n\n');
}
