import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import TaskCard from './TaskCard';
import { makeTask } from '../test/helpers';

describe('TaskCard', () => {
  it('renders external key as link for jira source type', () => {
    const task = makeTask({ source_type: 'jira', external_key: 'RHCLOUD-100', source_url: null });
    render(<TaskCard task={task} />);
    const link = screen.getByRole('link', { name: 'RHCLOUD-100' });
    expect(link).toHaveAttribute('href', 'https://redhat.atlassian.net/browse/RHCLOUD-100');
  });

  it('renders external key as span when source_type is not jira and no source_url', () => {
    const task = makeTask({ source_type: 'github', external_key: 'org/repo#42', source_url: null });
    render(<TaskCard task={task} />);
    const span = screen.getByText('org/repo#42');
    expect(span.tagName).toBe('SPAN');
  });

  it('shows correct status label for in_progress', () => {
    const task = makeTask({ status: 'in_progress' });
    render(<TaskCard task={task} />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });

  it('shows correct status label for paused', () => {
    const task = makeTask({ status: 'paused' });
    render(<TaskCard task={task} />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('shows correct status label for pr_open', () => {
    const task = makeTask({ status: 'pr_open' });
    render(<TaskCard task={task} />);
    expect(screen.getByText('PR Open')).toBeInTheDocument();
  });

  it('shows paused_reason when present', () => {
    const task = makeTask({ paused_reason: 'Waiting for review' });
    render(<TaskCard task={task} />);
    expect(screen.getByText('Waiting for review')).toBeInTheDocument();
  });

  it('does not show paused_reason when null', () => {
    const task = makeTask({ paused_reason: null });
    render(<TaskCard task={task} />);
    expect(screen.queryByText('Waiting for review')).not.toBeInTheDocument();
  });

  it('renders card for both github and jira source types', () => {
    const githubTask = makeTask({ source_type: 'github', external_key: 'org/repo#42', source_url: 'https://github.com/org/repo/issues/42' });
    const { container: c1 } = render(<TaskCard task={githubTask} />);
    expect(c1.querySelector('.pf-v6-c-card')).not.toBeNull();

    const jiraTask = makeTask({ source_type: 'jira' });
    const { container: c2 } = render(<TaskCard task={jiraTask} />);
    expect(c2.querySelector('.pf-v6-c-card')).not.toBeNull();
  });

  it('calls onClick when card clicked', async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    const task = makeTask();
    const { container } = render(<TaskCard task={task} onClick={handleClick} />);
    const card = container.querySelector('.pf-v6-c-card');
    await user.click(card!);
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('shows instance_id', () => {
    const task = makeTask({ instance_id: 'bot-42' });
    render(<TaskCard task={task} />);
    expect(screen.getByText('bot-42')).toBeInTheDocument();
  });
});
