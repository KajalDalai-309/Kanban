import { useState } from 'react';
import { api, setToken } from '../lib/api.js';

const DEMO = [
  { email: 'priya@abc.com', label: 'Priya', note: 'Org admin · ABC Technologies (all branches)' },
  { email: 'ravi@abc.com', label: 'Ravi', note: 'Branch admin · Hyderabad' },
  { email: 'anita@abc.com', label: 'Anita', note: 'Member · Hyderabad + Bangalore' },
  { email: 'arjun@xyz.com', label: 'Arjun', note: 'Org admin · XYZ Corp (a different organization)' },
];

export default function Login({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e, override) {
    e?.preventDefault();
    const body = override ?? form;
    setBusy(true);
    setError('');
    try {
      const path = mode === 'login' || override ? '/api/auth/login' : '/api/auth/register';
      const { token } = await api.post(path, body);
      setToken(token);
      onSignedIn();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand brand-lg"><span className="brand-mark" aria-hidden="true" />Kanban Teams</div>
        <p className="muted">Real-time boards for organizations and their branches.</p>

        <form onSubmit={submit} className="stack">
          {mode === 'register' && (
            <label className="field"><span>Name</span>
              <input value={form.name} onChange={set('name')} required maxLength={80} autoComplete="name" />
            </label>
          )}
          <label className="field"><span>Email</span>
            <input type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
          </label>
          <label className="field"><span>Password</span>
            <input type="password" value={form.password} onChange={set('password')} required minLength={mode === 'register' ? 8 : 1}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button className="link-btn" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
          {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>

        <div className="demo">
          <div className="demo-title">Demo accounts <span className="muted">(password: password123)</span></div>
          {DEMO.map((d) => (
            <button key={d.email} className="demo-row" disabled={busy}
              onClick={() => submit(null, { email: d.email, password: 'password123' })}>
              <strong>{d.label}</strong><span>{d.note}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
