// State of the board that is currently open.
// tasks is a map by id. tombstones remembers the version at which a task was removed,
// so a late or duplicated event cannot bring a deleted task back.
export const initialBoardState = {
  status: 'idle', // idle | loading | ready | error
  board: null,
  columns: [],
  tasks: {},
  tombstones: {},
  error: null,
};

export function boardReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return initialBoardState;

    case 'loading':
      return { ...initialBoardState, status: 'loading' };

    case 'loaded':
      return {
        status: 'ready',
        board: action.board,
        columns: action.columns,
        tasks: Object.fromEntries(action.tasks.map((t) => [t.id, t])),
        tombstones: {},
        error: null,
      };

    case 'error':
      return { ...state, status: 'error', error: action.error };

    // A task as the server has it. Ignored if we already have that version or a newer one.
    // This is what makes our own WebSocket echo harmless: it arrives with a version we already hold.
    case 'task/upsert': {
      const incoming = action.task;
      const current = state.tasks[incoming.id];
      if (current && current.version >= incoming.version) return state;
      if ((state.tombstones[incoming.id] ?? -1) >= incoming.version) return state;
      return { ...state, tasks: { ...state.tasks, [incoming.id]: incoming } };
    }

    // Optimistic change: applied locally, version untouched, so the server's answer (newer version) replaces it.
    case 'task/patch': {
      const current = state.tasks[action.id];
      if (!current) return state;
      return { ...state, tasks: { ...state.tasks, [action.id]: { ...current, ...action.patch } } };
    }

    case 'task/remove': {
      const { [action.id]: removed, ...rest } = state.tasks;
      const version = Math.max(action.version ?? 0, removed?.version ?? 0);
      return { ...state, tasks: rest, tombstones: { ...state.tombstones, [action.id]: version } };
    }

    // Put a task back to what it was before a failed optimistic change.
    // Skipped if a newer version arrived in the meantime.
    case 'task/rollback': {
      const snapshot = action.task;
      const current = state.tasks[snapshot.id];
      if (current && current.version !== snapshot.version) return state;
      const { [snapshot.id]: _gone, ...tombstones } = state.tombstones;
      return { ...state, tasks: { ...state.tasks, [snapshot.id]: snapshot }, tombstones };
    }

    // The server renumbered a column. Positions only, versions do not change.
    case 'positions/apply': {
      const tasks = { ...state.tasks };
      for (const { id, position } of action.positions) {
        if (tasks[id]) tasks[id] = { ...tasks[id], position };
      }
      return { ...state, tasks };
    }

    case 'columns/set':
      return { ...state, columns: action.columns };

    case 'column/remove':
      return { ...state, columns: state.columns.filter((c) => c.id !== action.columnId) };

    case 'board/set':
      return { ...state, board: action.board };

    default:
      return state;
  }
}

const byPosition = (a, b) =>
  a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

// { columnId: [tasks sorted top to bottom] }
export function groupTasks(state) {
  const groups = Object.fromEntries(state.columns.map((c) => [c.id, []]));
  for (const task of Object.values(state.tasks)) groups[task.columnId]?.push(task);
  for (const list of Object.values(groups)) list.sort(byPosition);
  return groups;
}
