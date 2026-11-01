import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './lib/api.js';
import { atLeastAdmin } from './lib/format.js';
import { useWorkspace } from './state/useWorkspace.js';
import Header from './components/Header.jsx';
import Login from './components/Login.jsx';
import BoardView from './components/BoardView.jsx';
import TaskPanel from './components/TaskPanel.jsx';
import OrgSettings from './components/OrgSettings.jsx';
import { ActivityFeed, MembersPanel, PresenceBar } from './components/Sidebar.jsx';
import { ConfirmModal, PromptModal } from './components/Dialogs.jsx';
import { useToast } from './components/Toasts.jsx';

// Root: handles sign-in and which organization / branch is selected.
export default function App() {
  const toast = useToast();
  const [session, setSession] = useState(getToken() ? 'loading' : 'out');
  const [me, setMe] = useState(null);
  const [orgId, setOrgId] = useState(() => localStorage.getItem('kanban.org'));
  const [tenantId, setTenantId] = useState(() => localStorage.getItem('kanban.tenant'));
  const [dialog, setDialog] = useState(null);

  const loadMe = useCallback(async () => {
    try {
      const data = await api.get('/api/me');
      setMe(data);
      setSession('in');
    } catch (e) {
      if (e.status === 401) {
        setToken(null);
        setSession('out');
      } else {
        setSession('error');
      }
    }
    return null;
  }, []);

  useEffect(() => {
    if (getToken()) loadMe();
  }, [loadMe]);

  useEffect(() => {
    const out = () => {
      setToken(null);
      setMe(null);
      setSession('out');
    };
    window.addEventListener('kanban:unauthorized', out);
    return () => window.removeEventListener('kanban:unauthorized', out);
  }, []);

  // Keep the selection valid: fall back to the first org / first branch the user can open.
  const orgs = me?.orgs ?? [];
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0] ?? null;
  const tenant = org?.tenants.find((t) => t.id === tenantId) ?? org?.tenants[0] ?? null;

  useEffect(() => {
    if (org) localStorage.setItem('kanban.org', org.id);
    if (tenant) localStorage.setItem('kanban.tenant', tenant.id);
  }, [org, tenant]);

  const signOut = () => {
    setToken(null);
    setMe(null);
    setSession('out');
  };

  if (session === 'loading') return <div className="center-screen muted">Loading…</div>;
  if (session === 'error') {
    return (
      <div className="center-screen">
        <p>Cannot reach the server.</p>
        <button className="btn" onClick={loadMe}>Try again</button>
      </div>
    );
  }
  if (session === 'out') return <Login onSignedIn={() => { setSession('loading'); loadMe(); }} />;

  const createOrg = async (name) => {
    try {
      const { org: created } = await api.post('/api/orgs', { name });
      await loadMe();
      setOrgId(created.id);
      setTenantId(null);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const createTenant = async (name) => {
    try {
      const { tenant: created } = await api.post(`/api/orgs/${org.id}/tenants`, { name });
      await loadMe();
      setTenantId(created.id);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="app">
      <Header
        user={me.user}
        orgs={orgs}
        org={org}
        tenant={tenant}
        onSelectOrg={(id) => { setOrgId(id); setTenantId(null); }}
        onSelectTenant={setTenantId}
        onNewOrg={() => setDialog('org')}
        onNewTenant={() => setDialog('tenant')}
        onOrgSettings={() => setDialog('settings')}
        onSignOut={signOut}
      />

      {!org && <NoOrg onCreate={() => setDialog('org')} />}
      {org && !tenant && (
        <div className="empty-state">
          <h3>{org.name} has no branches yet</h3>
          <p className="muted">
            {org.role === 'org_admin' ? 'Create the first branch to start adding boards.' : 'Ask an organization admin to add you to a branch.'}
          </p>
          {org.role === 'org_admin' && <button className="btn btn-primary" onClick={() => setDialog('tenant')}>Create branch</button>}
        </div>
      )}
      {/* key remounts the whole workspace when the branch changes, so no state leaks between tenants */}
      {tenant && (
        <Workspace
          key={tenant.id}
          tenant={tenant}
          user={me.user}
          toast={toast}
          onAccessLost={loadMe}
        />
      )}

      {dialog === 'org' && <PromptModal title="New organization" label="Organization name" submitLabel="Create" onSubmit={createOrg} onClose={() => setDialog(null)} />}
      {dialog === 'tenant' && <PromptModal title="New branch" label="Branch name" submitLabel="Create" onSubmit={createTenant} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && org && (
        <OrgSettings org={org} toast={toast} onClose={() => setDialog(null)} onChanged={loadMe} />
      )}
    </div>
  );
}

function NoOrg({ onCreate }) {
  return (
    <div className="empty-state">
      <h3>You are not part of any organization yet</h3>
      <p className="muted">Create one to get started, or ask an admin to add you to a branch.</p>
      <button className="btn btn-primary" onClick={onCreate}>Create organization</button>
    </div>
  );
}

// Everything for one branch: board toolbar, board, and the side panels.
function Workspace({ tenant, user, toast, onAccessLost }) {
  const ws = useWorkspace({ tenant, user, toast, onAccessLost });
  const { actions, state } = ws;
  const [selectedId, setSelectedId] = useState(null);
  const [side, setSide] = useState('activity');
  const [dialog, setDialog] = useState(null);

  const isAdmin = atLeastAdmin(tenant.role);
  const selected = selectedId ? state.tasks[selectedId] : null;
  const board = ws.boards.find((b) => b.id === ws.boardId);

  // Close the panel if the task disappears (deleted by someone else).
  useEffect(() => {
    if (selectedId && state.status === 'ready' && !state.tasks[selectedId]) setSelectedId(null);
  }, [selectedId, state]);

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y), except while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); actions.undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); actions.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (ws.loadError) {
    return <div className="empty-state"><h3>Could not load this branch</h3><p className="muted">{ws.loadError}</p></div>;
  }
  if (!ws.loaded) return <div className="center-screen muted">Loading branch…</div>;

  return (
    <div className="workspace">
      <div className="toolbar">
        <div className="row">
          <select className="select" aria-label="Board" value={ws.boardId ?? ''} onChange={(e) => actions.selectBoard(e.target.value)} disabled={!ws.boards.length}>
            {ws.boards.length === 0 && <option value="">No boards</option>}
            {ws.boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          {isAdmin && (
            <>
              <button className="btn btn-sm" onClick={() => setDialog('newBoard')}>+ Board</button>
              {board && <button className="icon-btn" onClick={() => setDialog('renameBoard')} aria-label="Rename board" title="Rename board">✎</button>}
              {board && <button className="icon-btn" onClick={() => setDialog('deleteBoard')} aria-label="Delete board" title="Delete board">🗑</button>}
            </>
          )}
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={actions.undo} disabled={!ws.canUndo} title={ws.undoLabel ? `Undo ${ws.undoLabel}` : 'Nothing to undo'}>↶ Undo</button>
          <button className="btn btn-sm" onClick={actions.redo} disabled={!ws.canRedo} title={ws.redoLabel ? `Redo ${ws.redoLabel}` : 'Nothing to redo'}>↷ Redo</button>
          <PresenceBar presence={ws.presence} connection={ws.connection} pending={ws.pending} />
        </div>
      </div>

      <div className="main">
        {ws.boards.length === 0 ? (
          <div className="empty-state">
            <h3>No boards in {tenant.name} yet</h3>
            <p className="muted">{isAdmin ? 'Create a board to start tracking tasks.' : 'A branch admin needs to create the first board.'}</p>
            {isAdmin && <button className="btn btn-primary" onClick={() => setDialog('newBoard')}>Create board</button>}
          </div>
        ) : (
          <BoardView
            state={state}
            grouped={ws.grouped}
            members={ws.members}
            canEditColumns={isAdmin}
            selectedId={selectedId}
            onSelect={setSelectedId}
            actions={actions}
          />
        )}

        <aside className="sidebar">
          <div className="tabs" role="tablist">
            {['activity', 'members'].map((t) => (
              <button key={t} role="tab" aria-selected={side === t} className={side === t ? 'active' : ''} onClick={() => setSide(t)}>
                {t === 'activity' ? 'Activity' : `Members (${ws.members.length})`}
              </button>
            ))}
          </div>
          {side === 'activity' ? (
            <ActivityFeed items={ws.activity} done={ws.activityDone} onLoadMore={actions.loadMoreActivity} />
          ) : (
            <MembersPanel
              members={ws.members}
              presence={ws.presence}
              canManage={isAdmin}
              currentUserId={user.id}
              onAdd={actions.addMember}
              onRole={actions.changeMemberRole}
              onRemove={actions.removeMember}
            />
          )}
        </aside>
      </div>

      {selected && (
        <TaskPanel
          key={selected.id}
          task={selected}
          columns={state.columns}
          members={ws.members}
          canDelete={isAdmin || selected.createdBy === user.id}
          onClose={() => setSelectedId(null)}
          onSave={actions.updateTask}
          onMove={(id, columnId) => actions.moveTask(id, columnId, { afterId: (ws.grouped[columnId] ?? []).at(-1)?.id ?? null, beforeId: null })}
          onDelete={actions.deleteTask}
        />
      )}

      {dialog === 'newBoard' && <PromptModal title="New board" label="Board name" submitLabel="Create" onSubmit={actions.createBoard} onClose={() => setDialog(null)} />}
      {dialog === 'renameBoard' && board && <PromptModal title="Rename board" label="Board name" initial={board.name} onSubmit={(n) => actions.renameBoard(board.id, n)} onClose={() => setDialog(null)} />}
      {dialog === 'deleteBoard' && board && (
        <ConfirmModal title="Delete board" message={`Delete "${board.name}" with all its columns and tasks? This cannot be undone.`}
          onConfirm={() => actions.deleteBoard(board.id)} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
