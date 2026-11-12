import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { drawCameraFrame, encodeJpegWithinLimit } from "../../shared/camera-capture.js";
import "./camera.css";

function cameraError(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera permission was denied. Allow camera access for this site in your browser, and check Camera permission in macOS System Settings, then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found. Connect a webcam and try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera could not start. Close other apps using your webcam and try again.";
    case "OverconstrainedError":
      return "The selected camera is no longer available. Select another camera and try again.";
    default:
      return error?.message || "The camera could not be started. Please try again.";
  }
}

export default function CameraCapture({ session, nextSequence, onConfirm }) {
  const video = useRef(null);
  const media = useRef(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const previewUrl = useRef(null);
  const captureJob = useRef(0);
  const countdownTimer = useRef(null);
  const [status, setStatus] = useState("stopped");
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");
  const [cameraFacingMode, setCameraFacingMode] = useState("user");
  const [mirrorPreference, setMirrorPreference] = useState(null);
  const [error, setError] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [capture, setCapture] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [uploadAttempted, setUploadAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(Date.now());
  const expiresAt = new Date(session.token_expires_at).getTime();
  const expired = !Number.isFinite(expiresAt) || now >= expiresAt;
  const photoLimit = Number(session.photo_limit || 0);
  const photosTaken = Number(session.photos_taken || 0);
  const mirrorSelfiePhotos = mirrorPreference ?? (cameraFacingMode === "user");
  const sequence = nextSequence || photosTaken + 1;
  const unavailable = expired || !["pending", "active"].includes(session.status) || photosTaken >= photoLimit;

  function cancelCountdown() {
    captureJob.current += 1;
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    if (mounted.current) setCountdown(null);
  }

  function releaseStream() {
    generation.current += 1;
    cancelCountdown();
    if (media.current) media.current.getTracks().forEach((track) => track.stop());
    media.current = null;
    if (video.current) video.current.srcObject = null;
    if (mounted.current) setStatus("stopped");
  }

  function clearCapture() {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setCapture(null);
    setConfirmed(false);
    setUploadAttempted(false);
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === "videoinput");
    if (mounted.current) setDevices(inputs);
  }

  async function startCamera(selected = deviceId) {
    if (unavailable || saving) return;
    releaseStream();
    setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError("Camera access needs HTTPS or localhost in a supported browser. Open the booth on localhost for this Mac, or use the HTTPS booth address.");
      return;
    }
    const request = generation.current;
    setStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(selected ? { deviceId: { exact: selected } } : { facingMode: "user" }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      // A permission prompt can outlive Stop, navigation, or another start request.
      if (!mounted.current || request !== generation.current || Date.now() >= expiresAt) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      media.current = stream;
      const track = stream.getVideoTracks()[0];
      const trackSettings = track?.getSettings?.() || {};
      const actualDevice = trackSettings.deviceId;
      setCameraFacingMode(trackSettings.facingMode || (!selected ? "user" : "unknown"));
      if (actualDevice) setDeviceId(actualDevice);
      if (track) track.addEventListener("ended", () => {
        if (media.current === stream && mounted.current) {
          releaseStream();
          setError("The camera disconnected or its permission was revoked. Start it again to continue.");
        }
      }, { once: true });
      video.current.srcObject = stream;
      await video.current.play();
      if (request === generation.current && mounted.current) {
        setStatus(video.current.videoWidth > 0 ? "live" : "starting");
        await refreshDevices();
      }
    } catch (failure) {
      if (mounted.current && request === generation.current) {
        releaseStream();
        setError(cameraError(failure));
      }
    }
  }

  async function takeFrame(job) {
    const element = video.current;
    if (job !== captureJob.current || !element || !media.current || element.readyState < 2 || !element.videoWidth || !element.videoHeight) {
      if (mounted.current && job === captureJob.current) setError("The live camera frame is not ready. Wait for the preview and try again.");
      return;
    }
    if (Date.now() >= expiresAt) { releaseStream(); return; }
    const canvas = document.createElement("canvas");
    // Save the real camera resolution and bake the selected orientation into
    // this original so filters, exports, and downloads inherit it.
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) { setError("This browser could not create an image canvas."); return; }
    drawCameraFrame(context, element, canvas.width, canvas.height, { mirrorHorizontal: mirrorSelfiePhotos });
    let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
    const maxUploadBytes = Number(import.meta.env.VITE_MAX_PHOTO_UPLOAD_BYTES);
    if (blob && Number.isInteger(maxUploadBytes) && maxUploadBytes > 0 && blob.size > maxUploadBytes) {
      try { blob = await encodeJpegWithinLimit(canvas, maxUploadBytes); }
      catch (failure) {
        if (mounted.current && job === captureJob.current) setError(failure.message);
        return;
      }
    }
    if (!mounted.current || job !== captureJob.current) return;
    if (!blob) { setError("The camera frame could not be encoded. Please retake the photo."); return; }
    clearCapture();
    const url = URL.createObjectURL(blob);
    previewUrl.current = url;
    setCapture({ blob, url, width: canvas.width, height: canvas.height, sequence });
  }

  function beginCountdown() {
    if (status !== "live" || capture || unavailable || countdown !== null || countdownTimer.current !== null || saving) return;
    setError(null);
    const job = ++captureJob.current;
    let remaining = 3;
    setCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) setCountdown(remaining);
      else {
        clearInterval(timer);
        if (countdownTimer.current === timer) countdownTimer.current = null;
        setCountdown(null);
        takeFrame(job).catch(() => {
          if (mounted.current) setError("The photo could not be captured. Please try again.");
        });
      }
    }, 1000);
    countdownTimer.current = timer;
  }

  async function confirmPhoto() {
    if (!capture || saving || confirmed || expired) return;
    setError(null);
    setSaving(true);
    setUploadAttempted(true);
    try {
      if (onConfirm) await onConfirm({ blob: capture.blob, width: capture.width, height: capture.height, sequence: capture.sequence, filter: "original" });
      if (mounted.current) setConfirmed(true);
    } catch (failure) {
      if (mounted.current) setError(failure.response?.data?.error?.message || failure.message || "This photo could not be saved. Keep this preview and try again.");
    } finally { if (mounted.current) setSaving(false); }
  }

  useEffect(() => {
    mounted.current = true;
    const interval = setInterval(() => setNow(Date.now()), 500);
    const deviceChange = () => refreshDevices().catch(() => {});
    navigator.mediaDevices?.addEventListener?.("devicechange", deviceChange);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      releaseStream();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      navigator.mediaDevices?.removeEventListener?.("devicechange", deviceChange);
    };
  }, []);

  useEffect(() => { if (unavailable) releaseStream(); }, [unavailable]);

  return <section className="camera-capture" aria-labelledby="camera-title">
    <div className="camera-heading"><div><span className="eyebrow">MAKE A REAL MOMENT</span><h3 id="camera-title">Photo {capture?.sequence || sequence} of {photoLimit}</h3></div><span className={`camera-state ${status === "live" ? "is-live" : ""}`}>{status === "live" ? "Camera live" : status === "starting" ? "Starting…" : "Camera off"}</span></div>
    {(error || expired || (!expired && unavailable)) && <div className="camera-notices">{error && <div className="notice error" role="alert">{error}</div>}{expired && <div className="notice error" role="alert">This capture session has expired. The camera has been stopped.</div>}{!expired && unavailable && <div className="notice info">This session has no photo captures remaining.</div>}</div>}
    <div className="camera-workspace-grid">
      <div className="camera-visual-column">
        <div className={`camera-stage ${capture ? "has-capture" : ""}`} style={{ aspectRatio: `${capture?.width || video.current?.videoWidth || 16} / ${capture?.height || video.current?.videoHeight || 9}` }}>
          <video ref={video} autoPlay muted playsInline className={`camera-video${mirrorSelfiePhotos ? " is-mirrored" : ""}`} aria-label="Live webcam preview" onCanPlay={() => { if (media.current && video.current?.videoWidth) setStatus("live"); }} />
          {capture && <img src={capture.url} alt="Your actual captured camera photo" className="camera-captured" />}
          {!capture && status === "stopped" && <div className="camera-off-state"><Camera size={38} strokeWidth={1.4} aria-hidden="true"/><strong>Ready when you are.</strong><p>Start your webcam to see the live preview.</p></div>}
          {!capture && status === "starting" && <div className="camera-off-state" role="status"><span className="spinner"/><p>Allow camera access in your browser.</p></div>}
          {countdown !== null && <div className="camera-countdown" aria-live="assertive" role="status">{countdown}</div>}
        </div>
        <p className="camera-caption">{capture ? `${capture.width} × ${capture.height} · ${mirrorSelfiePhotos ? "Mirrored selfie" : "Camera orientation"}` : mirrorSelfiePhotos ? "Live preview and saved selfie are mirrored together." : "Live preview and saved photo use the camera orientation."}</p>
      </div>
      <aside className="camera-control-panel" aria-label="Camera controls">
        {devices.length > 1 && !capture && <label className="camera-device-label">Camera<select value={deviceId} disabled={saving || countdown !== null || unavailable} onChange={(event) => { setDeviceId(event.target.value); if (status !== "stopped") startCamera(event.target.value); }}>{devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label>}
        <label className="camera-mirror-setting"><input type="checkbox" checked={mirrorSelfiePhotos} disabled={Boolean(capture) || countdown !== null || saving} onChange={(event) => setMirrorPreference(event.target.checked)} /><span><strong>Mirror selfie photos</strong><small>When on, the live preview and saved photos match.</small></span></label>
        <p className="camera-original-note">Filters are chosen after all four original photographs are saved.</p>
        <div className="camera-controls">
      {capture ? confirmed ? <><span className="camera-saved-label">Photo {capture.sequence} saved</span>{!unavailable && <button type="button" className="button primary" onClick={() => { clearCapture(); if (status !== "live") startCamera(); }}>Capture next photo</button>}</> : <><button type="button" className="button secondary" disabled={saving || expired || uploadAttempted} onClick={() => { clearCapture(); if (status !== "live") startCamera(); }}>Retake</button><button type="button" className="button primary" disabled={saving || expired} onClick={confirmPhoto}>{saving ? "Saving photo…" : uploadAttempted ? "Retry saving this photo" : "Confirm photo"}</button></> : <>
        {status === "stopped" ? <button type="button" className="button primary" disabled={unavailable || saving} onClick={() => startCamera()}>Start Camera</button> : <button type="button" className="button secondary" onClick={releaseStream}>Stop Camera</button>}
        {countdown !== null ? <button type="button" className="button secondary" onClick={cancelCountdown}>Cancel countdown</button> : <button type="button" className="button primary" disabled={status !== "live" || unavailable} onClick={beginCountdown}>Take photo · 3 sec</button>}
      </>}
      {capture && status !== "stopped" && <button type="button" className="button secondary" disabled={saving} onClick={releaseStream}>Stop Camera</button>}
        </div>
        {capture && confirmed && <p className="camera-confirmation" role="status">{onConfirm ? "Your original photo was accepted by the booth." : "Photo selected on this device. It has not been uploaded yet."}</p>}
        {capture && uploadAttempted && !confirmed && !saving && <p className="camera-caption">Keep this photo and retry saving if the connection was interrupted. Refresh the saved photos to check its status before taking a replacement.</p>}
        <p className="camera-privacy">Only the camera is requested. No microphone access or recording.</p>
      </aside>
    </div>
  </section>;
}
