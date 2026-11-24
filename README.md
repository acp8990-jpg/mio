# TeleClip

Teleprompter **sin límite de caracteres** que **graba clip a clip** y une los clips en el propio móvil.
Es una app web instalable (PWA): funciona en Android y iPhone, sin servidores. Los vídeos no salen de tu dispositivo.

## Cómo se usa

1. **Guion**: pega o escribe el texto (o importa un `.txt`). Elige cómo dividirlo en clips:
   por párrafos (línea en blanco), por líneas, por frases o todo en un solo clip.
2. **Grabar**: la cámara se abre con el texto encima, cerca del objetivo.
   - ● graba el clip actual. Vuelve a pulsar para parar; el clip se guarda y pasa al siguiente fragmento.
   - **El texto sigue tu voz** (botón 🎙 arriba, o ⚙ → Voz):
     - *Siguiendo mis palabras*: reconoce lo que dices y va a esa palabra; si te paras, se para; si te
       saltas una frase, salta. Lo leído se atenúa y la palabra actual se resalta. Necesita internet.
     - *Mientras hablo*: avanza a la velocidad elegida solo cuando hablas (sin internet, cualquier navegador).
     - *A velocidad fija*.
   - **Vertical 9:16 u horizontal 16:9**: botón de formato arriba, o ⚙ → Grabación. La vista previa muestra
     exactamente el encuadre que se graba.
   - **Toca la imagen para enfocar** (y exponer) en ese punto; **mantén pulsado** para bloquear enfoque y
     exposición (aparece «AF bloqueado»). Funciona en Android con Chrome; en iPhone el navegador no lo permite
     y el enfoque es siempre automático.
   - **Mueve el cuadro de texto** arrastrando la barrita de arriba, y **cambia su tamaño** con la esquina inferior
     derecha. Se recuerda por separado con el móvil en vertical y en horizontal (⚙ → Texto → «Volver a colocar
     el texto arriba» lo devuelve a su sitio).
   - Toca el texto para pausar o reanudar. Arrástralo para colocarlo a mano y la lectura se resincroniza.
   - ▶ ensaya sin grabar. ⏮ ⏭ cambian de fragmento. ⟲ cambia de cámara.
   - ⚙ tiene cuatro pestañas:
     - **Texto**: velocidad, tamaño, alto y fondo, espejo, cuenta atrás, avanzar o parar solo.
     - **Voz**: modo, idioma del guion, sensibilidad del micrófono con medidor.
     - **Imagen**: **fondo** original, desenfocado (barra de 0 a 100), de un color o con una imagen tuya (detecta
       a la persona con MediaPipe; el modelo se descarga solo la primera vez, ~15 MB), **enfoque** automático o bloqueado, estilos (Natural, Vivo, Cálido, Frío, Retrato, Cine, B/N) y ajustes de exposición, brillo,
       contraste, luces, sombras, saturación, intensidad, temperatura, tinte, nitidez, suavizado de piel y viñeta.
       Más los controles propios de la cámara si el móvil los ofrece (zoom, exposición, balance de blancos,
       enfoque manual, linterna).
     - **Grabación**: formato, resolución (720p, 1080p, 4K), 30/60 fps, calidad de compresión y limpieza del
       sonido (reducción de ruido, cancelación de eco, volumen automático).
3. **Editar** (vista previa con todos los efectos, pestañas):
   - **Clips**: varias tomas por fragmento (eliges la buena), recorte automático o manual con forma de onda,
     **quitar silencios** (suave o fuerte, estilo TikTok), reordenar con ↑ ↓ y corregir el texto de cada clip.
   - **Subtítulos automáticos**: salen de tu guion sincronizados con tu voz. Estilos Resaltado, Karaoke, Grande y
     Clásico; letra, tamaño, posición, palabras por frase, mayúsculas y colores.
   - **Efectos**: zoom alterno en cada corte o acercamiento progresivo, transiciones (fundido, destello, zoom) y
     formato 9:16, 4:5, 1:1 o 16:9 con encuadre.
   - **Audio**: música de fondo que baja sola cuando hablas, mejora de voz (ecualizador y compresor), silenciar el
     ruido entre frases y volumen de la voz.
   - **Elementos**: textos, emojis e imágenes que se arrastran sobre la vista previa, con su momento de inicio y
     fin; logo o marca de agua en una esquina; barra de progreso.
   - **Exportar**: resolución hasta 4K, portada con título (descargable en JPG o puesta al principio del vídeo) y
     MP4 final, que se descarga o se comparte.
4. **Proyectos**: en la pestaña Guion, el menú ⋯ crea vídeos nuevos, renombra, duplica el guion o borra. Cada
   vídeo guarda su guion, sus tomas y su edición.

## Exportación

- **Formato**: siempre MP4. Vídeo H.264 (si el dispositivo no puede a esa resolución, prueba H.265, VP9 o AV1
  dentro del MP4) y audio AAC. Si el navegador no tiene codificador AAC (Firefox, algunos Chrome), se usa uno
  WebAssembly incluido en la app.
- **Sin recodificar**: si los clips ya son H.264/AAC del mismo tamaño y eliges «Original», se unen al instante y sin pérdida.
- **Proporción**: si es casi estándar (9:16, 16:9, 1:1, 4:5, 3:4) se ajusta a la medida exacta. Un clip con
  otra proporción se encaja con bandas negras, sin recortar.
- **Memoria**: el MP4 se escribe directamente en el almacenamiento privado del navegador (OPFS) cuando está
  disponible, para que un 4K largo no agote la RAM del móvil.
- Calidad de exportación: ~0,1 bits por píxel (≈6 Mbps en 1080p, ≈25 Mbps en 4K).
- La grabación admite 720p, 1080p y 4K si la cámara del móvil lo permite.

## Cómo funciona por dentro

| Parte | Tecnología |
|---|---|
| Cámara y micrófono | `getUserMedia` |
| Encuadre y color | La cámara se dibuja en un canvas del tamaño exacto (p. ej. 1080×1920) y un shader WebGL aplica la corrección de color en la GPU. Se graba ese canvas: lo que ves es lo que se graba |
| Grabación de cada clip | `MediaRecorder`: MP4 H.264 si el navegador lo permite (iPhone, Chrome reciente) y si no WebM |
| Fondo desenfocado | MediaPipe Selfie Segmenter (Apache-2.0, en `vendor/mediapipe/`) + desenfoque gaussiano en varias pasadas en la GPU |
| Enfoque por toque | `pointsOfInterest` / `focusMode` de MediaStreamTrack (Image Capture) |
| Editor | `js/timeline.js` (análisis de voz, recortes, silencios, tiempo de cada palabra), `js/render.js` (dibujo común de vista previa y exportación), `js/player.js`, `js/editor.js` |
| Mezcla de audio | Web Audio `OfflineAudioContext`: voz con EQ, compresor y puerta; música con atenuación automática |
| Seguir la voz | Web Speech API + alineación tolerante a errores con el guion (`js/voice.js`); plan B por nivel del micrófono |
| Almacenamiento | IndexedDB para los clips y `localStorage` para el guion y los ajustes |
| Unir, reescalar y exportar a MP4 | [Mediabunny](https://github.com/Vanilagy/mediabunny) + `@mediabunny/aac-encoder` (MPL-2.0, incluidas en `vendor/`), sobre WebCodecs |
| Sin conexión | Service worker (`sw.js`) |

No hay paso de compilación: es HTML, CSS y JavaScript sin dependencias que instalar.

## Probar en local

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

La cámara solo funciona en `https://` o en `localhost`. Para usarla en el móvil, publícala con HTTPS,
por ejemplo con GitHub Pages (Settings → Pages → rama y carpeta raíz), Netlify o Cloudflare Pages.
Luego, en el móvil: «Añadir a pantalla de inicio».

## Ideas para siguientes versiones

- Reconocimiento de voz sin internet (p. ej. sherpa-onnx o Vosk en WebAssembly).
- Subtítulos automáticos a partir del guion.
- Varias tomas por fragmento, recortar el inicio y el final de cada clip, y música de fondo.
- Varios proyectos o guiones.
