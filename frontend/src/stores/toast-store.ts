/**
 * Toast Store - Zustand store for toast notifications
 */

import { create } from 'zustand';

export interface Toast {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: string;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newToast: Toast = {
      ...toast,
      id,
      duration: toast.duration ?? 5000,
    };
    
    set((state) => ({
      toasts: [...state.toasts, newToast],
    }));
    
    // Auto-remove after duration
    if (newToast.duration && newToast.duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, newToast.duration);
    }
    
    return id;
  },
  
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
  
  clearToasts: () => {
    set({ toasts: [] });
  },
}));

// Convenience functions
export const toast = {
  info: (title: string, description?: string) =>
    useToastStore.getState().addToast({ type: 'info', title, description }),
  
  success: (title: string, description?: string) =>
    useToastStore.getState().addToast({ type: 'success', title, description }),
  
  warning: (title: string, description?: string) =>
    useToastStore.getState().addToast({ type: 'warning', title, description }),
  
  error: (title: string, description?: string) =>
    useToastStore.getState().addToast({ type: 'error', title, description }),
};
