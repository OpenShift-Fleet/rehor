import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import CycleRunCard from './CycleRunCard';
import { makeCycleRun } from '../test/helpers';

vi.mock('../api', () => ({
  fetchCycleRunTranscript: vi.fn(),
}));

import { fetchCycleRunTranscript } from '../api';

const mockFetchTranscript = vi.mocked(fetchCycleRunTranscript);

describe('CycleRunCard', () => {
  it('renders cycle type label and id', () => {
    const run = makeCycleRun({ id: 7, cycle_type: 'task_work' });
    render(<CycleRunCard run={run} />);
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
  });

  it('renders duration, tool calls, and tokens', () => {
    const run = makeCycleRun({
      started_at: '2025-07-01T10:00:00Z',
      finished_at: '2025-07-01T10:05:00Z',
      tool_calls: 8,
      tokens_used: 2500,
    });
    render(<CycleRunCard run={run} />);
    expect(screen.getByText('5m 0s')).toBeInTheDocument();
    expect(screen.getByText('8 tools')).toBeInTheDocument();
    expect(screen.getByText('2.5K tokens')).toBeInTheDocument();
  });

  it('omits duration when finished_at is null', () => {
    const run = makeCycleRun({ finished_at: null, tool_calls: 3, tokens_used: 100 });
    const { container } = render(<CycleRunCard run={run} />);
    expect(container.querySelector('.cycle-run-duration')).toBeNull();
    expect(screen.getByText('3 tools')).toBeInTheDocument();
  });

  it('omits tool calls and tokens when null', () => {
    const run = makeCycleRun({ tool_calls: null, tokens_used: null });
    const { container } = render(<CycleRunCard run={run} />);
    expect(container.querySelector('.cycle-run-tools')).toBeNull();
    expect(container.querySelector('.cycle-run-tokens')).toBeNull();
  });

  it('renders external key from progress', () => {
    const run = makeCycleRun({
      progress: { external_key: 'RHCLOUD-100', source_type: 'jira' },
    });
    render(<CycleRunCard run={run} />);
    const link = screen.getByRole('link', { name: 'RHCLOUD-100' });
    expect(link).toHaveAttribute('href', 'https://redhat.atlassian.net/browse/RHCLOUD-100');
  });

  it('renders summary and last step from progress', () => {
    const run = makeCycleRun({
      progress: { summary: 'Implemented fix for login', last_step: 'run tests' },
    });
    render(<CycleRunCard run={run} />);
    expect(screen.getByText('Implemented fix for login')).toBeInTheDocument();
    expect(screen.getByText('Step: run tests')).toBeInTheDocument();
  });

  it('renders instance_id when present', () => {
    const run = makeCycleRun({ instance_id: 'prod-bot' });
    render(<CycleRunCard run={run} />);
    expect(screen.getByText('prod-bot')).toBeInTheDocument();
  });

  it('applies selected class when selected', () => {
    const run = makeCycleRun();
    const { container } = render(<CycleRunCard run={run} selected />);
    expect(container.querySelector('.cycle-run-card.selected')).not.toBeNull();
  });

  it('calls onClick when card clicked', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    const run = makeCycleRun();
    const { container } = render(<CycleRunCard run={run} onClick={handleClick} />);
    await user.click(container.querySelector('.cycle-run-card')!);
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('shows download button when has_transcript', () => {
    const run = makeCycleRun({ has_transcript: true });
    render(<CycleRunCard run={run} />);
    expect(screen.getByTitle('Download transcript')).toBeInTheDocument();
  });

  it('downloads transcript on button click', async () => {
    const user = userEvent.setup();
    mockFetchTranscript.mockResolvedValue('{"type":"text"}\n');
    const run = makeCycleRun({ id: 5, has_transcript: true, cycle_type: 'task_work', started_at: '2025-07-01T10:00:00Z' });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<CycleRunCard run={run} />);
    await user.click(screen.getByTitle('Download transcript'));
    expect(mockFetchTranscript).toHaveBeenCalledWith(5);
    clickSpy.mockRestore();
  });
});
