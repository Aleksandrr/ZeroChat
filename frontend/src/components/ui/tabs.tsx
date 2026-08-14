import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@radix-ui/react-tabs"
import type * as React from "react"

import { cn } from "@/lib/utils"

function TabsComponent({
  className,
  ...props
}: React.ComponentProps<typeof Tabs>) {
  return <Tabs data-slot="tabs" className={cn("flex flex-col", className)} {...props} />
}

function TabsListComponent({
  className,
  ...props
}: React.ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      data-slot="tabs-list"
      className={cn("bg-muted inline-flex h-10 items-center justify-center rounded-lg p-1 gap-1.5", className)}
      {...props}
    />
  )
}

function TabsTriggerComponent({
  className,
  ...props
}: React.ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      data-slot="tabs-trigger"
      className={cn("data-[state=active]:bg-background data-[state=active]:shadow-sm focus-visible:border-ring focus-visible:ring-ring/50 text-muted-foreground dark:text-muted-foreground justify-center whitespace-nowrap rounded-md px-4 py-1.5 text-sm font-medium transition-all duration-200 outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground", className)}
      {...props}
    />
  )
}

function TabsContentComponent({
  className,
  ...props
}: React.ComponentProps<typeof TabsContent>) {
  return (
    <TabsContent
      data-slot="tabs-content"
      className={cn("focus-visible:border-ring focus-visible:ring-ring/50 mt-2 ring-offset-background outline-none focus-visible:ring-[3px] animate-fade-in", className)}
      {...props}
    />
  )
}

export {
  TabsComponent as Tabs,
  TabsContentComponent as TabsContent,
  TabsListComponent as TabsList,
  TabsTriggerComponent as TabsTrigger,
}
