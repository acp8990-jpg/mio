// Freemium: qué incluye la versión gratuita y qué desbloquea Subti Pro.
//
// Cobro con Lemon Squeezy (comerciante registrado: cobra y declara el IVA de cada país por ti).
// Al suscribirse, el cliente recibe una CLAVE DE LICENCIA (en la página de confirmación y por email) y la
// pega en la app. La app la activa y la revisa con la License API pública de Lemon Squeezy, que no necesita
// ninguna clave secreta, así que funciona en una web estática como GitHub Pages.
// Si la suscripción se cancela o deja de pagarse, la licencia caduca y la app vuelve al plan gratis.
//
// Para configurarlo, rellena LEMON (ver subti/PAGOS.md).

import { prefs, setPrefs } from './db.js';

export const LEMON = {
  storeId: 0, // número de tu tienda (Settings → Stores)
  productIds: [], // ids de los productos Subti Pro; vacío = se acepta cualquier producto de la tienda
  checkout: {
    monthly: '', // enlace de compra de la variante mensual, p. ej. 'https://tutienda.lemonsqueezy.com/buy/…'
    yearly: '', // enlace de compra de la variante anual
  },
  portal: '', // portal de cliente para cancelar o cambiar tarjeta, p. ej. 'https://tutienda.lemonsqueezy.com/billing'
  // Solo si el navegador bloquea las llamadas directas (CORS): URL del proxy de subti/server/license-proxy.js
  proxy: '',
};

export const paymentsReady = () => !!(LEMON.storeId && (LEMON.checkout.monthly || LEMON.checkout.yearly));

export const PRICES = {
  monthly: { label: 'Mensual', price: '4,99 €', per: '/mes' },
  yearly: { label: 'Anual', price: '29,99 €', per: '/año', note: '2,50 €/mes · ahorra 50 %' },
};

export const FREE = {
  maxShort: 1080, // resolución máxima (lado corto)
  watermark: true,
};

const TRIAL_DAYS = 7;
const RECHECK_MS = 12 * 3600e3; // revisar la licencia cada 12 h
const OFFLINE_GRACE_MS = 10 * 864e5; // sin conexión, Pro sigue 10 días desde la última comprobación correcta

// ---------------------------------------------------------------- estado

export function proStatus() {
  const lic = prefs('license', null);
  if (lic?.status === 'active' && Date.now() - lic.checked < OFFLINE_GRACE_MS) {
    return { pro: true, kind: 'license', plan: lic.variant, email: lic.email };
  }
  const st = prefs('pro', null);
  if (st?.kind === 'trial' && st.until && Date.now() < st.until) return { pro: true, kind: 'trial', until: st.until };
  return { pro: false, expired: !!(st?.until || lic) };
}

export const isPro = () => proStatus().pro;

export function startTrial() {
  const until = Date.now() + TRIAL_DAYS * 864e5;
  setPrefs('pro', { kind: 'trial', until });
  return until;
}

export const trialUsed = () => !!prefs('trialUsed', false);
export const markTrialUsed = () => setPrefs('trialUsed', true);

export function checkoutUrl(plan) {
  const base = LEMON.checkout[plan];
  if (!base) return '';
  const u = new URL(base);
  u.searchParams.set('checkout[custom][app]', 'subti');
  return u.toString();
}

// ---------------------------------------------------------------- License API

const API = 'https://api.lemonsqueezy.com/v1/licenses/';

async function call(action, params) {
  const body = new URLSearchParams(params);
  const url = LEMON.proxy ? `${LEMON.proxy.replace(/\/$/, '')}/${action}` : API + action;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* respuesta vacía */
  }
  return data;
}

function belongsToUs(meta) {
  if (!meta) return false;
  if (LEMON.storeId && Number(meta.store_id) !== Number(LEMON.storeId)) return false;
  if (LEMON.productIds.length && !LEMON.productIds.map(Number).includes(Number(meta.product_id))) return false;
  return true;
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Navegador';
  return `Subti · ${os} · ${new Date().toLocaleDateString('es')}`;
}

const MESSAGES = {
  'license_key not found.': 'Esa clave no existe. Cópiala tal cual del email de compra.',
  'This license key has reached the activation limit.': 'Esta clave ya está activada en el máximo de dispositivos. Quítala de otro dispositivo en el portal de cliente.',
  'This license key is expired.': 'Esta suscripción ha terminado. Renuévala para volver a Pro.',
  'This license key is disabled.': 'Esta clave está desactivada.',
};
const human = (err) => MESSAGES[err] || err || 'No se pudo comprobar la clave. Inténtalo de nuevo.';

/** Activa una clave en este dispositivo. Devuelve { ok, error }. */
export async function activateLicense(rawKey) {
  const key = rawKey.trim();
  if (!/^[A-Za-z0-9-]{16,}$/.test(key)) return { ok: false, error: 'Eso no parece una clave de licencia.' };
  let data;
  try {
    data = await call('activate', { license_key: key, instance_name: deviceName() });
  } catch {
    return { ok: false, error: 'Sin conexión con el servidor de pagos. Revisa tu internet.' };
  }
  if (!data.activated) return { ok: false, error: human(data.error) };
  if (!belongsToUs(data.meta)) {
    // no es de Subti: liberamos la activación que acabamos de gastar
    call('deactivate', { license_key: key, instance_id: data.instance?.id }).catch(() => {});
    return { ok: false, error: 'Esa clave no es de Subti Pro.' };
  }
  save(key, data.instance?.id, data);
  return { ok: true };
}

function save(key, instanceId, data) {
  setPrefs('license', {
    key,
    instanceId,
    status: data.license_key?.status === 'expired' || data.license_key?.status === 'disabled' ? data.license_key.status : 'active',
    variant: data.meta?.variant_name || '',
    email: data.meta?.customer_email || '',
    checked: Date.now(),
  });
}

/**
 * Revisa la licencia guardada (como mucho cada 12 h, salvo force). Si la suscripción terminó, quita Pro.
 * Sin conexión no cambia nada (hay 10 días de margen).
 */
export async function refreshLicense(force = false) {
  const lic = prefs('license', null);
  if (!lic?.key) return proStatus();
  if (!force && Date.now() - lic.checked < RECHECK_MS) return proStatus();
  try {
    const data = await call('validate', { license_key: lic.key, instance_id: lic.instanceId || '' });
    if (data.valid && belongsToUs(data.meta)) save(lic.key, lic.instanceId, data);
    else if (data.error || data.valid === false) setPrefs('license', { ...lic, status: data.license_key?.status || 'invalid', checked: Date.now() });
  } catch {
    /* sin conexión: se mantiene el estado */
  }
  return proStatus();
}

/** Quita la licencia de este dispositivo (libera la activación para otro). */
export async function unlinkLicense() {
  const lic = prefs('license', null);
  if (lic?.key && lic.instanceId) await call('deactivate', { license_key: lic.key, instance_id: lic.instanceId }).catch(() => {});
  setPrefs('license', null);
}

export const licenseInfo = () => prefs('license', null);
