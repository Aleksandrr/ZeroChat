/**
 * DragDropOverlay - Telegram-like drag & drop overlay for file uploads
 * Shows drop zones based on file types when dragging files over chat area
 */

import {
  File,
  Image,
  Music,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { useCallback, useMemo } from 'react';

import type { SendMode } from '@/lib/media';
import { cn } from '@/lib/utils';

interface DragDropOverlayProps {
  /** Whether overlay is visible */
  visible: boolean;
  /** MIME types of dragged files (for zone detection during dragover) */
  fileTypes: string[];
  /** Callback when file is dropped on a zone */
  onZoneDrop: (files: File[], mode: SendMode) => void;
  /** Callback when dropped on background (outside zones) */
  onBackgroundDrop?: () => void;
  /** Additional className */
  className?: string;
}

/**
 * Analyze file MIME types to determine available drop zones
 */
function analyzeFileTypes(fileTypes: string[]): {
  hasImages: boolean;
  hasVideos: boolean;
  hasAudio: boolean;
  hasOther: boolean;
  isMixed: boolean;
} {
  if (fileTypes.length === 0) {
    return { hasImages: false, hasVideos: false, hasAudio: false, hasOther: false, isMixed: false };
  }

  let hasImages = false;
  let hasVideos = false;
  let hasAudio = false;
  let hasOther = false;

  for (const type of fileTypes) {
    if (type.startsWith('image/')) {
      hasImages = true;
    } else if (type.startsWith('video/')) {
      hasVideos = true;
    } else if (type.startsWith('audio/')) {
      hasAudio = true;
    } else {
      hasOther = true;
    }
  }

  const typeCount = [hasImages, hasVideos, hasAudio, hasOther].filter(Boolean).length;
  const isMixed = typeCount > 1;

  return { hasImages, hasVideos, hasAudio, hasOther, isMixed };
}

/**
 * Get available zones based on file analysis
 */
function getZones(
  analysis: ReturnType<typeof analyzeFileTypes>
): { mode: SendMode; icon: React.ElementType; label: string; description: string }[] {
  const zones: { mode: SendMode; icon: React.ElementType; label: string; description: string }[] = [];

  // If mixed types, only show "file" zone
  if (analysis.isMixed) {
    zones.push({
      mode: 'file',
      icon: File,
      label: 'Файл',
      description: 'Отправить как файл',
    });
    return zones;
  }

  // Single type files - show appropriate zones
  if (analysis.hasImages) {
    zones.push(
      {
        mode: 'photo',
        icon: Image,
        label: 'Изображение',
        description: 'Сжать и отправить как фото',
      },
      {
        mode: 'file',
        icon: File,
        label: 'Файл',
        description: 'Отправить без сжатия',
      }
    );
  } else if (analysis.hasVideos) {
    zones.push(
      {
        mode: 'video',
        icon: Video,
        label: 'Видео',
        description: 'Сжать и отправить как видео',
      },
      {
        mode: 'file',
        icon: File,
        label: 'Файл',
        description: 'Отправить без сжатия',
      }
    );
  } else if (analysis.hasAudio) {
    zones.push({
      mode: 'audio',
      icon: Music,
      label: 'Аудио',
      description: 'Конвертировать в MP3',
    });
  } else if (analysis.hasOther) {
    zones.push({
      mode: 'file',
      icon: File,
      label: 'Файл',
      description: 'Отправить как есть',
    });
  }

  return zones;
}

/**
 * DragDropOverlay component
 */
export function DragDropOverlay({
  visible,
  fileTypes,
  onZoneDrop,
  onBackgroundDrop,
  className,
}: DragDropOverlayProps) {
 // Analyze file types to determine zones
 const analysis = useMemo(() => analyzeFileTypes(fileTypes), [fileTypes]);
 const zones = useMemo(() => getZones(analysis), [analysis]);

  // Unified drop handler - handles both zone drops and background drops
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Check if drop target is a zone (by data-mode attribute)
      const target = e.target as HTMLElement;
      const zoneElement = target.closest('[data-mode]') as HTMLElement | null;
      
      if (zoneElement) {
        const mode = zoneElement.dataset.mode as SendMode;
        
        // Extract files from dataTransfer (available during drop)
        const dataTransfer = e.dataTransfer;
        const droppedFiles: File[] = [];
        
        if (dataTransfer && dataTransfer.files) {
          // Prefer dataTransfer.files (available during drop event)
          droppedFiles.push(...Array.from(dataTransfer.files));
        } else if (dataTransfer && dataTransfer.items) {
          // Fallback to items (should also work during drop)
          for (let i = 0; i < dataTransfer.items.length; i++) {
            const item = dataTransfer.items[i];
            if (item && item.kind === 'file') {
              const file = item.getAsFile();
              if (file) {
                droppedFiles.push(file);
              }
            }
          }
        }
        
        if (droppedFiles.length > 0) {
          onZoneDrop(droppedFiles, mode);
        }
      } else {
        // Background drop (outside zones)
        onBackgroundDrop?.();
      }
    },
    [onZoneDrop, onBackgroundDrop]
  );

  if (!visible) {
    return null;
  }

  return (
    <div
      className={cn(
        'absolute inset-0 z-50 flex flex-col items-center justify-center',
        'bg-background/95 backdrop-blur-sm',
        'border-2 border-dashed border-primary rounded-lg',
        'transition-opacity duration-200',
        className
      )}
      onDrop={handleDrop}
    >
      {/* Title */}
      <div className="flex items-center gap-2 mb-6">
        <Upload className="h-6 w-6 text-primary" />
        <span className="text-lg font-semibold">
          Отправить {fileTypes.length > 1 ? `${fileTypes.length} файлов` : 'файл'}
        </span>
      </div>

      {/* Drop zones - vertical layout */}
      <div className="flex flex-col w-full max-w-xs gap-3 md:max-w-md md:gap-4 lg:max-w-2xl">
        {zones.map((zone) => {
          const Icon = zone.icon;
          return (
            <div
              key={zone.mode}
              data-mode={zone.mode}
              className={cn(
                'flex flex-col items-center gap-2 p-4 md:p-8 lg:p-12 rounded-lg',
                'bg-accent/50 border-2 border-transparent',
                'hover:bg-accent hover:border-primary',
                'cursor-pointer transition-all duration-200',
                'active:scale-95'
              )}
            >
              <Icon className="h-8 w-8 md:h-12 md:w-12 lg:h-16 lg:w-16 text-primary" />
              <div className="text-center">
                <div className="font-medium text-sm md:text-base lg:text-lg">{zone.label}</div>
                <div className="text-xs md:text-sm text-muted-foreground">{zone.description}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Cancel hint */}
      <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
        <X className="h-4 w-4" />
        <span>Отмена - дропните вне зон</span>
      </div>
    </div>
  );
}
