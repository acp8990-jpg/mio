// Proxy opcional para la License API de Lemon Squeezy (Cloudflare Workers, plan gratuito).
// Solo hace falta si el navegador bloquea las llamadas directas a api.lemonsqueezy.com (CORS).
// Despliegue: Cloudflare → Workers → Create → pega este archivo → Deploy, y pon su URL en LEMON.proxy (js/plan.js).
// No guarda nada ni necesita claves: reenvía activate / validate / deactivate tal cual.

const ALLOWED_ORIGINS = ['https://acp8990-jpg.github.io', 'http://localhost:8000'];
const ACTIONS = new Set(['activate', 'validate', 'deactivate']);

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const action = new URL(request.url).pathname.split('/').filter(Boolean).pop();
    if (request.method !== 'POST' || !ACTIONS.has(action)) return new Response('Not found', { status: 404, headers: cors });
    const res = await fetch(`https://api.lemonsqueezy.com/v1/licenses/${action}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: await request.text(),
    });
    return new Response(res.body, { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
