import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const keyPattern = /^[a-f0-9]{64}$/i;
const memory = new Map();
const storageKey = (id) => `racebooth:guest-session:${id}`;

export function rememberGuestCredential(id, key) {
  if (!id || typeof key !== "string" || !keyPattern.test(key)) return "";
  memory.set(id, key);
  try { sessionStorage.setItem(storageKey(id), key); } catch { /* Private browsing can disable storage. */ }
  return key;
}

export function loadGuestCredential(id, urlKey) {
  if (typeof urlKey === "string" && keyPattern.test(urlKey)) return rememberGuestCredential(id, urlKey);
  if (memory.has(id)) return memory.get(id);
  try {
    const stored = sessionStorage.getItem(storageKey(id));
    if (stored && keyPattern.test(stored)) return rememberGuestCredential(id, stored);
  } catch { /* The live page can keep its credential in memory. */ }
  return "";
}

export function useGuestCheckoutKey(id) {
  const location = useLocation();
  const navigate = useNavigate();
  const [key, setKey] = useState(() => {
    const search = new URLSearchParams(location.search);
    const fragment = new URLSearchParams(location.hash.slice(1));
    return loadGuestCredential(id, fragment.get("key") || search.get("key"));
  });
  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const fragment = new URLSearchParams(location.hash.slice(1));
    const supplied = fragment.get("key") || search.get("key");
    setKey(loadGuestCredential(id, supplied));
    if (supplied) {
      search.delete("key"); fragment.delete("key");
      navigate({ pathname: location.pathname, search: search.size ? `?${search}` : "", hash: fragment.size ? `#${fragment}` : "" }, { replace: true });
    }
  }, [id, location.pathname, location.search, location.hash, navigate]);
  return key;
}

const freeStorageKey = (id) => `racebooth:free-session:${id}`;

export function rememberFreeSessionKey(id, key) {
  if (!id || typeof key !== "string" || !keyPattern.test(key)) return "";
  try { sessionStorage.setItem(freeStorageKey(id), key); } catch {}
  return key;
}

export function loadFreeSessionKey(id) {
  try {
    const stored = sessionStorage.getItem(freeStorageKey(id));
    if (stored && keyPattern.test(stored)) return stored;
  } catch {}
  return "";
}

const freeMetadata = new Map();
const metadataKey = (sessionId) => `racebooth:session-details:${sessionId}`;

export function rememberFreeSessionMetadata(sessionId, { freeSessionId, frameDesign }) {
  if (!sessionId || !freeSessionId) return;
  const details = { freeSessionId, frameDesign };
  freeMetadata.set(sessionId, details);
  try { sessionStorage.setItem(metadataKey(sessionId), JSON.stringify(details)); } catch { /* Memory fallback. */ }
}

export function loadFreeSessionMetadata(sessionId) {
  if (freeMetadata.has(sessionId)) return freeMetadata.get(sessionId);
  try {
    const details = JSON.parse(sessionStorage.getItem(metadataKey(sessionId)) || "null");
    if (details?.freeSessionId) { freeMetadata.set(sessionId, details); return details; }
  } catch { /* Storage may be unavailable. */ }
  return {};
}
