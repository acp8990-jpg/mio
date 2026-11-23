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
3. **Clips**: revisa cada toma, regrábala, descárgala o bórrala. **Unir clips y exportar** crea un único vídeo
   que puedes descargar o compartir directamente.

## Cómo funciona por dentro

| Parte | Tecnología |
|---|---|
| Cámara y micrófono | `getUserMedia` |
| Grabación de cada clip | `MediaRecorder` (MP4 en iPhone, WebM en Android/Chrome) |
| Almacenamiento | IndexedDB para los clips y `localStorage` para el guion y los ajustes |
| Unir clips | [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0, incluida en `vendor/`). Si todos los clips tienen el mismo formato, los copia sin recodificar (instantáneo). Si no, recodifica a un tamaño y audio comunes |
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
