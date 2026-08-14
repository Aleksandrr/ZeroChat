import {
  Select,
  SelectContent,
  SelectGroup,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectLabel,
  SelectPortal,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "@radix-ui/react-select"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import type * as React from "react"

import { cn } from "@/lib/utils"

function SelectComponent({
  ...props
}: React.ComponentProps<typeof Select>) {
  return <Select data-slot="select" {...props} />
}

function SelectTriggerComponent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      data-slot="select-trigger"
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex h-9 w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
        className
      )}
      {...props}
    >
      <SelectValue data-slot="select-value" placeholder="Select an option" />
      <SelectIcon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectIcon>
    </SelectTrigger>
  )
}

function SelectValueComponent({
  className,
  ...props
}: React.ComponentProps<typeof SelectValue>) {
  return <SelectValue data-slot="select-value" className={className} {...props} />
}

function SelectIconComponent({
  className,
  ...props
}: React.ComponentProps<typeof SelectIcon>) {
  return <SelectIcon data-slot="select-icon" className={cn("text-muted-foreground", className)} {...props} />
}

function SelectContentComponent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectContent>) {
  return (
    <SelectPortal>
      <SelectContent
        data-slot="select-content"
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton asChild>
          <div className="flex cursor-default items-center justify-center py-1">
            <ChevronUpIcon className="size-4" />
          </div>
        </SelectScrollUpButton>
        <SelectViewport data-slot="select-viewport" className={cn("p-1", position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]")}>
          {children}
        </SelectViewport>
        <SelectScrollDownButton asChild>
          <div className="flex cursor-default items-center justify-center py-1">
            <ChevronDownIcon className="size-4" />
          </div>
        </SelectScrollDownButton>
      </SelectContent>
    </SelectPortal>
  )
}

function SelectViewportComponent({
  className,
  ...props
}: React.ComponentProps<typeof SelectViewport>) {
  return <SelectViewport data-slot="select-viewport" className={cn("p-1", className)} {...props} />
}

function SelectGroupComponent({
  ...props
}: React.ComponentProps<typeof SelectGroup>) {
  return <SelectGroup data-slot="select-group" {...props} />
}

function SelectLabelComponent({
  className,
  ...props
}: React.ComponentProps<typeof SelectLabel>) {
  return <SelectLabel data-slot="select-label" className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)} {...props} />
}

function SelectItemComponent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectItem>) {
  return (
    <SelectItem
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 relative flex w-full cursor-default items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        className
      )}
      {...props}
    >
      <SelectItemText data-slot="select-item-text">{children}</SelectItemText>
      <SelectItemIndicator asChild>
        <ChevronDownIcon className="absolute right-2 size-4" />
      </SelectItemIndicator>
    </SelectItem>
  )
}

function SelectItemTextComponent({
  className,
  ...props
}: React.ComponentProps<typeof SelectItemText>) {
  return <SelectItemText data-slot="select-item-text" className={className} {...props} />
}

function SelectItemIndicatorComponent({
  className,
  ...props
}: React.ComponentProps<typeof SelectItemIndicator>) {
  return <SelectItemIndicator data-slot="select-item-indicator" className={cn("absolute right-2 inline-flex items-center justify-center", className)} {...props} />
}

function SelectSeparatorComponent({
  className,
  ...props
}: React.ComponentProps<typeof SelectSeparator>) {
  return <SelectSeparator data-slot="select-separator" className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)} {...props} />
}

export {
  SelectComponent as Select,
  SelectContentComponent as SelectContent,
  SelectGroupComponent as SelectGroup,
  SelectIconComponent as SelectIcon,
  SelectItemComponent as SelectItem,
  SelectItemIndicatorComponent as SelectItemIndicator,
  SelectItemTextComponent as SelectItemText,
  SelectLabelComponent as SelectLabel,
  SelectSeparatorComponent as SelectSeparator,
  SelectTriggerComponent as SelectTrigger,
  SelectValueComponent as SelectValue,
  SelectViewportComponent as SelectViewport,
}
