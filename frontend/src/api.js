import axios from "axios";

const configuredTimeout = Number(import.meta.env.VITE_API_TIMEOUT_MS);
const apiTimeout = Number.isInteger(configuredTimeout) && configuredTimeout >= 1000 && configuredTimeout <= 120000
  ? configuredTimeout
  : 25000;

export const api = axios.create({
  baseURL: "/api",
  withCredentials: true,
  timeout: apiTimeout,
});
let csrfToken;
let csrfRequest;

export async function refreshCsrf() {
  if (!csrfRequest) {
    csrfRequest = api
      .get("/auth/csrf")
      .then(({ data }) => {
        csrfToken = data.csrfToken;
        return csrfToken;
      })
      .finally(() => {
        csrfRequest = null;
      });
  }
  return csrfRequest;
}

api.interceptors.request.use(async (config) => {
  if (config.url?.startsWith("/public")) {
    return config;
  }
  if (!["get", "head", "options"].includes(config.method?.toLowerCase())) {
    if (!csrfToken) await refreshCsrf();
    config.headers["X-CSRF-Token"] = csrfToken;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const request = error.config;
    // The backend rejects CSRF before running the route. Renew once after a
    // session expires or another browser tab rotates the session on login.
    if (
      error.response?.status === 403 &&
      error.response?.data?.error?.code === "CSRF_REJECTED" &&
      request &&
      !request.csrfRetried
    ) {
      request.csrfRetried = true;
      csrfToken = undefined;
      await refreshCsrf();
      return api.request(request);
    }
    return Promise.reject(error);
  },
);

export function errorMessage(error) {
  if (!error.response)
    return "The server could not be reached. Check your connection and try again.";
  const detail = error.response.data;
  return (
    detail?.error?.message ||
    (typeof detail?.error === "string" ? detail.error : detail?.message) ||
    "This action could not be completed. Please try again."
  );
}
