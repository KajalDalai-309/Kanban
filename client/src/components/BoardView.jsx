import { useMemo, useRef, useState } from 'react';
import { ConfirmModal, PromptModal } from './Dialogs.jsx';
import TaskCard from './TaskCard.jsx';

// Which gap between the cards is the pointer in? Returns an index among the cards that are not being dragged.
function indexFromPointer(listEl, clientY, draggingId) {
  const cards = [...listEl.querySelectorAll('[data-task-id]')].filter((el) => el.dataset.taskId !== draggingId);
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return cards.length;
}

function Composer({ onSubmit, onCancel }) {
  const [title, setTitle] = useState('');
  const submit = () => {
    if (!title.trim()) return onCancel();
    onSubmit(title.trim());
    setTitle('');
  };
  return (
    <div className="composer">
      <textarea
        autoFocus
        rows={2}
        maxLength={200}
        placeholder="What needs to be done?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={submit}>Add task</button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Column({ column, index, total, tasks, membersById, canEdit, selectedId, dragId, drop, handlers, actions }) {
  const listRef = useRef(null);
  const [composing, setComposing] = useState(false);
  const [dialog, setDialog] = useState(null);
  const others = tasks.filter((t) => t.id !== dragId);
  const dropHere = drop?.columnId === column.id ? drop.index : null;
  const indicator = <div className="drop-indicator" aria-hidden="true" />;

  return (
    <section className={`column ${dropHere !== null ? 'drop-active' : ''}`} aria-label={column.name}>
      <header className="column-head">
        <h3>{column.name}</h3>
        <span className="count">{tasks.length}</span>
        {canEdit && (
          <div className="col-tools">
            <button className="icon-btn" disabled={index === 0} onClick={() => actions.moveColumn(column.id, -1)} aria-label={`Move ${column.name} left`}>‹</button>
            <button className="icon-btn" disabled={index === total - 1} onClick={() => actions.moveColumn(column.id, 1)} aria-label={`Move ${column.name} right`}>›</button>
            <button className="icon-btn" onClick={() => setDialog('rename')} aria-label={`Rename ${column.name}`}>✎</button>
            <button className="icon-btn" onClick={() => setDialog('delete')} aria-label={`Delete ${column.name}`}>✕</button>
          </div>
        )}
      </header>

      <div
        ref={listRef}
        className="column-body"
        onDragOver={(e) => handlers.onDragOver(e, column.id, listRef.current)}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && handlers.onDragLeave(column.id)}
        onDrop={(e) => handlers.onDrop(e, column.id)}
      >
        {tasks.map((task) => (
          <div key={task.id} className="card-slot">
            {dropHere !== null && others[dropHere]?.id === task.id && indicator}
            <TaskCard
              task={task}
              assignee={membersById[task.assigneeId]}
              selected={selectedId === task.id}
              dragging={dragId === task.id}
              onSelect={handlers.onSelect}
              onDragStart={handlers.onDragStart}
              onDragEnd={handlers.onDragEnd}
            />
          </div>
        ))}
        {dropHere !== null && dropHere >= others.length && indicator}
        {tasks.length === 0 && dropHere === null && <div className="column-empty">No tasks yet</div>}
      </div>

      <footer className="column-foot">
        {composing ? (
          <Composer
            onCancel={() => setComposing(false)}
            onSubmit={(title) => {
              const last = tasks.at(-1);
              actions.createTask(column.id, { title }, { afterId: last?.id ?? null, beforeId: null });
            }}
          />
        ) : (
          <button className="add-task" onClick={() => setComposing(true)}>+ Add task</button>
        )}
      </footer>

      {dialog === 'rename' && (
        <PromptModal title="Rename column" label="Column name" initial={column.name}
          onSubmit={(name) => actions.renameColumn(column.id, name)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && (
        <ConfirmModal title="Delete column" message={`Delete "${column.name}"? A column must be empty before it can be deleted.`}
          onConfirm={() => actions.deleteColumn(column.id)} onClose={() => setDialog(null)} />
      )}
    </section>
  );
}

export default function BoardView({ state, grouped, members, canEditColumns, selectedId, onSelect, actions }) {
  const [dragId, setDragId] = useState(null);
  const [drop, setDrop] = useState(null); // { columnId, index }
  const [addingColumn, setAddingColumn] = useState(false);
  const membersById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);

  const clear = () => {
    setDragId(null);
    setDrop(null);
  };

  const handlers = {
    onSelect,
    onDragStart: setDragId,
    onDragEnd: clear,
    onDragOver(e, columnId, listEl) {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const index = indexFromPointer(listEl, e.clientY, dragId);
      setDrop((d) => (d?.columnId === columnId && d.index === index ? d : { columnId, index }));
    },
    onDragLeave: (columnId) => setDrop((d) => (d?.columnId === columnId ? null : d)),
    onDrop(e, columnId) {
      e.preventDefault();
      if (!dragId || !drop || drop.columnId !== columnId) return clear();
      const column = grouped[columnId] ?? [];
      const others = column.filter((t) => t.id !== dragId);
      // Dropped back exactly where it was: nothing to do.
      const sameSpot = column.some((t) => t.id === dragId) && column.findIndex((t) => t.id === dragId) === drop.index;
      if (!sameSpot) {
        actions.moveTask(dragId, columnId, {
          afterId: others[drop.index - 1]?.id ?? null,
          beforeId: others[drop.index]?.id ?? null,
        });
      }
      clear();
    },
  };

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className="board" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="column skeleton">
            <div className="sk sk-title" /><div className="sk sk-card" /><div className="sk sk-card" />
          </div>
        ))}
      </div>
    );
  }
  if (state.status === 'error') {
    return <div className="empty-state"><h3>Could not load this board</h3><p className="muted">{state.error}</p></div>;
  }

  return (
    <div className="board">
      {state.columns.map((column, i) => (
        <Column
          key={column.id}
          column={column}
          index={i}
          total={state.columns.length}
          tasks={grouped[column.id] ?? []}
          membersById={membersById}
          canEdit={canEditColumns}
          selectedId={selectedId}
          dragId={dragId}
          drop={drop}
          handlers={handlers}
          actions={actions}
        />
      ))}
      {canEditColumns && (
        <button className="column column-add" onClick={() => setAddingColumn(true)}>+ Add column</button>
      )}
      {state.columns.length === 0 && !canEditColumns && (
        <div className="empty-state"><h3>This board has no columns yet</h3><p className="muted">Ask a branch admin to add some.</p></div>
      )}
      {addingColumn && (
        <PromptModal title="Add column" label="Column name" submitLabel="Add"
          onSubmit={actions.createColumn} onClose={() => setAddingColumn(false)} />
      )}
    </div>
  );
}
