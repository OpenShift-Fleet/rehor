import { describe, it, expect, vi, afterEach } from 'vitest';
import { timeAgo, formatDuration, formatTokens, sourceUrl, displayKey, effectiveState } from './utils';

describe('timeAgo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for less than 60 seconds ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:30Z'));
    expect(timeAgo('2025-01-01T12:00:00Z')).toBe('just now');
  });

  it('returns "Xm ago" for less than 1 hour ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:25:00Z'));
    expect(timeAgo('2025-01-01T12:00:00Z')).toBe('25m ago');
  });

  it('returns "Xh ago" for less than 1 day ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T15:00:00Z'));
    expect(timeAgo('2025-01-01T12:00:00Z')).toBe('3h ago');
  });

  it('returns "Xd ago" for 1 day or more ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-03T12:00:00Z'));
    expect(timeAgo('2025-01-01T12:00:00Z')).toBe('2d ago');
  });
});

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(45000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3720000)).toBe('1h 2m');
  });
});

describe('formatTokens', () => {
  it('formats millions', () => {
    expect(formatTokens(1500000)).toBe('1.5M');
  });

  it('formats thousands', () => {
    expect(formatTokens(2500)).toBe('2.5K');
  });

  it('formats small numbers as-is', () => {
    expect(formatTokens(42)).toBe('42');
  });
});

describe('sourceUrl', () => {
  it('returns source_url when set', () => {
    expect(
      sourceUrl({ source_url: 'https://example.com', source_type: 'jira', external_key: 'X-1' }),
    ).toBe('https://example.com');
  });

  it('constructs jira URL from external_key when source_type is jira', () => {
    expect(
      sourceUrl({ source_url: null, source_type: 'jira', external_key: 'RHCLOUD-123' }),
    ).toBe('https://redhat.atlassian.net/browse/RHCLOUD-123');
  });

  it('returns null when no external_key', () => {
    expect(sourceUrl({ source_url: null, source_type: 'jira', external_key: null })).toBeNull();
  });

  it('returns null for non-jira without source_url', () => {
    expect(
      sourceUrl({ source_url: null, source_type: 'github', external_key: 'org/repo#42' }),
    ).toBeNull();
  });
});

describe('displayKey', () => {
  it('returns external_key when present', () => {
    expect(displayKey({ external_key: 'RHCLOUD-001' })).toBe('RHCLOUD-001');
  });

  it('returns empty string when no external_key', () => {
    expect(displayKey({ external_key: null })).toBe('');
  });
});

describe('effectiveState', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns working as-is', () => {
    expect(effectiveState({ state: 'working', updated_at: '2025-01-01T00:00:00Z' })).toBe('working');
  });

  it('returns error as-is', () => {
    expect(effectiveState({ state: 'error', updated_at: '2025-01-01T00:00:00Z' })).toBe('error');
  });

  it('returns idle when last_seen is recent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:30Z'));
    expect(effectiveState({ state: 'idle', last_seen: '2025-01-01T12:00:00Z', updated_at: '2025-01-01T11:00:00Z' })).toBe('idle');
  });

  it('returns sleep when last_seen is stale and state is idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:05:00Z'));
    expect(effectiveState({ state: 'idle', last_seen: '2025-01-01T12:00:00Z', updated_at: '2025-01-01T11:00:00Z' })).toBe('sleep');
  });

  it('falls back to updated_at when last_seen is null', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:05:00Z'));
    expect(effectiveState({ state: 'idle', last_seen: null, updated_at: '2025-01-01T12:00:00Z' })).toBe('sleep');
  });

  it('returns idle when no timestamps available', () => {
    expect(effectiveState({ state: 'idle' })).toBe('idle');
  });

  it('does not convert working to sleep even if stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:05:00Z'));
    expect(effectiveState({ state: 'working', last_seen: '2025-01-01T12:00:00Z', updated_at: '2025-01-01T11:00:00Z' })).toBe('working');
  });
});
