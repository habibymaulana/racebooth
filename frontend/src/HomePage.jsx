import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage } from "./api";
import FrameSelector, { FRAMES } from "./FrameSelector";
import { rememberFreeSessionKey, rememberGuestCredential, rememberFreeSessionMetadata } from "./guestAccess";

// SVG icon helpers
function CameraIcon({ size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>;
}
function FrameIcon({ size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>;
}
function MailIcon({ size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>;
}
function ShieldIcon({ size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
}
function ZapIcon({ size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
}
function GiftIcon({ size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><path d="M12 22V7m0 0a3 3 0 1 0-3-3 3 3 0 1 0 3 3"/><path d="M12 7a3 3 0 1 1 3-3 3 3 0 1 1-3 3"/></svg>;
}
function StarIcon({ size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
}

function HowItWorksStep({ number, icon, title, description }) {
  return (
    <div className="how-step">
      <div className="how-step-number">{number}</div>
      <div className="how-step-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function FloatingDecor() {
  // Pure CSS/SVG decorative shapes — no emoji
  return (
    <div className="decor-container" aria-hidden="true">
      <div className="decor-bubble decor-1">
        <svg width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#b4c7e7" opacity="0.7"/></svg>
      </div>
      <div className="decor-bubble decor-2">
        <svg width="28" height="28" viewBox="0 0 28 28"><rect x="4" y="4" width="20" height="20" rx="6" fill="#f5c6d8" opacity="0.7"/></svg>
      </div>
      <div className="decor-bubble decor-3">
        <svg width="24" height="24" viewBox="0 0 24 24"><polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" fill="#c9b8d8" opacity="0.7"/></svg>
      </div>
      <div className="decor-bubble decor-4">
        <svg width="30" height="30" viewBox="0 0 30 30"><path d="M15 3a12 12 0 0 1 0 24A12 12 0 0 1 15 3z" fill="#9dc4b0" opacity="0.6"/></svg>
      </div>
      <div className="decor-bubble decor-5">
        <svg width="26" height="26" viewBox="0 0 26 26"><path d="M13 2l3 8h8l-6 5 2 8-7-5-7 5 2-8-6-5h8z" fill="#f5e6a3" opacity="0.7"/></svg>
      </div>
      <div className="decor-bubble decor-6">
        <svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" fill="#fce4ec" opacity="0.65"/></svg>
      </div>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState("hero"); // hero | frame | starting
  const [selectedFrame, setSelectedFrame] = useState("blueberry");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function startSession() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post("/public/free-sessions", { frameDesign: selectedFrame });
      rememberFreeSessionKey(data.freeSessionId, data.sessionKey);
      rememberGuestCredential(data.sessionId, data.sessionKey);
      rememberFreeSessionMetadata(data.sessionId, { freeSessionId: data.freeSessionId, frameDesign: selectedFrame });
      navigate(`/photobooth/session/${data.sessionId}#key=${data.sessionKey}&fid=${data.freeSessionId}&frame=${selectedFrame}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const selectedFrameData = FRAMES.find(f => f.id === selectedFrame);

  return (
    <div className="home-page">
      <FloatingDecor />

      {/* Hero Section */}
      {step === "hero" && (
        <>
          <section className="hero-section">
            <div className="hero-badge">
              <GiftIcon size={14} />
              Completely Free — No Account Needed
            </div>
            <h1 className="hero-title">
              Your moment,<br />
              <span className="hero-title-accent">beautifully framed.</span>
            </h1>
            <p className="hero-subtitle">
              racebooth. is a free interactive photobooth. Pick a cute frame, snap 4 photos,
              get your photostrip — and share the memories instantly.
            </p>
            <div className="hero-actions">
              <button
                className="rb-button primary large"
                onClick={() => setStep("frame")}
              >
                <CameraIcon size={18} />
                Start Photobooth — It&apos;s Free!
              </button>
              <p className="hero-hint">No sign-up. No payment. Just photos.</p>
            </div>

            {/* Frame peek */}
            <div className="hero-frame-peek">
              {FRAMES.slice(0,3).map(f => (
                <div key={f.id} className="hero-frame-chip" style={{ background: f.colors[1], borderColor: f.colors[0] }}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: f.accent }} />
                  <span>{f.name}</span>
                </div>
              ))}
              <div className="hero-frame-chip more-chip">
                <span>+{FRAMES.length - 3} more</span>
              </div>
            </div>
          </section>

          {/* How It Works */}
          <section className="how-section">
            <div className="section-label">HOW IT WORKS</div>
            <h2>Three simple steps</h2>
            <div className="how-steps">
              <HowItWorksStep
                number="1"
                icon={<FrameIcon size={22} />}
                title="Choose your frame"
                description="Pick from 12 original cute designs — scrapbook, doodle, vintage, film board, and more."
              />
              <HowItWorksStep
                number="2"
                icon={<CameraIcon size={22} />}
                title="Take 4 photos"
                description="Strike a pose, review each original photo, retake if you want, and confirm your favourites."
              />
              <HowItWorksStep
                number="3"
                icon={<MailIcon size={22} />}
                title="Get your strip"
                description="Download your photostrip instantly, or email a private gallery link before it expires."
              />
            </div>
          </section>

          {/* Features */}
          <section className="features-section">
            <div className="features-grid">
              <div className="feature-card">
                <span className="feature-icon"><GiftIcon size={22} /></span>
                <h3>Always Free</h3>
                <p>No hidden costs, no subscriptions. racebooth. is completely free for everyone.</p>
              </div>
              <div className="feature-card">
                <span className="feature-icon"><ShieldIcon size={22} /></span>
                <h3>Private Gallery</h3>
                <p>Your photos stay private. Only you have access through your unique session link.</p>
              </div>
              <div className="feature-card">
                <span className="feature-icon"><ZapIcon size={22} /></span>
                <h3>Instant Results</h3>
                <p>Your photostrip is composed immediately. Download or email it in seconds.</p>
              </div>
              <div className="feature-card">
                <span className="feature-icon"><FrameIcon size={22} /></span>
                <h3>12 Cute Frames</h3>
                <p>Original designs ranging from scrapbook-cute to cinematic midnight and retro check aesthetics.</p>
              </div>
            </div>
          </section>
        </>
      )}

      {/* Frame Selection Step */}
      {step === "frame" && (
        <div className="frame-step">
          <button className="rb-back-button" onClick={() => setStep("hero")}>
            ← Back
          </button>
          <FrameSelector selected={selectedFrame} onSelect={setSelectedFrame} />

          {/* Selected Frame Preview */}
          {selectedFrameData && (
            <div className="selected-frame-confirm" style={{ background: selectedFrameData.colors[1], borderColor: selectedFrameData.colors[0] }}>
              <div>
                <span className="selected-frame-swatch" style={{ background: selectedFrameData.accent }} />
                <div>
                  <strong>{selectedFrameData.name}</strong>
                  <p>{selectedFrameData.description}</p>
                </div>
              </div>
              <span className="selected-badge">Selected ✓</span>
            </div>
          )}

          {error && (
            <div className="rb-error-notice" role="alert">
              <span>
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </span>
              <span>{error}</span>
            </div>
          )}

          <div className="frame-step-actions">
            <span className="sticky-frame-name" aria-live="polite">{selectedFrameData?.name || "Choose a frame"}</span>
            <button
              className="rb-button primary large"
              onClick={startSession}
              disabled={busy || !selectedFrame}
            >
              {busy ? (
                <><span className="spinner small" /> Starting your session…</>
              ) : (
                <><StarIcon size={16} /> Start Free Session</>
              )}
            </button>
            <p className="frame-step-hint">Next: start your webcam and allow camera access.</p>
          </div>
        </div>
      )}
    </div>
  );
}
