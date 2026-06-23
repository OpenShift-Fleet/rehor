import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { HashRouter, Routes, Route, NavLink, Navigate, useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { WSProvider, useWS } from './hooks/useWebSocket';
import type { BotInstance } from './types';
import { fetchStats, fetchInstances } from './api';
import BotBanner from './components/BotBanner';
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

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === '__global__') {
      navigate('/tasks');
    } else if (val === '__instances__') {
      navigate('/instances');
    } else {
      const subPath = location.pathname.match(/\/instances\/[^/]+\/(.*)/)?.[1] || 'tasks';
      navigate(`/instances/${encodeURIComponent(val)}/${subPath}`);
    }
  };

  return (
    <select
      className="instance-selector"
      value={currentId || '__global__'}
      onChange={handleChange}
    >
      <option value="__global__">All instances</option>
      <option value="__instances__">Overview</option>
      {instances.map((inst) => (
        <option key={inst.instance_id} value={inst.instance_id}>
          {inst.instance_id} — {inst.state.toUpperCase()}
        </option>
      ))}
    </select>
  );
}

function InstanceScoped() {
  const { id } = useParams<{ id: string }>();
  const instanceId = decodeURIComponent(id || '');
  const base = `/instances/${encodeURIComponent(instanceId)}`;

  return (
    <>
      <nav className="tab-nav">
        <NavLink to={`${base}/tasks`}>Tasks</NavLink>
        <NavLink to={`${base}/archived`}>Archive</NavLink>
        <NavLink to={`${base}/memories`}>Memories</NavLink>
        <NavLink to={`${base}/search`}>Search</NavLink>
        <NavLink to={`${base}/cycles`}>Cycles</NavLink>
        <NavLink to={`${base}/costs`}>Costs</NavLink>
        <NavLink to={`${base}/viz`}>Viz</NavLink>
      </nav>
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
    <div className="app">
      <header>
        <div className="header-left">
          <Link to="/instances" className="header-home">
            <img src="/static/icon.png" alt="" className="header-icon" />
            <h1 className="header-title">Řehoř</h1>
          </Link>
          <InstanceSelector instances={instances} currentId={currentInstanceId} />
        </div>
        <div className="header-right">
          <div className="stats-bar">
            <span className="stat">{stats.tasks} tasks</span>
            <span className="stat">{stats.memories} memories</span>
          </div>
          <span className={`ws-dot ${connected ? 'connected' : ''}`} title={connected ? 'Connected' : 'Disconnected'} />
        </div>
      </header>

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
          <nav className="tab-nav">
            <NavLink to="/tasks">Tasks</NavLink>
            <NavLink to="/archived">Archive</NavLink>
            <NavLink to="/cycles">Cycles</NavLink>
            <NavLink to="/memories">Memories</NavLink>
            <NavLink to="/search">Search</NavLink>
            <NavLink to="/costs">Costs</NavLink>
            <NavLink to="/viz">Viz</NavLink>
          </nav>
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
