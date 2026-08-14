/**
 * MobileFolderTabs — горизонтальные "pill" tabs сверху над ChatList.
 *
 * Mobile-only (caller gates with `useIsMobile()`). Если папок нет —
 * возвращает null (ничего не рендерит, не занимает место).
 *
 * Содержит:
 *   - "Все" таб (selectedFolderId = null)
 *   - Таб для каждой папки (имя + цветной dot если есть folder.color)
 *   - Горизонтальный скролл если табов много (scrollbar скрыт)
 *
 * Swipe-логика живёт в ChatList (props не принимает) — там swipe
 * по списку чатов переключает активный таб. Этот компонент только
 * отображает табы и обновляет useFolderStore.
 *
 * `computeFolderSwipe` — чистая функция-помощник для swipe-навигации,
 * экспортирована здесь чтобы ChatList и тесты могли ей пользоваться
 * без дублирования логики.
 */
import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';

import { useFolderStore } from '@/stores/folder-store';
import { getAllFolders, type StoredFolder } from '@/lib/messages/db';
import { cn } from '@/lib/utils';

/** Минимальная горизонтальная дистанция свайпа в px (ниже — тап/скролл). */
export const FOLDER_SWIPE_THRESHOLD = 60;
/** Насколько горизонтальный компонент должен доминировать над вертикальным. */
export const FOLDER_SWIPE_DOMINANCE = 1.5;

/**
 * Pure helper: по свайпу (dx, dy) и текущему списку табов/активному табу
 * вычисляет целевой folderId. Возвращает:
 *   - `null`     → переключиться на "Все" таб
 *   - `string`   → переключиться на конкретную папку
 *   - `undefined` → жест не распознан как горизонтальный swipe (no-op)
 *
 * Чистая функция — не трогает store, не имеет side-effects. Используется
 * как в ChatList (реальный swipe handler), так и в unit-тестах.
 */
export function computeFolderSwipe(
  dx: number,
  dy: number,
  folders: StoredFolder[],
  selectedFolderId: string | null,
): string | null | undefined {
  // Только если горизонтальный свайп доминирует (не вертикальный скролл).
  if (Math.abs(dx) < FOLDER_SWIPE_THRESHOLD) return undefined;
  if (Math.abs(dx) < Math.abs(dy) * FOLDER_SWIPE_DOMINANCE) return undefined;

  const allTabs: (string | null)[] = [null, ...folders.map((f) => f.id)];
  const currentIdx = allTabs.indexOf(selectedFolderId);
  if (currentIdx === -1) return undefined;

  if (dx > 0 && currentIdx > 0) {
    // Swipe right → previous tab. `currentIdx > 0` guarantees the slot
    // exists; the value can be `null` (the "Все" tab) or a folder id.
    const prev = allTabs[currentIdx - 1];
    if (prev !== undefined) return prev;
  }
  if (dx < 0 && currentIdx < allTabs.length - 1) {
    // Swipe left → next tab.
    const next = allTabs[currentIdx + 1];
    if (next !== undefined) return next;
  }
  return undefined;
}

export function MobileFolderTabs() {
  const [folders, setFolders] = useState<StoredFolder[]>([]);
  const selectedFolderId = useFolderStore((s) => s.selectedFolderId);
  const selectFolder = useFolderStore((s) => s.selectFolder);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await getAllFolders();
        if (!cancelled) setFolders(list);
      } catch (e) {
        console.error('[MobileFolderTabs] load failed:', e);
      }
    };
    void load();
    const handler = () => void load();
    window.addEventListener('zerochat:folders-updated', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('zerochat:folders-updated', handler);
    };
  }, []);

  // Если папок нет — не показываем ничего (mobile-first, save vertical space).
  if (folders.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1 px-2 py-2 overflow-x-auto border-b bg-background/95 backdrop-blur"
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
    >
      <FolderTab
        active={selectedFolderId === null}
        onClick={() => selectFolder(null)}
        icon={<MessageCircle className="h-3.5 w-3.5" />}
        label="Все"
      />
      {folders.map((folder) => (
        <FolderTab
          key={folder.id}
          active={selectedFolderId === folder.id}
          onClick={() => selectFolder(folder.id)}
          label={folder.name}
          color={folder.color ?? undefined}
        />
      ))}
    </div>
  );
}

interface FolderTabProps {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  color?: string;
}

function FolderTab({ active, onClick, label, icon, color }: FolderTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-accent'
      )}
    >
      {color && !icon && (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
      )}
      {icon}
      <span>{label}</span>
    </button>
  );
}

export default MobileFolderTabs;
