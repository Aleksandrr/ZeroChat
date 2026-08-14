import * as React from "react"
import ReactDOM from "react-dom"

import { cn } from "@/lib/utils"

// Context Menu Context
interface ContextMenuState {
  open: boolean;
  position: { x: number; y: number } | null;
  setOpen: (open: boolean) => void;
  setPosition: (pos: { x: number; y: number } | null) => void;
}

const ContextMenuStateContext = React.createContext<ContextMenuState>({
  open: false,
  position: null,
  setOpen: () => {},
  setPosition: () => {},
});

// Helper function to separate trigger from content children
function extractContextMenuChildren(children: React.ReactNode) {
  const result: { trigger: React.ReactNode; content: React.ReactNode[] } = {
    trigger: null,
    content: []
  };

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    
    if (child.type === ContextMenuTrigger) {
      result.trigger = child;
    } else if (child.type === ContextMenuContent) {
      result.content.push(child);
    }
  });

  return result;
}

// Main Context Menu Component
interface ContextMenuRootProps {
  children: React.ReactNode;
}

export function ContextMenu({ children }: ContextMenuRootProps) {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);
  
  const { trigger, content } = React.useMemo(
    () => extractContextMenuChildren(children),
    [children]
  );

  // Закрытие всех меню при открытии нового
  React.useEffect(() => {
    const handleCloseAll = () => {
      if (open) {
        setOpen(false);
        setPosition(null);
      }
    };
    window.addEventListener('contextmenu:close-all', handleCloseAll);
    return () => {
      window.removeEventListener('contextmenu:close-all', handleCloseAll);
    };
  }, [open, setOpen, setPosition]);

  return (
    <ContextMenuStateContext.Provider value={{ open, position, setOpen, setPosition }}>
      {trigger}
      {open && position && content.map((child, index) => (
        <ContextMenuContentWrapper key={index} position={position}>
          {child}
        </ContextMenuContentWrapper>
      ))}
    </ContextMenuStateContext.Provider>
  );
}

interface ContextMenuContentWrapperProps {
  children: React.ReactNode;
  position: { x: number; y: number };
}

function ContextMenuContentWrapper({ children, position }: ContextMenuContentWrapperProps) {
  const { setOpen, setPosition } = React.useContext(ContextMenuStateContext);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const isOpening = React.useRef(false); // Начинаем как false
  const [dimensions, setDimensions] = React.useState<{ width: number; height: number } | null>(null);

  // Сбрасываем флаг открытия при каждом рендере компонента
  React.useEffect(() => {
    isOpening.current = true;
    const timer = setTimeout(() => {
      isOpening.current = false;
    }, 0);
    return () => clearTimeout(timer);
  });

  // Измеряем размеры меню после рендера
  React.useEffect(() => {
    if (contentRef.current) {
      const { width, height } = contentRef.current.getBoundingClientRect();
      setDimensions({ width, height });
    }
  }, [children]);

  // Handle click to close - закрываем меню при любом клике (кроме первого после открытия)
  React.useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // Игнорируем первый клик после открытия (сам клик, который открыл меню)
      if (isOpening.current) {
        return;
      }
      // Закрываем меню при любом клике
      setOpen(false);
      setPosition(null);
    };

    const handleContextMenu = (e: MouseEvent) => {
      // Закрываем все меню при новом контекстном клике
      setOpen(false);
      setPosition(null);
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('contextmenu', handleContextMenu);

    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [setOpen, setPosition]);

  // Calculate position with smart flipping - меню примыкает к курсору и меняет направление если не хватает места
  const adjustedPosition = React.useMemo(() => {
    // Если размеры еще не измерены, возвращаем исходную позицию
    if (!dimensions) return position;

    const { width, height } = dimensions;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let { x, y } = position;

    // Определяем, нужно ли перевернуть направление раскрытия
    // Меню раскрывается вправо-вниз от курсора (курсор - левый верхний угол меню)
    // Если не хватает места справа, открываем слева от курсора (правый край меню у курсора)
    // Если не хватает места снизу, открываем сверху от курсора (нижний край меню у курсора)
    const shouldFlipX = x + width > viewportWidth;
    const shouldFlipY = y + height > viewportHeight;

    // Вычисляем позицию - меню примыкает к курсору без отступа
    let finalX = shouldFlipX ? x - width : x;
    let finalY = shouldFlipY ? y - height : y;

    // Убеждаемся, что не вышли за левую/верхнюю границу
    finalX = Math.max(5, finalX);
    finalY = Math.max(5, finalY);

    return { x: finalX, y: finalY };
  }, [position, dimensions]);

  const menu = (
    <div
      ref={contentRef}
      className="fixed z-50 min-w-max overflow-hidden rounded-md animate-in fade-in zoom-in-95"
      style={{
        top: adjustedPosition.y,
        left: adjustedPosition.x,
        transformOrigin: 'top left'
      }}
    >
      <div className="p-1">
        {children}
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return null;
  }

  return ReactDOM.createPortal(menu, document.body);
}

interface ContextMenuContentProps {
  children: React.ReactNode;
  className?: string;
}

export function ContextMenuContent({ children, className }: ContextMenuContentProps) {
  return (
    <div className={cn('', className)}>
      {children}
    </div>
  );
}

interface ContextMenuTriggerProps {
  children: React.ReactNode;
  className?: string;
}

export const ContextMenuTrigger = React.forwardRef<HTMLDivElement, ContextMenuTriggerProps>(
  ({ children, className, ...props }, ref) => {
    const { setOpen, setPosition } = React.useContext(ContextMenuStateContext);
    
    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation(); // Останавливаем всплытие, чтобы обработчик на document не сработал
      // Закрыть все другие меню
      window.dispatchEvent(new Event('contextmenu:close-all'));
      setPosition({ x: e.clientX, y: e.clientY });
      setOpen(true);
    };

    return (
      <div
        ref={ref}
        className={cn("inline-block w-full", className)}
        {...props}
        onContextMenu={handleContextMenu}
      >
        {children}
      </div>
    );
  }
);
ContextMenuTrigger.displayName = "ContextMenuTrigger";

interface ContextMenuItemProps extends React.HTMLAttributes<HTMLDivElement> {
  inset?: boolean;
}

export const ContextMenuItem = React.forwardRef<HTMLDivElement, ContextMenuItemProps>(
  ({ className, inset, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          inset && "pl-8",
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
ContextMenuItem.displayName = "ContextMenuItem";

export const ContextMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("my-1 h-px bg-border", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = "ContextMenuSeparator";
