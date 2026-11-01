import { useRef, useState } from 'react';
import { timeAgo } from '../lib/format.js';
import { ConfirmModal } from './Dialogs.jsx';

const FIELD_LABELS = { title: 'Title', description: 'Description', priority: 'Priority', assigneeId: 'Assignee', dueDate: 'Due date' };

// What the server stores for an empty select / date input.
const normalize = (field, value) => (field === 'assigneeId' || field === 'dueDate' ? value || null : value);

/**
 * Side panel for one task. Edits are kept in `draft` (only the fields the user touched),
 * so fields nobody here touched keep following live updates from other users.
 * baseRef remembers which version the draft started from; the server uses it to
 * detect that someone else changed the same field in the meantime.
 */
export default function TaskPanel({ task, columns, members, canDelete, onClose, onSave, onMove, onDelete }) {
  const [draft, setDraft] = useState({});
  const [conflict, setConflict] = useState(null); // { fields, current }
  const [choices, setChoices] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const baseRef = useRef(null); // { version, task } at the moment the first edit was made

  const value = (field) => (field in draft ? draft[field] : task[field] ?? '');
  const dirty = Object.keys(draft).filter((f) => normalize(f, draft[f]) !== (task[f] ?? null) && !(draft[f] === '' && task[f] == null));
  const changedByOthers = baseRef.current ? dirty.filter((f) => task[f] !== baseRef.current.task[f]) : [];
  const saving0 = task.version === 0;

  const edit = (field, v) => {
    if (!baseRef.current) baseRef.current = { version: task.version, task };
    setError('');
    setDraft((d) => ({ ...d, [field]: v }));
  };

  const discard = () => {
    setDraft({});
    setConflict(null);
    baseRef.current = null;
    setError('');
  };

  async function save() {
    if (!dirty.length || saving) return;
    const changes = Object.fromEntries(dirty.map((f) => [f, normalize(f, draft[f])]));
    if ('title' in changes && !changes.title.trim()) return setError('Title cannot be empty');
    if ('title' in changes) changes.title = changes.title.trim();

    setSaving(true);
    const result = await onSave(task.id, changes, baseRef.current.version);
    setSaving(false);
    if (result.conflict) {
      setConflict(result.conflict);
      setChoices(Object.fromEntries(result.conflict.fields.map((f) => [f, 'mine'])));
    } else if (result.ok) {
      discard();
    }
  }

  // Apply the user's choice per conflicting field, then re-base the draft on the server's current version.
  function resolve() {
    const next = { ...draft };
    for (const f of conflict.fields) if (choices[f] === 'theirs') delete next[f];
    baseRef.current = { version: conflict.current.version, task: conflict.current };
    setDraft(next);
    setConflict(null);
    if (Object.keys(next).length === 0) baseRef.current = null;
  }

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
    if (e.key === 'Escape') onClose();
  };

  const creator = members.find((m) => m.id === task.createdBy);
  const display = (field, v) =>
    field === 'assigneeId' ? members.find((m) => m.id === v)?.name ?? 'Unassigned' : v || '(empty)';

  return (
    <aside className="drawer task-panel" aria-label="Task details" onKeyDown={onKeyDown}>
      <div className="drawer-head">
        <h2>Task details</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close task details">×</button>
      </div>

      <div className="drawer-body stack">
        {conflict && (
          <div className="conflict" role="alert">
            <strong>Someone else changed this task while you were editing.</strong>
            {conflict.fields.map((f) => (
              <div key={f} className="conflict-row">
                <div className="conflict-label">{FIELD_LABELS[f]}</div>
                <label className={choices[f] === 'theirs' ? 'picked' : ''}>
                  <input type="radio" name={`c-${f}`} checked={choices[f] === 'theirs'} onChange={() => setChoices((c) => ({ ...c, [f]: 'theirs' }))} />
                  <span>Theirs</span><em>{display(f, conflict.current[f])}</em>
                </label>
                <label className={choices[f] === 'mine' ? 'picked' : ''}>
                  <input type="radio" name={`c-${f}`} checked={choices[f] === 'mine'} onChange={() => setChoices((c) => ({ ...c, [f]: 'mine' }))} />
                  <span>Mine</span><em>{display(f, normalize(f, draft[f]))}</em>
                </label>
              </div>
            ))}
            <button className="btn btn-primary btn-sm" onClick={resolve}>Continue</button>
          </div>
        )}

        {!conflict && changedByOthers.length > 0 && (
          <div className="notice">
            Someone else also changed {changedByOthers.map((f) => FIELD_LABELS[f].toLowerCase()).join(', ')}. You will be asked to choose when you save.
          </div>
        )}

        <label className="field">
          <span>Title</span>
          <input value={value('title')} maxLength={200} onChange={(e) => edit('title', e.target.value)} />
        </label>

        <label className="field">
          <span>Description</span>
          <textarea rows={6} maxLength={5000} value={value('description')} onChange={(e) => edit('description', e.target.value)} placeholder="Add more detail…" />
        </label>

        <div className="grid-2">
          <label className="field">
            <span>Priority</span>
            <select value={value('priority')} onChange={(e) => edit('priority', e.target.value)}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </label>
          <label className="field">
            <span>Due date</span>
            <input type="date" value={value('dueDate') ?? ''} onChange={(e) => edit('dueDate', e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Assignee</span>
          <select value={value('assigneeId') ?? ''} onChange={(e) => edit('assigneeId', e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>

        <label className="field">
          <span>Column</span>
          <select value={task.columnId} onChange={(e) => onMove(task.id, e.target.value)} disabled={saving0}>
            {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="row">
          <button className="btn btn-primary" onClick={save} disabled={!dirty.length || saving || saving0}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button className="btn" onClick={discard} disabled={!Object.keys(draft).length}>Discard</button>
          <span className="spacer" />
          {canDelete && <button className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>Delete</button>}
        </div>

        <dl className="meta">
          <dt>Created by</dt><dd>{creator?.name ?? 'Unknown'} · {timeAgo(task.createdAt)}</dd>
          <dt>Last updated</dt><dd>{timeAgo(task.updatedAt)}</dd>
          <dt>Version</dt><dd>{task.version}</dd>
        </dl>
      </div>

      {confirmDelete && (
        <ConfirmModal title="Delete task" message={`Delete "${task.title}"? You can undo this with Ctrl+Z.`}
          onConfirm={() => onDelete(task.id)} onClose={() => setConfirmDelete(false)} />
      )}
    </aside>
  );
}
