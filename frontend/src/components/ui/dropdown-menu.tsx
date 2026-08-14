"use client"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@radix-ui/react-dropdown-menu"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"
import type * as React from "react"

import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

function DropdownMenuComponent({
  ...props
}: React.ComponentProps<typeof DropdownMenu>) {
  return <DropdownMenu data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortalComponent({
  ...props
}: React.ComponentProps<typeof DropdownMenuPortal>) {
  return <DropdownMenuPortal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTriggerComponent({
  ...props
}: React.ComponentProps<typeof DropdownMenuTrigger>) {
  return <DropdownMenuTrigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContentComponent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuPortal>
      <DropdownMenuContent
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1 shadow-lg",
          className
        )}
        {...props}
      />
    </DropdownMenuPortal>
  )
}

function DropdownMenuGroupComponent({
  ...props
}: React.ComponentProps<typeof DropdownMenuGroup>) {
  return <DropdownMenuGroup data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuItemComponent({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuItem> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  const isMobile = useIsMobile();
  
  return (
    <DropdownMenuItem
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        isMobile ? 'py-2.5 min-h-[44px]' : 'py-1.5',
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItemComponent({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuCheckboxItem>) {
  return (
    <DropdownMenuCheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuItemIndicator>
      </span>
      {children}
    </DropdownMenuCheckboxItem>
  )
}

function DropdownMenuRadioGroupComponent({
  ...props
}: React.ComponentProps<typeof DropdownMenuRadioGroup>) {
  return <DropdownMenuRadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItemComponent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuRadioItem>) {
  return (
    <DropdownMenuRadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuItemIndicator>
      </span>
      {children}
    </DropdownMenuRadioItem>
  )
}

function DropdownMenuLabelComponent({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuLabel> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparatorComponent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuSeparator>) {
  return (
    <DropdownMenuSeparator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSubComponent({
  ...props
}: React.ComponentProps<typeof DropdownMenuSub>) {
  return <DropdownMenuSub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTriggerComponent({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuSubTrigger> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuSubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuSubTrigger>
  )
}

function DropdownMenuSubContentComponent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuSubContent>) {
  return (
    <DropdownMenuSubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg p-1 shadow-lg",
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenuComponent as DropdownMenu,
  DropdownMenuCheckboxItemComponent as DropdownMenuCheckboxItem,
  DropdownMenuContentComponent as DropdownMenuContent,
  DropdownMenuGroupComponent as DropdownMenuGroup,
  DropdownMenuItemComponent as DropdownMenuItem,
  DropdownMenuLabelComponent as DropdownMenuLabel,
  DropdownMenuPortalComponent as DropdownMenuPortal,
  DropdownMenuRadioGroupComponent as DropdownMenuRadioGroup,
  DropdownMenuRadioItemComponent as DropdownMenuRadioItem,
  DropdownMenuSeparatorComponent as DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSubComponent as DropdownMenuSub,
  DropdownMenuSubContentComponent as DropdownMenuSubContent,
  DropdownMenuSubTriggerComponent as DropdownMenuSubTrigger,
  DropdownMenuTriggerComponent as DropdownMenuTrigger,
}
