// Une los clips en un único vídeo, en el propio dispositivo.
// 1) Ruta rápida: si todos los clips tienen el mismo códec y tamaño, copia los paquetes sin recodificar.
// 2) Ruta de respaldo: decodifica y recodifica todo a un tamaño común (más lenta, siempre funciona).

import {
  Input,
  Output,
  BlobSource,
  BufferTarget,
  ALL_FORMATS,
  Mp4OutputFormat,
  WebMOutputFormat,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  CanvasSink,
  CanvasSource,
  AudioBufferSink,
  AudioSample,
  AudioSampleSource,
  canEncodeVideo,
  canEncodeAudio,
  QUALITY_HIGH,
} from '../vendor/mediabunny.min.mjs';

const MP4_VIDEO = ['avc', 'hevc'];

async function describe(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('Uno de los clips no contiene vídeo.');
  const audio = await input.getPrimaryAudioTrack();
  const start = await input.getFirstTimestamp();
  const end = await input.computeDuration();
  return {
    input,
    video,
    audio,
    start,
    duration: Math.max(0.04, end - start),
    vConfig: await video.getDecoderConfig(),
    aConfig: audio ? await audio.getDecoderConfig() : null,
    rotation: await video.getRotation(),
  };
}

function sameBytes(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const x = ArrayBuffer.isView(a) ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(a);
  const y = ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function canCopy(clips) {
  const f = clips[0];
  if (!f.vConfig || (f.audio && !f.aConfig)) return false;
  return clips.every(
    (c) =>
      c.video.codec === f.video.codec &&
      c.video.codedWidth === f.video.codedWidth &&
      c.video.codedHeight === f.video.codedHeight &&
      c.rotation === f.rotation &&
      sameBytes(c.vConfig?.description, f.vConfig.description) &&
      !!c.audio === !!f.audio &&
      (!f.audio ||
        (c.audio.codec === f.audio.codec &&
          c.audio.sampleRate === f.audio.sampleRate &&
          c.audio.numberOfChannels === f.audio.numberOfChannels &&
          sameBytes(c.aConfig?.description, f.aConfig.description))),
  );
}

async function collect(track) {
  const packets = [];
  for await (const p of new EncodedPacketSink(track).packets()) packets.push(p);
  return packets;
}

function finish(output, target, useMp4, mode) {
  const mime = useMp4 ? 'video/mp4' : 'video/webm';
  return {
    blob: new Blob([target.buffer], { type: mime }),
    mime,
    ext: useMp4 ? 'mp4' : 'webm',
    mode,
  };
}

async function copyJoin(clips, onProgress) {
  const first = clips[0];
  const useMp4 = MP4_VIDEO.includes(first.video.codec) || first.audio?.codec === 'aac';
  const target = new BufferTarget();
  const output = new Output({
    format: useMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target,
  });
  const vSource = new EncodedVideoPacketSource(first.video.codec);
  output.addVideoTrack(vSource, { rotation: first.rotation });
  let aSource = null;
  if (first.audio) {
    aSource = new EncodedAudioPacketSource(first.audio.codec);
    output.addAudioTrack(aSource);
  }
  await output.start();

  const total = clips.reduce((s, c) => s + c.duration, 0);
  let offset = 0;
  let firstVideo = true;
  let firstAudio = true;

  for (const clip of clips) {
    const vp = await collect(clip.video);
    const ap = clip.audio ? await collect(clip.audio) : [];
    let i = 0;
    let j = 0;
    // Intercalamos audio y vídeo por marca de tiempo, respetando el orden de cada pista.
    while (i < vp.length || j < ap.length) {
      const takeAudio = j < ap.length && (i >= vp.length || ap[j].timestamp < vp[i].timestamp);
      const p = takeAudio ? ap[j++] : vp[i++];
      const shifted = p.clone({ timestamp: Math.max(0, p.timestamp - clip.start + offset) });
      if (takeAudio) {
        await aSource.add(shifted, firstAudio ? { decoderConfig: first.aConfig } : undefined);
        firstAudio = false;
      } else {
        await vSource.add(shifted, firstVideo ? { decoderConfig: first.vConfig } : undefined);
        firstVideo = false;
        onProgress?.(Math.min(1, (shifted.timestamp + 0.001) / total));
      }
    }
    offset += clip.duration;
  }
  await output.finalize();
  return finish(output, target, useMp4, 'copia');
}

/** Convierte un AudioBuffer al número de canales y frecuencia indicados. */
async function conform(buffer, channels, rate) {
  if (buffer.numberOfChannels === channels && buffer.sampleRate === rate) return buffer;
  const length = Math.max(1, Math.round(buffer.duration * rate));
  const ctx = new OfflineAudioContext(channels, length, rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

async function pickCodecs(width, height) {
  const options = [
    { mp4: true, v: 'avc', a: 'aac' },
    { mp4: false, v: 'vp9', a: 'opus' },
    { mp4: false, v: 'vp8', a: 'opus' },
  ];
  // Preferimos una combinación en la que se puedan codificar vídeo y audio.
  for (const o of options) {
    if ((await canEncodeVideo(o.v, { width, height })) && (await canEncodeAudio(o.a))) return o;
  }
  for (const o of options) {
    if (await canEncodeVideo(o.v, { width, height })) return { ...o, a: null };
  }
  throw new Error('Este navegador no puede codificar vídeo.');
}

async function reencodeJoin(clips, onProgress) {
  const first = clips[0];
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const width = even(first.video.displayWidth);
  const height = even(first.video.displayHeight);
  const codecs = await pickCodecs(width, height);
  const hasAudio = clips.some((c) => c.audio) && codecs.a;

  const target = new BufferTarget();
  const output = new Output({
    format: codecs.mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target,
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const vSource = new CanvasSource(canvas, { codec: codecs.v, bitrate: QUALITY_HIGH });
  output.addVideoTrack(vSource);
  let aSource = null;
  if (hasAudio) {
    aSource = new AudioSampleSource({ codec: codecs.a, bitrate: QUALITY_HIGH });
    output.addAudioTrack(aSource);
  }
  await output.start();

  // Todo el audio sale con el mismo formato aunque los clips difieran (mono/estéreo, 44,1/48 kHz).
  const audioClips = clips.filter((c) => c.audio);
  const outRate = audioClips[0]?.audio.sampleRate || 48000;
  const outChannels = Math.min(2, Math.max(1, ...audioClips.map((c) => c.audio.numberOfChannels)));

  const total = clips.reduce((s, c) => s + c.duration, 0);
  let offset = 0;
  let lastTs = -1;
  for (const clip of clips) {
    const videoJob = (async () => {
      const sink = new CanvasSink(clip.video, { width, height, fit: 'contain', poolSize: 2 });
      for await (const frame of sink.canvases()) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(frame.canvas, 0, 0, width, height);
        // Las marcas de tiempo deben crecer siempre, también en el empalme entre clips.
        const ts = Math.max(0, lastTs + 1 / 240, frame.timestamp - clip.start + offset);
        lastTs = ts;
        await vSource.add(ts, frame.duration || 1 / 30);
        onProgress?.(Math.min(1, ts / total));
      }
    })();
    const audioJob = (async () => {
      if (!aSource || !clip.audio) return;
      for await (const { buffer, timestamp } of new AudioBufferSink(clip.audio).buffers()) {
        const normalized = await conform(buffer, outChannels, outRate);
        const ts = Math.max(0, timestamp - clip.start + offset);
        for (const sample of AudioSample.fromAudioBuffer(normalized, ts)) {
          await aSource.add(sample);
          sample.close();
        }
      }
    })();
    await Promise.all([videoJob, audioJob]);
    offset += clip.duration;
  }
  await output.finalize();
  return finish(output, target, codecs.mp4, 'recodificado');
}

/**
 * @param {Blob[]} blobs clips en orden
 * @param {(p:number)=>void} onProgress progreso 0..1
 */
export async function joinClips(blobs, onProgress) {
  if (!blobs.length) throw new Error('No hay clips que unir.');
  const clips = [];
  for (const b of blobs) clips.push(await describe(b));
  if (canCopy(clips)) {
    try {
      return await copyJoin(clips, onProgress);
    } catch (err) {
      console.warn('Copia directa fallida, recodificando…', err);
    }
  }
  onProgress?.(0);
  return reencodeJoin(clips, onProgress);
}
