import sharp from 'sharp';

// The final strip slots are 600px wide. Work at up to 1600px to retain detail
// without allocating several full 24-megapixel intermediate images.
export async function renderArtFilter(source, style) {
  const { data, info } = await sharp(source).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const luminance = new Uint8Array(width * height);
  for (let p = 0; p < luminance.length; p++) {
    const i = p * 3;
    luminance[p] = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
  }
  const blurred = style === 'pencil-sketch'
    ? await sharp(Buffer.from(luminance.buffer), { raw: { width, height, channels: 1 } }).blur(5).greyscale().raw().toBuffer()
    : null;
  const output = Buffer.allocUnsafe(width * height * 3);
  const clamp = n => Math.max(0, Math.min(255, Math.round(n)));
  const quantize = (n, steps) => Math.round(n / 255 * (steps - 1)) * 255 / (steps - 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x, i = p * 3;
      const l = luminance[p];
      const left = luminance[y * width + Math.max(0, x - 1)];
      const right = luminance[y * width + Math.min(width - 1, x + 1)];
      const up = luminance[Math.max(0, y - 1) * width + x];
      const down = luminance[Math.min(height - 1, y + 1) * width + x];
      const edge = Math.abs(right - left) + Math.abs(down - up);
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      let out;
      switch (style) {
        case 'pencil-sketch': {
          const sketch = Math.min(255, l * 255 / Math.max(1, blurred[p]));
          const ink = clamp(sketch - Math.max(0, edge - 8) * 1.3);
          out = [ink, ink, ink]; break;
        }
        case 'comic-pop': {
          const ink = edge > 34 ? .18 : 1;
          out = [r, g, b].map(c => quantize(clamp((c - l) * 1.5 + l), 5) * ink); break;
        }
        case 'doodle-art': {
          const ink = edge > 26 ? .25 : 1;
          out = [r, g, b].map(c => (quantize(c * .75 + 255 * .25, 6)) * ink); break;
        }
        case 'retro-print': {
          const dot = ((x % 5 - 2) ** 2 + (y % 5 - 2) ** 2 < 3 && l < 180) ? .76 : 1;
          out = [quantize(r * .82 + 40, 7), quantize(g * .78 + 35, 7), quantize(b * .65 + 28, 7)].map(c => c * dot); break;
        }
        case 'dreamy-illustration': {
          out = [r, g, b].map((c, channel) => quantize(c * .72 + 255 * .28 + (channel === 0 ? 7 : channel === 2 ? 12 : 0), 12)); break;
        }
        case 'magazine-cutout': {
          const ink = edge > 48 ? .32 : 1;
          out = [r, g, b].map(c => quantize(clamp((c - 128) * 1.32 + 128), 4) * ink); break;
        }
        default: throw new Error('Unknown artistic style');
      }
      output[i] = clamp(out[0]); output[i + 1] = clamp(out[1]); output[i + 2] = clamp(out[2]);
    }
  }
  return sharp(output, { raw: { width, height, channels: 3 } });
}
