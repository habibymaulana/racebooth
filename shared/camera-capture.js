// Bake the selected selfie orientation into the original capture once. The
// preview may use CSS mirroring for display, but saved pixels are flipped here.
export function drawCameraFrame(context, video, width, height, { mirrorHorizontal = false } = {}) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (mirrorHorizontal) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, width, height);
}

export async function encodeJpegWithinLimit(canvas, maxBytes, { qualities = [0.92, 0.86, 0.8, 0.74, 0.68], minimumWidth = 1280 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer.');
  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width < 1 || canvas.height < 1) {
    throw new TypeError('A non-empty camera canvas is required.');
  }
  const minScale = Math.min(1, minimumWidth / canvas.width);
  let scale = 1;
  for (let sizeAttempt = 0; sizeAttempt < 8; sizeAttempt += 1) {
    let target = canvas;
    if (scale < 1) {
      target = document.createElement('canvas');
      target.width = Math.max(1, Math.round(canvas.width * scale));
      target.height = Math.max(1, Math.round(canvas.height * scale));
      const context = target.getContext('2d', { alpha: false });
      if (!context) throw new Error('This browser could not prepare the photo for upload.');
      context.drawImage(canvas, 0, 0, target.width, target.height);
    }
    for (const quality of qualities) {
      const blob = await new Promise(resolve => target.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) throw new Error('This browser could not encode the photo for upload.');
      if (blob.size <= maxBytes) return blob;
    }
    if (scale <= minScale) break;
    scale = Math.max(minScale, scale * 0.82);
  }
  throw new Error('This photo is too large for the current upload limit. Retake it with a lower camera resolution.');
}
