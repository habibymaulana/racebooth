import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Camera, Check, Download, Frame, Menu, PackageCheck, ShieldCheck, X } from "lucide-react";
import { api, errorMessage } from "./api";
import FrameSelector, { FRAMES } from "./FrameSelector";
import { rememberFreeSessionKey, rememberGuestCredential, rememberFreeSessionMetadata } from "./guestAccess";
import { renderFrameSvg } from "../../shared/frame-designs.js";

const icons = { arrow: ArrowRight, camera: Camera, check: Check, download: Download, frame: Frame, package: PackageCheck, shield: ShieldCheck };
function Icon({ name, size = 20 }) {
  const Glyph = icons[name] || Frame;
  return <Glyph aria-hidden="true" size={size} strokeWidth={1.7} />;
}

const formatPrice = value => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0));
const requestKeyStorage = (packageId, frameDesign) => `racebooth:pending-checkout:${packageId}:${frameDesign}`;
const newRequestKey = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure checkout is unavailable in this browser.");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

function frameArtwork(frame, count = 4) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderFrameSvg(frame.id, count))}`;
}

function HeroFrameStack() {
  const samples = [FRAMES[7], FRAMES[0], FRAMES[10]];
  return <div className="home-frame-stack" aria-label="Examples of original Racebooth photostrip artwork">
    {samples.map((frame, index) => <figure key={frame.id} className={`home-float-frame home-float-frame-${index + 1}`}>
      <img src={frameArtwork(frame)} alt={`${frame.name} original four-photo strip frame`} />
      <figcaption><span>{frame.category}</span><strong>{frame.name}</strong></figcaption>
    </figure>)}
    <span className="home-frame-note" aria-hidden="true">12 original frames</span>
  </div>;
}

function Marquee() {
  const message = "CAPTURE FOUR REAL MOMENTS — KEEP THEM CLOSE — YOUR STRIP, YOUR STORY — RACEBOOTH — ";
  return <div className="home-marquee" aria-label="Capture four real moments, keep them close, your strip, your story">
    <span className="sr-only">Capture four real moments. Keep them close. Your strip, your story. Racebooth.</span>
    <div className="home-marquee-track" aria-hidden="true"><span>{message}</span><span>{message}</span></div>
  </div>;
}

function FeatureStep({ number, icon, title, description }) {
  return <article className="home-step-card"><span className="home-step-number">{number}</span><span className="home-step-icon"><Icon name={icon} size={21} /></span><h3>{title}</h3><p>{description}</p></article>;
}

export default function HomePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState("home");
  const [packages, setPackages] = useState([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [packagesError, setPackagesError] = useState(null);
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [selectedFrame, setSelectedFrame] = useState("blueberry");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [showAllPackages, setShowAllPackages] = useState(false);
  const [resumeSession, setResumeSession] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem("racebooth:last-public-session") || "null");
      return value && /^[0-9a-f-]{36}$/i.test(value.sessionId) && FRAMES.some(frame => frame.id === value.frameDesign) ? value : null;
    } catch { return null; }
  });
  const availablePackages = useMemo(() => packages.filter(item => item.is_active && Number(item.photo_limit) === 4), [packages]);
  const visiblePackages = showAllPackages ? availablePackages : availablePackages.slice(0, 3);
  const selectedPackage = availablePackages.find(item => item.id === selectedPackageId) || null;
  const selectedFrameData = FRAMES.find(frame => frame.id === selectedFrame);

  useEffect(() => {
    let mounted = true;
    api.get("/public/packages")
      .then(({ data }) => { if (mounted) setPackages(data.packages || []); })
      .catch(err => { if (mounted) setPackagesError(errorMessage(err)); })
      .finally(() => { if (mounted) setPackagesLoading(false); });
    return () => { mounted = false; };
  }, []);

  function enterSessionPicker(frameId = selectedFrame) {
    setSelectedFrame(frameId);
    setError(null);
    setNavOpen(false);
    setStep("frame");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function startFreeSession() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.post("/public/free-sessions", { frameDesign: selectedFrame });
      rememberFreeSessionKey(data.freeSessionId, data.sessionKey);
      rememberGuestCredential(data.sessionId, data.sessionKey);
      rememberFreeSessionMetadata(data.sessionId, { freeSessionId: data.freeSessionId, frameDesign: selectedFrame });
      const recovery = { sessionId: data.sessionId, frameDesign: selectedFrame, packageName: "Free session", paymentReference: "" };
      setResumeSession(recovery);
      try { sessionStorage.setItem("racebooth:last-public-session", JSON.stringify(recovery)); } catch { /* The live session key remains in memory. */ }
      navigate(`/photobooth/session/${data.sessionId}#key=${data.sessionKey}&fid=${data.freeSessionId}&frame=${selectedFrame}`);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  async function startSimulatedCheckout() {
    if (busy || !selectedPackage) return;
    setBusy(true); setError(null);
    const storageKey = requestKeyStorage(selectedPackage.id, selectedFrame);
    let idempotencyKey;
    try {
      idempotencyKey = sessionStorage.getItem(storageKey) || newRequestKey();
      sessionStorage.setItem(storageKey, idempotencyKey);
    } catch { idempotencyKey = newRequestKey(); }
    try {
      const { data } = await api.post("/public/checkouts", {
        packageId: selectedPackage.id,
        idempotencyKey,
        frameDesign: selectedFrame,
      }, { timeout: 60000 });
      if (!data?.transaction?.is_simulated || data.transaction.payment_status !== "paid" || data.session.status !== "active") {
        throw new Error("The simulated checkout did not return a verified active session.");
      }
      rememberGuestCredential(data.session.id, data.sessionKey);
      const recovery = { sessionId: data.session.id, frameDesign: selectedFrame, packageName: data.package.name, paymentReference: data.checkout.paymentReference };
      setResumeSession(recovery);
      try { sessionStorage.setItem("racebooth:last-public-session", JSON.stringify(recovery)); } catch { /* The live session key remains in memory. */ }
      try { sessionStorage.removeItem(storageKey); } catch { /* The active session is already persisted. */ }
      navigate(`/photobooth/session/${data.session.id}#key=${data.sessionKey}&frame=${selectedFrame}`);
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  }

  function choosePackage(packageId) {
    setSelectedPackageId(packageId);
    setError(null);
    setNavOpen(false);
    setStep("frame");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (step === "frame") return <div className="home-v2 home-v2-session">
    <div className="home-session-nav"><Link to="/" className="home-anchor-brand">racebooth.</Link><span>Four photos, one keepsake</span><Link to="/" className="home-session-back">Back to home</Link></div>
    <div className="home-session-heading"><span className="home-kicker">YOUR SESSION, YOUR STYLE</span><h1>Choose your frame.</h1><p>Pick one original frame for your four-photo strip. It stays locked once the session starts.</p></div>
    <div className="home-session-package">
      <label htmlFor="session-package">Your session</label>
      <select id="session-package" value={selectedPackageId} onChange={event => setSelectedPackageId(event.target.value)}>
        <option value="">Free four-photo session</option>
        {availablePackages.map(item => <option key={item.id} value={item.id}>{item.name} · {formatPrice(item.price_idr)} simulated</option>)}
      </select>
      {selectedPackage && <p>{selectedPackage.description || "A four-photo photostrip session."}</p>}
    </div>
    <FrameSelector selected={selectedFrame} onSelect={setSelectedFrame} />
    {selectedFrameData && <div className="home-selected-frame"><span className="home-frame-swatch" style={{ background: selectedFrameData.accent }} /><div><span className="home-kicker">FRAME LOCKS WHEN YOU BEGIN</span><strong>{selectedFrameData.name}</strong><p>{selectedFrameData.description}</p></div><Icon name="check" size={19} /></div>}
    {error && <div className="home-error" role="alert">{error}</div>}
    {selectedPackage ? <div className="home-checkout-box">
      <div><span className="home-kicker">SIMULATED CHECKOUT · NO CHARGE</span><strong>{formatPrice(selectedPackage.price_idr)}</strong><p>Simulasi Pembayaran — Tidak ada uang sungguhan yang ditagihkan.</p></div>
      <button type="button" className="home-button primary" onClick={startSimulatedCheckout} disabled={busy}>{busy ? "Preparing your session…" : <>Confirm simulated checkout <Icon name="arrow" size={18} /></>}</button>
    </div> : <div className="home-checkout-box free-checkout-box">
      <div><span className="home-kicker">NO PAYMENT REQUIRED</span><strong>Free four-photo session</strong><p>One frame, four photos, and a private gallery. No account needed.</p></div>
      <button type="button" className="home-button primary" onClick={startFreeSession} disabled={busy}>{busy ? "Preparing your session…" : <>Start free photobooth <Icon name="arrow" size={18} /></>}</button>
    </div>}
  </div>;

  return <div className="home-v2">
    <nav className="home-nav" aria-label="Main navigation">
      <Link to="/" className="home-anchor-brand" aria-label="Racebooth home">racebooth.</Link>
      <div className="home-nav-links">
        <a href="#frames">Explore frames</a><a href="#how-it-works">How it works</a><a href="#packages">Packages</a>
      </div>
      <button type="button" className="home-button primary home-nav-cta" onClick={() => document.getElementById("packages")?.scrollIntoView({ behavior: "smooth" })}>Choose a session <Icon name="arrow" size={17} /></button>
      <button type="button" className="home-menu-toggle" aria-label={navOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={navOpen} aria-controls="home-mobile-menu" onClick={() => setNavOpen(open => !open)}>{navOpen ? <X size={20} /> : <Menu size={20} />}</button>
      {navOpen && <div className="home-mobile-menu" id="home-mobile-menu">
        <a href="#frames" onClick={() => setNavOpen(false)}>Explore frames</a><a href="#how-it-works" onClick={() => setNavOpen(false)}>How it works</a><a href="#packages" onClick={() => setNavOpen(false)}>Packages</a>
        <button type="button" className="home-button primary" onClick={() => { setNavOpen(false); document.getElementById("packages")?.scrollIntoView({ behavior: "smooth" }); }}>Choose a session <Icon name="arrow" size={17} /></button>
      </div>}
    </nav>

    <section className="home-hero" aria-labelledby="home-title">
      <HeroFrameStack />
      <div className="home-hero-copy">
        <span className="home-kicker"><span className="home-kicker-dot" /> A LITTLE BOOTH FOR BIG MEMORIES</span>
        <h1 id="home-title">A little booth.<br /><em>A lot to keep.</em></h1>
        <p>Four real photos, a frame that feels like you, and a keepsake you can take anywhere.</p>
        <div className="home-hero-actions"><a className="home-button primary" href="#packages">Choose a session <Icon name="arrow" size={18} /></a><a className="home-button quiet" href="#frames">Explore the frames</a></div>
        <p className="home-hero-note"><Icon name="shield" size={15} /> No registration. Your private gallery expires.</p>
      </div>
      <span className="home-hero-caption">REAL CAMERA MOMENTS<br />KEPT IN YOUR FRAME</span>
    </section>

    <Marquee />

    <section className="home-frame-section" id="frames" aria-labelledby="frames-title">
      <div className="home-section-heading">
        <span className="home-kicker">A FRAME FOR YOUR KIND OF MOMENT</span>
        <h2 id="frames-title">Twelve ways to<br /><em>make it yours.</em></h2>
        <p>Every original design is part of the four-photo strip. Choose one to begin a session.</p>
      </div>
      <div className="home-frame-gallery">
        {FRAMES.map(frame => <button key={frame.id} type="button" className="home-frame-gallery-card" onClick={() => enterSessionPicker(frame.id)} aria-label={`Start a session with the ${frame.name} frame`}>
          <span className="home-frame-gallery-art"><img src={frameArtwork(frame)} alt="" loading="lazy" /></span>
          <span className="home-frame-gallery-caption"><span><strong>{frame.name}</strong><small>{frame.category}</small></span><ArrowRight size={17} aria-hidden="true" /></span>
        </button>)}
      </div>
    </section>

    <section className="home-how" id="how-it-works" aria-labelledby="how-title">
      <div className="home-section-heading home-how-heading"><span className="home-kicker">A SIMPLE LITTLE RITUAL</span><h2 id="how-title">From hello<br /><em>to keepsake.</em></h2><p>Choose your frame, capture four photos, and make a strip to take with you.</p></div>
      <div className="home-step-grid">
        <FeatureStep number="01" icon="package" title="Choose a session" description="Pick a database-listed package or start with the free four-photo session." />
        <FeatureStep number="02" icon="frame" title="Choose your frame" description="Pick one of twelve original designs before your session begins." />
        <FeatureStep number="03" icon="camera" title="Capture four photos" description="Confirm your session, then pose, review, and save four originals. Paid-priced packages use a clearly labeled simulation." />
        <FeatureStep number="04" icon="download" title="Make it yours" description="Choose a filter, finalize your strip, then download or open your private gallery." />
      </div>
    </section>

    <section className="home-package-section" id="packages" aria-labelledby="packages-title">
      <div className="home-package-heading"><div><span className="home-kicker">THE SESSION COLLECTION</span><h2 id="packages-title">Choose your<br /><em>way to remember.</em></h2></div><p>Current package details and Rupiah prices come from the Racebooth catalogue.</p></div>
      {packagesError && <div className="home-error" role="alert">Package catalogue is unavailable right now. {packagesError}</div>}
      {packagesLoading ? <div className="home-package-loading" role="status">Loading sessions…</div> : availablePackages.length ? <>
        <div className="home-package-grid">
          {visiblePackages.map(item => <article key={item.id} className="home-package-card">
            <div className="home-package-card-top"><span className="home-package-index">{String(item.display_order + 1).padStart(2, "0")}</span><span className="home-package-label">FOUR-PHOTO SESSION</span></div>
            <h3>{item.name}</h3><p className="home-package-description">{item.description || "A four-photo photostrip session."}</p>
            <div className="home-package-price"><span>{formatPrice(item.price_idr)}</span><small> / session · simulated</small></div>
            {Array.isArray(item.benefits) && item.benefits.length > 0 && <ul>{item.benefits.map((benefit, benefitIndex) => <li key={`${item.id}-${benefitIndex}`}><Icon name="check" size={15} />{benefit}</li>)}</ul>}
            <button type="button" className="home-package-choose" onClick={() => choosePackage(item.id)}>Choose package <Icon name="arrow" size={17} /></button>
          </article>)}
        </div>
        {availablePackages.length > 3 && <button type="button" className="home-view-packages" onClick={() => setShowAllPackages(value => !value)}>{showAllPackages ? "Show fewer packages" : `View all ${availablePackages.length} packages`} <Icon name="arrow" size={16} /></button>}
      </> : <div className="home-packages-empty"><Icon name="package" size={22} /><div><strong>Packages are being prepared.</strong><p>The free four-photo session is ready whenever you are.</p></div></div>}
      <div className="home-free-option"><div><span className="home-kicker">NO PAYMENT REQUIRED</span><strong>Prefer to keep it simple?</strong><p>Start a free four-photo session, with one frame and a private gallery.</p></div><button type="button" className="home-free-link" onClick={() => enterSessionPicker("blueberry")}>Start free session <Icon name="arrow" size={16} /></button></div>
      <p className="home-simulation-disclosure">Simulasi Pembayaran — Tidak ada uang sungguhan yang ditagihkan.</p>
    </section>

    {resumeSession && <aside className="home-resume-session"><div><span className="home-kicker">SESSION SAVED IN THIS BROWSER</span><strong>{resumeSession.packageName || "Your photobooth session"}</strong><p>{resumeSession.paymentReference ? `Simulated reference ${resumeSession.paymentReference}` : "Your free four-photo session is ready."}</p></div><button type="button" className="home-resume-button" onClick={() => navigate(`/photobooth/session/${resumeSession.sessionId}#frame=${resumeSession.frameDesign}`)}>Resume session <Icon name="arrow" size={16} /></button></aside>}

    <section className="home-final-cta"><div><span className="home-kicker">YOUR PEOPLE. YOUR FRAME. YOUR STRIP.</span><h2>Keep a little<br /><em>piece of today.</em></h2><p>Pick a session and make something worth keeping.</p></div><a className="home-button light" href="#packages">Choose a session <Icon name="arrow" size={18} /></a></section>
  </div>;
}
