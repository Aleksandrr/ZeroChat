"use client"

import {
  Tooltip,
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from "@radix-ui/react-tooltip"
import type * as React from "react"

import { cn } from "@/lib/utils"

function TooltipProviderComponent({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipProvider>) {
  return <TooltipProvider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

function TooltipComponent({
  ...props
}: React.ComponentProps<typeof Tooltip>) {
  return <Tooltip data-slot="tooltip" {...props} />
}

function TooltipTriggerComponent({
  ...props
}: React.ComponentProps<typeof TooltipTrigger>) {
  return <TooltipTrigger data-slot="tooltip-trigger" {...props} />
}

function TooltipPortalComponent({
  ...props
}: React.ComponentProps<typeof TooltipPortal>) {
  return <TooltipPortal data-slot="tooltip-portal" {...props} />
}

function TooltipContentComponent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipContent>) {
  return (
    <TooltipContent
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        "bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 rounded-md px-3 py-1.5 text-sm shadow-md",
        className
      )}
      {...props}
    >
      <TooltipArrow className="fill-primary" />
    </TooltipContent>
  )
}

function TooltipArrowComponent({
  className,
  ...props
}: React.ComponentProps<typeof TooltipArrow>) {
  return <TooltipArrow data-slot="tooltip-arrow" className={cn("fill-primary", className)} {...props} />
}

export {
  TooltipComponent as Tooltip,
  TooltipArrowComponent as TooltipArrow,
  TooltipContentComponent as TooltipContent,
  TooltipPortalComponent as TooltipPortal,
  TooltipProviderComponent as TooltipProvider,
  TooltipTriggerComponent as TooltipTrigger,
}
