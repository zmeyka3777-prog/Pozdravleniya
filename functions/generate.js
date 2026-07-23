/**
 * Прокси для ИИ-генерации — Cloudflare Pages Function.
 * Доступна по адресу https://pozdravleniya.pages.dev/generate
 *
 * Прячет ключ OpenRouter (секрет OPENROUTER_KEY в настройках Pages-проекта),
 * посетители сайта ничего не вводят. Если подключено KV-хранилище LIMITS —
 * честно считает бесплатный лимит: 3 поздравления на IP за 30 дней.
 */

const ALLOWED_ORIGINS = [
  'https://zmeyka3777-prog.github.io',
  'https://pozdravleniya.pages.dev',
];

const SYSTEM_PROMPT =
  'Ты — талантливый автор тёплых персональных поздравлений на русском языке. ' +
  'Пишешь небанально, точно по заданному тону, попадая в характер человека.';

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const ok = ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.pozdravleniya.pages.dev');
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}

// Живой список бесплатных моделей с OpenRouter (приоритет — сильные в русском языке)
async function fetchFreeModels() {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    if (!r.ok) return [];
    const d = await r.json();
    const free = (d.data || []).map(m => m.id).filter(id => id.endsWith(':free'));
    const prio = ['deepseek', 'qwen', 'kimi', 'glm', 'llama', 'gemma', 'mistral'];
    free.sort((a, b) => {
      const ia = prio.findIndex(p => a.includes(p)), ib = prio.findIndex(p => b.includes(p));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return free;
  } catch { return []; }
}

// Диагностика: открыть /generate в браузере — покажет состояние без секретов
export async function onRequestGet({ request, env }) {
  const keyFound = Boolean(env.OPENROUTER_KEY || env.kimi || env.KIMI || env.Kimi);
  const free = await fetchFreeModels();
  return new Response(JSON.stringify({
    status: 'функция работает',
    key_found: keyFound,
    key_hint: keyFound ? 'ключ на месте' : 'секрет не найден — добавьте OPENROUTER_KEY (или kimi) в Settings → Variables and Secrets и сделайте Retry deployment',
    model: env.MODEL || 'авто: живой список бесплатных моделей OpenRouter',
    free_models_available: free.length,
    free_models_top: free.slice(0, 6),
    limits_kv: Boolean(env.LIMITS),
  }, null, 2), { headers: corsHeaders(request) });
}

export async function onRequestPost({ request, env }) {
  const cors = corsHeaders(request);
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: cors });

  // Ключ OpenRouter: принимаем любое из привычных имён секрета
  const apiKey = env.OPENROUTER_KEY || env.kimi || env.KIMI || env.Kimi;
  if (!apiKey) {
    return json({ error: 'no_key', message: 'Секрет с ключом OpenRouter не задан в настройках Pages' }, 500);
  }

  // Честный бесплатный лимит: 3 генерации на IP за 30 дней (нужно KV-хранилище LIMITS)
  if (env.LIMITS) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = 'ip:' + ip;
    const used = Number(await env.LIMITS.get(key)) || 0;
    const freeLimit = Number(env.FREE_LIMIT || 3);
    if (used >= freeLimit) {
      return json({ error: 'limit', message: 'Бесплатный лимит исчерпан' }, 402);
    }
    await env.LIMITS.put(key, String(used + 1), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const prompt = String(body.prompt || '').slice(0, 6000);
  if (!prompt) return json({ error: 'no_prompt' }, 400);

  // Живой список бесплатных моделей с OpenRouter + запасной статический
  const FREE_MODELS = [
    'deepseek/deepseek-chat-v3-0324:free',
    'qwen/qwen3-235b-a22b:free',
    'moonshotai/kimi-k2:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-3-27b-it:free',
  ];
  const liveFree = await fetchFreeModels();
  const models = [...new Set([env.MODEL, ...liveFree.slice(0, 6), ...FREE_MODELS].filter(Boolean))];

  if (liveFree.length === 0 && !env.MODEL) {
    // Живой список пуст — вероятно, OpenRouter закрыл бесплатный тариф
    // (всё равно попробуем статический список ниже, вдруг список просто не загрузился)
  }

  let lastErr = 'нет доступных моделей';
  let allUnavailableForFree = true;
  for (const model of models) {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': ALLOWED_ORIGINS[1],
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
    // Модель недоступна/не найдена — пробуем следующую; другие ошибки фатальны
    const retryable = resp.status === 404 || resp.status === 400 || resp.status === 429 ||
      errText.includes('unavailable') || errText.includes('not found') || errText.includes('No endpoints');
    if (!retryable) break;
  }

  if (allUnavailableForFree) {
    lastErr = 'Все модели OpenRouter отвечают «unavailable for free» — похоже, бесплатный тариф OpenRouter закрыт. Нужен другой источник ИИ (Groq/Gemini) или небольшое пополнение баланса OpenRouter. ' + lastErr;
  }
  return json({ error: 'upstream', message: lastErr }, 502);
}
