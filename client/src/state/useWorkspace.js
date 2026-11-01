import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, ApiError, getToken, NetworkError } from '../lib/api.js';
import { computePosition } from '../lib/ordering.js';
import { connectTenantSocket } from '../lib/socket.js';
import { boardReducer, groupTasks, initialBoardState } from './boardReducer.js';
import { History } from './history.js';

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));

/**
 * Everything the screen needs for one tenant (branch): boards, the open board,
 * members, activity, presence, the live connection, and the actions that change data.
 *
 * Every task action works the same way:
 *   1. change local state right away (optimistic)
 *   2. send the request
 *   3. on success, store the server's version of the task
 *   4. on a normal error, roll the local change back
 *   5. on a network error, keep the change and retry it when the connection returns
 */
export function useWorkspace({ tenant, user, toast, onAccessLost }) {
  const tenantId = tenant.id;
  const base = `/api/tenants/${tenantId}`;

  const [boards, setBoards] = useState([]);
  const [boardId, setBoardId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [state, dispatch] = useReducer(boardReducer, initialBoardState);
  const [members, setMembers] = useState([]);
  const [activity, setActivity] = useState([]);
  const [activityDone, setActivityDone] = useState(false);
  const [presence, setPresence] = useState([]);
  const [connection, setConnection] = useState('connecting');
  const [pending, setPending] = useState(0);
  const [, rerender] = useReducer((n) => n + 1, 0);

  const history = useRef(new History());
  const queue = useRef([]); // requests that failed because we were offline

  // Refs hold the latest values for callbacks that outlive a render (socket handlers, undo commands).
  const grouped = useMemo(() => groupTasks(state), [state]);
  const live = useRef({});
  live.current = { state, grouped, boardId, boards };

  // ---------- loading ----------
  const loadBoard = useCallback(
    async (id, { silent = false } = {}) => {
      if (!id) return dispatch({ type: 'reset' });
      if (!silent) dispatch({ type: 'loading' });
      try {
        const snapshot = await api.get(`${base}/boards/${id}`);
        if (live.current.boardId === id) dispatch({ type: 'loaded', ...snapshot });
      } catch (e) {
        if (e instanceof NetworkError && silent) return;
        dispatch({ type: 'error', error: e.message });
      }
    },
    [base]
  );

  const refreshBoards = useCallback(async () => {
    const { boards: list } = await api.get(`${base}/boards`);
    setBoards(list);
    return list;
  }, [base]);

  const refreshMembers = useCallback(async () => {
    const { members: list } = await api.get(`${base}/members`);
    setMembers(list);
  }, [base]);

  const refreshActivity = useCallback(async () => {
    const { activity: list } = await api.get(`${base}/activity?limit=50`);
    setActivity(list);
    setActivityDone(list.length < 50);
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list] = await Promise.all([refreshBoards(), refreshMembers(), refreshActivity()]);
        if (cancelled) return;
        const saved = localStorage.getItem(`kanban.board.${tenantId}`);
        setBoardId(list.find((b) => b.id === saved)?.id ?? list[0]?.id ?? null);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, refreshBoards, refreshMembers, refreshActivity]);

  useEffect(() => {
    history.current.clear();
    rerender();
    if (boardId) localStorage.setItem(`kanban.board.${tenantId}`, boardId);
    loadBoard(boardId);
  }, [boardId, tenantId, loadBoard]);

  // ---------- offline queue ----------
  const flushQueue = useCallback(async () => {
    const ops = queue.current.splice(0);
    for (let i = 0; i < ops.length; i++) {
      try {
        ops[i].onSuccess?.(await ops[i].request());
      } catch (e) {
        if (e instanceof NetworkError) {
          queue.current.push(...ops.slice(i)); // still offline: keep the rest, in order
          break;
        }
        // The thing we changed was deleted meanwhile (404): nothing left to do.
        if (!(e instanceof ApiError && e.status === 404)) toast(`A queued change was rejected: ${e.message}`, 'error');
      }
    }
    setPending(queue.current.length);
  }, [toast]);

  // After (re)connecting: send what we queued, then reload everything from the server.
  // Reloading also covers events missed while disconnected.
  const resync = useCallback(async () => {
    await flushQueue();
    await Promise.allSettled([
      loadBoard(live.current.boardId, { silent: true }),
      refreshBoards(),
      refreshMembers(),
      refreshActivity(),
    ]);
  }, [flushQueue, loadBoard, refreshBoards, refreshMembers, refreshActivity]);

  // ---------- realtime ----------
  const handleEvent = useCallback(
    (evt) => {
      const { name, data } = evt;
      const onThisBoard = (id) => id === live.current.boardId;

      switch (name) {
        case 'task.created':
        case 'task.updated':
        case 'task.moved':
        case 'task.restored':
          if (onThisBoard(data.task.boardId)) dispatch({ type: 'task/upsert', task: data.task });
          break;
        case 'task.deleted':
          if (onThisBoard(data.boardId)) dispatch({ type: 'task/remove', id: data.taskId, version: data.version });
          break;
        case 'positions.changed':
          dispatch({ type: 'positions/apply', positions: data.positions });
          break;
        case 'columns.changed':
          if (onThisBoard(data.boardId)) dispatch({ type: 'columns/set', columns: data.columns });
          break;
        case 'column.deleted':
          if (onThisBoard(data.boardId)) dispatch({ type: 'column/remove', columnId: data.columnId });
          break;
        case 'board.created':
          setBoards((list) => (list.some((b) => b.id === data.board.id) ? list : [...list, data.board]));
          break;
        case 'board.updated':
          setBoards((list) => list.map((b) => (b.id === data.board.id ? data.board : b)));
          if (onThisBoard(data.board.id)) dispatch({ type: 'board/set', board: data.board });
          break;
        case 'board.deleted': {
          const rest = live.current.boards.filter((b) => b.id !== data.boardId);
          setBoards(rest);
          if (onThisBoard(data.boardId)) {
            toast('This board was deleted', 'info');
            setBoardId(rest[0]?.id ?? null);
          }
          break;
        }
        case 'members.changed':
          refreshMembers().catch(() => {});
          break;
        default:
          break;
      }

      if (evt.activity) {
        setActivity((list) => (list.some((a) => a.id === evt.activity.id) ? list : [evt.activity, ...list].slice(0, 300)));
      }
    },
    [refreshMembers, toast]
  );

  const handlers = useRef({});
  handlers.current = { handleEvent, resync, onAccessLost, toast };

  useEffect(() => {
    const socket = connectTenantSocket({
      tenantId,
      token: getToken(),
      onStatus: (status) => {
        setConnection(status);
        if (status === 'online') handlers.current.resync();
      },
      onPresence: setPresence,
      onEvent: (evt) => handlers.current.handleEvent(evt),
      onKicked: () => {
        handlers.current.toast('You no longer have access to this branch', 'error');
        handlers.current.onAccessLost?.();
      },
    });
    const onBrowserOnline = () => socket.reconnectNow();
    window.addEventListener('online', onBrowserOnline);
    return () => {
      window.removeEventListener('online', onBrowserOnline);
      socket.close();
    };
  }, [tenantId]);

  // ---------- the optimistic request helper ----------
  async function perform({ optimistic, request, onSuccess, rollback }) {
    optimistic?.();
    try {
      const result = await request();
      onSuccess?.(result);
      return result;
    } catch (e) {
      if (e instanceof NetworkError) {
        queue.current.push({ request, onSuccess });
        setPending(queue.current.length);
        toast('You are offline. This change will sync when you reconnect.', 'info');
        return null;
      }
      rollback?.();
      throw e;
    }
  }

  const upsert = (task) => dispatch({ type: 'task/upsert', task });
  const taskNow = (id) => live.current.state.tasks[id];
  const siblingsOf = (columnId, excludeId) =>
    (live.current.grouped[columnId] ?? []).filter((t) => t.id !== excludeId);

  // ---------- low level task operations (throw on error, never touch history) ----------
  async function rawCreate(columnId, fields, anchors, id = crypto.randomUUID()) {
    const { board } = live.current.state;
    const { position } = computePosition(siblingsOf(columnId), anchors);
    const stamp = new Date().toISOString();
    const draft = {
      id, tenantId, boardId: board.id, columnId, title: fields.title,
      description: fields.description ?? '', priority: fields.priority ?? 'medium',
      assigneeId: fields.assigneeId ?? null, dueDate: fields.dueDate ?? null,
      position, version: 0, createdBy: user.id, createdAt: stamp, updatedAt: stamp,
    };
    const result = await perform({
      optimistic: () => upsert(draft),
      request: () => api.post(`${base}/columns/${columnId}/tasks`, { id, ...fields, ...anchors }),
      onSuccess: (r) => upsert(r.task),
      rollback: () => dispatch({ type: 'task/remove', id, version: 0 }),
    });
    return result?.task ?? draft;
  }

  async function rawMove(taskId, columnId, anchors) {
    const before = taskNow(taskId);
    if (!before) throw new Error('This task no longer exists');
    const { position } = computePosition(siblingsOf(columnId, taskId), anchors);
    const result = await perform({
      optimistic: () => dispatch({ type: 'task/patch', id: taskId, patch: { columnId, position } }),
      request: () => api.post(`${base}/tasks/${taskId}/move`, { columnId, ...anchors }),
      onSuccess: (r) => upsert(r.task),
      rollback: () => dispatch({ type: 'task/rollback', task: before }),
    });
    return result?.task ?? null;
  }

  async function rawUpdate(taskId, changes, baseVersion) {
    const before = taskNow(taskId);
    if (!before) throw new Error('This task no longer exists');
    try {
      const result = await perform({
        optimistic: () => dispatch({ type: 'task/patch', id: taskId, patch: changes }),
        request: () => api.patch(`${base}/tasks/${taskId}`, { baseVersion, changes }),
        onSuccess: (r) => upsert(r.task),
        rollback: () => dispatch({ type: 'task/rollback', task: before }),
      });
      return result?.task ?? null;
    } catch (e) {
      // On a conflict take the server's current copy so the screen shows the truth.
      if (e instanceof ApiError && e.details?.current) upsert(e.details.current);
      throw e;
    }
  }

  async function rawDelete(taskId) {
    const before = taskNow(taskId);
    if (!before) return;
    try {
      await perform({
        optimistic: () => dispatch({ type: 'task/remove', id: taskId, version: before.version }),
        request: () => api.del(`${base}/tasks/${taskId}`),
        rollback: () => dispatch({ type: 'task/rollback', task: before }),
      });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }

  async function rawRestore(taskId) {
    const { task } = await api.post(`${base}/tasks/${taskId}/restore`);
    upsert(task);
  }

  // ---------- history helpers ----------
  const record = (command) => {
    history.current.record(command);
    rerender();
  };

  async function runHistory(direction) {
    const h = history.current;
    const command = direction === 'undo' ? h.takeUndo() : h.takeRedo();
    if (!command) return;
    rerender();
    try {
      await command[direction]();
      if (direction === 'undo') h.pushRedo(command);
      else h.pushUndo(command);
    } catch (e) {
      const reason = e instanceof ApiError && e.status === 409 ? 'someone else changed it' : e.message;
      toast(`Could not ${direction} "${command.label}": ${reason}`, 'error');
    }
    rerender();
  }

  const report = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      toast(e.message, 'error');
      return null;
    }
  };

  // ---------- actions used by the UI ----------
  const actions = {
    createTask: (columnId, fields, anchors = {}) =>
      report(async () => {
        const task = await rawCreate(columnId, fields, anchors);
        record({ label: `create "${task.title}"`, undo: () => rawDelete(task.id), redo: () => rawRestore(task.id) });
        return task;
      }),

    moveTask: (taskId, columnId, anchors) =>
      report(async () => {
        const before = taskNow(taskId);
        if (!before) return null;
        // Where the task was, expressed as neighbours, so undo can put it back.
        const column = live.current.grouped[before.columnId] ?? [];
        const index = column.findIndex((t) => t.id === taskId);
        const origin = { afterId: column[index - 1]?.id ?? null, beforeId: column[index + 1]?.id ?? null };
        const moved = await rawMove(taskId, columnId, anchors);
        record({
          label: `move "${before.title}"`,
          undo: () => rawMove(taskId, before.columnId, origin),
          redo: () => rawMove(taskId, columnId, anchors),
        });
        return moved;
      }),

    // Returns { ok } or { conflict: { fields, current } } so the task panel can offer a resolution.
    updateTask: async (taskId, changes, baseVersion) => {
      const before = taskNow(taskId);
      try {
        const saved = await rawUpdate(taskId, changes, baseVersion);
        if (saved && before && saved.version > before.version) {
          const oldValues = pick(before, Object.keys(changes));
          const newValues = { ...changes };
          let lastVersion = saved.version;
          record({
            label: `edit "${saved.title}"`,
            // Undo/redo are conditional on nobody having touched those fields since (baseVersion = our last version).
            undo: async () => (lastVersion = (await rawUpdate(taskId, oldValues, lastVersion)).version),
            redo: async () => (lastVersion = (await rawUpdate(taskId, newValues, lastVersion)).version),
          });
        }
        return { ok: true };
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.details?.conflicts) {
          return { conflict: { fields: e.details.conflicts, current: e.details.current } };
        }
        toast(e.message, 'error');
        return { error: e.message };
      }
    },

    deleteTask: (taskId) =>
      report(async () => {
        const before = taskNow(taskId);
        await rawDelete(taskId);
        if (before) {
          record({ label: `delete "${before.title}"`, undo: () => rawRestore(taskId), redo: () => rawDelete(taskId) });
        }
      }),

    undo: () => runHistory('undo'),
    redo: () => runHistory('redo'),

    // Structure changes (boards, columns, members) wait for the server instead of being optimistic.
    createBoard: (name) =>
      report(async () => {
        const { board } = await api.post(`${base}/boards`, { name });
        setBoards((list) => (list.some((b) => b.id === board.id) ? list : [...list, board]));
        setBoardId(board.id);
      }),
    renameBoard: (id, name) =>
      report(async () => {
        const { board } = await api.patch(`${base}/boards/${id}`, { name });
        setBoards((list) => list.map((b) => (b.id === id ? board : b)));
        if (live.current.boardId === id) dispatch({ type: 'board/set', board });
      }),
    deleteBoard: (id) =>
      report(async () => {
        await api.del(`${base}/boards/${id}`);
        const rest = live.current.boards.filter((b) => b.id !== id);
        setBoards(rest);
        if (live.current.boardId === id) setBoardId(rest[0]?.id ?? null);
      }),
    createColumn: (name) =>
      report(async () => {
        const last = live.current.state.columns.at(-1);
        const { columns } = await api.post(`${base}/boards/${live.current.boardId}/columns`, {
          name, afterId: last?.id ?? null, beforeId: null,
        });
        dispatch({ type: 'columns/set', columns });
      }),
    renameColumn: (id, name) =>
      report(async () => {
        const { columns } = await api.patch(`${base}/columns/${id}`, { name });
        dispatch({ type: 'columns/set', columns });
      }),
    moveColumn: (id, direction) =>
      report(async () => {
        const cols = live.current.state.columns;
        const i = cols.findIndex((c) => c.id === id);
        const j = i + direction;
        if (j < 0 || j >= cols.length) return;
        const anchors =
          direction < 0
            ? { afterId: cols[i - 2]?.id ?? null, beforeId: cols[i - 1].id }
            : { afterId: cols[i + 1].id, beforeId: cols[i + 2]?.id ?? null };
        const { columns } = await api.patch(`${base}/columns/${id}`, anchors);
        dispatch({ type: 'columns/set', columns });
      }),
    deleteColumn: (id) =>
      report(async () => {
        await api.del(`${base}/columns/${id}`);
        dispatch({ type: 'column/remove', columnId: id });
      }),
    addMember: (email, role) =>
      report(async () => {
        await api.post(`${base}/members`, { email, role });
        await refreshMembers();
        return true;
      }),
    changeMemberRole: (userId, role) =>
      report(async () => {
        await api.patch(`${base}/members/${userId}`, { role });
        await refreshMembers();
      }),
    removeMember: (userId) =>
      report(async () => {
        await api.del(`${base}/members/${userId}`);
        await refreshMembers();
      }),
    loadMoreActivity: () =>
      report(async () => {
        const oldest = activity.at(-1)?.id;
        const { activity: older } = await api.get(`${base}/activity?limit=50${oldest ? `&before=${oldest}` : ''}`);
        setActivity((list) => [...list, ...older]);
        setActivityDone(older.length < 50);
      }),
    selectBoard: setBoardId,
  };

  return {
    loaded, loadError, boards, boardId, state, grouped, members, activity, activityDone,
    presence, connection, pending,
    canUndo: history.current.canUndo,
    canRedo: history.current.canRedo,
    undoLabel: history.current.nextUndoLabel,
    redoLabel: history.current.nextRedoLabel,
    actions,
  };
}
