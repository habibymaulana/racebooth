import { useRef } from "react";
import { renderFrameSvg, FRAME_LAYOUT } from "../../shared/frame-designs.js";

export const FRAMES = [
  // Original 6
  {
    id: "blueberry",
    name: "Blueberry Scrapbook",
    description: "Baby blue stripes, stars & clouds",
    colors: ["#b4c7e7", "#dce8f5", "#fff"],
    accent: "#7ba7d4",
    tag: "dreamy",
    category: "Pastel",
  },
  {
    id: "pink-diary",
    name: "Pink Diary",
    description: "Blush pink, ribbons & hearts",
    colors: ["#f5c6d8", "#fce4ec", "#fff5f8"],
    accent: "#e8a0bf",
    tag: "romantic",
    category: "Pastel",
  },
  {
    id: "retro-bloom",
    name: "Retro Bloom",
    description: "Sage green, vintage florals",
    colors: ["#9dc4b0", "#d4e8df", "#f5f0e8"],
    accent: "#6aaa8f",
    tag: "vintage",
    category: "Retro",
  },
  {
    id: "midnight-film",
    name: "Midnight Film",
    description: "Dark navy, film grain & stars",
    colors: ["#2d3561", "#1a2240", "#0f1628"],
    accent: "#7b8ece",
    tag: "cinematic",
    category: "Retro",
  },
  {
    id: "sunny-picnic",
    name: "Sunny Picnic",
    description: "Yellow, daisies & sunshine",
    colors: ["#f5e6a3", "#fdf3c7", "#fffde7"],
    accent: "#e8c84a",
    tag: "cheerful",
    category: "Pastel",
  },
  {
    id: "sweet-memories",
    name: "Sweet Memories",
    description: "Lavender, sparkles & polaroid",
    colors: ["#c9b8d8", "#e8def0", "#f5f0fb"],
    accent: "#a890c8",
    tag: "magical",
    category: "Pastel",
  },

  // 6 New Pinterest-inspired designs
  {
    id: "doodle-booth",
    name: "Doodle Booth",
    description: "Kraft cardboard, sketch lines & tape",
    colors: ["#e8dfce", "#f7edd8", "#241f1c"],
    accent: "#8c765c",
    tag: "sketched",
    category: "Doodle",
  },
  {
    id: "retro-checker",
    name: "Retro Checker",
    description: "Red & cream checkerboard border",
    colors: ["#fbf7ee", "#fad9d7", "#d33f39"],
    accent: "#d33f39",
    tag: "retro",
    category: "Retro",
  },
  {
    id: "denim-memories",
    name: "Denim Memories",
    description: "Denim blue texture & stitched borders",
    colors: ["#354e6e", "#e5eef9", "#89aed4"],
    accent: "#89aed4",
    tag: "collage",
    category: "Scrapbook",
  },
  {
    id: "polka-party",
    name: "Polka Party",
    description: "Festive confetti dots & coral ribbons",
    colors: ["#fffdf8", "#feeae6", "#e76f51"],
    accent: "#e76f51",
    tag: "party",
    category: "Artistic",
  },
  {
    id: "heart-collage",
    name: "Heart Collage",
    description: "Blush pink, washi tape & layered hearts",
    colors: ["#fae4eb", "#fdecf1", "#d85f85"],
    accent: "#d85f85",
    tag: "lovely",
    category: "Scrapbook",
  },
  {
    id: "vintage-film",
    name: "Vintage Film Board",
    description: "Analog contact sheet & Kodak aesthetic",
    colors: ["#22201e", "#3a3733", "#c49a6c"],
    accent: "#c49a6c",
    tag: "analog",
    category: "Retro",
  },
];

export const CATEGORIES = ["All", "Pastel", "Retro", "Scrapbook", "Doodle", "Artistic"];

function FrameBadgeIcon({ id, size = 15 }) {
  if (id === "blueberry" || id === "sweet-memories") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
    );
  }
  if (id === "pink-diary" || id === "heart-collage") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
      </svg>
    );
  }
  if (id === "retro-bloom" || id === "sunny-picnic") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3m-3.5-6.5-2 2m-7 7-2 2m0-11 2 2m7 7 2 2"/>
      </svg>
    );
  }
  if (id === "midnight-film" || id === "vintage-film") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect width="18" height="18" x="3" y="3" rx="2"/>
        <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>
      </svg>
    );
  }
  if (id === "retro-checker") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect width="18" height="18" x="3" y="3" rx="2"/>
        <path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
      </svg>
    );
  }
  if (id === "denim-memories" || id === "polka-party") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2l3 7h7l-5.5 4.5 2 7L12 16.5 6.5 20.5l2-7L3 9h7z"/>
    </svg>
  );
}

function FramePreview({ frame, selected }) {
  const [bg, mid] = frame.colors;
  const height = FRAME_LAYOUT.top + 4 * FRAME_LAYOUT.photoHeight + 3 * FRAME_LAYOUT.gap + FRAME_LAYOUT.footer;
  const svg = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderFrameSvg(frame.id, 4))}`;
  return (
    <div className={`frame-preview-card ${selected ? "selected" : ""}`} style={{ "--frame-bg": bg, "--frame-mid": mid, "--frame-accent": frame.accent }}>
      <div className="frame-strip-mini" style={{ aspectRatio: `${FRAME_LAYOUT.width} / ${height}` }}>
        <img className="frame-art-preview" src={svg} alt="" aria-hidden="true" />
        {[0, 1, 2, 3].map(index => (
          <div key={index} className="frame-photo-placeholder" style={{
            position: "absolute", left: `${100 * FRAME_LAYOUT.margin / FRAME_LAYOUT.width}%`,
            top: `${100 * (FRAME_LAYOUT.top + index * (FRAME_LAYOUT.photoHeight + FRAME_LAYOUT.gap)) / height}%`,
            width: `${100 * FRAME_LAYOUT.photoWidth / FRAME_LAYOUT.width}%`, height: `${100 * FRAME_LAYOUT.photoHeight / height}%`,
          }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 5l1.5 2H20v12H4V7h4.5L10 5z"/><circle cx="12" cy="13" r="3"/></svg></div>
        ))}
      </div>
      {selected && <div className="frame-selected-badge" aria-label="Selected">✓ Selected</div>}
    </div>
  );
}

export default function FrameSelector({ selected, onSelect }) {
  const carousel = useRef(null);
  const move = (direction) => carousel.current?.scrollBy({ left: direction * Math.min(carousel.current.clientWidth * .8, 720), behavior: "smooth" });

  return (
    <div className="frame-selector">
      <div className="frame-selector-header">
        <span className="rb-eyebrow">STEP 1 OF 3 · 12 ORIGINAL FRAMES</span>
        <h2>Choose your frame design</h2>
        <p>Pick the aesthetic that matches your mood today. All designs are 100% free.</p>
      </div>
      <div className="frame-carousel-shell">
        <button type="button" className="frame-carousel-arrow previous" onClick={() => move(-1)} aria-label="Show previous frame designs">‹</button>
        <div className="frame-carousel" ref={carousel} tabIndex={0} aria-label="Photostrip frame designs">
        {FRAMES.map(frame => (
          <button
            key={frame.id}
            type="button"
            className={`frame-option ${selected === frame.id ? "selected" : ""}`}
            onClick={() => onSelect(frame.id)}
            aria-pressed={selected === frame.id}
            aria-label={`${frame.name} (${frame.category}) — ${frame.description}`}
          >
            <FramePreview frame={frame} selected={selected === frame.id} />
            <div className="frame-option-info">
              <div className="frame-option-name">
                <span className="frame-option-icon" style={{ color: frame.accent }}>
                  <FrameBadgeIcon id={frame.id} />
                </span>
                <strong>{frame.name}</strong>
              </div>
              <p className="frame-option-desc">{frame.description}</p>
              <div className="frame-option-tags">
                <span className="frame-tag">{frame.tag}</span>
                <span className="frame-category-tag">{frame.category}</span>
              </div>
            </div>
          </button>
        ))}
        </div>
        <button type="button" className="frame-carousel-arrow next" onClick={() => move(1)} aria-label="Show more frame designs">›</button>
      </div>
      <p className="frame-carousel-hint">Swipe, scroll, or use the arrows to browse all 12 designs.</p>
    </div>
  );
}
