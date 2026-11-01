import { dueInfo } from '../lib/format.js';
import Avatar from './Avatar.jsx';

export default function TaskCard({ task, assignee, selected, dragging, onSelect, onDragStart, onDragEnd }) {
  const due = dueInfo(task.dueDate);
  const saving = task.version === 0; // created locally, not confirmed by the server yet

  return (
    <div
      className={`card ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${saving ? 'saving' : ''}`}
      data-task-id={task.id}
      draggable
      tabIndex={0}
      role="button"
      aria-label={`${task.title}, ${task.priority} priority`}
      onClick={() => onSelect(task.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(task.id);
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id); // Firefox needs data to start a drag
        onDragStart(task.id);
      }}
      onDragEnd={onDragEnd}
    >
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        <span className={`chip chip-${task.priority}`}>{task.priority}</span>
        {due && <span className={`due ${due.overdue ? 'overdue' : due.soon ? 'soon' : ''}`}>{due.label}</span>}
        {saving && <span className="muted small">saving…</span>}
        <span className="spacer" />
        {assignee && <Avatar user={assignee} size={22} />}
      </div>
    </div>
  );
}
