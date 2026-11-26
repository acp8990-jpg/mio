// Hilo aparte para la detección de la persona: así el dibujo y la grabación nunca esperan al modelo.
/* global Vision */
importScripts('../vendor/mediapipe/vision_bundle.js');

let segmenter = null;
let lastTs = 0;

async function init(base) {
  const fileset = await Vision.FilesetResolver.forVisionTasks(base);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${base}selfie_segmenter.tflite`, delegate },
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  try {
    segmenter = await Vision.ImageSegmenter.createFromOptions(fileset, options('GPU'));
    return 'GPU';
  } catch {
    segmenter = await Vision.ImageSegmenter.createFromOptions(fileset, options('CPU'));
    return 'CPU';
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      const delegate = await init(msg.base);
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
    return;
  }
  if (msg.type === 'frame') {
    const bitmap = msg.bitmap;
    let sent = false;
    try {
      const ts = Math.max(lastTs + 1, Math.round(msg.ts));
      lastTs = ts;
      segmenter.segmentForVideo(bitmap, ts, (result) => {
        const mask = result.confidenceMasks?.[0];
        if (!mask) return;
        const f = mask.getAsFloat32Array();
        const data = new Uint8Array(f.length);
        for (let i = 0; i < f.length; i++) data[i] = f[i] * 255;
        self.postMessage({ type: 'mask', data, width: mask.width, height: mask.height }, [data.buffer]);
        sent = true;
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    } finally {
      bitmap.close?.();
      if (!sent) self.postMessage({ type: 'skip' });
    }
  }
};
