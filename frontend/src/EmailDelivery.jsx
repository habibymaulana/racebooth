import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";

function MailIcon({ size = 20 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2"/>
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
    </svg>
  );
}

function LockIcon({ size = 14 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function CheckCircleIcon({ size = 20 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  );
}

export default function EmailDelivery({ freeSessionId, sessionKey, onSent }) {
  const [email, setEmail] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(null);
  const [deliveryError, setDeliveryError] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusChecked, setStatusChecked] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!freeSessionId || !sessionKey) return;
    let active = true;
    const controller = new AbortController();
    setChecking(true);
    setError(null);
    api.get(`/public/free-sessions/${freeSessionId}/email-status`, {
      headers: { "X-Session-Key": sessionKey }, signal: controller.signal,
    }).then(({ data }) => {
      if (!active) return;
      setStatus(data.deliveries?.[0]?.status || null);
      setStatusChecked(true);
    }).catch((failure) => {
      if (active && failure.code !== "ERR_CANCELED") {
        setError(errorMessage(failure));
        setStatusChecked(false);
      }
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; controller.abort(); };
  }, [freeSessionId, sessionKey, revision]);

  if (!freeSessionId || !sessionKey) return null;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!agreed || busy || checking || !statusChecked || ["sent", "pending"].includes(status)) return;
    setBusy(true);
    setError(null);
    setDeliveryError(null);
    try {
      const { data } = await api.post(
        `/public/free-sessions/${freeSessionId}/send-email`,
        { recipientEmail: email.trim() },
        { headers: { "X-Session-Key": sessionKey }, timeout: 35000 },
      );
      setStatus(data.status === "sent" ? "sent" : "pending");
      if (data.status === "sent") onSent?.();
    } catch (failure) {
      const code = failure.response?.data?.error?.code;
      if (code === "EMAIL_ALREADY_SENT") setStatus("sent");
      else if (code === "EMAIL_DELIVERY_IN_PROGRESS" || code === "EMAIL_DELIVERY_UNCONFIRMED") setStatus("pending");
      else {
        setDeliveryError(errorMessage(failure));
        setStatusChecked(false);
        setRevision((value) => value + 1);
      }
    } finally { setBusy(false); }
  }

  if (status === "sent" || status === "pending") {
    return <div className="email-success" role="status">
      <div className="email-success-icon"><CheckCircleIcon size={28} /></div>
      <h3>{status === "sent" ? "Email accepted for delivery" : "Delivery awaiting confirmation"}</h3>
      <p>{status === "sent"
        ? "Gmail accepted your gallery email. Check your inbox or spam folder."
        : "Your request was received, but email delivery has not been confirmed. Another send is blocked to prevent duplicates."}</p>
      <p className="email-success-hint">Your gallery remains available until the expiry shown above. Download your photos to keep them.</p>
      {status === "pending" && <button className="button secondary" disabled={checking} onClick={() => setRevision((value) => value + 1)}>{checking ? "Checking delivery…" : "Refresh delivery status"}</button>}
      {error && <p className="gallery-inline-error" role="alert">{error}</p>}
    </div>;
  }

  return <div className="email-delivery-form">
    <div className="email-form-header">
      <span className="email-form-icon"><MailIcon size={22} /></span>
      <div><h3>Get your photos by email</h3><p>We&apos;ll send a secure link to your private gallery — no sign-up needed.</p></div>
    </div>
    {(deliveryError || error) && <div className="rb-error-notice" role="alert"><span>{deliveryError || error}</span><button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Check delivery status</button></div>}
    {checking && <p role="status">Checking previous delivery requests…</p>}
    {status === "failed" && <p className="gallery-inline-error">The previous delivery failed. You can try again.</p>}
    <form onSubmit={handleSubmit}>
      <label htmlFor={`email-input-${freeSessionId}`} className="rb-label">Your email address</label>
      <input id={`email-input-${freeSessionId}`} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required maxLength={254} autoComplete="email" className="rb-input" disabled={busy || checking} />
      <label className="rb-checkbox-label"><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} disabled={busy || checking} /><span>I agree to receive my racebooth gallery link at this email address.</span></label>
      <button type="submit" className="rb-button primary full" disabled={busy || checking || !statusChecked || !email.trim() || !agreed}>{busy ? <><span className="spinner small" /> Sending…</> : <><MailIcon size={16} /> Send my gallery link</>}</button>
    </form>
    <p className="email-privacy-note"><LockIcon /> Your recipient address and delivery status are recorded to process this request and prevent duplicate emails.</p>
  </div>;
}
