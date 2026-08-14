/**
 * GalleryViewer - Full-screen image gallery with navigation and zoom
 * Displays all images from the current chat, not just a single message
 *
 * Исправления:
 * 1. Корректное преобразование координат для double tap (увеличение в точке касания)
 * 2. Плавный pinch-to-zoom с сохранением точки под пальцами
 * 3. Масштаб сбрасывается при перелистывании
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Download, Maximize, Minimize, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
} from '@/components/ui/dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useImageGallery } from '@/contexts/ImageGalleryContext';
import { fileLogger } from '@/lib/utils/file-logger';

// Константы для жестов
const DOUBLE_TAP_DELAY = 300; // мс
const DOUBLE_TAP_SCALE = 3; // целевой масштаб при двойном тапе
const SWIPE_THRESHOLD = 50; // минимальное расстояние для свайпа
const PINCH_THRESHOLD = 5; // минимальное изменение расстояния для срабатывания pinch
const WHEEL_ZOOM_SENSITIVITY = 0.005; // чувствительность колесика
const PINCH_ZOOM_SENSITIVITY = 0.01; // чувствительность pinch

export function GalleryViewer() {
  const {
    isOpen,
    images,
    currentIndex,
    zoomLevel,
    closeGallery,
    goToNext,
    goToPrev,
    zoomIn,
    zoomOut,
    resetZoom,
    setZoomLevel,
  } = useImageGallery();

  const currentImage = images[currentIndex];
  const hasMultiple = images.length > 1;
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < images.length - 1;

  // Состояние для панорамирования
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Состояние для touch-жестов
  const [isTouchPanning, setIsTouchPanning] = useState(false);
  const touchPanStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchPanStartPosRef = useRef<{ x: number; y: number } | null>(null);

  // Для распознавания двойного тапа
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);

  // Для pinch-жеста - исправлено: храним точку на изображении, а не midpoint
  const pinchStateRef = useRef<{
    initialDistance: number | null;
    initialZoom: number;
    initialPan: { x: number; y: number };
    imagePoint: { x: number; y: number } | null; // точка на изображении, которая должна оставаться под пальцами
  }>({
    initialDistance: null,
    initialZoom: 1,
    initialPan: { x: 0, y: 0 },
    imagePoint: null,
  });

  // Для свайпа
  const touchStartRef = useRef<{
    x1: number; y1: number;
    x2: number | null; y2: number | null;
    time: number
  } | null>(null);

  // Сброс масштаба и панорамирования при смене изображения
  useEffect(() => {
    resetZoom();
    setPan({ x: 0, y: 0 });
  }, [currentIndex, resetZoom]);

  // Сброс панорамирования при зуме 1x
  useEffect(() => {
    if (zoomLevel === 1) {
      setPan({ x: 0, y: 0 });
    }
  }, [zoomLevel]);

  // Фокус на контейнере при открытии
  useEffect(() => {
    if (isOpen && containerRef.current) {
      containerRef.current.focus();
    }
  }, [isOpen]);

  // Глобальный обработчик колесика мыши с плавным масштабированием
  useEffect(() => {
    if (!isOpen) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      if (e.ctrlKey) {
        // Плавное масштабирование с Ctrl
        const delta = -e.deltaY * WHEEL_ZOOM_SENSITIVITY;
        const newZoom = Math.max(0.5, Math.min(5, zoomLevel + delta));
        setZoomLevel(newZoom);
      } else {
        // Навигация свайпом колесика
        if (e.deltaX < 0 || e.deltaY < 0) {
          if (canGoPrev) goToPrev();
        } else if (e.deltaX > 0 || e.deltaY > 0) {
          if (canGoNext) goToNext();
        }
      }
    };

    document.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      document.removeEventListener('wheel', handleWheel);
    };
  }, [isOpen, canGoPrev, canGoNext, goToPrev, goToNext, zoomLevel, setZoomLevel]);

  // Обработчик клавиатуры
  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      closeGallery();
    } else if (e.key === 'ArrowLeft' && canGoPrev) {
      e.preventDefault();
      goToPrev();
    } else if (e.key === 'ArrowRight' && canGoNext) {
      e.preventDefault();
      goToNext();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomIn();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      resetZoom();
    }
  };

  // Скачивание изображения
  const handleDownload = () => {
    if (!currentImage?.data) return;
    const url = `data:${currentImage.mimeType};base64,${currentImage.data}`;
    if (url) {
      fileLogger.logDownloadStart(currentImage.id, currentImage.fileName, currentImage.size);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentImage.fileName;
      a.click();
      fileLogger.logDownloadComplete(currentImage.id, currentImage.fileName, 0);
    }
  };

  // === Обработчики для мыши (панорамирование) ===
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoomLevel <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    panStartRef.current = { x: pan.x, y: pan.y };
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !dragStartRef.current || !panStartRef.current) return;

    const deltaX = e.clientX - dragStartRef.current.x;
    const deltaY = e.clientY - dragStartRef.current.y;

    setPan({
      x: panStartRef.current.x + deltaX,
      y: panStartRef.current.y + deltaY,
    });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current = null;
    panStartRef.current = null;
  }, []);

  // Глобальные слушатели для мыши
  useEffect(() => {
    if (!isDragging) return;

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // === Утилиты для преобразования координат (ИСПРАВЛЕНО) ===
  /**
   * Преобразует экранные координаты в координаты изображения
   * относительно левого верхнего угла (0,0) трансформации
   */
  const getImagePointFromClientPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    if (!imageRef.current) return null;
    const rect = imageRef.current.getBoundingClientRect();
    
    // Координаты внутри элемента изображения (0..width, 0..height)
    const elementX = clientX - rect.left;
    const elementY = clientY - rect.top;
    
    // Преобразуем в координаты изображения с учётом текущего масштаба и pan
    // Важно: точка (0,0) трансформации — это левый верхний угол
    const imageX = (elementX - pan.x) / zoomLevel;
    const imageY = (elementY - pan.y) / zoomLevel;
    
    return { x: imageX, y: imageY };
  };

  /**
   * Устанавливает новый масштаб так, чтобы точка изображения imagePoint
   * осталась под экранными координатами clientX, clientY
   */
  const setZoomAtPoint = (newZoom: number, clientX: number, clientY: number, fixedImagePoint?: { x: number; y: number }) => {
    // Если не передана фиксированная точка, вычисляем текущую
    const imagePoint = fixedImagePoint || getImagePointFromClientPoint(clientX, clientY);
    if (!imagePoint) return;

    // Вычисляем новый pan так, чтобы точка изображения осталась под пальцем
    // Формула: clientXY = imageX * newZoom + newPanX
    // Отсюда: newPanX = clientX - imageX * newZoom
    const newPanX = clientX - imagePoint.x * newZoom;
    const newPanY = clientY - imagePoint.y * newZoom;

    setZoomLevel(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  // === Обработчики touch-событий ===
  const handleTouchStart = (e: React.TouchEvent) => {
    const touches = e.touches;

    if (touches.length === 1) {
      const touch = touches[0];
      if (!touch) return;

      const now = Date.now();
      const { clientX, clientY } = touch;

      // Проверка на двойной тап
      if (lastTapRef.current) {
        const { time, x, y } = lastTapRef.current;
        const timeDiff = now - time;
        const distance = Math.hypot(clientX - x, clientY - y);

        if (timeDiff < DOUBLE_TAP_DELAY && distance < 30) {
          e.preventDefault();
          // Toggle между 1x и DOUBLE_TAP_SCALE с зумом в точку касания
          if (Math.abs(zoomLevel - 1) < 0.1) {
            setZoomAtPoint(DOUBLE_TAP_SCALE, clientX, clientY);
          } else {
            resetZoom();
          }
          lastTapRef.current = null;
          return;
        }
      }

      lastTapRef.current = { time: now, x: clientX, y: clientY };

      touchStartRef.current = {
        x1: clientX,
        y1: clientY,
        x2: null,
        y2: null,
        time: now
      };

      if (zoomLevel > 1) {
        e.preventDefault();
        setIsTouchPanning(true);
        touchPanStartRef.current = { x: clientX, y: clientY };
        touchPanStartPosRef.current = { x: pan.x, y: pan.y };
      }
    } else if (touches.length === 2) {
      const touch1 = touches[0];
      const touch2 = touches[1];
      if (!touch1 || !touch2) return;

      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );

      // Вычисляем точку между пальцами (центр жеста)
      const midPoint = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };

      // Находим точку на изображении, соответствующую центру между пальцами
      const imagePoint = getImagePointFromClientPoint(midPoint.x, midPoint.y);

      pinchStateRef.current = {
        initialDistance: distance,
        initialZoom: zoomLevel,
        initialPan: { x: pan.x, y: pan.y },
        imagePoint: imagePoint, // фиксируем точку на весь жест
      };

      touchStartRef.current = {
        x1: touch1.clientX,
        y1: touch1.clientY,
        x2: touch2.clientX,
        y2: touch2.clientY,
        time: Date.now()
      };

      lastTapRef.current = null;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touches = e.touches;

    if (touches.length === 1 && isTouchPanning && touchPanStartRef.current && touchPanStartPosRef.current) {
      e.preventDefault();
      const touch = touches[0];
      if (!touch) return;
      const deltaX = touch.clientX - touchPanStartRef.current.x;
      const deltaY = touch.clientY - touchPanStartRef.current.y;
      setPan({
        x: touchPanStartPosRef.current.x + deltaX,
        y: touchPanStartPosRef.current.y + deltaY,
      });
    } else if (touches.length === 2 && pinchStateRef.current.initialDistance !== null && pinchStateRef.current.imagePoint) {
      e.preventDefault();

      const touch1 = touches[0];
      const touch2 = touches[1];
      if (!touch1 || !touch2) return;

      const currentDistance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );

      const delta = currentDistance - pinchStateRef.current.initialDistance;

      if (Math.abs(delta) > PINCH_THRESHOLD) {
        // Вычисляем новый масштаб относительно начального
        const scaleFactor = 1 + delta * PINCH_ZOOM_SENSITIVITY;
        let newZoom = pinchStateRef.current.initialZoom * scaleFactor;
        newZoom = Math.max(0.5, Math.min(5, newZoom));

        // Вычисляем новый центр между пальцами
        const midPoint = {
          x: (touch1.clientX + touch2.clientX) / 2,
          y: (touch1.clientY + touch2.clientY) / 2,
        };

        // Используем фиксированную точку на изображении для вычисления нового pan
        // Формула: midPoint = imagePoint * newZoom + newPan
        // Отсюда: newPan = midPoint - imagePoint * newZoom
        const newPanX = midPoint.x - pinchStateRef.current.imagePoint.x * newZoom;
        const newPanY = midPoint.y - pinchStateRef.current.imagePoint.y * newZoom;

        setPan({ x: newPanX, y: newPanY });
        setZoomLevel(newZoom);
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const touches = e.touches;

    if (touches.length === 0 && touchStartRef.current) {
      if (!isTouchPanning) {
        const startX = touchStartRef.current.x1;
        const startY = touchStartRef.current.y1;
        const changedTouch = e.changedTouches[0];

        if (changedTouch) {
          const endX = changedTouch.clientX;
          const endY = changedTouch.clientY;
          const deltaX = endX - startX;
          const deltaY = endY - startY;
          const deltaTime = Date.now() - touchStartRef.current.time;

          if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > SWIPE_THRESHOLD && deltaTime < 500) {
            if (deltaX < 0 && canGoNext) {
              goToNext();
            } else if (deltaX > 0 && canGoPrev) {
              goToPrev();
            }
          }
        }
      }

      touchStartRef.current = null;
      setIsTouchPanning(false);
      touchPanStartRef.current = null;
      touchPanStartPosRef.current = null;
    }

    if (touches.length < 2) {
      pinchStateRef.current.initialDistance = null;
      pinchStateRef.current.imagePoint = null;
    }
  };

  // URL изображения
  const imageUrl = currentImage?.data
    ? `data:${currentImage.mimeType};base64,${currentImage.data}`
    : null;

  if (!isOpen || !currentImage || !imageUrl) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={closeGallery}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 bg-black/90" />
        <DialogPrimitive.Content
          ref={containerRef}
          className="fixed inset-0 flex items-center justify-center bg-transparent border-none shadow-none p-0 z-50 outline-none"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          <DialogPrimitive.Title>
            <VisuallyHidden>Image Gallery</VisuallyHidden>
          </DialogPrimitive.Title>
          <DialogPrimitive.Description>
            <VisuallyHidden>Full-screen image viewer with navigation and zoom controls</VisuallyHidden>
          </DialogPrimitive.Description>

          {/* Изображение с поддержкой жестов */}
          <img
            ref={imageRef}
            src={imageUrl}
            alt={currentImage.fileName}
            className="object-contain cursor-grab active:cursor-grabbing transition-transform duration-200 ease-out touch-none"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoomLevel})`,
            }}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            draggable={false}
          />

          {/* Кнопка закрытия */}
          <button
            onClick={closeGallery}
            className="fixed top-4 right-4 z-50 p-2 rounded-full bg-white/95 hover:bg-white text-black transition-all duration-200 shadow-lg focus:outline-none focus:ring-2 focus:ring-white/50"
            aria-label="Закрыть"
          >
            <X className="h-5 w-5" />
          </button>

          {/* Навигационные кнопки */}
          {hasMultiple && (
            <>
              <button
                onClick={goToPrev}
                disabled={!canGoPrev}
                className="fixed left-4 top-1/2 -translate-y-1/2 z-50 p-3 rounded-full bg-white/90 hover:bg-white text-black transition-all duration-200 shadow-lg disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-white/50"
                aria-label="Предыдущее изображение"
              >
                <ChevronLeft className="h-8 w-8" />
              </button>
              <button
                onClick={goToNext}
                disabled={!canGoNext}
                className="fixed right-4 top-1/2 -translate-y-1/2 z-50 p-3 rounded-full bg-white/90 hover:bg-white text-black transition-all duration-200 shadow-lg disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-white/50"
                aria-label="Следующее изображение"
              >
                <ChevronRight className="h-8 w-8" />
              </button>
            </>
          )}

          {/* Панель управления */}
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 p-2 rounded-lg bg-white/95 shadow-lg">
            <Button
              variant="ghost"
              size="icon"
              onClick={zoomOut}
              disabled={zoomLevel <= 0.5}
              className="h-9 w-9 bg-transparent hover:bg-black/10 text-black disabled:opacity-30"
              aria-label="Уменьшить"
            >
              <Minimize className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium text-black min-w-[60px] text-center">
              {Math.round(zoomLevel * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={zoomIn}
              disabled={zoomLevel >= 5}
              className="h-9 w-9 bg-transparent hover:bg-black/10 text-black disabled:opacity-30"
              aria-label="Увеличить"
            >
              <Maximize className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={resetZoom}
              disabled={zoomLevel === 1}
              className="h-9 w-9 bg-transparent hover:bg-black/10 text-black disabled:opacity-30"
              aria-label="Сбросить zoom"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleDownload}
              className="h-9 w-9 bg-transparent hover:bg-black/10 text-black"
              aria-label="Скачать"
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>

          {/* Счетчик изображений */}
          {hasMultiple && (
            <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-full bg-black/60 text-white text-sm font-medium">
              {currentIndex + 1} / {images.length}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}