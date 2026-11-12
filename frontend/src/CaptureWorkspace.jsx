import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Check } from "lucide-react";
import CameraCapture from "./CameraCapture";
import { api, errorMessage } from "./api";
import {
  GalleryResults,
  useGallery,
  useStoredImage,
  downloadImage,
  filterLabel,
  displayDate,
  galleryAccess,
  galleryErrorMessage,
} from "./Gallery";
import EmailDelivery from "./EmailDelivery";
import { FRAMES } from "./FrameSelector";
import { loadFreeSessionMetadata, rememberFreeSessionMetadata } from "./guestAccess";
import "./gallery.css";

// SVG Icons
function DownloadIcon({ size = 18 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function QrIcon({ size = 18 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="5" height="5" x="3" y="3" rx="1"/>
      <rect width="5" height="5" x="16" y="3" rx="1"/>
      <rect width="5" height="5" x="3" y="16" rx="1"/>
      <path d="M21 16h-3a2 2 0 0 0-2 2v3"/>
      <path d="M21 21v.01"/>
      <path d="M12 7v3a2 2 0 0 1-2 2H7"/>
      <path d="M3 12h.01"/>
      <path d="M12 3h.01"/>
      <path d="M12 16v.01"/>
      <path d="M16 12h1"/>
      <path d="M21 12v.01"/>
      <path d="M12 21v-1"/>
    </svg>
  );
}

function CopyIcon({ size = 16 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
  );
}

function ExternalLinkIcon({ size = 16 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  );
}

function CheckIcon({ size = 16 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

const basicFilters = [
  ["original", "Original"], ["bw", "Black & White"], ["vintage", "Vintage"], ["warm", "Warm"],
  ["cool", "Cool"], ["sepia", "Sepia"], ["contrast", "High Contrast"], ["glow", "Soft Glow"],
];
const artisticFilters = [
  ["pencil-sketch", "Pencil Sketch"], ["comic-pop", "Comic Pop"], ["doodle-art", "Doodle Art"],
  ["retro-print", "Retro Print"], ["dreamy-illustration", "Dreamy Illustration"], ["magazine-cutout", "Magazine Cutout"],
];
const filterCss = {
  original: "none", bw: "grayscale(1)", vintage: "sepia(.3) saturate(.7)", warm: "sepia(.18) saturate(1.15)",
  cool: "saturate(.9) hue-rotate(8deg)", sepia: "sepia(1)", contrast: "contrast(1.35)", glow: "brightness(1.1) saturate(.9) blur(.25px)",
  "pencil-sketch": "grayscale(1) contrast(1.55)", "comic-pop": "saturate(1.8) contrast(1.35)", "doodle-art": "grayscale(.35) contrast(1.55)",
  "retro-print": "sepia(.35) contrast(1.2) saturate(.8)", "dreamy-illustration": "brightness(1.1) saturate(1.2) contrast(.95)", "magazine-cutout": "contrast(1.7) saturate(1.35)",
};

const formatDate = (value) =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));

// Individual photo card for the results section
function ResultsPhotoCard({ photo, access }) {
  const path = `${access.base}/photos/${photo.id}/file`;
  const image = useStoredImage(path, access);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);

  return (
    <div className="rb-photo-card">
      <div className="rb-photo-thumb" style={photo?.width_px && photo?.height_px ? { aspectRatio: `${photo.width_px} / ${photo.height_px}` } : undefined}>
        {image.loading ? (
          <div className="gallery-image-loading"><span className="spinner" /></div>
        ) : image.url ? (
          <img src={image.url} referrerPolicy="no-referrer" alt={`Saved photo ${photo.sequence} (${filterLabel(photo.filter)})`} />
        ) : (
          <div className="gallery-image-error">{image.error}</div>
        )}
      </div>
      <div className="rb-photo-meta">
        <div>
          <strong>Photo {photo.sequence}</strong>
          <span>{filterLabel(photo.filter)} · {photo.width_px || "—"} × {photo.height_px || "—"}</span>
        </div>
        <button
          type="button"
          className="button secondary small-button"
          disabled={downloading || !image.url}
          onClick={async () => {
            setDownloading(true);
            setError(null);
            try {
              await downloadImage(path, `racebooth-photo-${String(photo.sequence).padStart(2, "0")}.jpg`, access);
            } catch (fail) {
              setError(await galleryErrorMessage(fail));
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? "Downloading…" : "Download"}
        </button>
      </div>
      {error && <p className="gallery-inline-error">{error}</p>}
    </div>
  );
}

export default function CaptureWorkspace({ sessionId, checkoutKey, freeSessionId: propFid }) {
  const location = useLocation();
  const hash = new URLSearchParams(location.hash.slice(1));
  const search = new URLSearchParams(location.search);

  // Extract freeSessionId and initial frame preference from props or URL
  const storedMetadata = loadFreeSessionMetadata(sessionId);
  const suppliedFrame = hash.get("frame") || search.get("frame") || storedMetadata.frameDesign;

  const { data, loading, error, reload, access } = useGallery(sessionId, checkoutKey, "");
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState(null);
  const [filterCategory, setFilterCategory] = useState("basic");
  const [selectedFilter, setSelectedFilter] = useState("original");
  const editRevision = useRef(0);
  const [filterPending, setFilterPending] = useState(false);
  const [filterMessage, setFilterMessage] = useState(null);

  // Automatic QR state
  const [shareData, setShareData] = useState(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState(null);
  const [copied, setCopied] = useState(false);
  const shareRequestedRef = useRef(false);
  const [emailDeliveryEnabled, setEmailDeliveryEnabled] = useState(false);

  // Photostrip download state
  const [stripDownloading, setStripDownloading] = useState(false);
  const [stripDownloadError, setStripDownloadError] = useState(null);

  const session = data?.session;
  const freeSessionId = session?.free_session_id || propFid || hash.get("fid") || search.get("fid") || storedMetadata.freeSessionId || "";
  const background = session?.frame_design || suppliedFrame || "blueberry";

  useEffect(() => {
    if (freeSessionId) {
      rememberFreeSessionMetadata(sessionId, { freeSessionId, frameDesign: session?.frame_design || suppliedFrame || "blueberry" });
    }
  }, [sessionId, freeSessionId, session?.frame_design, suppliedFrame]);

  useEffect(() => {
    shareRequestedRef.current = false;
    setShareData(null);
    setShareError(null);
    setCopied(false);
  }, [sessionId]);

  const photos = data?.photos || [];
  const accepted = new Set(photos.map((photo) => photo.sequence));
  let nextSequence = 1;
  while (accepted.has(nextSequence)) nextSequence++;
  const complete = !!session && photos.length >= session.photo_limit;
  const hasStrip = data?.strip?.status === "composed";
  const strip = hasStrip ? data.strip : null;
  const isFinalized = Boolean(strip?.is_finalized);
  const captureExpired = !!session && Date.now() >= new Date(session.token_expires_at).getTime();

  // Load photostrip image when available
  const stripPath = hasStrip ? `${access.base}/photostrip/file` : null;
  const stripImage = useStoredImage(stripPath, access, strip?.edit_revision || 0);

  useEffect(() => {
    let active = true;
    api.get('/public/features')
      .then(({ data: features }) => { if (active) setEmailDeliveryEnabled(features.emailDeliveryEnabled === true); })
      .catch(() => { if (active) setEmailDeliveryEnabled(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (strip?.selected_filter) {
      setSelectedFilter(strip.selected_filter);
      editRevision.current = Math.max(editRevision.current, Number(strip.edit_revision || 0));
    }
  }, [strip?.selected_filter, strip?.edit_revision]);

  // Auto-generate QR code when photostrip is ready
  const requestShare = useCallback(async () => {
    if (!sessionId || !checkoutKey) return;
    setShareLoading(true);
    setShareError(null);
    try {
      const { data: result } = await api.post(
        `/public/sessions/${sessionId}/gallery-share`,
        { scope: "gallery" },
        { headers: { "X-Checkout-Key": checkoutKey } }
      );
      if (!result.url || !result.qrDataUrl) {
        throw new Error("The gallery link was not returned. Please try again.");
      }
      setShareData(result);
    } catch (err) {
      setShareError(err.response?.data?.error?.message || err.message || "Could not generate QR code.");
    } finally {
      setShareLoading(false);
    }
  }, [sessionId, checkoutKey]);

  useEffect(() => {
    if (hasStrip && isFinalized && !shareRequestedRef.current && !shareData) {
      shareRequestedRef.current = true;
      requestShare();
    }
  }, [hasStrip, isFinalized, requestShare, shareData]);

  async function savePhoto(capture) {
    const result = await api.post(
      `/public/sessions/${sessionId}/photos`,
      capture.blob,
      {
        headers: {
          "Content-Type": capture.blob.type,
          "X-Checkout-Key": checkoutKey,
          "X-Photo-Sequence": String(capture.sequence),
          "X-Photo-Filter": "original",
        },
        timeout: 60000,
      }
    );
    // The API composes the first original preview automatically after photo 4.
    // Keep a client fallback for a transient processing failure.
    if (capture.sequence === 4 && !result.data.strip) {
      await composeStrip("original", false, 0).catch(() => {});
    }
    await reload().catch(() => {});
    return result.data.photo;
  }

  async function composeStrip(filter = selectedFilter, finalize = false, revision = editRevision.current) {
    if (composing) return;
    setComposing(true);
    setComposeError(null);
    try {
      await api.post(
        `/public/sessions/${sessionId}/photostrip`,
        { filter, finalize, editRevision: revision },
        { headers: { "X-Checkout-Key": checkoutKey }, timeout: 60000 }
      );
      await reload();
    } catch (failure) {
      setComposeError(errorMessage(failure));
    } finally {
      setComposing(false);
    }
  }

  async function chooseFilter(filter) {
    const revision = ++editRevision.current;
    setSelectedFilter(filter);
    setFilterPending(true);
    setFilterMessage(null);
    try {
      const response = await api.post(`/public/sessions/${sessionId}/photostrip`, { filter, finalize: false, editRevision: revision }, { headers: { "X-Checkout-Key": checkoutKey }, timeout: 60000 });
      if (response.data.stale || response.data.strip?.selected_filter !== filter) throw new Error("That edit was superseded. Please select the look again.");
      await reload();
      setFilterMessage(`${filterLabel(filter)} applied to all four originals.`);
    } catch (err) {
      setSelectedFilter(strip?.selected_filter || "original");
      if (err.response?.data?.error?.code !== "RESULT_LOCKED") setFilterMessage(errorMessage(err));
    } finally { setFilterPending(false); }
  }

  async function finalizeResult() {
    const revision = ++editRevision.current;
    setFilterPending(true);
    setFilterMessage(null);
    try {
      const response = await api.post(`/public/sessions/${sessionId}/photostrip`, { filter: selectedFilter, finalize: true, editRevision: revision }, { headers: { "X-Checkout-Key": checkoutKey }, timeout: 60000 });
      if (response.data.stale || !response.data.strip?.is_finalized || response.data.strip.selected_filter !== selectedFilter) throw new Error("Your selected look was not finalized. Please try again.");
      await reload();
      setFilterMessage("Your final photostrip is ready to share.");
    } catch (err) { setFilterMessage(errorMessage(err)); }
    finally { setFilterPending(false); }
  }

  async function handleDownloadStrip() {
    if (stripDownloading || !stripImage.url) return;
    if (!isFinalized) { await finalizeResult(); return; }
    setStripDownloading(true);
    setStripDownloadError(null);
    try {
      await downloadImage(stripPath, "racebooth-photostrip.jpg", access);
    } catch (err) {
      setStripDownloadError(await galleryErrorMessage(err));
    } finally {
      setStripDownloading(false);
    }
  }

  const frameInfo = FRAMES.find(f => f.id === (strip?.background || background));

  return (
    <div className="capture-workspace">
      <div className="public-hero">
        <span className="rb-eyebrow">CAPTURE THE MOMENT · KEEP THE MEMORY</span>
        <h1>{hasStrip ? "Your memories, captured!" : "Let's make some memories."}</h1>
        <p>
          {hasStrip
            ? "Your photos and photostrip are ready! Scan the QR code, get them emailed, or download directly below."
            : "Capture four original photographs, review each one, and save your favourite poses."}
        </p>
      </div>

      {loading && !session && (
        <div className="loading" role="status">
          <span className="spinner" />
          Verifying your session…
        </div>
      )}

      {error && (
        <div className="notice error" role="alert">
          <span>{error}</span>
          <button className="text-button" onClick={() => reload().catch(() => {})}>
            Retry
          </button>
        </div>
      )}

      {session && (
        <>
          {/* Progress summary shown only during capture / composing */}
          {!hasStrip && (
            <>
              <div className="capture-session-summary">
                <div className="capture-session-copy">
                  <div className="capture-session-overline">
                    <span className="capture-session-type">{freeSessionId ? "FREE SESSION" : "PACKAGE SESSION"}</span>
                    <span className="capture-session-status">{session.status}</span>
                  </div>
                  <h2>{session.package_name || "racebooth. session"}</h2>
                  <p>
                    <span>{photos.length} of {session.photo_limit} photos saved</span>
                    <span>Capture until {formatDate(session.token_expires_at)} WIB</span>
                    {frameInfo && <span>{frameInfo.name} frame</span>}
                  </p>
                </div>
              </div>

              <ol className="capture-slots" aria-label="Photo capture progress">
                {Array.from(
                  { length: Math.min(session.photo_limit, 20) },
                  (_, index) => (
                    <li
                      key={index}
                      className={
                        accepted.has(index + 1)
                          ? "saved"
                          : index + 1 === nextSequence
                          ? "current"
                          : ""
                      }
                    >
                      <span className="capture-slot-number">
                        {accepted.has(index + 1)
                          ? <Check size={15} strokeWidth={2} aria-label="Saved" />
                          : String(index + 1).padStart(2, "0")}
                      </span>
                      <strong>
                        {accepted.has(index + 1)
                          ? "Saved"
                          : index + 1 === nextSequence && !complete
                          ? "Up next"
                          : "Photo"}
                      </strong>
                    </li>
                  )
                )}
              </ol>
            </>
          )}

          {/* Camera Capture Stage */}
          {!complete && !hasStrip && (
            <div className="capture-camera-panel">
              <CameraCapture
                session={session}
                nextSequence={nextSequence}
                onConfirm={savePhoto}
              />
            </div>
          )}

          {complete && !hasStrip && (
            <section className="strip-composer auto-composition" aria-live="polite">
              <span className="rb-eyebrow">RESULTS WORKSPACE</span>
              <h2>Preparing your memory strip</h2>
              <p>Your four original photographs are saved. We are composing the selected <strong>{FRAMES.find((frame) => frame.id === background)?.name || "frame"}</strong> automatically.</p>
              {composing ? <div className="processing-inline"><span className="spinner" /> Creating the original preview…</div> : <button type="button" className="rb-button primary" onClick={() => composeStrip("original", false, 0)}>Retry preview</button>}
            </section>
          )}

          {hasStrip && !isFinalized && (
            <section className="post-capture-editor rb-card" aria-labelledby="edit-title">
              <div className="rb-card-header"><div><span className="rb-eyebrow">STEP 3 OF 3</span><h2 id="edit-title">Make it yours</h2><p className="rb-card-subtext">Choose a look for your four-photo memory strip. The original frame stays locked.</p></div><span className="locked-frame-label">Frame locked · {FRAMES.find((frame) => frame.id === background)?.name || background}</span></div>
              <div className="editor-strip-preview" aria-label="Processed photostrip preview">
                {stripImage.loading || filterPending ? <span className="spinner" /> : stripImage.url ? <img src={stripImage.url} referrerPolicy="no-referrer" alt={`Photostrip with ${filterLabel(strip?.selected_filter)} applied`} /> : <span className="gallery-image-error">{stripImage.error}</span>}
              </div>
              <div className="filter-picker-header"><strong>{filterCategory === "basic" ? "Basic presets" : "Artistic styles"}</strong><button type="button" className="filter-category-toggle" aria-pressed={filterCategory === "art"} onClick={() => setFilterCategory(filterCategory === "basic" ? "art" : "basic")}>{filterCategory === "basic" ? "Show artistic styles" : "Show basic presets"}</button></div>
              <div className="global-filter-options" role="listbox" aria-label="Global photostrip filter">
                {(filterCategory === "basic" ? basicFilters : artisticFilters).map(([id, label]) => <button key={id} type="button" role="option" aria-selected={selectedFilter === id} className={`global-filter-option ${selectedFilter === id ? "selected" : ""}`} disabled={filterPending} onClick={() => chooseFilter(id)}><span className="filter-swatch" style={{ filter: filterCss[id] }} />{label}</button>)}
              </div>
              {filterPending && <div className="processing-inline" role="status"><span className="spinner" /> Applying {filterLabel(selectedFilter)} to all four originals…</div>}
              {filterMessage && <p className="editor-status" role="status">{filterMessage}</p>}
              {composeError && <div className="notice error" role="alert">{composeError}</div>}
              <button type="button" className="rb-button primary large" disabled={filterPending || composing} onClick={finalizeResult}>{filterPending ? "Processing…" : "Finalize photostrip and continue"}</button>
            </section>
          )}

          {/* Interim Gallery before strip is composed */}
          {!hasStrip && (
            <GalleryResults
              compactEmpty
              sessionId={sessionId}
              gallery={data}
              credential={checkoutKey}
              allowSharing={false}
            />
          )}
          {hasStrip && !isFinalized && (
            <GalleryResults
              sessionId={sessionId}
              gallery={data}
              credential={checkoutKey}
              allowSharing={false}
            />
          )}

          {/* ======================================================== */}
          {/* COMPLETED RESULTS: TWO-COLUMN RESPONSIVE LAYOUT          */}
          {/* ======================================================== */}
          {hasStrip && isFinalized && (
            <div className="rb-results-grid">
              {/* AREA 1: Photostrip Card (Desktop Left Column Top) */}
              <div className="rb-area-strip rb-card">
                <div className="rb-card-header">
                  <div>
                    <span className="rb-eyebrow">VERTICAL PHOTOSTRIP</span>
                    <h2>{frameInfo ? frameInfo.name : `${strip.background.toUpperCase()} FRAME`}</h2>
                  </div>
                  {frameInfo && (
                    <span className="frame-tag" style={{ background: frameInfo.colors[1], color: frameInfo.accent }}>
                      {frameInfo.tag}
                    </span>
                  )}
                </div>

                <div className="rb-photostrip-stage">
                  {stripImage.loading ? (
                    <div className="rb-stage-loading">
                      <span className="spinner" />
                      <p>Rendering your photostrip…</p>
                    </div>
                  ) : stripImage.url ? (
                    <img
                      src={stripImage.url}
                      referrerPolicy="no-referrer"
                      alt="Your composed racebooth photostrip"
                      className="rb-strip-preview-img"
                    />
                  ) : (
                    <div className="rb-stage-error">{stripImage.error}</div>
                  )}
                </div>

                <div className="rb-photostrip-actions">
                  <button
                    type="button"
                    className="rb-button primary large full"
                    disabled={stripDownloading || !stripImage.url}
                    onClick={handleDownloadStrip}
                  >
                    <DownloadIcon size={20} />
                    {stripDownloading ? "Downloading photostrip…" : "Download Photostrip (High-Res)"}
                  </button>
                  {stripDownloadError && (
                    <p className="gallery-inline-error">{stripDownloadError}</p>
                  )}
                </div>
              </div>

              {/* AREA 2: Automatic QR Code Card (Desktop Right Column Top) */}
              <div className="rb-area-qr rb-card">
                <div className="rb-card-header">
                  <div className="rb-icon-badge">
                    <QrIcon size={22} />
                  </div>
                  <div>
                    <span className="rb-eyebrow">SCAN ON YOUR PHONE</span>
                    <h3>Instant Mobile Access</h3>
                  </div>
                </div>

                <p className="rb-card-subtext">
                  Point your phone camera at this QR code to view, download, and share your photos directly.
                </p>

                <div className="rb-qr-box">
                  {shareLoading && (
                    <div className="rb-qr-state" role="status">
                      <span className="spinner" />
                      <p>Creating your secure QR code…</p>
                    </div>
                  )}

                  {shareError && (
                    <div className="rb-qr-state error" role="alert">
                      <p>{shareError}</p>
                      <button
                        type="button"
                        className="rb-button secondary small"
                        onClick={requestShare}
                      >
                        Retry QR generation
                      </button>
                    </div>
                  )}

                  {shareData?.qrDataUrl && !shareLoading && (
                    <div className="rb-qr-content">
                      <div className="rb-qr-image-wrapper">
                        <img
                          src={shareData.qrDataUrl}
                          alt="QR code to open your private racebooth gallery"
                          className="rb-qr-image"
                        />
                      </div>
                      <p className="rb-qr-caption">
                        No app required · Opens securely in your phone browser
                      </p>
                      <div className="rb-qr-link-row">
                        <label className="sr-only" htmlFor="rb-share-url-input">
                          Private gallery link
                        </label>
                        <input
                          id="rb-share-url-input"
                          type="text"
                          readOnly
                          value={shareData.url}
                          className="rb-input small"
                          onFocus={(e) => e.target.select()}
                        />
                        <button
                          type="button"
                          className="rb-button secondary small"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(shareData.url);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 3000);
                            } catch {
                              setShareError("Could not copy automatically. Please copy the link text.");
                            }
                          }}
                        >
                          {copied ? (
                            <><CheckIcon size={14} /> Copied</>
                          ) : (
                            <><CopyIcon size={14} /> Copy</>
                          )}
                        </button>
                        <a
                          href={shareData.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rb-button secondary small"
                          title="Open gallery in new tab"
                        >
                          <ExternalLinkIcon size={14} />
                        </a>
                      </div>
                      {shareData.expiresAt && (
                        <p className="rb-qr-expiry">
                          Access link valid until {formatDate(shareData.expiresAt)} WIB
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* AREA 3: Email Delivery Card (Desktop Right Column Bottom, directly below QR) */}
              {freeSessionId && emailDeliveryEnabled && <div className="rb-area-email rb-card">
                <EmailDelivery
                  freeSessionId={freeSessionId}
                  sessionKey={checkoutKey}
                />
              </div>}

              {/* AREA 4: Individual Photos Section (Desktop Left Column Bottom) */}
              <div className="rb-area-photos rb-card">
                <div className="rb-card-header">
                  <div>
                    <span className="rb-eyebrow">HIGH-RESOLUTION SNAPSHOTS</span>
                    <h3>Individual Photos</h3>
                    <p className="rb-card-subtext" style={{ margin: "4px 0 0" }}>
                      Download your original uncropped photos in full camera resolution.
                    </p>
                  </div>
                </div>

                <div className="rb-individual-grid">
                  {photos.map((photo) => (
                    <ResultsPhotoCard
                      key={photo.id}
                      photo={photo}
                      access={access}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="capture-footer-actions">
            <button
              className="button secondary"
              disabled={loading}
              onClick={() => reload().catch(() => {})}
            >
              {loading ? "Refreshing…" : "Refresh saved photos"}
            </button>
            <Link className="button secondary" to={`/photobooth/gallery/${sessionId}`}>
              Open private gallery
            </Link>
            <Link className="text-button" to="/racebooth">
              Return to racebooth.
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
