import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, errorMessage } from "./api";
import { loadGuestCredential, loadFreeSessionMetadata } from "./guestAccess";
import EmailDelivery from "./EmailDelivery";
import "./gallery.css";

export const displayDate = (value) => value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(new Date(value)) : "—";
export const filterLabel = (value) => ({
  original: "Original",
  bw: "Black & white",
  vintage: "Vintage",
  warm: "Warm",
  cool: "Cool",
  sepia: "Sepia",
  contrast: "Contrast",
  glow: "Glow",
  "pencil-sketch": "Pencil Sketch",
  "comic-pop": "Comic Pop",
  "doodle-art": "Doodle Art",
  "retro-print": "Retro Print",
  "dreamy-illustration": "Dreamy Illustration",
  "magazine-cutout": "Magazine Cutout"
})[value] || value;

export async function galleryErrorMessage(error) {
  if (error?.response?.data instanceof Blob) {
    try { const body = JSON.parse(await error.response.data.text()); return body?.error?.message || "This image could not be loaded."; } catch { return "This image could not be loaded. Refresh the gallery and try again."; }
  }
  return errorMessage(error);
}

async function storedImageResult(data) {
  if (/^application\/json(?:;|$)/i.test(data?.type || "")) {
    const result = JSON.parse(await data.text());
    const url = new URL(result.url);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".private.blob.vercel-storage.com")) {
      throw new Error("The private image link was not valid.");
    }
    return { url: url.toString(), objectUrl: null };
  }
  const objectUrl = URL.createObjectURL(data);
  return { url: objectUrl, objectUrl };
}

export function galleryAccess(sessionId, credential, shareToken) {
  return {
    base: shareToken ? `/public/galleries/${sessionId}` : `/public/sessions/${sessionId}`,
    headers: shareToken ? { Authorization: `Bearer ${shareToken}` } : { "X-Checkout-Key": credential },
    identity: shareToken || credential || "",
  };
}

export function useGallery(sessionId, credential, shareToken) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const request = useRef(0);
  const access = useMemo(() => galleryAccess(sessionId, credential, shareToken), [sessionId, credential, shareToken]);
  const reload = useCallback(async () => {
    const revision = ++request.current;
    if (!access.identity) { setState({ data: null, loading: false, error: "This private gallery needs the original session link or a valid shared gallery link." }); return null; }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const { data } = await api.get(shareToken ? access.base : `${access.base}/gallery`, { headers: access.headers });
      if (revision === request.current) setState({ data, loading: false, error: null });
      return data;
    } catch (error) {
      if (revision === request.current) setState({ data: null, loading: false, error: await galleryErrorMessage(error) });
      throw error;
    }
  }, [access, shareToken]);
  useEffect(() => { reload().catch(() => {}); return () => { request.current += 1; }; }, [reload]);
  return { ...state, reload, access };
}

export function useStoredImage(path, access, revision = 0) {
  const [state, setState] = useState({ url: null, error: null, loading: true });
  useEffect(() => {
    let active = true; let objectUrl; const controller = new AbortController();
    setState({ url: null, error: null, loading: true });
    if (!path) return () => { active = false; controller.abort(); };
    api.get(`${path}?direct=1`, { headers: access.headers, responseType: "blob", signal: controller.signal }).then(async ({ data }) => {
      if (!active) return;
      const image = await storedImageResult(data);
      objectUrl = image.objectUrl;
      setState({ url: image.url, error: null, loading: false });
    }).catch(async (error) => {
      if (active && error.code !== "ERR_CANCELED") setState({ url: null, error: await galleryErrorMessage(error), loading: false });
    });
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path, access, revision]);
  return state;
}

export async function downloadImage(path, filename, access) {
  const { data } = await api.get(`${path}?direct=1&download=1`, { headers: access.headers, responseType: "blob" });
  const image = await storedImageResult(data);
  const anchor = document.createElement("a");
  anchor.href = image.url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  if (image.objectUrl) setTimeout(() => URL.revokeObjectURL(image.objectUrl), 10000);
}

export function StoredImageCard({ photo, strip, access, onShare }) {
  const isStrip = !!strip;
  const path = isStrip ? `${access.base}/photostrip/file` : `${access.base}/photos/${photo.id}/file`;
  const image = useStoredImage(path, access, strip?.edit_revision || 0);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const label = isStrip ? "Your photostrip" : `Photo ${photo.sequence}`;
  return <article className={`saved-image-card ${isStrip ? "is-photostrip" : ""}`}>
    <div className="saved-image-preview" style={!isStrip && photo?.width_px && photo?.height_px ? { aspectRatio: `${photo.width_px} / ${photo.height_px}` } : undefined}>{image.loading ? <span className="gallery-image-loading" role="status"><span className="spinner"/>Loading saved image…</span> : image.url ? <img src={image.url} referrerPolicy="no-referrer" alt={isStrip ? "Your saved vertical photostrip" : `Saved photo ${photo.sequence} with ${filterLabel(photo.filter)} filter`} /> : <div className="gallery-image-error" role="alert">{image.error}</div>}</div>
    <div className="saved-image-details"><div><strong>{label}</strong><span>{isStrip ? `${strip.background} frame · JPEG` : `${filterLabel(photo.filter)} · ${photo.width_px || "—"} × ${photo.height_px || "—"}`}</span></div><div className="saved-image-actions"><button className="button secondary small-button" disabled={downloading || !image.url} onClick={async () => { setDownloading(true); setError(null); try { await downloadImage(path, isStrip ? "racebooth-photostrip.jpg" : `racebooth-photo-${String(photo.sequence).padStart(2, "0")}.jpg`, access); } catch (failure) { setError(await galleryErrorMessage(failure)); } finally { setDownloading(false); } }}>{downloading ? "Downloading…" : "Download"}</button>{onShare && <button className="button secondary small-button" onClick={() => onShare(isStrip ? { scope: "strip" } : { scope: "photo", photoId: photo.id })}>QR link</button>}</div>{error && <p className="gallery-inline-error" role="alert">{error}</p>}</div>
  </article>;
}

export function GalleryResults({ sessionId, gallery, credential, shareToken, allowSharing = true, compactEmpty = false }) {
  const access = useMemo(() => galleryAccess(sessionId, credential, shareToken), [sessionId, credential, shareToken]);
  const [share, setShare] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);
  const [copied, setCopied] = useState(false);
  const photos = gallery.photos || [];
  const strip = gallery.strip?.status === "composed" ? gallery.strip : null;
  const mayShare = allowSharing && !!credential && !shareToken;
  async function createShare(body) {
    if (sharing) return;
    setSharing(true); setShareError(null); setCopied(false); setShare(null);
    try {
      const { data } = await api.post(`/public/sessions/${sessionId}/gallery-share`, body, { headers: { "X-Checkout-Key": credential } });
      if (!data.url || !data.qrDataUrl) throw new Error("The gallery link was not returned. Please try again.");
      setShare(data);
    } catch (error) { setShareError(error.response?.data?.error?.message || error.message || "This gallery link could not be created."); }
    finally { setSharing(false); }
  }
  useEffect(() => { setShare(null); setShareError(null); setCopied(false); }, [sessionId, credential, shareToken]);
  return <section className={`gallery-results${compactEmpty && !photos.length && !strip ? " is-compact-empty" : ""}`} aria-labelledby="saved-photos-title"><div className="gallery-section-heading"><div><span className="eyebrow">YOUR REAL MOMENTS, SAVED</span><h2 id="saved-photos-title">{gallery.scope === "photo" ? "Your shared photo" : gallery.scope === "strip" ? "Your photostrip" : "Your saved photos"}</h2><p>{photos.length} saved photo{photos.length === 1 ? "" : "s"}{gallery.session?.gallery_expires_at ? ` · Gallery available until ${displayDate(gallery.session.gallery_expires_at)} WIB` : ""}</p></div>{mayShare && photos.length > 0 && <button className="button secondary" disabled={sharing} onClick={() => createShare({ scope: "gallery" })}>{sharing ? "Creating link…" : "Share gallery with QR"}</button>}</div>
    {shareError && <div className="notice error" role="alert">{shareError}</div>}
    {sharing && <div className="loading" role="status"><span className="spinner"/>Creating a secure gallery link…</div>}
    {share && <div className="gallery-share-panel"><img src={share.qrDataUrl} alt={`QR code opening this ${share.scope === "photo" ? "photo" : share.scope === "strip" ? "photostrip" : "gallery"}`} /><div><span className="eyebrow">SCAN TO OPEN YOUR {share.scope === "photo" ? "PHOTO" : share.scope === "strip" ? "PHOTOSTRIP" : "GALLERY"}</span><h3>Your memories, ready to take.</h3><p>This private link allows viewing and downloading {share.scope === "photo" ? "this photo" : share.scope === "strip" ? "this photostrip" : "this gallery"}. Anyone with it can access these results until {displayDate(share.expiresAt)} WIB.</p><label className="sr-only" htmlFor="gallery-share-url">Private gallery link</label><input id="gallery-share-url" value={share.url} readOnly onFocus={(event) => event.target.select()} /><div className="gallery-share-actions"><button className="button primary small-button" onClick={async () => { try { await navigator.clipboard.writeText(share.url); setCopied(true); } catch { setShareError("Copy is unavailable. Select the link above and copy it manually."); } }}>{copied ? "Link copied" : "Copy private link"}</button><a className="button secondary small-button" href={share.url} target="_blank" rel="noopener noreferrer">Open link</a><button className="text-button" onClick={() => setShare(null)}>Close</button></div></div></div>}
    {!photos.length && !strip ? <div className="gallery-empty"><strong>Your photos will appear here.</strong><p>Confirm a captured photo to save it to this private gallery.</p></div> : <div className="gallery-media-layout"><div className="saved-photo-grid">{photos.map((photo) => <StoredImageCard key={photo.id} photo={photo} access={access} onShare={mayShare ? createShare : null} />)}</div>{strip && <StoredImageCard key={strip.id} strip={strip} access={access} onShare={mayShare ? createShare : null} />}</div>}
  </section>;
}

export default function GuestGallery({ sessionId }) {
  const location = useLocation();
  const fragment = useMemo(() => new URLSearchParams(location.hash.slice(1)), [location.hash]);
  const shareToken = fragment.get("share") || "";
  const credential = shareToken ? "" : loadGuestCredential(sessionId, fragment.get("key") || fragment.get("session"));
  const { data, loading, error, reload } = useGallery(sessionId, credential, shareToken);
  const [emailDeliveryEnabled, setEmailDeliveryEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    api.get("/public/features").then(({ data: features }) => { if (active) setEmailDeliveryEnabled(features.emailDeliveryEnabled === true); }).catch(() => { if (active) setEmailDeliveryEnabled(false); });
    return () => { active = false; };
  }, []);
  return <div className="guest-gallery-page"><div className="public-hero"><span className="eyebrow">TAKE THE MEMORIES WITH YOU</span><h1>Your racebooth. gallery.</h1><p>Real photos, saved from your photobooth session.</p></div>{loading && !data && <div className="loading" role="status"><span className="spinner"/>Opening your private gallery…</div>}{error && <div className="notice error" role="alert"><span>{error}</span><button className="text-button" onClick={() => reload().catch(() => {})}>Retry</button></div>}{data && <GalleryResults sessionId={sessionId} gallery={data} credential={credential} shareToken={shareToken} />}{emailDeliveryEnabled && credential && data?.strip?.status === "composed" && <EmailDelivery freeSessionId={data.session?.free_session_id || loadFreeSessionMetadata(sessionId).freeSessionId} sessionKey={credential} />}{credential && <Link to={`/photobooth/session/${sessionId}`} className="back-link">Return to your session</Link>}<p className="gallery-private-note">Keep your gallery link private. Downloads remain available only while your gallery access is valid.</p></div>;
}
