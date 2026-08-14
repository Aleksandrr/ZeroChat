/**
 * ImageGalleryContext - Global image gallery for the chat
 * Manages viewing of multiple images across all messages with navigation and zoom
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { Attachment } from '@/types';

interface ImageGalleryState {
  isOpen: boolean;
  images: Attachment[]; // All images in the current chat
  currentIndex: number;
  zoomLevel: number;
}

interface ImageGalleryContextType extends ImageGalleryState {
  openGallery: (images: Attachment[], startIndex: number) => void;
  closeGallery: () => void;
  goToNext: () => void;
  goToPrev: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  setZoomLevel: (level: number) => void;
}

const ImageGalleryContext = createContext<ImageGalleryContextType | null>(null);

export function ImageGalleryProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ImageGalleryState>({
    isOpen: false,
    images: [],
    currentIndex: 0,
    zoomLevel: 1,
  });

  const openGallery = useCallback((images: Attachment[], startIndex: number) => {
    setState({
      isOpen: true,
      images,
      currentIndex: startIndex,
      zoomLevel: 1,
    });
  }, []);

  const closeGallery = useCallback(() => {
    setState(prev => ({ ...prev, isOpen: false }));
  }, []);

  const goToNext = useCallback(() => {
    setState(prev => ({
      ...prev,
      currentIndex: Math.min(prev.currentIndex + 1, prev.images.length - 1),
    }));
  }, []);

  const goToPrev = useCallback(() => {
    setState(prev => ({
      ...prev,
      currentIndex: Math.max(prev.currentIndex - 1, 0),
    }));
  }, []);

  const zoomIn = useCallback(() => {
    setState(prev => ({ ...prev, zoomLevel: Math.min(prev.zoomLevel + 0.5, 5) }));
  }, []);

  const zoomOut = useCallback(() => {
    setState(prev => ({ ...prev, zoomLevel: Math.max(prev.zoomLevel - 0.5, 0.5) }));
  }, []);

  const resetZoom = useCallback(() => {
    setState(prev => ({ ...prev, zoomLevel: 1 }));
  }, []);

  const setZoomLevel = useCallback((level: number) => {
    setState(prev => ({ ...prev, zoomLevel: Math.max(0.5, Math.min(level, 5)) }));
  }, []);

  const value = useMemo<ImageGalleryContextType>(() => ({
    ...state,
    openGallery,
    closeGallery,
    goToNext,
    goToPrev,
    zoomIn,
    zoomOut,
    resetZoom,
    setZoomLevel,
  }), [state, openGallery, closeGallery, goToNext, goToPrev, zoomIn, zoomOut, resetZoom, setZoomLevel]);

  return (
    <ImageGalleryContext.Provider value={value}>
      {children}
    </ImageGalleryContext.Provider>
  );
}

export function useImageGallery() {
  const context = useContext(ImageGalleryContext);
  if (!context) {
    throw new Error('useImageGallery must be used within ImageGalleryProvider');
  }
  return context;
}
