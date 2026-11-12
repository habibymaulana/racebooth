import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';

const time = value => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' }) : 'No run recorded';

export function IncidentDiagnosis({ diagnosis }) {
  if (!diagnosis) return null;
  return <div className="qc-diagnosis">
    <strong>Hermes diagnosis · {diagnosis.severity} · {diagnosis.model}</strong>
    <p>{diagnosis.diagnosis}</p><p><strong>Probable root cause:</strong> {diagnosis.probable_root_cause}</p>
    <p><strong>Recommendation:</strong> {diagnosis.recommendation}</p><small>Generated {time(diagnosis.created_at)} (Jakarta)</small>
  </div>;
}

export default function QualityControl({ readOnly = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [retrying, setRetrying] = useState('');
  const [diagnosing, setDiagnosing] = useState('');

  async function refresh() {
    setError('');
    try { setData((await api.get('/qc/status')).data); }
    catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  async function run() {
    if (running) return;
    setRunning(true); setMessage(''); setError('');
    try {
      const response = (await api.post('/qc/check')).data;
      setMessage(response.summary);
      await refresh();
    } catch (err) { setError(errorMessage(err)); }
    finally { setRunning(false); }
  }

  async function retry(id) {
    if (retrying) return;
    setRetrying(id); setError(''); setMessage('');
    try {
      const response = (await api.post(`/qc/retry-email/${id}`)).data;
      setMessage(response.note || 'Delivery request processed. Review its recorded outcome.');
      await refresh();
    } catch (err) { setError(errorMessage(err)); }
    finally { setRetrying(''); }
  }

  async function diagnose(id) {
    if (diagnosing) return;
    setDiagnosing(id); setError(''); setMessage('');
    try {
      await api.post(`/qc/incidents/${id}/diagnose`, {}, { timeout: 125000 });
      setMessage('Hermes returned a diagnosis for operator review.');
      await refresh();
    } catch (err) { setError(errorMessage(err)); }
    finally { setDiagnosing(''); }
  }

  const counts = data?.counts;
  const checks = data?.lastRun?.details?.checks || [];
  const incidents = data?.incidents || [];
  const hermes = data?.hermes;

  return <div className="qc-dashboard">
    <div className="section-heading qc-page-heading">
      <span className="eyebrow">RACEBOOTH OPERATIONS</span>
      <h1>Quality control</h1>
      <p>Recorded failures, database checks, private storage checks, and service connectivity.</p>
    </div>
    {loading && <p role="status">Loading recorded QC status…</p>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice info" role="status">{message}</div>}
    <section className="panel qc-panel">
      <div className="section-heading"><h2>Run diagnostics</h2><p>Checks record findings for operator review. They do not alter photos, sessions, workflows, or infrastructure.</p></div>
      {!readOnly && <button className="button primary" onClick={run} disabled={running || loading}>{running ? 'Running checks…' : 'Run system QC check'}</button>}
      {readOnly && <p className="muted">Supervisor access is read-only.</p>}
      <p className="muted">Last recorded run: {time(data?.lastRun?.created_at)} (Jakarta)</p>
      {data?.lastRun && <p>{data.lastRun.summary}</p>}
    </section>
    <section className="panel qc-panel">
      <h2>Hermes Agent connection</h2>
      <p className="qc-hermes-status"><strong>{hermes?.status ? hermes.status.toUpperCase() : 'STATUS UNKNOWN'}</strong></p>
      <p>{hermes?.message || 'No verified Hermes status has been loaded.'}</p>
      <p className="muted">Operator-requested diagnoses are {hermes?.inferenceEnabled ? 'enabled' : 'disabled'}. Hermes provides recommendations only; system checks remain independent.</p>
      {hermes?.inferenceEnabled && <p className="muted">Configured model: {hermes.configuredProvider || 'provider unknown'} · {hermes.configuredModel || 'model unknown'}. A saved inference through this target is {hermes.modelVerified ? 'verified' : 'not yet verified'}.</p>}
      {hermes?.lastDiagnosis && <p className="muted">Last model response: {hermes.lastDiagnosis.model}, {time(hermes.lastDiagnosis.created_at)} (Jakarta). This records a previous result, not current provider availability.</p>}
      {hermes?.setupInstructions && <ul>{hermes.setupInstructions.map(step => <li key={step}>{step}</li>)}</ul>}
      <p><a href="https://hermes-agent.nousresearch.com/docs/getting-started/quickstart" target="_blank" rel="noreferrer">Official Hermes setup guide</a></p>
    </section>
    <div className="qc-count-grid">
      {[['Critical open', counts?.critical_count], ['Warning open', counts?.warning_count], ['Information open', counts?.info_count]].map(([label, value]) => <section className="panel" key={label}>
        <p className="muted">{label}</p><strong className="qc-count-value">{value ?? '—'}</strong>
      </section>)}
    </div>
    <section className="panel qc-panel">
      <h2>Latest check results</h2>
      {checks.length ? <div className="qc-check-list">{checks.map(check => <article key={check.name}>
        <strong>{check.name}</strong> <span className="badge">{check.status}</span><p>{check.message}</p>
      </article>)}</div> : <p>No completed diagnostic results are recorded. Run a QC check to inspect the current system.</p>}
    </section>
    <section className="panel qc-panel">
      <h2>Recorded incidents</h2>
      <p className="muted">Up to 50 most recently detected incidents. Open incidents remain in the audit history until an operator reconciles them.</p>
      {!data ? <p>Incident status is unknown until data loads successfully.</p> : incidents.length === 0 ? <p>No incidents are recorded. This alone does not establish that all services are healthy.</p> : <div className="qc-incident-list">
        {incidents.map(incident => <article key={incident.id}>
          <span className="badge">{incident.severity.toUpperCase()} · {incident.category} · {incident.status}</span>
          <h3>{incident.title}</h3><p>{incident.description}</p>
          {incident.recommendation && <p><strong>Review:</strong> {incident.recommendation}</p>}
          <IncidentDiagnosis diagnosis={incident.ai_diagnosis} />
          <p className="muted">Detected {time(incident.detected_at)} (Jakarta)</p>
          {!readOnly && <><button className="button secondary" disabled={!hermes?.inferenceEnabled || !!diagnosing} onClick={() => diagnose(incident.id)}>{diagnosing === incident.id ? 'Requesting diagnosis…' : 'Request Hermes diagnosis'}</button>{' '}
          {incident.category === 'email' && incident.title === 'Photo email delivery failed' && incident.entity_id && incident.status === 'open' && <button className="button secondary" disabled={!!retrying} onClick={() => retry(incident.entity_id)}>{retrying === incident.entity_id ? 'Requesting retry…' : 'Retry definite failed delivery'}</button>}</>}
        </article>)}
      </div>}
    </section>
  </div>;
}
