import { renderHook, act } from '@testing-library/react';
import { useDraftPersistence } from './useDraftPersistence';

const KEY = 'test-form';
const TTL = 1000 * 60 * 60; // 1 hour

beforeEach(() => {
  window.localStorage.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useDraftPersistence', () => {
  it('saves draft to storage as values change (debounced)', () => {
    const { result } = renderHook(() =>
      useDraftPersistence({ key: KEY, values: { address: '' }, ttl: TTL })
    );

    act(() => {
      result.current.save({ address: '0xabc' });
      jest.advanceTimersByTime(500);
    });

    const raw = window.localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.values).toEqual({ address: '0xabc' });
    expect(typeof parsed.savedAt).toBe('number');
  });

  it('restores a saved draft on mount and exposes restored flag', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ values: { address: '0xrestored' }, savedAt: Date.now() })
    );

    const { result } = renderHook(() =>
      useDraftPersistence({ key: KEY, values: { address: '' }, ttl: TTL })
    );

    expect(result.current.restored).toBe(true);
    expect(result.current.draft).toEqual({ address: '0xrestored' });
  });

  it('discards the draft and clears storage', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ values: { address: '0xdiscard' }, savedAt: Date.now() })
    );

    const { result } = renderHook(() =>
      useDraftPersistence({ key: KEY, values: { address: '' }, ttl: TTL })
    );

    act(() => {
      result.current.discard();
    });

    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(result.current.restored).toBe(false);
    expect(result.current.draft).toBeNull();
  });

  it('clears the draft on successful submission', () => {
    const { result } = renderHook(() =>
      useDraftPersistence({ key: KEY, values: { address: '' }, ttl: TTL })
    );

    act(() => {
      result.current.save({ address: '0xsubmit' });
      jest.advanceTimersByTime(500);
    });
    expect(window.localStorage.getItem(KEY)).not.toBeNull();

    act(() => {
      result.current.clear();
    });

    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('expires stale drafts past the ttl window', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        values: { address: '0xstale' },
        savedAt: Date.now() - TTL - 1000,
      })
    );

    const { result } = renderHook(() =>
      useDraftPersistence({ key: KEY, values: { address: '' }, ttl: TTL })
    );

    expect(result.current.restored).toBe(false);
    expect(result.current.draft).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
