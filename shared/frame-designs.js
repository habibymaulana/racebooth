// Original racebooth vector artwork, shared by frame previews and JPEG composition.
// The camera delivers 16:9 images. Keep each slot within a fraction of a
// percent of that ratio (600 × 338) so landscape captures remain full-bleed.
export const FRAME_LAYOUT = Object.freeze({ width: 720, margin: 60, top: 110, photoWidth: 600, photoHeight: 338, gap: 30, footer: 160 });

export const FRAME_DESIGNS = Object.freeze({
  // Original 6
  blueberry: { background: '#bcd4f0', ink: '#1e3a63', accent: '#5c8ec9', label: 'BLUEBERRY SCRAPBOOK', category: 'Pastel' },
  'pink-diary': { background: '#fce4ec', ink: '#7a2d5a', accent: '#e8a0bf', label: 'PINK DIARY', category: 'Pastel' },
  'retro-bloom': { background: '#d4e8df', ink: '#2d5a3d', accent: '#6aaa8f', label: 'RETRO BLOOM', category: 'Retro' },
  'midnight-film': { background: '#1a2240', ink: '#d8e3ff', accent: '#7b8ece', label: 'MIDNIGHT FILM', category: 'Retro' },
  'sunny-picnic': { background: '#fdf3c7', ink: '#7a5f0a', accent: '#e8c84a', label: 'SUNNY PICNIC', category: 'Pastel' },
  'sweet-memories': { background: '#e8def0', ink: '#5a3d7a', accent: '#a890c8', label: 'SWEET MEMORIES', category: 'Pastel' },

  // 6 New Pinterest-inspired original designs
  'doodle-booth': { background: '#e8dfce', ink: '#241f1c', accent: '#8c765c', label: 'DOODLE BOOTH', category: 'Doodle' },
  'retro-checker': { background: '#fbf7ee', ink: '#8a2420', accent: '#d33f39', label: 'RETRO CHECKER', category: 'Retro' },
  'denim-memories': { background: '#354e6e', ink: '#e5eef9', accent: '#89aed4', label: 'DENIM MEMORIES', category: 'Scrapbook' },
  'polka-party': { background: '#fffdf8', ink: '#262220', accent: '#e76f51', label: 'POLKA PARTY', category: 'Artistic' },
  'heart-collage': { background: '#fae4eb', ink: '#6b203c', accent: '#d85f85', label: 'HEART COLLAGE', category: 'Scrapbook' },
  'vintage-film': { background: '#22201e', ink: '#f0e6d6', accent: '#c49a6c', label: 'VINTAGE FILM BOARD', category: 'Retro' },
});

const star = (x, y, size, color) => `<path d="M0,-${size} L${size * .26},-${size * .26} L${size},0 L${size * .26},${size * .26} L0,${size} L-${size * .26},${size * .26} L-${size},0 L-${size * .26},-${size * .26}Z" transform="translate(${x} ${y})" fill="${color}"/>`;
const heart = (x, y, size, color) => `<path d="M0,5 C-22,-10 -16,-30 0,-16 C16,-30 22,-10 0,5Z" transform="translate(${x} ${y}) scale(${size / 20})" fill="${color}"/>`;
const flower = (x, y, color, center = '#f3cb55') => `<g transform="translate(${x} ${y})">${[0,60,120,180,240,300].map(a => `<ellipse cx="0" cy="-13" rx="8" ry="14" fill="${color}" transform="rotate(${a})"/>`).join('')}<circle r="9" fill="${center}"/></g>`;
const cloud = (x, y) => `<g transform="translate(${x} ${y})" fill="#ffffff"><ellipse rx="28" ry="12"/><circle cx="-13" cy="-8" r="12"/><circle cx="7" cy="-13" r="17"/></g>`;
const bow = (x, y) => `<g transform="translate(${x} ${y})" stroke="#b96388" stroke-width="3" stroke-linejoin="round" fill="#f5bed5"><path d="M0,0 C-42,-38 -45,22 -5,8 L-16,37 L0,24 L16,37 L5,8 C45,22 42,-38 0,0Z"/><circle r="7" fill="#d77fa4"/></g>`;

// Sketch doodle decorations
const tape = (x, y, angle, color = '#f2e8d5') => `<rect x="${x - 30}" y="${y - 10}" width="60" height="20" rx="2" fill="${color}" opacity="0.8" transform="rotate(${angle} ${x} ${y})" />`;
const doodleStar = (x, y, size, color = '#241f1c') => `<path d="M0,-${size} Q2,-2 ${size},0 Q2,2 0,${size} Q-2,2 -${size},0 Q-2,-2 0,-${size}Z" transform="translate(${x} ${y})" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
const sparkleDoodle = (x, y, size, color = '#241f1c') => `<g transform="translate(${x} ${y})" stroke="${color}" stroke-width="2" stroke-linecap="round"><line x1="0" y1="-${size}" x2="0" y2="${size}"/><line x1="-${size}" y1="0" x2="${size}" y2="0"/></g>`;

export function renderFrameSvg(frameId, photoCount = 4) {
  const design = FRAME_DESIGNS[frameId];
  if (!design) throw new Error('Unknown frame design');
  if (!Number.isInteger(photoCount) || photoCount < 1 || photoCount > 20) throw new Error('Invalid frame photo count');
  const l = FRAME_LAYOUT;
  const height = l.top + photoCount * l.photoHeight + (photoCount - 1) * l.gap + l.footer;
  let pattern = '';
  let decor = '';

  if (frameId === 'blueberry') {
    pattern = '<pattern id="paper" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="11" height="32" fill="#ffffff" opacity=".24"/></pattern>';
    decor += cloud(99, 62) + cloud(621, 59) + star(173, 46, 15, '#f8e9a7') + star(552, 73, 10, '#fff');
    for (let y = 170; y < height - 130; y += 275) {
      decor += `<g fill="#718fc9"><circle cx="29" cy="${y}" r="11"/><circle cx="40" cy="${y + 10}" r="11"/><circle cx="24" cy="${y + 18}" r="11"/></g><path d="M28,${y - 8}q10,-22 20,-9q-8,16 -20,9" fill="#729c7c"/>`;
      decor += star(691, y + 100, 16, '#fff') + star(29, y + 150, 11, '#8da9d4');
    }
  } else if (frameId === 'pink-diary') {
    pattern = '<pattern id="paper" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="2" fill="#dba1bc" opacity=".5"/></pattern>';
    decor += bow(104, 45) + bow(615, 45);
    for (let y = 185; y < height - 120; y += 260) decor += heart(29, y, 23, '#df92b4') + heart(690, y + 120, 19, '#fff') + `<path d="M20,${y + 80}q25,30 0,60" stroke="#df92b4" stroke-width="3" fill="none"/>`;
  } else if (frameId === 'retro-bloom') {
    pattern = '<pattern id="paper" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M0,10H20" stroke="#719a83" stroke-opacity=".12"/></pattern>';
    decor += flower(106, 52, '#f3ad94') + flower(614, 52, '#f5eee0');
    for (let y = 175; y < height - 110; y += 300) decor += flower(27, y, '#f3ad94') + flower(693, y + 145, '#fff5df') + `<path d="M28,${y + 30}q-20,50 2,90m-2,-50q-25,-20 -18,-40q24,5 18,40m1,15q26,-30 18,-45q-24,10 -18,45" stroke="#6f9e7d" stroke-width="3" fill="#9abd9b"/>`;
  } else if (frameId === 'midnight-film') {
    pattern = '<pattern id="paper" width="13" height="17" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r=".8" fill="#fff" opacity=".13"/><circle cx="9" cy="13" r=".5" fill="#fff" opacity=".1"/></pattern>';
    for (let y = 123; y < height - 125; y += 57) decor += `<rect x="16" y="${y}" width="22" height="32" rx="5" fill="#b5c3e1" opacity=".62"/><rect x="682" y="${y}" width="22" height="32" rx="5" fill="#b5c3e1" opacity=".62"/>`;
    decor += star(106, 53, 23, '#f4d890') + star(610, 53, 18, '#d7e3ff') + `<path d="M558,28a24,24 0 1 0 20,38a22,22 0 0 1 -20,-38" fill="#f4d890"/>`;
  } else if (frameId === 'sunny-picnic') {
    pattern = '<pattern id="paper" width="52" height="52" patternUnits="userSpaceOnUse"><rect width="26" height="52" fill="#ebbd4d" opacity=".14"/><rect width="52" height="26" fill="#ebbd4d" opacity=".14"/></pattern>';
    decor += flower(109, 52, '#fffef4') + `<g transform="translate(611 54)" stroke="#dcac2e" stroke-width="3">${[0,45,90,135,180,225,270,315].map(a => `<path d="M0,-29V-39" transform="rotate(${a})"/>`).join('')}<circle r="22" fill="#f5cd50"/><path d="M-9,4q9,12 18,0" fill="none"/><circle cx="-7" cy="-4" r="1.5"/><circle cx="7" cy="-4" r="1.5"/></g>`;
    for (let y = 195; y < height - 100; y += 300) decor += flower(27, y, '#fffef4') + flower(692, y + 140, '#fffef4') + star(30, y + 160, 10, '#e5b43f');
  } else if (frameId === 'sweet-memories') {
    pattern = '<pattern id="paper" width="60" height="60" patternUnits="userSpaceOnUse"><circle cx="12" cy="15" r="2" fill="#ad91c6" opacity=".5"/><path d="M42,35v12m-6,-6h12" stroke="#fff" stroke-width="2"/></pattern>';
    decor += star(110, 54, 27, '#fff') + heart(608, 62, 25, '#b8a0d2') + star(563, 38, 13, '#fff');
    for (let y = 165; y < height - 120; y += 250) decor += star(28, y, 20, '#fff') + heart(692, y + 90, 21, '#b8a0d2') + star(693, y + 180, 13, '#fff');
  } else if (frameId === 'doodle-booth') {
    // Kraft cardboard with sketch doodle lines, washi tape, and cute doodle stars
    pattern = '<pattern id="paper" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="1" fill="#75624e" opacity=".2"/><circle cx="16" cy="16" r="1" fill="#75624e" opacity=".2"/></pattern>';
    decor += tape(100, 48, -6, '#f7edd8') + tape(620, 52, 8, '#f7edd8');
    decor += doodleStar(68, 80, 14, '#241f1c') + doodleStar(650, 85, 12, '#241f1c');
    decor += `<path d="M80,32 C120,22 180,36 210,26" stroke="#241f1c" stroke-width="2" fill="none" stroke-dasharray="4 4"/>`;
    for (let y = 200; y < height - 140; y += 280) {
      decor += doodleStar(28, y, 11, '#241f1c') + doodleStar(692, y + 110, 13, '#8c765c');
      decor += sparkleDoodle(30, y + 80, 8, '#241f1c') + sparkleDoodle(690, y + 170, 7, '#241f1c');
      decor += tape(30, y + 140, 90, '#ebd8be');
    }
  } else if (frameId === 'retro-checker') {
    // Red & orange retro checkerboard trim
    pattern = '<pattern id="paper" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#d33f39" opacity=".85"/><rect x="10" y="10" width="10" height="10" fill="#d33f39" opacity=".85"/><rect x="10" width="10" height="10" fill="#fbf7ee"/><rect y="10" width="10" height="10" fill="#fbf7ee"/></pattern>';
    // Checker stripes on left and right margins
    decor += `<rect x="12" y="24" width="24" height="${height - 48}" rx="4" fill="url(#paper)"/>`;
    decor += `<rect x="684" y="24" width="24" height="${height - 48}" rx="4" fill="url(#paper)"/>`;
    // Camera badge at header
    decor += `<g transform="translate(100, 50)" fill="#d33f39"><rect x="-24" y="-16" width="48" height="32" rx="6"/><circle cx="0" cy="0" r="9" fill="#fbf7ee"/><circle cx="0" cy="0" r="5" fill="#d33f39"/></g>`;
    decor += star(620, 52, 16, '#e87738') + star(650, 40, 10, '#d33f39');
    for (let y = 240; y < height - 150; y += 320) {
      decor += star(48, y, 12, '#e87738') + star(672, y + 120, 14, '#d33f39');
    }
  } else if (frameId === 'denim-memories') {
    // Textured denim blue with stitch dashed lines and fabric patch look
    pattern = '<pattern id="paper" width="16" height="16" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="16" y2="16" stroke="#253850" stroke-width="1.5" opacity=".4"/><line x1="16" y1="0" x2="0" y2="16" stroke="#253850" stroke-width="1.5" opacity=".4"/></pattern>';
    // Stitched perimeter line
    decor += `<rect x="20" y="20" width="680" height="${height - 40}" rx="12" fill="none" stroke="#b8cde6" stroke-width="3" stroke-dasharray="8 6"/>`;
    // Patch badge
    decor += `<g transform="translate(105, 52)"><rect x="-35" y="-18" width="70" height="36" rx="8" fill="#4a688e" stroke="#fff" stroke-width="2" stroke-dasharray="4 3"/><text x="0" y="5" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="12" font-weight="800">MEMORIES</text></g>`;
    decor += star(620, 52, 16, '#b8cde6') + star(655, 68, 10, '#fff');
    for (let y = 180; y < height - 120; y += 270) {
      decor += star(35, y, 11, '#b8cde6') + heart(685, y + 80, 14, '#b8cde6');
    }
  } else if (frameId === 'polka-party') {
    // Ivory with festive multi-colored polka dots & party ribbons
    pattern = '<pattern id="paper" width="36" height="36" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="3.5" fill="#2b2b2b" opacity=".75"/><circle cx="28" cy="28" r="3" fill="#e76f51" opacity=".7"/><circle cx="28" cy="10" r="2.5" fill="#f4a261" opacity=".65"/><circle cx="10" cy="28" r="2.5" fill="#2a9d8f" opacity=".6"/></pattern>';
    decor += `<g transform="translate(100, 50)" fill="#e76f51"><circle r="16"/><circle r="10" fill="#fff"/><circle r="5"/></g>`;
    decor += star(610, 48, 18, '#f4a261') + star(645, 62, 11, '#2a9d8f');
    for (let y = 200; y < height - 130; y += 260) {
      decor += star(28, y, 13, '#e76f51') + star(692, y + 100, 15, '#2a9d8f') + heart(28, y + 140, 12, '#f4a261');
    }
  } else if (frameId === 'heart-collage') {
    // Romantic blush pink scrapbook with layered illustrated hearts and washi tape
    pattern = '<pattern id="paper" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M0 20 Q10 15 20 20 T40 20" stroke="#f0c4d4" stroke-width="1.5" fill="none" opacity=".5"/></pattern>';
    decor += tape(105, 45, -5, '#ffffffcc') + tape(615, 45, 7, '#ffffffcc');
    decor += heart(105, 52, 22, '#d85f85') + heart(615, 52, 20, '#d85f85');
    decor += star(160, 46, 11, '#fff') + star(560, 46, 11, '#fff');
    for (let y = 175; y < height - 110; y += 240) {
      decor += heart(28, y, 18, '#d85f85') + heart(692, y + 80, 20, '#ffffff') + heart(690, y + 160, 14, '#c87698');
      decor += star(30, y + 90, 10, '#ffffff');
    }
  } else if (frameId === 'vintage-film') {
    // Aged film board contact sheet with dark aesthetic & camera roll perforations
    pattern = '<pattern id="paper" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.8" fill="#c49a6c" opacity=".12"/><circle cx="12" cy="12" r="0.6" fill="#fff" opacity=".08"/></pattern>';
    // Film strip sprockets on edges
    for (let y = 40; y < height - 40; y += 46) {
      decor += `<rect x="14" y="${y}" width="20" height="28" rx="4" fill="#3a3733"/><rect x="686" y="${y}" width="20" height="28" rx="4" fill="#3a3733"/>`;
      decor += `<text x="24" y="${y + 20}" text-anchor="middle" font-family="monospace" font-size="9" fill="#c49a6c" opacity=".6">●</text>`;
    }
    decor += `<text x="110" y="58" font-family="monospace" font-size="14" font-weight="700" letter-spacing="2" fill="#c49a6c">KODAK 400</text>`;
    decor += `<text x="610" y="58" font-family="monospace" font-size="14" font-weight="700" letter-spacing="2" fill="#c49a6c">EXP 04</text>`;
  }

  // Photo mats
  const mats = Array.from({ length: photoCount }, (_, i) => {
    const y = l.top + i * (l.photoHeight + l.gap);
    const matBg = (frameId === 'midnight-film' || frameId === 'vintage-film') ? '#33312e' : (frameId === 'denim-memories' ? '#f0f4fa' : (frameId === 'doodle-booth' ? '#fcfaf6' : '#fffdf9'));
    const strokeAttr = (frameId === 'midnight-film' || frameId === 'vintage-film')
      ? 'stroke="#45423e" stroke-width="2"'
      : (frameId === 'doodle-booth' ? 'stroke="#241f1c" stroke-width="2"' : 'stroke="#d8e1ea" stroke-width="1.5"');
    return `<rect x="${l.margin - 8}" y="${y - 8}" width="${l.photoWidth + 16}" height="${l.photoHeight + 16}" rx="5" fill="${matBg}" ${strokeAttr}/>`;
  }).join('');

  const bottom = height - l.footer;
  decor += star(117, bottom + 82, 13, design.accent) + star(603, bottom + 82, 13, design.accent);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="${height}" viewBox="0 0 720 ${height}"><defs>${pattern}</defs><rect width="720" height="${height}" fill="${design.background}"/><rect width="720" height="${height}" fill="url(#paper)"/>${mats}${decor}<text x="360" y="62" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="700" letter-spacing="3" fill="${design.ink}">LET'S MAKE MEMORIES</text><text x="360" y="${bottom + 71}" text-anchor="middle" font-family="sans-serif" font-size="40" font-weight="800" letter-spacing="-2" fill="${design.ink}">racebooth.</text><text x="360" y="${bottom + 102}" text-anchor="middle" font-family="sans-serif" font-size="13" letter-spacing="3" fill="${design.ink}">${design.label}</text><text x="360" y="${bottom + 132}" text-anchor="middle" font-family="sans-serif" font-size="11" letter-spacing="1.5" fill="${design.ink}">CAPTURE THE MOMENT. KEEP THE MEMORY.</text></svg>`;
}
