import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ConfirmDialog from './ConfirmDialog';

describe('ConfirmDialog', () => {
  const baseProps = {
    open: true,
    title: 'Confirm Action',
    message: 'Are you sure?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders title and message', () => {
    render(<ConfirmDialog {...baseProps} />);
    expect(screen.getByText('Confirm Action')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('calls onConfirm with undefined when no inputLabel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...baseProps} onConfirm={onConfirm} />);
    await user.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it('calls onConfirm with typed value when inputLabel provided', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        {...baseProps}
        onConfirm={onConfirm}
        inputLabel="Reason"
        inputPlaceholder="Enter reason"
      />,
    );
    const input = screen.getByPlaceholderText('Enter reason');
    await user.type(input, 'needs more work');
    await user.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith('needs more work');
  });

  it('calls onCancel when cancel clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} onCancel={onCancel} />);
    await user.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('confirm button uses danger variant when variant is danger', () => {
    render(<ConfirmDialog {...baseProps} variant="danger" confirmLabel="Delete" />);
    const btn = screen.getByText('Delete').closest('button');
    expect(btn).toHaveClass('pf-m-danger');
  });

  it('confirm button uses primary variant when variant is default', () => {
    render(<ConfirmDialog {...baseProps} variant="default" confirmLabel="OK" />);
    const btn = screen.getByText('OK').closest('button');
    expect(btn).toHaveClass('pf-m-primary');
  });
});
