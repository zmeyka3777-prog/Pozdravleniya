/**
 * Код Судьбы — прокси для генерации поздравлений через OpenRouter (Kimi K2 free).
 *
 * Зачем: ключ OpenRouter хранится здесь (секрет OPENROUTER_KEY), посетители сайта
 * ничего не вводят. Заодно честно считаем бесплатный лимит: 3 поздравления на IP
 * за 30 дней (если подключено KV-хранилище LIMITS — без него лимит не проверяется).
 *
 * Настройка — см. worker/README.md в репозитории.
 */

const ALLOWED_ORIGINS = [
  'https://zmeyka3777-prog.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5500',
];

const SYSTEM_PROMPT =
  'Ты — талантливый автор тёплых персональных поздравлений на русском языке. ' +
  'Пишешь небанально, точно по заданному тону, попадая в характер человека.';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: cors });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (!env.OPENROUTER_KEY) return json({ error: 'no_key', message: 'Секрет OPENROUTER_KEY не задан' }, 500);

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

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.OPENROUTER_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': ALLOWED_ORIGINS[0],
        'X-Title': 'Kod Sudby Greetings',
      },
      body: JSON.stringify({
        model: env.MODEL || 'moonshotai/kimi-k2:free',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.9,
        max_tokens: 700,
      }),
    });

    if (!resp.ok) {
      return json({ error: 'upstream', message: 'OpenRouter HTTP ' + resp.status }, 502);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return json({ error: 'empty' }, 502);

    return json({ text });
  },
};
