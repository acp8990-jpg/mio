# Subti · subtítulos animados automáticos

App web instalable (PWA) que pone **subtítulos animados palabra a palabra** a tus vídeos para TikTok, Reels y Shorts.
Todo ocurre en el propio dispositivo: el vídeo **nunca se sube a ningún servidor**.

Modelo **freemium**: gratis con marca de agua y 3 estilos, y **Subti Pro** (4,99 €/mes o 29,99 €/año) con los
8 estilos, sin marca de agua, exportación en 4K y transcripción de máxima precisión.

## Flujo

1. **Elegir vídeo** (o arrastrarlo, o «Compartir → Subti» desde la galería del móvil una vez instalada).
2. **Generar subtítulos**: idioma (español por defecto) y calidad. Whisper transcribe en el dispositivo con
   tiempos por palabra; el texto va apareciendo mientras escucha.
3. **Editor**:
   - Vista previa con los subtítulos encima, exactamente como se exportan. Tocar = reproducir/pausar.
     **Arrastrar en vertical = colocar los subtítulos**, con imán en el centro y en la zona segura.
   - Línea de tiempo con los bloques de subtítulos y la forma de onda; desliza para moverte.
   - **Estilo**: 8 estilos animados con vista previa en vivo y color de resaltado.
   - **Texto**: corrige cualquier frase; los tiempos se reajustan solos.
   - **Ajustes**: tamaño, posición, palabras a la vez, mayúsculas y descarga del `.srt`.
4. **Exportar**: MP4 (H.264 + AAC) en 720p, 1080p o 4K (Pro), con o sin marca de agua. Compartir o guardar.

## Grabar con teleprompter

Desde el inicio, **Grabar con teleprompter**:

1. **Guion** sin límite de texto: escribe, pega o importa un `.txt`. La app cuenta palabras y calcula la duración
   aproximada. Puedes grabar por **párrafos**, por **frases** o **todo seguido**: si te equivocas, repites solo esa parte.
2. **Cámara** a pantalla completa con el texto encima, cerca del objetivo:
   - El texto **sigue tu voz** (va a la palabra que dices), avanza **mientras hablas** o va a **velocidad fija**.
     Se cambia con el botón del micrófono.
   - **Ensayar** sin grabar, cuenta atrás, tomas por partes con ✓, repetir cualquier parte y **Listo** para unirlas.
   - Toca la imagen para enfocar; mantén pulsado para bloquear enfoque y exposición. Arrastra la barrita del
     cuadro de texto para cambiar su alto.
3. **Ajustes** (rueda dentada), con cuatro pestañas:
   - **Texto**: tamaño, velocidad (palabras/min), alto y fondo del cuadro, posición, alineación, cuenta atrás,
     espejo, pasar a la siguiente parte y parar al terminar el texto.
   - **Voz**: modo, idioma del guion y sensibilidad del micrófono con medidor.
   - **Imagen**: estilos (Natural, Vivo, Cálido, Frío, Retrato, Cine, B/N), 12 ajustes finos y fondo original,
     desenfocado, de color o con una imagen tuya.
   - **Cámara**: vertical u horizontal, 720p/1080p/4K, 30/60 fps, calidad de compresión, limpieza del sonido y
     los controles del propio móvil (zoom, exposición, balance de blancos, enfoque manual, linterna).
4. Al terminar se unen las tomas y se transcribe. **Los subtítulos usan la escritura exacta de tu guion**
   (ortografía, tildes y puntuación) con los tiempos reales de tu voz. Sin conexión para la IA, salen del guion
   con tiempos aproximados.

Reutiliza los módulos de TeleClip (`../js/camera.js`, `grade.js`, `segment.js`, `voice.js` y `export.js`).

## Estilos

| Estilo | Plan | Cómo es |
|---|---|---|
| Impacto | Gratis | Condensada en mayúsculas con contorno; la palabra que suena crece y se pone amarilla |
| Karaoke | Gratis | La frase entera, se van «encendiendo» las palabras; la actual en verde |
| Limpio | Gratis | Texto sobrio sobre una píldora oscura, palabra a palabra |
| Caja | Pro | La palabra que suena va dentro de una caja de color |
| Neón | Pro | Brillo de neón cian; la palabra actual en rosa |
| Titular | Pro | Dos palabras grandes que rebotan al entrar |
| Rotulador | Pro | Letra manuscrita con subrayado de rotulador fosforito |
| Máquina | Pro | Máquina de escribir, letra a letra con cursor |

## Cómo funciona por dentro

| Parte | Tecnología |
|---|---|
| Audio del vídeo | [Mediabunny](https://github.com/Vanilagy/mediabunny) → 16 kHz mono (`js/transcribe.js`) |
| Transcripción | Whisper (`onnx-community/whisper-base_timestamped`; el preciso, `whisper-small_timestamped`) con [Transformers.js](https://github.com/huggingface/transformers.js) en un Web Worker, WebGPU si hay y si no WebAssembly (`js/worker.js`). Ventanas de ≤28 s cortadas en silencios |
| Subtítulos | Un único motor de dibujo en canvas para la vista previa y la exportación (`js/captions.js`) |
| Exportación | Decodifica cada fotograma, dibuja los subtítulos y recodifica con WebCodecs; el audio se copia sin pérdida (`js/render.js`) |
| Proyectos | IndexedDB en el dispositivo (`js/db.js`) |
| Planes | `js/plan.js` |
| Sin conexión | Service worker (`sw.js`); el modelo de voz queda en la caché del navegador tras la primera descarga |

Sin paso de compilación: HTML, CSS y JavaScript. Mediabunny está en `../vendor/`; Transformers.js 4.3.2 se carga
desde jsDelivr (versión fija) y el service worker lo guarda. Las fuentes (licencia SIL OFL) están en `fonts/`.

## Probar en local

```bash
python3 -m http.server 8000
# abre http://localhost:8000/subti/
```

Hace falta conexión la primera vez para descargar el modelo de voz (≈80 MB desde huggingface.co y el motor
WebAssembly desde cdn.jsdelivr.net).

## Pagos

Suscripciones con **Lemon Squeezy** y claves de licencia comprobadas desde la app (sin servidor).
Guía para activarlo: [PAGOS.md](PAGOS.md). Configuración en `js/plan.js` (`LEMON`); proxy opcional en
`server/license-proxy.js`.

## Pendiente

- Analítica mínima (embudo: vídeo elegido → transcrito → exportado → Pro).
- Más estilos, emojis automáticos y palabras clave resaltadas con IA.
