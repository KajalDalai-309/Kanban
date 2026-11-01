import { useEffect, useRef, useState } from 'react';

export function Modal({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Asks for one line of text.
export function PromptModal({ title, label, initial = '', submitLabel = 'Save', onSubmit, onClose }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => input.current?.select(), []);

  const submit = async (e) => {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    await onSubmit(value.trim());
    onClose();
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{label}</span>
          <input ref={input} value={value} maxLength={80} onChange={(e) => setValue(e.target.value)} required />
        </label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !value.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmModal({ title, message, confirmLabel = 'Delete', onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await onConfirm();
    onClose();
  };
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{message}</p>
      <div className="row end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" onClick={run} disabled={busy} autoFocus>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
