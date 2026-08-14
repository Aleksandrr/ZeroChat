/**
 * MobileFolderTabs unit tests.
 *
 * Covers:
 *   1. Component render: returns null when folders.length === 0
 *      (so mobile layout doesn't waste vertical space on fresh installs).
 *   2. Component render: renders "Все" + per-folder tabs when folders exist.
 *   3. computeFolderSwipe: swipe right → previous tab (or "Все" if on a folder)
 *   4. computeFolderSwipe: swipe left → next tab (or no-op if on last)
 *   5. computeFolderSwipe: vertical-dominant gesture → no-op (no tab flip
 *      while scrolling the chat list)
 *
 * The component loads folders via `getAllFolders()` from IndexedDB; we mock
 * that module to control the folder list per-test. The store
 * (`useFolderStore`) is mocked with an in-memory implementation so tests
 * don't touch localStorage.
 *
 * NOTE: @testing-library/react is unavailable in this sandbox (its peer
 * dep @testing-library/dom is not installed), so the render tests use
 * `react-dom/client` directly with a manual `act()` + microtask flush.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

// --- Mocks --------------------------------------------------------------

// Mock the IndexedDB-backed `getAllFolders` BEFORE importing the component.
let _mockFolders: any[] = [];
const mockGetAllFolders = vi.fn(async () => _mockFolders);
vi.mock('@/lib/messages/db', () => ({
  getAllFolders: () => mockGetAllFolders(),
}));

// Mock `useFolderStore` with an in-memory implementation so tests don't
// touch localStorage and can reset state cleanly between tests.
let _selectedFolderId: string | null = null;
const _selectFolderMock = vi.fn((id: string | null) => {
  _selectedFolderId = id;
});
vi.mock('@/stores/folder-store', () => ({
  useFolderStore: (selector: (s: any) => any) =>
    selector({
      selectedFolderId: _selectedFolderId,
      selectFolder: _selectFolderMock,
    }),
}));

// --- Imports (must run after vi.mock calls) -----------------------------

import {
  MobileFolderTabs,
  computeFolderSwipe,
  FOLDER_SWIPE_THRESHOLD,
} from '../MobileFolderTabs';
import type { StoredFolder } from '@/lib/messages/db';

// --- Helpers ------------------------------------------------------------

function makeFolder(overrides: Partial<StoredFolder> = {}): StoredFolder {
  return {
    id: overrides.id ?? 'folder-1',
    name: overrides.name ?? 'Folder 1',
    color: overrides.color ?? null,
    order: overrides.order ?? 0,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
  };
}

/** Mount <Component /> into a detached container, flush effects, return HTML. */
async function renderToHtml(component: React.ReactElement): Promise<{ container: HTMLElement; html: string }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  // Flush microtasks so the async getAllFolders() inside useEffect resolves.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, html: container.innerHTML };
}

function cleanupContainer(container: HTMLElement) {
  container.remove();
}

// --- Tests ---------------------------------------------------------------

describe('MobileFolderTabs — component render', () => {
  beforeEach(() => {
    _mockFolders = [];
    _selectedFolderId = null;
    _selectFolderMock.mockClear();
    mockGetAllFolders.mockClear();
    mockGetAllFolders.mockImplementation(async () => _mockFolders);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns null (empty HTML) when there are no folders', async () => {
    _mockFolders = [];
    const { container, html } = await renderToHtml(<MobileFolderTabs />);
    expect(html).toBe('');
    cleanupContainer(container);
  });

  it('renders "Все" + one tab per folder when folders exist', async () => {
    _mockFolders = [
      makeFolder({ id: 'f1', name: 'Work' }),
      makeFolder({ id: 'f2', name: 'Family', color: '#ff0000' }),
    ];
    const { container, html } = await renderToHtml(<MobileFolderTabs />);
    expect(html).toContain('Все');
    expect(html).toContain('Work');
    expect(html).toContain('Family');
    // 1 "Все" tab + 2 folder tabs = 3 buttons.
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(3);
    cleanupContainer(container);
  });

  it('renders a colored dot for folders with a color', async () => {
    _mockFolders = [makeFolder({ id: 'f1', name: 'Work', color: '#00ff00' })];
    const { container } = await renderToHtml(<MobileFolderTabs />);
    const dot = container.querySelector('span[style*="background-color"]');
    expect(dot).toBeTruthy();
    // jsdom normalises #00ff00 → rgb(0, 255, 0) when reading back `style`.
    const style = (dot as HTMLElement).getAttribute('style') || '';
    expect(style).toMatch(/(rgb\(0,\s*255,\s*0\)|#00ff00)/);
    cleanupContainer(container);
  });

  it('marks "Все" as aria-pressed=true when selectedFolderId is null', async () => {
    _mockFolders = [makeFolder({ id: 'f1', name: 'Work' })];
    _selectedFolderId = null;
    const { container } = await renderToHtml(<MobileFolderTabs />);
    const buttons = container.querySelectorAll('button');
    // First button is "Все".
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
    // Folder tab is NOT active.
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('false');
    cleanupContainer(container);
  });

  it('marks a folder tab as aria-pressed=true when selectedFolderId matches', async () => {
    _mockFolders = [makeFolder({ id: 'f1', name: 'Work' })];
    _selectedFolderId = 'f1';
    const { container } = await renderToHtml(<MobileFolderTabs />);
    const buttons = container.querySelectorAll('button');
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false'); // "Все"
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');  // Work
    cleanupContainer(container);
  });

  it('clicking a folder tab calls selectFolder with that folder id', async () => {
    _mockFolders = [makeFolder({ id: 'f1', name: 'Work' })];
    _selectedFolderId = null;
    const { container } = await renderToHtml(<MobileFolderTabs />);
    const buttons = container.querySelectorAll('button');
    const workTab = buttons[1]!;
    await act(async () => {
      workTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(_selectFolderMock).toHaveBeenCalledWith('f1');
    cleanupContainer(container);
  });

  it('clicking "Все" calls selectFolder(null)', async () => {
    _mockFolders = [makeFolder({ id: 'f1', name: 'Work' })];
    _selectedFolderId = 'f1';
    const { container } = await renderToHtml(<MobileFolderTabs />);
    const buttons = container.querySelectorAll('button');
    const allTab = buttons[0]!;
    await act(async () => {
      allTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(_selectFolderMock).toHaveBeenCalledWith(null);
    cleanupContainer(container);
  });

  it('reloads folders when zerochat:folders-updated fires', async () => {
    _mockFolders = [];
    const { container } = await renderToHtml(<MobileFolderTabs />);
    // Initially no tabs.
    expect(container.querySelectorAll('button').length).toBe(0);
    // Simulate a folder being created elsewhere.
    _mockFolders = [makeFolder({ id: 'f1', name: 'New' })];
    await act(async () => {
      window.dispatchEvent(new Event('zerochat:folders-updated'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Now the "New" tab should be rendered.
    expect(container.innerHTML).toContain('New');
    cleanupContainer(container);
  });
});

describe('computeFolderSwipe — pure helper (swipe right → previous tab)', () => {
  const folders: StoredFolder[] = [
    makeFolder({ id: 'f1', name: 'Work', order: 0 }),
    makeFolder({ id: 'f2', name: 'Family', order: 1 }),
    makeFolder({ id: 'f3', name: 'Friends', order: 2 }),
  ];

  it('swipe right from folder 1 → "Все" (null)', () => {
    // tabs: [null, f1, f2, f3], currentIdx=1, swipe right → tab 0 (null)
    const result = computeFolderSwipe(100, 5, folders, 'f1');
    expect(result).toBeNull();
  });

  it('swipe right from folder 2 → folder 1', () => {
    const result = computeFolderSwipe(100, 5, folders, 'f2');
    expect(result).toBe('f1');
  });

  it('swipe right from "Все" (null) → no-op (already at first)', () => {
    const result = computeFolderSwipe(100, 5, folders, null);
    expect(result).toBeUndefined();
  });

  it('swipe right from last folder → previous folder (not no-op)', () => {
    const result = computeFolderSwipe(100, 5, folders, 'f3');
    expect(result).toBe('f2');
  });
});

describe('computeFolderSwipe — pure helper (swipe left → next tab)', () => {
  const folders: StoredFolder[] = [
    makeFolder({ id: 'f1', name: 'Work', order: 0 }),
    makeFolder({ id: 'f2', name: 'Family', order: 1 }),
    makeFolder({ id: 'f3', name: 'Friends', order: 2 }),
  ];

  it('swipe left from "Все" (null) → folder 1', () => {
    const result = computeFolderSwipe(-100, 5, folders, null);
    expect(result).toBe('f1');
  });

  it('swipe left from folder 2 → folder 3', () => {
    const result = computeFolderSwipe(-100, 5, folders, 'f2');
    expect(result).toBe('f3');
  });

  it('swipe left from last folder → no-op (already at last)', () => {
    const result = computeFolderSwipe(-100, 5, folders, 'f3');
    expect(result).toBeUndefined();
  });

  it('swipe left from folder 1 → folder 2', () => {
    const result = computeFolderSwipe(-100, 5, folders, 'f1');
    expect(result).toBe('f2');
  });
});

describe('computeFolderSwipe — pure helper (vertical / no-op cases)', () => {
  const folders: StoredFolder[] = [
    makeFolder({ id: 'f1', name: 'Work', order: 0 }),
    makeFolder({ id: 'f2', name: 'Family', order: 1 }),
  ];

  it('vertical-dominant gesture → no-op (does NOT flip tabs while scrolling)', () => {
    // |dy| >> |dx| — clearly a vertical scroll, not a swipe.
    const result = computeFolderSwipe(20, 200, folders, 'f2');
    expect(result).toBeUndefined();
  });

  it('diagonal gesture where vertical dominates by >threshold → no-op', () => {
    // |dx|=70 (>60 threshold), |dy|=60. 70 < 60*1.5=90 → vertical dominates.
    const result = computeFolderSwipe(70, 60, folders, 'f2');
    expect(result).toBeUndefined();
  });

  it('horizontal movement below threshold → no-op (treat as tap)', () => {
    // |dx| < 60 — too small to be a swipe.
    const result = computeFolderSwipe(FOLDER_SWIPE_THRESHOLD - 1, 0, folders, 'f2');
    expect(result).toBeUndefined();
  });

  it('horizontal at exactly threshold → fires (>=, not >)', () => {
    // |dx| === 60 — boundary case. Current impl uses `<` so 60 passes.
    const result = computeFolderSwipe(FOLDER_SWIPE_THRESHOLD, 0, folders, 'f2');
    expect(result).toBe('f1');
  });

  it('unknown selectedFolderId → no-op (defensive)', () => {
    // selectedFolderId is not in the tabs list — return undefined.
    const result = computeFolderSwipe(-100, 5, folders, 'unknown-folder');
    expect(result).toBeUndefined();
  });

  it('empty folders list → swipe is no-op (single "Все" tab)', () => {
    // Even a clear horizontal swipe can't move past the only tab.
    const result = computeFolderSwipe(-100, 5, [], null);
    expect(result).toBeUndefined();
  });

  it('swipe with dx = 0 (no movement) → no-op', () => {
    expect(computeFolderSwipe(0, 0, folders, 'f1')).toBeUndefined();
  });

  it('exactly equal |dx| and |dy| → no-op (horizontal must dominate by 1.5×)', () => {
    // |dx| = 100, |dy| = 100. 100 < 100*1.5=150 → vertical dominates → no-op.
    expect(computeFolderSwipe(100, 100, folders, 'f1')).toBeUndefined();
  });
});

describe('computeFolderSwipe — pure function guarantees', () => {
  const folders: StoredFolder[] = [
    makeFolder({ id: 'f1', name: 'A', order: 0 }),
    makeFolder({ id: 'f2', name: 'B', order: 1 }),
  ];

  it('same inputs → same output (no side effects)', () => {
    const a = computeFolderSwipe(-100, 5, folders, 'f1');
    const b = computeFolderSwipe(-100, 5, folders, 'f1');
    expect(a).toBe(b);
  });

  it('does not mutate the folders array', () => {
    const originalLength = folders.length;
    const originalFirstId = folders[0]?.id;
    computeFolderSwipe(-100, 5, folders, 'f1');
    expect(folders.length).toBe(originalLength);
    expect(folders[0]?.id).toBe(originalFirstId);
  });
});
