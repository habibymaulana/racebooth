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
