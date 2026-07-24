import { lazy, Suspense, useEffect, useState, useCallback } from 'react';

import { HashRouter, Routes, Route, NavLink, Navigate, useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { WSProvider, useWS } from './hooks/useWebSocket';
import type { BotInstance } from './types';
import { fetchStats, fetchInstances } from './api';
import {
  Nav,
  NavList,
  NavItem,
  Masthead,
  MastheadMain,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarGroup,
  Label,
  MenuToggle,
  MenuToggleElement,
  Select,
  SelectList,
  SelectOption
} from '@patternfly/react-core';
import BotBanner from './components/BotBanner';
import ThemeSelector from './components/ThemeSelector';
import Toasts from './components/Toasts';

const Instances = lazy(() => import('./pages/Instances'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Memories = lazy(() => import('./pages/Memories'));
const Search = lazy(() => import('./pages/Search'));
const Costs = lazy(() => import('./pages/Costs'));
const EmbeddingMap = lazy(() => import('./pages/EmbeddingMap'));
const ArchivedTasks = lazy(() => import('./pages/ArchivedTasks'));
const CycleRuns = lazy(() => import('./pages/CycleRuns'));

function InstanceSelector({ instances, currentId }: { instances: BotInstance[]; currentId?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = (_e: any, val: string | number | undefined) => {
    const value = String(val);
    setIsOpen(false);
    if (value === '__global__') {
      navigate('/tasks');
    } else if (value === '__instances__') {
      navigate('/instances');
    } else {
      const subPath = location.pathname.match(/\/instances\/[^/]+\/(.*)/)?.[1] || 'tasks';
      navigate(`/instances/${encodeURIComponent(value)}/${subPath}`);
    }
  };

  const currentLabel = currentId
    ? instances.find(i => i.instance_id === currentId)?.instance_id || currentId
    : 'All instances';

  return (
    <Select
      isOpen={isOpen}
      selected={currentId || '__global__'}
      onSelect={handleSelect}
      onOpenChange={setIsOpen}
      toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
        <MenuToggle ref={toggleRef} onClick={() => setIsOpen(!isOpen)} isExpanded={isOpen}>
          {currentLabel}
        </MenuToggle>
      )}
    >
      <SelectList>
        <SelectOption value="__global__">All instances</SelectOption>
        <SelectOption value="__instances__">Overview</SelectOption>
        {instances.map((inst) => (
          <SelectOption key={inst.instance_id} value={inst.instance_id}>
            {inst.instance_id} — {inst.state.toUpperCase()}
          </SelectOption>
        ))}
      </SelectList>
    </Select>
  );
}

function InstanceScoped() {
  const { id } = useParams<{ id: string }>();
  const instanceId = decodeURIComponent(id || '');
  const base = `/instances/${encodeURIComponent(instanceId)}`;

  return (
    <>
      <Nav variant="horizontal" aria-label="Instance navigation">
        <NavList>
          <NavItem><NavLink to={`${base}/tasks`}>Tasks</NavLink></NavItem>
          <NavItem><NavLink to={`${base}/archived`}>Archive</NavLink></NavItem>
          <NavItem><NavLink to={`${base}/memories`}>Memories</NavLink></NavItem>
          <NavItem><NavLink to={`${base}/search`}>Search</NavLink></NavItem>
          <NavItem><NavLink to={`${base}/cycles`}>Cycles</NavLink></NavItem>
          <NavItem><NavLink to={`${base}/costs`}>Costs</NavLink></NavItem>
          <NavItem><NavLink to={`${base}/viz`}>Viz</NavLink></NavItem>
        </NavList>
      </Nav>
      <Suspense fallback={null}>
        <Routes>
          <Route path="tasks" element={<Tasks instanceId={instanceId} />} />
          <Route path="archived" element={<ArchivedTasks instanceId={instanceId} />} />
          <Route path="cycles" element={<CycleRuns instanceId={instanceId} />} />
          <Route path="memories" element={<Memories />} />
          <Route path="search" element={<Search />} />
          <Route path="costs" element={<Costs />} />
          <Route path="viz" element={<EmbeddingMap />} />
          <Route path="" element={<Navigate to="tasks" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}

function AppInner() {
  const [stats, setStats] = useState<{ tasks: number; memories: number }>({ tasks: 0, memories: 0 });
  const [instances, setInstances] = useState<BotInstance[]>([]);
  const { connected, onEvent } = useWS();
  const location = useLocation();

  const instanceMatch = location.pathname.match(/\/instances\/([^/]+)/);
  const currentInstanceId = instanceMatch ? decodeURIComponent(instanceMatch[1]) : undefined;
  const currentInstance = instances.find((i) => i.instance_id === currentInstanceId);

  const loadStats = useCallback(async () => {
    try {
      const s = await fetchStats();
      const taskTotal = s.tasks ? Object.values(s.tasks as Record<string, number>).reduce((a: number, b: number) => a + b, 0) : 0;
      setStats({ tasks: taskTotal, memories: s.memories?.total ?? 0 });
    } catch {
      // ignore
    }
  }, []);

  const loadInstances = useCallback(async () => {
    try {
      setInstances(await fetchInstances());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadInstances();
  }, [loadStats, loadInstances]);

  useEffect(() => {
    const unsub = onEvent((event) => {
      if (event.type === 'bot_status') {
        loadInstances();
      }
      if (
        event.type === 'task_added' ||
        event.type === 'task_removed' ||
        event.type === 'task_archived' ||
        event.type === 'memory_stored' ||
        event.type === 'memory_deleted'
      ) {
        loadStats();
        loadInstances();
      }
    });
    return unsub;
  }, [onEvent, loadStats, loadInstances]);

  return (
    <>
      <Masthead>
        <MastheadMain style={{ flex: 1 }}>
          <Toolbar style={{ width: '100%' }}>
            <ToolbarContent>
              <ToolbarItem>
                <Link to="/instances" style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none', color: 'inherit' }}>
                  <img src="/static/icon.png" alt="" className="header-icon" />
                  <span style={{ fontSize: '1.25rem', fontWeight: 700 }}>Řehoř</span>
                </Link>
              </ToolbarItem>
              <ToolbarItem>
                <InstanceSelector instances={instances} currentId={currentInstanceId} />
              </ToolbarItem>
              <ToolbarGroup align={{ default: 'alignEnd' }}>
                <ToolbarItem>
                  <ThemeSelector />
                </ToolbarItem>
                <ToolbarItem>
                  <Label variant="outline">{stats.tasks} tasks</Label>
                </ToolbarItem>
                <ToolbarItem>
                  <Label variant="outline">{stats.memories} memories</Label>
                </ToolbarItem>
                <ToolbarItem>
                  <span className={`ws-dot ${connected ? 'connected' : ''}`} title={connected ? 'Connected' : 'Disconnected'} />
                </ToolbarItem>
              </ToolbarGroup>
            </ToolbarContent>
          </Toolbar>
        </MastheadMain>
      </Masthead>
      <div className="app">

      {currentInstance && (
        <BotBanner status={{
          state: currentInstance.state,
          message: currentInstance.message,
          external_key: currentInstance.external_key,
          source_type: currentInstance.source_type,
          source_url: currentInstance.source_url,
          repo: currentInstance.repo,
          instance_id: currentInstance.instance_id,
          cycle_start: currentInstance.cycle_start,
          updated_at: currentInstance.updated_at,
        }} />
      )}

      <Toasts />

      <main>
        {!currentInstanceId && (
          <Nav variant="horizontal" aria-label="Global navigation">
            <NavList>
              <NavItem><NavLink to="/tasks">Tasks</NavLink></NavItem>
              <NavItem><NavLink to="/archived">Archive</NavLink></NavItem>
              <NavItem><NavLink to="/cycles">Cycles</NavLink></NavItem>
              <NavItem><NavLink to="/memories">Memories</NavLink></NavItem>
              <NavItem><NavLink to="/search">Search</NavLink></NavItem>
              <NavItem><NavLink to="/costs">Costs</NavLink></NavItem>
              <NavItem><NavLink to="/viz">Viz</NavLink></NavItem>
            </NavList>
          </Nav>
        )}
        <Suspense fallback={null}>
          <Routes>
            <Route path="/instances/:id/*" element={<InstanceScoped />} />
            <Route path="/instances" element={<Instances />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/archived" element={<ArchivedTasks />} />
            <Route path="/cycles" element={<CycleRuns />} />
            <Route path="/memories" element={<Memories />} />
            <Route path="/search" element={<Search />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="/viz" element={<EmbeddingMap />} />
            <Route path="/" element={<Navigate to="/instances" replace />} />
          </Routes>
        </Suspense>
      </main>
      </div>
    </>
  );
}

export default function App() {
  return (
    <WSProvider>
      <HashRouter>
        <AppInner />
      </HashRouter>
    </WSProvider>
  );
}
