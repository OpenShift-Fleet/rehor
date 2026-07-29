import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '@patternfly/patternfly/patternfly.css';
import '@patternfly/patternfly/patternfly-addons.css';
import '../src/App.css';

import type { WSEvent } from '../src/types';

import TaskCard from '../src/components/TaskCard';
import BotBanner from '../src/components/BotBanner';
import ConfirmDialog from '../src/components/ConfirmDialog';
import CycleRunCard from '../src/components/CycleRunCard';
import DetailPanel from '../src/components/DetailPanel';
import Toasts from '../src/components/Toasts';

import Tasks from '../src/pages/Tasks';
import ArchivedTasks from '../src/pages/ArchivedTasks';
import Costs from '../src/pages/Costs';
import CycleRuns from '../src/pages/CycleRuns';
import Instances from '../src/pages/Instances';

import { WSProvider } from './mockWebSocket';

import {
  makeTask,
  makeBotStatus,
  makeCycleRun,
} from '../src/test/helpers';

// --- Hidden input helper for recording callbacks ---

function RecordInput({ id }: { id: string }) {
  return <input type="hidden" id={id} value="" />;
}

function record(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement;
  if (el) el.value = value;
}

// --- Scenario registry ---

const scenarios: Record<string, () => JSX.Element> = {
  // ── TaskCard ──
  'TaskCard/JiraLink': () => (
    <TaskCard task={makeTask({ source_type: 'jira', external_key: 'RHCLOUD-100', source_url: null })} />
  ),
  'TaskCard/GitHubNoUrl': () => (
    <TaskCard task={makeTask({ source_type: 'github', external_key: 'org/repo#42', source_url: null })} />
  ),
  'TaskCard/InProgress': () => (
    <TaskCard task={makeTask({ status: 'in_progress' })} />
  ),
  'TaskCard/Paused': () => (
    <TaskCard task={makeTask({ status: 'paused', paused_reason: 'Waiting for review' })} />
  ),
  'TaskCard/PrOpen': () => (
    <TaskCard task={makeTask({ status: 'pr_open' })} />
  ),
  'TaskCard/NoPausedReason': () => (
    <TaskCard task={makeTask({ paused_reason: null })} />
  ),
  'TaskCard/WithInstanceId': () => (
    <TaskCard task={makeTask({ instance_id: 'bot-42' })} />
  ),
  'TaskCard/GitHubWithUrl': () => (
    <TaskCard task={makeTask({ source_type: 'github', external_key: 'org/repo#42', source_url: 'https://github.com/org/repo/issues/42' })} />
  ),
  'TaskCard/ClickHandling': () => (
    <>
      <RecordInput id="clicked" />
      <TaskCard
        task={makeTask({ external_key: 'RHCLOUD-100', source_type: 'jira' })}
        onClick={() => record('clicked', 'true')}
      />
    </>
  ),

  // ── BotBanner ──
  'BotBanner/Idle': () => (
    <BotBanner status={makeBotStatus({ state: 'idle', message: 'Waiting for tasks' })} />
  ),
  'BotBanner/Working': () => (
    <BotBanner status={makeBotStatus({
      state: 'working',
      message: 'Working on RHCLOUD-100',
      external_key: 'RHCLOUD-100',
      source_type: 'jira',
      repo: 'org/repo',
      cycle_start: new Date(Date.now() - 125_000).toISOString(),
    })} />
  ),
  'BotBanner/Error': () => (
    <BotBanner status={makeBotStatus({ state: 'error', message: 'Cycle failed' })} />
  ),
  'BotBanner/IdleWithWake': () => (
    <BotBanner status={makeBotStatus({ state: 'idle', instance_id: 'dev-bot' })} />
  ),
  'BotBanner/WorkingNoWake': () => (
    <BotBanner status={makeBotStatus({ state: 'working', instance_id: 'dev-bot' })} />
  ),
  // ── ConfirmDialog ──
  'ConfirmDialog/Default': () => (
    <>
      <RecordInput id="confirmed" />
      <ConfirmDialog
        open={true}
        title="Confirm Action"
        message="Are you sure?"
        onConfirm={(val) => record('confirmed', val ?? '__undefined__')}
        onCancel={() => record('confirmed', '__cancelled__')}
      />
    </>
  ),
  'ConfirmDialog/WithInput': () => (
    <>
      <RecordInput id="confirmed" />
      <ConfirmDialog
        open={true}
        title="Confirm Action"
        message="Are you sure?"
        inputLabel="Reason"
        inputPlaceholder="Enter reason"
        onConfirm={(val) => record('confirmed', val ?? '__undefined__')}
        onCancel={() => record('confirmed', '__cancelled__')}
      />
    </>
  ),
  'ConfirmDialog/Danger': () => (
    <ConfirmDialog
      open={true}
      title="Delete"
      message="This is permanent"
      variant="danger"
      confirmLabel="Delete"
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  ),
  'ConfirmDialog/Primary': () => (
    <ConfirmDialog
      open={true}
      title="Confirm"
      message="Proceed?"
      variant="default"
      confirmLabel="OK"
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  ),

  // ── CycleRunCard ──
  'CycleRunCard/Default': () => (
    <CycleRunCard run={makeCycleRun({ id: 7, cycle_type: 'task_work' })} />
  ),
  'CycleRunCard/WithDuration': () => (
    <CycleRunCard run={makeCycleRun({
      started_at: '2025-07-01T10:00:00Z',
      finished_at: '2025-07-01T10:05:00Z',
      tool_calls: 8,
      tokens_used: 2500,
    })} />
  ),
  'CycleRunCard/NoFinished': () => (
    <CycleRunCard run={makeCycleRun({ finished_at: null, tool_calls: 3, tokens_used: 100 })} />
  ),
  'CycleRunCard/NullStats': () => (
    <CycleRunCard run={makeCycleRun({ tool_calls: null, tokens_used: null })} />
  ),
  'CycleRunCard/WithProgress': () => (
    <CycleRunCard run={makeCycleRun({
      progress: { external_key: 'RHCLOUD-100', source_type: 'jira' },
    })} />
  ),
  'CycleRunCard/WithSummary': () => (
    <CycleRunCard run={makeCycleRun({
      progress: { summary: 'Implemented fix for login', last_step: 'run tests' },
    })} />
  ),
  'CycleRunCard/WithInstanceId': () => (
    <CycleRunCard run={makeCycleRun({ instance_id: 'prod-bot' })} />
  ),
  'CycleRunCard/Selected': () => (
    <CycleRunCard run={makeCycleRun()} selected />
  ),
  'CycleRunCard/ClickHandling': () => (
    <>
      <RecordInput id="clicked" />
      <CycleRunCard
        run={makeCycleRun()}
        onClick={() => record('clicked', 'true')}
      />
    </>
  ),
  'CycleRunCard/WithTranscript': () => (
    <CycleRunCard run={makeCycleRun({ id: 5, has_transcript: true, cycle_type: 'task_work', started_at: '2025-07-01T10:00:00Z' })} />
  ),

  // ── DetailPanel ──
  'DetailPanel/PauseVisible': () => (
    <>
      <RecordInput id="action" />
      <DetailPanel
        type="task"
        task={makeTask({ status: 'in_progress', external_key: 'RHCLOUD-555' })}
        onClose={() => {}}
        onPause={(key) => record('action', `pause:${key}`)}
      />
    </>
  ),
  'DetailPanel/PausePrOpen': () => (
    <DetailPanel
      type="task"
      task={makeTask({ status: 'pr_open' })}
      onClose={() => {}}
      onPause={() => {}}
    />
  ),
  'DetailPanel/PausePrChanges': () => (
    <DetailPanel
      type="task"
      task={makeTask({ status: 'pr_changes' })}
      onClose={() => {}}
      onPause={() => {}}
    />
  ),
  'DetailPanel/PausedNoPause': () => (
    <DetailPanel
      type="task"
      task={makeTask({ status: 'paused' })}
      onClose={() => {}}
      onPause={() => {}}
    />
  ),
  'DetailPanel/DoneNoPause': () => (
    <DetailPanel
      type="task"
      task={makeTask({ status: 'done' })}
      onClose={() => {}}
      onPause={() => {}}
    />
  ),
  'DetailPanel/NoPauseCallback': () => (
    <DetailPanel
      type="task"
      task={makeTask({ status: 'in_progress' })}
      onClose={() => {}}
    />
  ),
  'DetailPanel/UnpauseVisible': () => (
    <>
      <RecordInput id="action" />
      <DetailPanel
        type="task"
        task={makeTask({ status: 'paused', external_key: 'RHCLOUD-777' })}
        onClose={() => {}}
        onUnpause={(key) => record('action', `unpause:${key}`)}
      />
    </>
  ),
  'DetailPanel/InProgressNoUnpause': () => (
    <DetailPanel
      type="task"
      task={makeTask({ status: 'in_progress' })}
      onClose={() => {}}
      onUnpause={() => {}}
    />
  ),
  'DetailPanel/ArchiveVisible': () => (
    <DetailPanel
      type="task"
      task={makeTask({ status: 'in_progress' })}
      onClose={() => {}}
      onDelete={() => {}}
    />
  ),
  'DetailPanel/ArchivedNoArchive': () => (
    <DetailPanel
      type="task"
      task={makeTask({ status: 'archived' })}
      onClose={() => {}}
      onDelete={() => {}}
    />
  ),
  'DetailPanel/WithPausedReason': () => (
    <DetailPanel
      type="task"
      task={makeTask({ paused_reason: 'Blocked by dependency' })}
      onClose={() => {}}
    />
  ),

  // ── Toasts (useWS aliased to mockWebSocket via Vite config) ──
  'Toasts/Default': () => (
    <WSProvider>
      <Toasts />
    </WSProvider>
  ),

  // ── Pages (API mocked via page.route() in tests) ──
  'Tasks/Default': () => (
    <MemoryRouter><Tasks /></MemoryRouter>
  ),
  'ArchivedTasks/Default': () => (
    <MemoryRouter><ArchivedTasks /></MemoryRouter>
  ),
  'Costs/Default': () => (
    <div style={{ width: '1200px', height: '800px' }}><Costs /></div>
  ),
  'CycleRuns/Default': () => (
    <MemoryRouter><CycleRuns /></MemoryRouter>
  ),
  'CycleRuns/WithInstanceId': () => (
    <MemoryRouter><CycleRuns instanceId="prod-bot" /></MemoryRouter>
  ),
  'Instances/Default': () => (
    <MemoryRouter><Instances /></MemoryRouter>
  ),
};

// --- Mount/unmount API ---

const root = createRoot(document.getElementById('root')!);

(window as any).mount = (scenarioId: string) => {
  const scenario = scenarios[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  root.render(<>{scenario()}</>);
};

(window as any).unmount = () => {
  root.render(null);
};

declare global {
  interface Window {
    mount(scenarioId: string): void;
    unmount(): void;
    emitWSEvent?(event: WSEvent): void;
  }
}
