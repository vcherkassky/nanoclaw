import { describe, it, expect } from 'vitest';

import { formatDuration, formatRelativeTime, formatBytes } from './format.js';

describe('formatDuration', () => {
  it('returns "0s" for zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });
  it('formats sub-second as ms when below 1000', () => {
    expect(formatDuration(420)).toBe('420ms');
  });
  it('formats seconds', () => {
    expect(formatDuration(2_500)).toBe('2s');
  });
  it('formats minutes + seconds', () => {
    expect(formatDuration(75_000)).toBe('1m 15s');
  });
  it('formats hours + minutes', () => {
    expect(formatDuration(3_725_000)).toBe('1h 2m');
  });
  it('formats days + hours', () => {
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });
});

describe('formatRelativeTime', () => {
  it('renders just now for <60s', () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe(
      'just now',
    );
  });
  it('renders minutes ago', () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now),
    ).toBe('5m ago');
  });
  it('renders hours ago', () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now),
    ).toBe('3h ago');
  });
  it('renders days ago', () => {
    const now = Date.now();
    expect(
      formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now),
    ).toBe('2d ago');
  });
  it('renders "never" for null', () => {
    expect(formatRelativeTime(null)).toBe('never');
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });
  it('formats KB with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
  it('formats MB with one decimal', () => {
    expect(formatBytes(2_400_000)).toBe('2.3 MB');
  });
  it('formats GB with one decimal', () => {
    expect(formatBytes(3_200_000_000)).toBe('3.0 GB');
  });
});
