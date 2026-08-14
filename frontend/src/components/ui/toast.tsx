/**
 * Toast Component
 * 
 * Displays toast notifications in the UI.
 * Should be rendered at the root of the application.
 */

import { AlertCircle, AlertTriangle, CheckCircle2, Info,X } from 'lucide-react';
import { useEffect } from 'react';

import { type Toast as ToastType,useToastStore } from '@/stores/toast-store';

interface ToastItemProps {
  toast: ToastType;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  useEffect(() => {
    if (toast.duration && toast.duration > 0) {
      const timer = setTimeout(() => {
        onDismiss(toast.id);
      }, toast.duration);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [toast.id, toast.duration, onDismiss]);

  const icons = {
    info: <Info className="h-5 w-5 text-blue-500" />,
    success: <CheckCircle2 className="h-5 w-5 text-green-500" />,
    warning: <AlertTriangle className="h-5 w-5 text-yellow-500" />,
    error: <AlertCircle className="h-5 w-5 text-red-500" />,
  };

  const bgColors = {
    info: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    success: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',
    warning: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
    error: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
  };

  return (
    <div
      className={`
        flex items-start gap-3 p-4 rounded-lg border shadow-lg
        animate-in slide-in-from-right-full fade-in duration-200
        ${bgColors[toast.type]}
        max-w-sm w-full
      `}
    >
      {icons[toast.type]}
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-foreground">{toast.title}</p>
        {toast.description && (
          <p className="text-sm text-muted-foreground mt-0.5">{toast.description}</p>
        )}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
      >
        <X className="h-4 w-4 text-muted-foreground" />
      </button>
    </div>
  );
}

interface ToastContainerProps {
  className?: string;
}

/**
 * Toast container - place this at the root of your app
 */
export function ToastContainer({ className = '' }: ToastContainerProps) {
  const toasts = useToastStore((state) => state.toasts);
  const removeToast = useToastStore((state) => state.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className={`
        fixed bottom-4 right-4 z-[100] flex flex-col gap-2
        ${className}
      `}
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={removeToast}
        />
      ))}
    </div>
  );
}

export type { Toast } from '@/stores/toast-store';
export { toast } from '@/stores/toast-store';
