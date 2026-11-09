import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { api, errorMessage, refreshCsrf } from "./api";
import CaptureWorkspace from "./CaptureWorkspace";
import GuestGallery from "./Gallery";
import { useGuestCheckoutKey } from "./guestAccess";
import HomePage from "./HomePage";
import QualityControl from "./QualityControl";

const Auth = createContext(null);
const money = (value) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
const date = (value) =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Jakarta",
      }).format(new Date(value))
    : "—";
const shortId = (value) => value?.slice(0, 8).toUpperCase();

function Icon({ name, size = 20, ...props }) {
  const paths = {
    camera: (
      <>
        <path d="M14 5l1.5 2H20v12H4V7h4.5L10 5z" />
        <circle cx="12" cy="13" r="3.2" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    receipt: (
      <>
        <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
        <path d="M9 8h6M9 12h6" />
      </>
    ),
    box: (
      <>
        <path d="M12 3l9 5-9 5-9-5zM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    logout: (
      <>
        <path d="M9 4H4v16h5M9 12h12m-5-5 5 5-5 5" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="9" r="5" />
        <path d="m12 13 8 8m-4-4 3-3m-6 0 3-3" />
      </>
    ),
    wallet: (
      <>
        <rect x="3" y="6" width="18" height="14" rx="3" />
        <path d="m5 6 12-3v3M16 11h5v5h-5a2.5 2.5 0 0 1 0-5z" />
      </>
    ),
    alert: (
      <>
        <path d="m12 3 10 18H2zM12 9v5" />
        <path d="M12 17h.01" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M15 8V3H3v13h5" />
      </>
    ),
    edit: (
      <>
        <path d="m16 3 5 5-12 12-6 1 1-6zM13 6l5 5" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    external: (
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.camera}
    </svg>
  );
}

function Spinner({ label = "Loading workspace…" }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}
function ErrorNotice({ error, onRetry }) {
  return error ? (
    <div className="notice error" role="alert">
      <Icon name="alert" />
      <div>{typeof error === "string" ? error : errorMessage(error)}</div>
      {onRetry && (
        <button className="text-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  ) : null;
}
function Empty({ title, children, action, icon = "receipt" }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={27} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Status({ transaction }) {
  const status = transaction.payment_status;
  if (transaction.payment_method === "free") return <span className="badge success"><span className="badge-dot" />Free session</span>;
  return (
    <span
      className={`badge ${status === "paid" ? "success" : status === "pending" ? "warning" : "neutral"}`}
    >
      <span className="badge-dot" />
      {status === "paid" && transaction.is_simulated
        ? "Simulated paid"
        : status?.replace(/^./, (s) => s.toUpperCase())}
    </span>
  );
}
function SimulationNote({ compact = false }) {
  return (
    <div className={`simulation-note ${compact ? "compact" : ""}`}>
      <Icon name="shield" size={18} />
      <div>
        <strong>Simulation environment</strong>
        <span>
          {compact
            ? "No real payments are collected."
            : "QRIS simulation only. Confirmations do not collect money and are excluded from real revenue."}
        </span>
      </div>
      <span className="simulation-pill">TEST MODE</span>
    </div>
  );
}

function useResource(url) {
  const [state, setState] = useState({
    data: null,
    error: null,
    loading: true,
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .get(url, { signal: controller.signal })
      .then(({ data }) => setState({ data, loading: false, error: null }))
      .catch((error) => {
        if (error.code !== "ERR_CANCELED")
          setState((s) => ({ ...s, loading: false, error }));
      });
    return () => controller.abort();
  }, [url, revision]);
  return { ...state, reload: () => setRevision((n) => n + 1) };
}

// ---------------- Top Level App Component ----------------

export default function App() {
  const location = useLocation();
  const isOperator = location.pathname === "/operator" || location.pathname.startsWith("/operator/");

  // Public visitor racebooth routes do not require operator login!
  if (!isOperator) {
    return (
      <Routes>
        <Route path="/" element={<PublicLayout><HomePage /></PublicLayout>} />
        <Route path="/racebooth" element={<PublicLayout><HomePage /></PublicLayout>} />
        <Route path="/photobooth" element={<PublicLayout><HomePage /></PublicLayout>} />
        <Route path="/photobooth/session/:id" element={<PublicSession />} />
        <Route path="/racebooth/session/:id" element={<PublicSession />} />
        <Route path="/photobooth/:id" element={<PublicSession />} />
        <Route path="/racebooth/:id" element={<PublicSession />} />
        <Route path="/photobooth/gallery/:id" element={<PublicGalleryPage />} />
        <Route path="/racebooth/gallery/:id" element={<PublicGalleryPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return <OperatorApp />;
}

function OperatorApp() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    refreshCsrf()
      .then(() => api.get("/auth/me"))
      .then(({ data }) => {
        if (active) setUser(data.user);
      })
      .catch((err) => {
        if (active && err.response?.status !== 401) setError(err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  useEffect(() => {
    const interceptor = api.interceptors.response.use(
      (response) => response,
      (err) => {
        if (
          err.response?.status === 401 &&
          !err.config?.url?.includes("/auth/")
        )
          setUser(null);
        return Promise.reject(err);
      },
    );
    return () => api.interceptors.response.eject(interceptor);
  }, []);

  if (loading)
    return (
      <div className="app-loading">
        <Brand />
        <Spinner />
      </div>
    );
  if (error)
    return (
      <div className="connection-error">
        <Brand />
        <h1>Let’s reconnect your workspace.</h1>
        <ErrorNotice error={error} onRetry={() => setRevision((n) => n + 1)} />
      </div>
    );
  return (
    <Auth.Provider value={{ user, setUser }}>
      {!user ? (
        <Login />
      ) : user.role !== "operator" ? (
        <AccessDenied />
      ) : (
        <Shell />
      )}
    </Auth.Provider>
  );
}

function Brand({ inverse = false }) {
  return (
    <div className={`brand ${inverse ? "inverse" : ""}`}>
      <span className="brand-symbol">
        <Icon name="camera" size={24} />
      </span>
      <div>
        <strong>
          racebooth<span>.</span>
        </strong>
        <small>OPERATOR WORKSPACE</small>
      </div>
    </div>
  );
}

// ---------------- Public Visitor Photobooth Flow ----------------

function PublicFooter() {
  return (
    <footer className="rb-footer">
      <div className="rb-footer-inner">
        <div className="rb-footer-brand">
          <Link to="/" className="rb-brand">
            <span className="rb-brand-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
            </span>
            <span className="rb-brand-name">
              racebooth<span className="rb-brand-dot">.</span>
            </span>
          </Link>
          <p className="rb-footer-tagline">Capture the moment. Keep the memory.</p>
          <p className="rb-footer-desc">
            Free interactive photobooth with 12 original cute frame designs, real camera capture, art photo filters, and instant private gallery sharing.
          </p>
        </div>

        <div className="rb-footer-nav">
          <h4>Explore</h4>
          <ul>
            <li><Link to="/">Home</Link></li>
            <li><Link to="/#frame">Frame Selection</Link></li>
            <li><Link to="/operator">Operator Dashboard</Link></li>
          </ul>
        </div>

        <div className="rb-footer-features">
          <h4>Highlights</h4>
          <ul>
            <li>100% Free · No Account Needed</li>
            <li>12 Cute Original Frames</li>
            <li>6 Real Art Photo Filters</li>
            <li>Private Expiring Galleries</li>
          </ul>
        </div>
      </div>

      <div className="rb-footer-bottom">
        <div className="rb-footer-bottom-inner">
          <p>© 2026 racebooth. All rights reserved.</p>
          <p className="rb-footer-note">Real camera capture · Ephemeral session storage</p>
        </div>
      </div>
    </footer>
  );
}

function PublicLayout({ children }) {
  return (
    <div className="public-shell">
      <header className="public-nav">
        <div className="public-nav-inner">
          <Link to="/" className="rb-brand">
            <span className="rb-brand-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
            </span>
            <span className="rb-brand-name">
              racebooth<span className="rb-brand-dot">.</span>
            </span>
          </Link>
          <div className="public-nav-actions">
            <span
              className="session-pill"
              style={{
                margin: 0,
                padding: "5px 14px",
                fontSize: "11px",
                background: "#fdf2f8",
                color: "#be185d",
                border: "1px solid #fbcfe8",
                fontWeight: "700"
              }}
            >
              FREE PHOTOBOOTH
            </span>
            <Link
              to="/operator"
              style={{
                fontSize: "12px",
                color: "#6b5b80",
                textDecoration: "none",
                fontWeight: "600",
                padding: "6px 12px",
                borderRadius: "8px",
                background: "#f5f0fb"
              }}
            >
              Operator Dashboard →
            </Link>
          </div>
        </div>
      </header>
      <main className="public-content">{children}</main>
      <PublicFooter />
    </div>
  );
}

function PublicSession() {
  const { id } = useParams();
  const checkoutKey = useGuestCheckoutKey(id);
  const location = useLocation();
  const hash = new URLSearchParams(location.hash.slice(1));
  const search = new URLSearchParams(location.search);
  const freeSessionId = hash.get("fid") || search.get("fid") || "";

  return (
    <PublicLayout>
      <CaptureWorkspace sessionId={id} checkoutKey={checkoutKey} freeSessionId={freeSessionId} />
    </PublicLayout>
  );
}

function PublicGalleryPage() {
  const { id } = useParams();

  return (
    <PublicLayout>
      <GuestGallery sessionId={id} />
    </PublicLayout>
  );
}

// ---------------- Existing Operator Components ----------------

function Login() {
  const { setUser } = useContext(Auth);
  const [form, setForm] = useState({ email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  async function login(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post("/auth/login", {
        ...form,
        email: form.email.trim(),
      });
      await refreshCsrf();
      setUser(data.user);
      navigate("/operator", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-layout">
      <div className="login-story">
        <Brand inverse />
        <div className="story-content">
          <span className="eyebrow light">THE OPERATOR WORKSPACE</span>
          <h1>
            Good moments.
            <br />
            Smooth operations.
          </h1>
          <p>
            Everything you need to manage packages,
            <br className="desktop-break" /> payments, and the next great
            session.
          </p>
          <div className="story-photo">
            <div className="photo-line" />
            <Icon name="camera" size={86} />
            <div className="photo-caption">MAKE ROOM FOR MEMORIES</div>
          </div>
        </div>
        <div className="story-footer">
          <span>Built for the people behind the booth.</span>
          <span>PHASE 01</span>
        </div>
      </div>
      <main className="login-main">
        <div className="login-form">
          <span className="eyebrow">WELCOME BACK</span>
          <h2>Your booth, in focus.</h2>
          <p className="muted">Sign in to your operator workspace.</p>
          <ErrorNotice error={error} />
          <form onSubmit={login}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              placeholder="you@yourstudio.com"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              maxLength={254}
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              maxLength={1024}
            />
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <>
                  <span className="spinner small" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in to workspace
                  <Icon name="arrow" size={18} />
                </>
              )}
            </button>
          </form>
          <div className="login-security">
            <Icon name="shield" size={18} />
            <p>
              Operator access only. Ask your administrator to provision an
              account before signing in.
            </p>
          </div>
          <div style={{ marginTop: "16px", textAlign: "center" }}>
            <Link to="/photobooth" style={{ fontSize: "13px", color: "#4f8f7c", fontWeight: "600" }}>
              Go to Public Visitor Photobooth →
            </Link>
          </div>
        </div>
        <p className="login-bottom">
          racebooth. Photobooth Management · Operator console
        </p>
      </main>
    </div>
  );
}

function AccessDenied() {
  const { setUser } = useContext(Auth);
  const [error, setError] = useState(null);
  return (
    <div className="connection-error">
      <Brand />
      <h1>Operator access required</h1>
      <p>This workspace is available to active operators.</p>
      <ErrorNotice error={error} />
      <button
        className="button primary"
        onClick={async () => {
          try {
            await api.post("/auth/logout");
            await refreshCsrf();
            setUser(null);
          } catch (err) {
            setError(err);
          }
        }}
      >
        Sign out
      </button>
    </div>
  );
}

function Shell() {
  const { user, setUser } = useContext(Auth);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const links = [
    { to: "/operator", label: "Overview", icon: "grid", end: true },
    { to: "/operator/transactions/new", label: "New transaction", icon: "plus" },
    { to: "/operator/transactions", label: "Transactions", icon: "receipt", end: true },
    { to: "/operator/packages", label: "Packages", icon: "box" },
    { to: "/operator/qc", label: "Quality control", icon: "shield" },
  ];

  const current =
    location.pathname === "/operator" || location.pathname === "/operator/"
      ? "Overview"
      : location.pathname.startsWith("/operator/qc")
        ? "Quality control"
        : location.pathname.startsWith("/operator/packages")
        ? "Packages"
        : location.pathname.endsWith("/new")
          ? "New transaction"
          : "Transactions";

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/logout");
      await refreshCsrf();
      setUser(null);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="workspace">
      <button
        className={`sidebar-scrim ${open ? "visible" : ""}`}
        aria-label="Close navigation"
        onClick={() => setOpen(false)}
      />
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <Brand />
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                `nav-link ${isActive ? "selected" : ""}`
              }
            >
              <Icon name={link.icon} />
              {link.label}
              {link.label === "New transaction" && (
                <span className="nav-shortcut">+</span>
              )}
            </NavLink>
          ))}
          <a
            href="/photobooth"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link"
            style={{ color: "#4f8f7c", marginTop: "12px" }}
          >
            <Icon name="external" />
            Public Booth
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="live-dot" />
            <strong>Free visitor sessions</strong>
            <p>
              Four photos, private galleries,
              <br />
              and delivery monitoring.
            </p>
          </div>
          <div className="sidebar-version">
            <Icon name="shield" size={15} />
            <span>Operator console</span>
            <span>v1.2</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <Icon name="chevron" size={14} />
            <strong>{current}</strong>
          </div>
          <div className="topbar-right">
            <span className="mode-badge">
              <span />
              OPERATOR
            </span>
            <div className="operator">
              <span className="avatar">
                {(user.fullName || user.full_name || user.email || "O")
                  .slice(0, 1)
                  .toUpperCase()}
              </span>
              <div>
                <strong>{user.fullName || user.full_name || "Operator"}</strong>
                <small>Operator</small>
              </div>
            </div>
            <button
              className="icon-button logout"
              title="Sign out"
              aria-label="Sign out"
              disabled={busy}
              onClick={logout}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </header>
        <main className="page">
          <ErrorNotice error={error} />
          <Routes>
            <Route path="/operator" element={<Overview />} />
            <Route path="/operator/transactions" element={<Transactions />} />
            <Route path="/operator/transactions/new" element={<NewTransaction />} />
            <Route
              path="/operator/transactions/:id"
              element={<TransactionDetail key={location.pathname} />}
            />
            <Route path="/operator/packages" element={<Packages />} />
            <Route path="/operator/qc" element={<QualityControl />} />
            <Route path="*" element={<Navigate to="/operator" replace />} />
          </Routes>
          <footer className="page-footer">
            <span>racebooth. · Photobooth Management</span>
            <span>All times in WIB (UTC+7)</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function TransactionTable({ transactions, compact = false }) {
  const navigate = useNavigate();
  if (!transactions.length)
    return (
      <Empty
        title="Your first session starts here"
        action={
          <Link to="/operator/transactions/new" className="button primary small-button">
            <Icon name="plus" size={16} />
            New transaction
          </Link>
        }
      >
        Create a transaction to start the simulated payment flow.
      </Empty>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Transaction</th>
            <th>Type</th>
            <th>Package</th>
            <th>Amount</th>
            <th>Payment status</th>
            {!compact && <th>Token</th>}
            <th>Created · WIB</th>
            <th>
              <span className="sr-only">View</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.id}>
              <td>
                <Link className="table-id" to={`/operator/transactions/${tx.id}`}>
                  #{shortId(tx.id)}
                </Link>
              </td>
              <td>
                <span className={`badge ${tx.is_visitor ? "neutral" : "primary"}`} style={{ fontSize: "11px" }}>
                  {tx.is_visitor ? "Public Guest" : "Operator"}
                </span>
              </td>
              <td>
                <strong className="table-name">
                  {tx.package_name || "Photo package"}
                </strong>
              </td>
              <td className="amount">{money(tx.amount_idr)}</td>
              <td>
                <Status transaction={tx} />
              </td>
              {!compact && (
                <td>
                  <span
                    className={`token-state ${tx.token_status ? "has-token" : ""}`}
                  >
                    {tx.token_status || "Not issued"}
                  </span>
                </td>
              )}
              <td className="table-date">{date(tx.created_at)}</td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`View transaction ${shortId(tx.id)}`}
                  onClick={() => navigate(`/operator/transactions/${tx.id}`)}
                >
                  <Icon name="chevron" size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview() {
  const { data, error, loading, reload } = useResource("/dashboard");
  const stats = data?.stats || {};
  const { user } = useContext(Auth);
  const firstName = (user.fullName || user.full_name || "operator").split(
    " ",
  )[0];
  return (
    <>
      <PageHeading
        eyebrow="YOUR WORKSPACE, AT A GLANCE"
        title={`Hello, ${firstName}.`}
        description="Monitor free sessions, photo results, and historical transactions."
        action={
          <div style={{ display: "flex", gap: "10px" }}>
            <a
              href="/photobooth"
              target="_blank"
              rel="noopener noreferrer"
              className="button secondary"
            >
              <Icon name="external" size={16} />
              Open Public Booth
            </a>
            <Link className="button primary" to="/operator/transactions/new">
              <Icon name="plus" size={18} />
              New transaction
            </Link>
          </div>
        }
      />
      <ErrorNotice error={error} onRetry={reload} />
      {loading ? (
        <Spinner label="Loading your overview…" />
      ) : (
        data && (
          <>
            <div className="stats-grid">
              <Stat icon="camera" label="Free sessions" value={stats.totalFreeSessions ?? "—"} note="Visitor sessions created" />
              <Stat icon="check" label="Completed free sessions" value={stats.completedFreeSessions ?? "—"} note="Photostrip composed" accent />
              <Stat icon="grid" label="Saved photos" value={stats.totalStoredPhotos ?? "—"} note="Accepted camera captures" />
              <Stat icon="camera" label="Photostrips" value={stats.totalPhotostrips ?? "—"} note="Stored composition results" />
              <Stat icon="key" label="Active sessions" value={stats.activeSessions ?? "—"} note="Capture access currently valid" />
              <Stat icon="check" label="Emails accepted" value={stats.emailsSent ?? "—"} note="Confirmed by email provider" />
              <Stat icon="clock" label="Unconfirmed emails" value={stats.emailsUnconfirmed ?? "—"} note="Pending or historical unverified delivery" />
              <Stat icon="alert" label="Email failures" value={stats.emailsFailed ?? "—"} note="Recorded failed deliveries" />
              <Stat icon="wallet" label="Historical real revenue" value={money(stats.realRevenueIdr)} note="Free and simulated sessions excluded" />
            </div>
            <section className="panel free-session-metrics">
              <div className="panel-heading"><div><h2>Recent free sessions</h2><p>Live session and photostrip records.</p></div><Link className="inline-link" to="/operator/qc">Open quality control <Icon name="arrow" size={16} /></Link></div>
              {!data.recentFreeSessions?.length ? <Empty title="No free sessions yet" icon="camera">Start the public booth to create a free session.</Empty> : <div className="table-scroll"><table><thead><tr><th>Session</th><th>Frame</th><th>Photos saved</th><th>Photostrip</th><th>Created · WIB</th></tr></thead><tbody>{data.recentFreeSessions.map(session => <tr key={session.id}><td>#{shortId(session.id)}</td><td>{session.frame_design}</td><td>{session.photos_saved} / 4</td><td>{session.strip_status || "Not composed"}</td><td>{date(session.created_at)}</td></tr>)}</tbody></table></div>}
              {!!data.popularFrames?.length && <p className="frame-popularity">Frame selections: {data.popularFrames.map(frame => `${frame.frame_design} (${frame.count})`).join(" · ")}</p>}
            </section>
            <div className="overview-lower">
              <section className="panel transactions-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent transactions</h2>
                    <p>Historical payments and free-session records.</p>
                  </div>
                  <Link className="inline-link" to="/operator/transactions">
                    View all
                    <Icon name="arrow" size={16} />
                  </Link>
                </div>
                <TransactionTable
                  transactions={data.recentTransactions || []}
                  compact
                />
              </section>
              <aside className="flow-card">
                <span className="eyebrow light">AUTOMATED GUEST FLOW</span>
                <h2>
                  From frame selection
                  <br />
                  to photo-ready.
                </h2>
                <ol>
                  <li>
                    <span>01</span>
                    <div>
                      <strong>Choose a Frame</strong>
                      <p>Guest starts a free public session.</p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>Four Real Photos</strong>
                      <p>Camera captures are confirmed and saved privately.</p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>Private Gallery & Email</strong>
                      <p>Download the strip or request a gallery link.</p>
                    </div>
                  </li>
                </ol>
                <a href="/photobooth" target="_blank" rel="noopener noreferrer">
                  Open Public Booth View
                  <Icon name="external" size={18} />
                </a>
                <div className="flow-decoration" />
              </aside>
            </div>
          </>
        )
      )}
    </>
  );
}

function Stat({ icon, label, value, note, accent }) {
  return (
    <section className={`stat-card ${accent ? "stat-accent" : ""}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">
          <Icon name={icon} size={18} />
        </span>
      </div>
      <strong className="stat-value">{value}</strong>
      <p>{note}</p>
    </section>
  );
}

function Transactions() {
  const { data, error, loading, reload } = useResource("/transactions");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const transactions = (data?.transactions || []).filter(
    (tx) =>
      `${tx.id} ${tx.package_name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (status === "all" || tx.payment_status === status),
  );
  return (
    <>
      <PageHeading
        eyebrow="PAYMENTS & SESSIONS"
        title="Transactions"
        description="Monitor automated guest transactions and operator records."
        action={
          <div style={{ display: "flex", gap: "10px" }}>
            <a href="/photobooth" target="_blank" rel="noopener noreferrer" className="button secondary">
              <Icon name="external" size={16} />
              Guest Booth
            </a>
            <Link className="button primary" to="/operator/transactions/new">
              <Icon name="plus" size={18} />
              New transaction
            </Link>
          </div>
        }
      />
      <SimulationNote compact />
      <ErrorNotice error={error} onRetry={reload} />
      <section className="panel">
        <div className="table-tools">
          <div className="search-input">
            <Icon name="search" size={18} />
            <input
              aria-label="Search transactions"
              placeholder="Search transaction or package…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="Filter payment status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="refunded">Refunded</option>
          </select>
          <button
            className="icon-button"
            title="Refresh transactions"
            aria-label="Refresh transactions"
            onClick={reload}
          >
            <Icon name="refresh" size={18} />
          </button>
        </div>
        {loading ? (
          <Spinner label="Loading transactions…" />
        ) : (
          data &&
          (transactions.length || (!search && status === "all") ? (
            <TransactionTable transactions={transactions} />
          ) : (
            <Empty title="No matching transactions">
              Try a different search or payment status.
            </Empty>
          ))
        )}
        <div className="table-footer">
          {data
            ? `${transactions.length} transaction${transactions.length === 1 ? "" : "s"} shown`
            : "Transaction activity"}
          <span>Simulated payments are automatically excluded from real revenue.</span>
        </div>
      </section>
    </>
  );
}

function PackageCard({ pkg, selected, onSelect, onEdit }) {
  return (
    <article
      className={`package-card ${selected ? "package-selected" : ""} ${!pkg.is_active ? "package-inactive" : ""}`}
    >
      <div className="package-card-top">
        <span className="package-icon">
          <Icon name="camera" size={25} />
        </span>
        {onSelect ? (
          <span className={`radio-mark ${selected ? "checked" : ""}`}>
            {selected && <Icon name="check" size={13} />}
          </span>
        ) : (
          <span className={`badge ${pkg.is_active ? "success" : "neutral"}`}>
            {pkg.is_active ? "Active" : "Inactive"}
          </span>
        )}
      </div>
      <h3>{pkg.name}</h3>
      <div className="package-price">
        {money(pkg.price_idr)}
        <small>/ session</small>
      </div>
      <div className="package-features">
        <span>
          <Icon name="camera" size={16} />
          {pkg.photo_limit} photos
        </span>
        <span>
          <Icon name="clock" size={16} />
          {pkg.session_duration_minutes} minutes
        </span>
      </div>
      {onSelect ? (
        <button
          className={`button full ${selected ? "primary" : "secondary"}`}
          onClick={onSelect}
        >
          {selected ? (
            <>
              <Icon name="check" size={16} />
              Selected package
            </>
          ) : (
            <>
              Choose package
              <Icon name="arrow" size={16} />
            </>
          )}
        </button>
      ) : (
        <button className="button secondary full" onClick={onEdit}>
          <Icon name="edit" size={16} />
          Edit package
        </button>
      )}
    </article>
  );
}

function NewTransaction() {
  const { user } = useContext(Auth);
  const { data, error, loading, reload } = useResource("/packages");
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const navigate = useNavigate();
  const packages = (data?.packages || []).filter((pkg) => pkg.is_active);
  const chosen = packages.find((pkg) => pkg.id === selected);
  const requestKeys = useRef(new Map());

  async function create() {
    if (!chosen || busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const storageKey = `photobooth:create:${user.id}:${chosen.id}`;
      let key = requestKeys.current.get(chosen.id);
      try {
        key ||= sessionStorage.getItem(storageKey);
      } catch {}
      key ||= crypto.randomUUID();
      requestKeys.current.set(chosen.id, key);
      try {
        sessionStorage.setItem(storageKey, key);
      } catch {}
      const { data: result } = await api.post("/transactions", {
        packageId: chosen.id,
        idempotencyKey: key,
      });
      requestKeys.current.delete(chosen.id);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      navigate(`/operator/transactions/${result.transaction.id}`);
    } catch (err) {
      setSubmitError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="MANUAL OPERATOR TRANSACTION"
        title="New transaction"
        description="Create an in-person transaction or assist a guest."
      />
      <Steps current={1} />
      <SimulationNote />
      <ErrorNotice error={error} onRetry={reload} />
      <ErrorNotice error={submitError} />
      <div className="checkout-grid">
        <section>
          <div className="section-heading">
            <div>
              <h2>Choose a package</h2>
              <p>Active packages available for a new session.</p>
            </div>
            <Link to="/operator/packages" className="inline-link">
              Manage packages
              <Icon name="arrow" size={16} />
            </Link>
          </div>
          {loading ? (
            <Spinner label="Loading packages…" />
          ) : !packages.length ? (
            <div className="panel">
              <Empty
                icon="box"
                title="Add your first package"
                action={
                  <Link className="button primary" to="/operator/packages">
                    <Icon name="plus" size={16} />
                    Manage packages
                  </Link>
                }
              >
                You need an active package before creating a transaction.
              </Empty>
            </div>
          ) : (
            <div className="package-grid checkout-packages">
              {packages.map((pkg) => (
                <PackageCard
                  key={pkg.id}
                  pkg={pkg}
                  selected={selected === pkg.id}
                  onSelect={() => setSelected(pkg.id)}
                />
              ))}
            </div>
          )}
        </section>
        <aside className="panel order-summary">
          <span className="eyebrow">TRANSACTION SUMMARY</span>
          <h2>{chosen?.name || "Your next session"}</h2>
          <p>
            {chosen
              ? "Review your selection before continuing."
              : "Select a package to see the details."}
          </p>
          <dl>
            <div>
              <dt>Package</dt>
              <dd>{chosen?.name || "Not selected"}</dd>
            </div>
            <div>
              <dt>Photo allowance</dt>
              <dd>{chosen ? `${chosen.photo_limit} photos` : "—"}</dd>
            </div>
            <div>
              <dt>Session duration</dt>
              <dd>{chosen ? `${chosen.session_duration_minutes} min` : "—"}</dd>
            </div>
            <div>
              <dt>Payment mode</dt>
              <dd>
                <span className="test-label">QRIS simulation</span>
              </dd>
            </div>
          </dl>
          <div className="order-total">
            <span>Total simulated amount</span>
            <strong>{chosen ? money(chosen.price_idr) : "—"}</strong>
          </div>
          <button
            className="button primary full"
            disabled={!chosen || busy}
            onClick={create}
          >
            {busy ? (
              <>
                <span className="spinner small" />
                Creating transaction…
              </>
            ) : (
              <>
                Create transaction
                <Icon name="arrow" size={18} />
              </>
            )}
          </button>
          <p className="fine-print">
            <Icon name="shield" size={15} />
            No payment is collected. A real transaction record will be created.
          </p>
        </aside>
      </div>
    </>
  );
}

function Steps({ current }) {
  return (
    <ol className="steps" aria-label="Transaction progress">
      {["Choose package", "Verify payment", "Active session"].map(
        (name, index) => (
          <li
            key={name}
            className={
              current === index + 1
                ? "current"
                : current > index + 1
                  ? "complete"
                  : ""
            }
          >
            <span>
              {current > index + 1 ? (
                <Icon name="check" size={15} />
              ) : (
                `0${index + 1}`
              )}
            </span>
            <strong>{name}</strong>
            {index < 2 && <i />}
          </li>
        ),
      )}
    </ol>
  );
}

function TransactionDetail() {
  const { id } = useParams();
  const { data, error, loading, reload } = useResource(`/transactions/${id}`);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [showOverride, setShowOverride] = useState(false);

  const tx = data?.transaction;
  const paid = tx?.payment_status === "paid";
  const isFree = tx?.payment_method === "free";
  const guestLink = tx?.session_id
    ? `${window.location.origin}/photobooth/session/${tx.session_id}#key=${tx.checkout_key || ""}`
    : `${window.location.origin}/photobooth`;

  // Exception handling only
  async function manualConfirm() {
    setBusy("confirm");
    setActionError(null);
    try {
      await api.post(`/transactions/${id}/confirm-simulation`, {
        confirmation: "SIMULATED_PAYMENT",
      });
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  async function manualIssueToken() {
    setBusy("token");
    setActionError(null);
    try {
      await api.post(`/transactions/${id}/token`);
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Link className="back-link" to="/operator/transactions">
        <Icon name="arrow" size={16} />
        All transactions
      </Link>
      <PageHeading
        eyebrow="TRANSACTION MONITOR"
        title={tx ? `Transaction #${shortId(tx.id)}` : "Transaction details"}
        description={
          tx
            ? `Created ${date(tx.created_at)} WIB · ${tx.is_visitor ? "Public Guest Session" : "Operator Transaction"}`
            : "Transaction and session monitor."
        }
        action={tx && <Status transaction={tx} />}
      />
      <ErrorNotice error={error} onRetry={reload} />
      <ErrorNotice error={actionError} />
      {loading && !tx ? (
        <Spinner label="Loading transaction…" />
      ) : (
        tx && (
          <div className="checkout-grid">
            <section className="panel payment-panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    {isFree ? "Free Racebooth Session" : paid
                      ? "Payment Recorded"
                      : "Awaiting Simulated Payment"}
                  </h2>
                  <p>
                    {isFree ? "This session is free. No payment was collected." : paid
                      ? "This historical payment record authorizes the linked photobooth session."
                      : "This historical transaction is awaiting payment."}
                  </p>
                </div>
                {paid && (
                  <span className="success-icon">
                    <Icon name="check" size={21} />
                  </span>
                )}
              </div>

              {paid ? (
                <div className="token-success" style={{ marginTop: "16px" }}>
                  <div className="token-ready">
                    <Icon name="key" size={32} />
                  </div>
                  <span className="eyebrow">SESSION TOKEN STATUS</span>
                  <div style={{ fontSize: "16px", fontWeight: "600", color: "#166534", margin: "8px 0 16px" }}>
                    {tx.token_status === "issued" ? "Session Token Active & Verified" : "Token Issuance In Progress"}
                  </div>

                  {/* Share Access Link with Guest */}
                  <div style={{ background: "#f4f9f7", padding: "16px", borderRadius: "10px", margin: "16px 0", border: "1px solid #dbeae3" }}>
                    <span className="eyebrow" style={{ color: "#4f8f7c" }}>GUEST SESSION ACCESS LINK</span>
                    <div style={{ wordBreak: "break-all", fontSize: "12px", fontFamily: "monospace", margin: "8px 0 12px", color: "#223b34" }}>
                      {guestLink}
                    </div>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <button
                        className="button secondary"
                        onClick={async () => {
                          await navigator.clipboard.writeText(guestLink);
                          setCopiedLink(true);
                          setTimeout(() => setCopiedLink(false), 2500);
                        }}
                      >
                        <Icon name={copiedLink ? "check" : "copy"} size={16} />
                        {copiedLink ? "Copied Link!" : "Copy Guest Link"}
                      </button>
                      <a
                        href={guestLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="button primary"
                      >
                        <Icon name="external" size={16} />
                        Open Session
                      </a>
                    </div>
                  </div>

                  <div className="token-meta">
                    <span>
                      <Icon name="clock" size={16} />
                      Expires: {date(tx.token_expires_at)}
                    </span>
                    <span>
                      <Icon name="camera" size={16} />
                      Session: {tx.session_id ? shortId(tx.session_id) : "Ready"}
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ padding: "24px 0" }}>
                  <div className="notice info" style={{ marginBottom: "20px" }}>
                    <Icon name="clock" size={20} />
                    <div>
                      <strong>Awaiting Guest Action</strong>
                      <p style={{ marginTop: "4px" }}>
                        This historical transaction is awaiting payment. Public visitors now start free sessions from the booth homepage.
                      </p>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                    <a
                      href={guestLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="button primary"
                    >
                      <Icon name="external" size={16} />
                      Open Free Photobooth
                    </a>
                    <button
                      className="button secondary"
                      onClick={async () => {
                        await navigator.clipboard.writeText(guestLink);
                        setCopiedLink(true);
                        setTimeout(() => setCopiedLink(false), 2500);
                      }}
                    >
                      <Icon name={copiedLink ? "check" : "copy"} size={16} />
                      {copiedLink ? "Copied!" : "Copy Booth Link"}
                    </button>
                  </div>
                </div>
              )}

              {/* Exception Handling / Manual Actions */}
              <div style={{ marginTop: "32px", borderTop: "1px solid #eef2ef", paddingTop: "20px" }}>
                <button
                  className="text-button"
                  style={{ fontSize: "12px", color: "#8a968e" }}
                  onClick={() => setShowOverride(!showOverride)}
                >
                  {showOverride ? "Hide Exception Tools ▲" : "Exception Handling & Manual Controls ▼"}
                </button>

                {showOverride && (
                  <div style={{ background: "#fff", padding: "16px", borderRadius: "8px", border: "1px solid #e5ebe7", marginTop: "12px" }}>
                    <p style={{ fontSize: "12px", color: "#63756b", marginBottom: "12px" }}>
                      Manual overrides for troubleshooting and test simulations:
                    </p>
                    <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                      {!paid && (
                        <button
                          className="button secondary"
                          disabled={busy === "confirm"}
                          onClick={manualConfirm}
                        >
                          Manual Confirm Payment
                        </button>
                      )}
                      {paid && tx.token_status !== "issued" && (
                        <button
                          className="button primary"
                          disabled={busy === "token"}
                          onClick={manualIssueToken}
                        >
                          Manual Invoke Token Issuance
                        </button>
                      )}
                      <button className="button secondary" onClick={reload}>
                        <Icon name="refresh" size={16} />
                        Refresh Status
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <aside className="panel order-summary">
              <span className="eyebrow">TRANSACTION DETAILS</span>
              <h2>{tx.package_name || "Photo package"}</h2>
              <p>Reference #{shortId(tx.id)}</p>
              <dl>
                <div>
                  <dt>Transaction Type</dt>
                  <dd>
                    <span className={`badge ${tx.is_visitor ? "neutral" : "primary"}`}>
                      {tx.is_visitor ? "Public Guest" : "Operator"}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>{money(tx.amount_idr)}</dd>
                </div>
                <div>
                  <dt>Payment method</dt>
                  <dd>{tx.payment_method?.toUpperCase()}{tx.is_simulated ? " (SIMULATED)" : ""}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <Status transaction={tx} />
                  </dd>
                </div>
                <div>
                  <dt>Confirmation</dt>
                  <dd>{tx.paid_at ? date(tx.paid_at) : "Pending"}</dd>
                </div>
                <div>
                  <dt>Token Status</dt>
                  <dd className="capitalize">{tx.token_status || "Not issued"}</dd>
                </div>
              </dl>
              <div className="summary-simulation">
                <Icon name="shield" size={21} />
                <strong>{isFree ? "Free session" : tx.is_simulated ? "Simulation record" : "Payment record"}</strong>
                <p>{isFree ? "No payment was collected for this session." : tx.is_simulated ? "Test payments are excluded from real revenue reporting." : "Historical transaction data is preserved."}</p>
              </div>
            </aside>
          </div>
        )
      )}
    </>
  );
}

function Packages() {
  const { data, error, loading, reload } = useResource("/packages");
  const [editing, setEditing] = useState(null);
  const packages = data?.packages || [];
  return (
    <>
      <PageHeading
        eyebrow="THE SESSION COLLECTION"
        title="Photo packages"
        description="Historical package terms. Public visitors now start free sessions."
        action={
          <button className="button primary" onClick={() => setEditing({})}>
            <Icon name="plus" size={18} />
            Add package
          </button>
        }
      />
      <ErrorNotice error={error} onRetry={reload} />
      <div className="section-heading">
        <div>
          <h2>
            Your packages <span className="count-pill">{packages.length}</span>
          </h2>
          <p>Active packages are automatically visible to public guests.</p>
        </div>
        <span className="muted small-text">
          {packages.filter((pkg) => pkg.is_active).length} active
        </span>
      </div>
      {loading ? (
        <Spinner label="Loading packages…" />
      ) : !packages.length ? (
        <div className="panel">
          <Empty
            icon="box"
            title="Make your first package"
            action={
              <button className="button primary" onClick={() => setEditing({})}>
                <Icon name="plus" size={16} />
                Add package
              </button>
            }
          >
            A great session starts with a package. Set a price, photo count, and
            duration.
          </Empty>
        </div>
      ) : (
        <div className="package-grid">
          {packages.map((pkg) => (
            <PackageCard
              key={pkg.id}
              pkg={pkg}
              onEdit={() => setEditing(pkg)}
            />
          ))}
        </div>
      )}
      {editing && (
        <PackageModal
          pkg={editing}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function PackageModal({ pkg, close, saved }) {
  const [form, setForm] = useState({
    name: pkg.name || "",
    price_idr: pkg.price_idr ?? "",
    photo_limit: pkg.photo_limit ?? "",
    session_duration_minutes: pkg.session_duration_minutes ?? "",
    is_active: pkg.is_active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialog = useRef(null);
  const closeRef = useRef(close);
  const busyRef = useRef(busy);
  closeRef.current = close;
  busyRef.current = busy;

  useEffect(() => {
    const node = dialog.current;
    const before = document.activeElement;
    node.showModal();
    const cancel = (event) => {
      event.preventDefault();
      if (!busyRef.current) closeRef.current();
    };
    node.addEventListener("cancel", cancel);
    return () => {
      node.removeEventListener("cancel", cancel);
      if (node.open) node.close();
      before?.focus?.();
    };
  }, []);

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const body = {
      ...form,
      name: form.name.trim(),
      price_idr: Number(form.price_idr),
      photo_limit: Number(form.photo_limit),
      session_duration_minutes: Number(form.session_duration_minutes),
    };
    try {
      if (pkg.id) await api.patch(`/packages/${pkg.id}`, body);
      else await api.post("/packages", body);
      saved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const update = (name) => (event) =>
    setForm({ ...form, [name]: event.target.value });

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="package-dialog-title"
    >
      <div className="modal-heading">
        <div>
          <span className="eyebrow">PHOTO PACKAGE</span>
          <h2 id="package-dialog-title">
            {pkg.id ? "Edit package" : "Create a new package"}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close package form"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <ErrorNotice error={error} />
      {pkg.id && (
        <div className="notice info">
          <Icon name="shield" size={17} />
          <p>
            Packages used by a transaction keep their pricing, photo allowance,
            and duration. Create a new package to change those terms.
          </p>
        </div>
      )}
      <form onSubmit={save}>
        <label htmlFor="package-name">Package name</label>
        <input
          id="package-name"
          autoFocus
          value={form.name}
          onChange={update("name")}
          placeholder="e.g. The classic session"
          required
          minLength={2}
          maxLength={100}
        />
        <label htmlFor="package-price">
          Price <span>(IDR)</span>
        </label>
        <div className="input-prefix">
          <span>Rp</span>
          <input
            id="package-price"
            type="number"
            min="0"
            max="1000000000"
            step="1"
            value={form.price_idr}
            onChange={update("price_idr")}
            placeholder="75000"
            required
          />
        </div>
        <div className="form-grid">
          <div>
            <label htmlFor="package-photos">Photo allowance</label>
            <input
              id="package-photos"
              type="number"
              min="1"
              max="1000"
              step="1"
              value={form.photo_limit}
              onChange={update("photo_limit")}
              placeholder="6"
              required
            />
          </div>
          <div>
            <label htmlFor="package-duration">
              Duration <span>(minutes)</span>
            </label>
            <input
              id="package-duration"
              type="number"
              min="1"
              max="1440"
              step="1"
              value={form.session_duration_minutes}
              onChange={update("session_duration_minutes")}
              placeholder="15"
              required
            />
          </div>
        </div>
        <label className="checkbox-label active-checkbox">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
          />
          <span>
            <strong>Available for new transactions</strong>
            <small>Guests and operators can select this package when it is active.</small>
          </span>
        </label>
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <>
                <span className="spinner small" />
                Saving…
              </>
            ) : (
              <>
                <Icon name="check" size={17} />
                {pkg.id ? "Save changes" : "Create package"}
              </>
            )}
          </button>
        </div>
      </form>
    </dialog>
  );
}
