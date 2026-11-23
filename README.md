# TeleClip

Teleprompter **sin límite de caracteres** que **graba clip a clip** y une los clips en el propio móvil.
Es una app web instalable (PWA): funciona en Android y iPhone, sin servidores. Los vídeos no salen de tu dispositivo.

## Cómo se usa

1. **Guion**: pega o escribe el texto (o importa un `.txt`). Elige cómo dividirlo en clips:
   por párrafos (línea en blanco), por líneas, por frases o todo en un solo clip.
2. **Grabar**: la cámara se abre con el texto encima, cerca del objetivo.
   - ● graba el clip actual y el texto sube solo. Vuelve a pulsar para parar.
   - Al parar, el clip se guarda y se pasa al siguiente fragmento.
   - Toca el texto para pausar o reanudar. Arrástralo para moverlo a mano.
   - ▶ ensaya sin grabar. ⏮ ⏭ cambian de fragmento. ⟲ cambia de cámara.
   - ⚙ velocidad, tamaño de letra, alto y fondo del texto, cuenta atrás, calidad (720p/1080p),
     texto en espejo, avanzar al siguiente clip al parar y parar al acabar el texto.
3. **Clips**: revisa cada toma, regrábala, descárgala o bórrala. **Unir clips y exportar** crea un único
   vídeo **MP4 (H.264 + AAC)** que puedes descargar o compartir directamente.
   Elige la resolución final: Original, 720p, 1080p, 1440p (2K) o **2160p (4K)**. Los clips se reescalan
   (también hacia arriba) con suavizado de alta calidad. En vertical, 4K = 2160×3840.

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
| Grabación de cada clip | `MediaRecorder`: MP4 H.264 si el navegador lo permite (iPhone, Chrome reciente) y si no WebM |
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

- Que el texto avance siguiendo la voz (reconocimiento de voz en el dispositivo, p. ej. sherpa-onnx o Vosk).
- Subtítulos automáticos a partir del guion.
- Varias tomas por fragmento, recortar el inicio y el final de cada clip, y música de fondo.
- Varios proyectos o guiones.
