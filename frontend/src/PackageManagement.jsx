import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { Box, Check, Eye, Pencil, Plus } from "lucide-react";

const emptyDraft = () => ({ name: "", price_idr: "", description: "", benefitsText: "", is_active: true, display_order: 0 });
const money = value => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0));

function PackageIcon({ name = "box", size = 18 }) {
  const icons = { box: Box, check: Check, edit: Pencil, eye: Eye, plus: Plus };
  const Glyph = icons[name] || Box;
  return <Glyph aria-hidden="true" size={size} strokeWidth={1.8} />;
}

export default function PackageManagement() {
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get("/admin/packages");
      setPackages(data.packages || []);
    } catch (err) { setError(err); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function save(event) {
    event.preventDefault();
    if (saving || !draft) return;
    setSaving(true);
    setError(null);
    const body = {
      name: draft.name.trim(),
      price_idr: Number(draft.price_idr),
      description: draft.description.trim(),
      benefits: draft.benefitsText.split("\n").map(item => item.trim()).filter(Boolean),
      is_active: Boolean(draft.is_active),
      display_order: Number(draft.display_order),
    };
    try {
      if (draft.id) await api.patch(`/admin/packages/${draft.id}`, body);
      else await api.post("/admin/packages", body);
      setDraft(null);
      await load();
    } catch (err) { setError(err); }
    finally { setSaving(false); }
  }

  async function toggleActive(pkg) {
    setError(null);
    try {
      await api.patch(`/admin/packages/${pkg.id}`, { is_active: !pkg.is_active });
      await load();
    } catch (err) { setError(err); }
  }

  function edit(pkg) {
    setDraft(pkg ? {
      id: pkg.id,
      name: pkg.name || "",
      price_idr: String(pkg.price_idr ?? ""),
      description: pkg.description || "",
      benefitsText: Array.isArray(pkg.benefits) ? pkg.benefits.join("\n") : "",
      is_active: Boolean(pkg.is_active),
      display_order: Number(pkg.display_order || 0),
    } : emptyDraft());
  }

  return (
    <div className="package-admin-page">
      <header className="package-admin-heading">
        <div>
          <span className="eyebrow">ADMINISTRATION</span>
          <h1>Package management</h1>
        <p>Set the package details shown on the public booth. New managed packages use the existing four-photo flow.</p>
        </div>
        <button type="button" className="button primary" onClick={() => edit(null)}><PackageIcon name="plus"/> Create package</button>
      </header>

      <div className="package-admin-notice" role="note">
        <PackageIcon name="eye" size={20}/>
        <p>Changing a package only affects future checkouts. Transaction rows keep their saved price and package snapshot. Deactivated packages remain in history; packages with historical photo limits other than four are not shown in public checkout.</p>
      </div>
      {error && <div className="notice error" role="alert">{errorMessage(error)}</div>}

      {draft && <form className="package-admin-form" onSubmit={save}>
        <div className="package-admin-form-title">
          <div><span className="eyebrow">FOUR-PHOTO SESSION</span><h2>{draft.id ? "Edit package" : "Create package"}</h2></div>
          <button type="button" className="button secondary small-button" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
        </div>
        <div className="package-admin-fields">
          <label>Package name<input autoFocus required minLength={2} maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}/></label>
          <label>Price in IDR<input required type="number" inputMode="numeric" min="0" max="1000000000" step="1" value={draft.price_idr} onChange={e => setDraft({ ...draft, price_idr: e.target.value })}/></label>
          <label className="package-admin-wide">Short description<textarea rows="2" maxLength={400} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label>
          <label className="package-admin-wide">Included benefits <span className="field-hint">One benefit per line, up to eight.</span><textarea rows="4" maxLength={1000} value={draft.benefitsText} onChange={e => setDraft({ ...draft, benefitsText: e.target.value })}/></label>
          <label>Display order<input type="number" min="0" max="10000" step="1" value={draft.display_order} onChange={e => setDraft({ ...draft, display_order: e.target.value })}/></label>
          <label className="package-admin-checkbox"><input type="checkbox" checked={draft.is_active} onChange={e => setDraft({ ...draft, is_active: e.target.checked })}/> Show to visitors for new checkouts</label>
        </div>
        <div className="package-admin-actions"><button type="submit" className="button primary" disabled={saving}>{saving ? "Saving…" : draft.id ? "Save package" : "Create package"}</button></div>
      </form>}

      <section className="package-admin-list" aria-labelledby="package-list-title">
        <div className="package-admin-list-heading"><div><span className="eyebrow">DATABASE RECORDS</span><h2 id="package-list-title">Current packages</h2></div><span className="count-pill">{packages.length}</span></div>
        {loading ? <div className="loading" role="status">Loading packages…</div> : !packages.length ? <div className="package-admin-empty">No packages exist yet. Create the first package to make package checkout available.</div> : (
          <div className="package-admin-table-wrap"><table className="package-admin-table">
            <thead><tr><th>Order</th><th>Package</th><th>Price</th><th>Benefits</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{packages.map(pkg => <tr key={pkg.id}>
              <td>{pkg.display_order}</td>
              <td><strong>{pkg.name}</strong><small>{pkg.description || "Four-photo photostrip session"}</small><small className="package-id">{pkg.id}</small></td>
              <td className="package-admin-price">{money(pkg.price_idr)}</td>
              <td>{Array.isArray(pkg.benefits) && pkg.benefits.length ? pkg.benefits.join(" · ") : <span className="muted">No benefits listed</span>}</td>
              <td><span className={`badge ${pkg.is_active ? "success" : "neutral"}`}>{pkg.is_active ? "Active" : "Inactive"}</span></td>
              <td><div className="package-admin-row-actions"><button type="button" className="icon-button" aria-label={`Edit ${pkg.name}`} onClick={() => edit(pkg)}><PackageIcon name="edit"/></button><button type="button" className="button secondary small-button" onClick={() => toggleActive(pkg)}>{pkg.is_active ? "Deactivate" : "Activate"}</button></div></td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
