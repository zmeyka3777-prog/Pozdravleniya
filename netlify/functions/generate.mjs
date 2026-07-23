/**
 * Прокси для ИИ-генерации — Netlify Function (зеркало functions/generate.js для Cloudflare).
 * Доступна по адресу <site>.netlify.app/generate
 *
 * Секрет OPENROUTER_KEY задаётся в переменных окружения проекта Netlify.
 */

const ALLOWED_ORIGINS = [
  'https://zmeyka3777-prog.github.io',
  'https://pozdravleniya.pages.dev',
];

const SYSTEM_PROMPT =
  'Ты — талантливый автор тёплых персональных поздравлений на русском языке. ' +
  'Пишешь небанально, точно по заданному тону, попадая в характер человека.';

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const ok = ALLOWED_ORIGINS.includes(origin)
    || origin.endsWith('.netlify.app')
    || origin.endsWith('.pozdravleniya.pages.dev');
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

// Живой список бесплатных моделей с OpenRouter (приоритет — сильные в русском)
async function fetchFreeModels() {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    if (!r.ok) return [];
    const d = await r.json();
    const unsuitable = /(code|coder|safety|guard|moderation|embed|rerank|audio|whisper|ocr|vision)/i;
    const free = (d.data || []).map(m => m.id)
      .filter(id => id.endsWith(':free') && !unsuitable.test(id));
    const prio = ['deepseek', 'qwen', 'kimi', 'glm', 'llama', 'gemma', 'mistral'];
    free.sort((a, b) => {
      const ia = prio.findIndex(p => a.includes(p)), ib = prio.findIndex(p => b.includes(p));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return free;
  } catch { return []; }
}

export default async (req) => {
  const cors = corsHeaders(req);
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: cors });

  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const apiKey = process.env.OPENROUTER_KEY || process.env.kimi || process.env.KIMI;

  // Диагностика: GET /generate
  if (req.method === 'GET') {
    const free = await fetchFreeModels();
    return json({
      status: 'функция работает (Netlify)',
      key_found: Boolean(apiKey),
      key_hint: apiKey ? 'ключ на месте' : 'добавьте переменную OPENROUTER_KEY в Site configuration → Environment variables',
      model: process.env.MODEL || 'авто: живой список бесплатных моделей OpenRouter',
      free_models_available: free.length,
      free_models_top: free.slice(0, 6),
    });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!apiKey) return json({ error: 'no_key', message: 'Переменная OPENROUTER_KEY не задана' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const prompt = String(body.prompt || '').slice(0, 6000);
  if (!prompt) return json({ error: 'no_prompt' }, 400);

  const FREE_MODELS = [
    'deepseek/deepseek-chat-v3-0324:free',
    'qwen/qwen3-235b-a22b:free',
    'moonshotai/kimi-k2:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-3-27b-it:free',
  ];
  const liveFree = await fetchFreeModels();
  const models = [...new Set([process.env.MODEL, ...liveFree.slice(0, 6), ...FREE_MODELS].filter(Boolean))];

  let lastErr = 'нет доступных моделей';
  let allUnavailableForFree = true;
  for (const model of models) {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': ALLOWED_ORIGINS[0],
        'X-Title': 'Kod Sudby Greetings',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.9,
        max_tokens: 1300,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return json({ text, model });
      lastErr = 'модель ' + model + ' вернула пустой ответ';
      continue;
    }

    const errText = (await resp.text()).slice(0, 300);
    lastErr = 'OpenRouter HTTP ' + resp.status + ' (' + model + '): ' + errText;
    if (!errText.includes('unavailable for free')) allUnavailableForFree = false;
    const retryable = resp.status === 404 || resp.status === 400 || resp.status === 429 ||
      errText.includes('unavailable') || errText.includes('not found') || errText.includes('No endpoints');
    if (!retryable) break;
  }

  if (allUnavailableForFree) {
    lastErr = 'Все модели OpenRouter отвечают «unavailable for free». ' + lastErr;
  }
  return json({ error: 'upstream', message: lastErr }, 502);
};

export const config = { path: '/generate' };
