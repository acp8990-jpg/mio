# Activar los pagos de Subti Pro (Lemon Squeezy)

Subti cobra con **Lemon Squeezy**. Es el «comerciante registrado» (*merchant of record*): cobra al cliente, calcula y
declara el IVA de cada país y te paga lo que queda. Tú no necesitas servidor ni gestionar el IVA europeo.
Comisión aproximada: 5 % + 0,50 $ por venta; compruébala en su web.

Cómo funciona para el cliente:

1. En Subti pulsa **Suscribirme**. Se abre el pago de Lemon Squeezy en otra pestaña.
2. Paga y recibe una **clave de licencia**: en la página de confirmación y por email.
3. Vuelve a Subti: el campo para pegar la clave ya está abierto. Pulsa **Activar** y ya es Pro.
4. Si cancela o deja de pagar, la clave caduca y la app vuelve sola al plan gratis (se revisa cada 12 h).

## 1. Crear la tienda (≈15 min)

1. Crea la cuenta en https://app.lemonsqueezy.com y una tienda (por ejemplo «subti»), en **EUR**.
2. Completa la verificación de identidad y los datos de cobro (Settings → Payouts). Hasta que la aprueben puedes
   probarlo todo en **modo de prueba** (*Test mode*, interruptor abajo a la izquierda).

## 2. Crear el producto

**Products → New product**:

- Nombre: `Subti Pro`
- Precio: **Subscription**. Crea dos variantes:
  - `Mensual`: 4,99 € cada mes
  - `Anual`: 29,99 € cada año
- En **License keys**: activa **Generate license keys**.
  - *Activation limit*: `3` (móvil, tablet y ordenador)
  - *License length*: que dure lo que la suscripción (sin caducidad propia)
- En **Confirmation modal / Thank you**:
  - *Button text*: `Volver a Subti`
  - *Button link*: `https://acp8990-jpg.github.io/mio/subti/?compra=ok`

  Así, al terminar de pagar, la app se abre con el campo de la clave listo.
- Publica el producto.

## 3. Copiar los datos que necesita la app

| Dato | Dónde está |
|---|---|
| **ID de la tienda** | Settings → Stores: el número junto al nombre (`#12345`) |
| **ID del producto** | Products → Subti Pro: el número de la URL (`/products/67890`) |
| **Enlace de compra mensual** | Products → Subti Pro → Share → variante *Mensual* → Copy link |
| **Enlace de compra anual** | Igual, con la variante *Anual* |
| **Portal de cliente** | `https://TU-TIENDA.lemonsqueezy.com/billing` |

Pégalos en `subti/js/plan.js`:

```js
export const LEMON = {
  storeId: 12345,
  productIds: [67890],
  checkout: {
    monthly: 'https://subti.lemonsqueezy.com/buy/…',
    yearly: 'https://subti.lemonsqueezy.com/buy/…',
  },
  portal: 'https://subti.lemonsqueezy.com/billing',
  proxy: '',
};
```

O pásamelos y lo hago yo. Ninguno de estos datos es secreto: todos son públicos.

Mientras `storeId` esté a 0, la app sigue como hasta ahora: solo con la prueba gratis de 7 días.

## 4. Probar

1. Con la tienda en *Test mode*, compra con la tarjeta de prueba `4242 4242 4242 4242` (cualquier fecha futura y CVC).
2. Pega la clave en Subti → debe ponerse **Pro**.
3. En el panel de Lemon Squeezy cancela esa suscripción de prueba y, cuando termine, la app vuelve a gratis.
4. Cuando todo vaya bien, desactiva el *Test mode* y cambia los enlaces de compra por los de modo real (son distintos).

## Si la activación falla con un error de red (CORS)

La app llama directamente a la License API pública de Lemon Squeezy (`api.lemonsqueezy.com/v1/licenses/…`), que
no necesita ninguna clave secreta. Si algún navegador bloquease esas llamadas, despliega el proxy gratuito de
`server/license-proxy.js` en Cloudflare Workers (instrucciones dentro del archivo) y pon su URL en `LEMON.proxy`.

## Antes de vender

- **Fiscalidad**: Lemon Squeezy declara el IVA de las ventas, pero lo que te paga es un ingreso tuyo; en España
  normalmente implica darte de alta como autónomo o facturar a través de una sociedad. Consúltalo con tu gestor.
- **Textos legales**: añade una página de condiciones y de privacidad (Lemon Squeezy pide enlaces a ellas).
- **Límite conocido**: la prueba gratuita de 7 días se guarda en el navegador; alguien con conocimientos podría
  repetirla borrando los datos del sitio. Es lo normal en una web sin servidor y su impacto es pequeño.
