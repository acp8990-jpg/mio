// Freemium: qué incluye la versión gratuita y qué desbloquea Subti Pro.
//
// IMPORTANTE: el cobro todavía no está conectado. Cuando haya cuenta en una pasarela (Stripe Payment
// Links, Lemon Squeezy o Paddle), pon aquí los enlaces de pago y verifica la compra en un servidor
// (o con licencias firmadas). Hasta entonces, «Probar Pro» activa una prueba local de 7 días.

import { prefs, setPrefs } from './db.js';

export const CHECKOUT = {
  monthly: '', // p. ej. 'https://buy.stripe.com/...'
  yearly: '',
};

export const PRICES = {
  monthly: { label: 'Mensual', price: '4,99 €', per: '/mes' },
  yearly: { label: 'Anual', price: '29,99 €', per: '/año', note: '2,50 €/mes · ahorra 50 %' },
};

export const FREE = {
  maxShort: 1080, // resolución máxima (lado corto)
  watermark: true,
};

const TRIAL_DAYS = 7;

export function proStatus() {
  const st = prefs('pro', null);
  if (!st) return { pro: false };
  if (st.until && Date.now() > st.until) return { pro: false, expired: true };
  return { pro: true, until: st.until, kind: st.kind };
}

export const isPro = () => proStatus().pro;

export function startTrial() {
  const until = Date.now() + TRIAL_DAYS * 864e5;
  setPrefs('pro', { kind: 'trial', until });
  return until;
}

export function trialUsed() {
  return !!prefs('trialUsed', false);
}

export function markTrialUsed() {
  setPrefs('trialUsed', true);
}
