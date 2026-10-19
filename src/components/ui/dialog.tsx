import { usePresentation } from '@/presentation-context';
"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const presentation = usePresentation();
  return <DialogPrimitive.Root {...props} modal={presentation ? false : props.modal} />;
}

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const overlayClassName = "fixed inset-0 z-50 overlay-dim data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";

function focusableChildren(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
  )].filter(element => getComputedStyle(element).display !== "none" &&
    getComputedStyle(element).visibility !== "hidden");
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      overlayClassName,
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { portalContainer?: HTMLElement }
>(({ className, children, portalContainer: suppliedPortal, onKeyDown, onOpenAutoFocus, ...props }, ref) => {
  const presentation = usePresentation();
  const portalContainer = suppliedPortal ?? presentation?.portalContainer;
  return (
  <DialogPortal container={portalContainer}>
    {portalContainer ? (
      // Non-modal Radix avoids document-wide scroll/aria mutations. Preserve the
      // original visual backdrop inside the island instead of dropping it.
      <div aria-hidden="true" data-treasure-dialog-backdrop="" data-state="open" className={overlayClassName} />
    ) : <DialogOverlay />}
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
        className,
      )}
      {...props}
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event);
        if (portalContainer && !event.defaultPrevented && event.target instanceof HTMLElement) {
          event.preventDefault();
          (focusableChildren(event.target)[0] || event.target).focus();
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!portalContainer || event.defaultPrevented || event.key !== "Tab") return;
        const content = event.currentTarget;
        const candidates = focusableChildren(content);
        const first = candidates[0], last = candidates.at(-1);
        const scope = content.getRootNode();
        const active = scope instanceof ShadowRoot ? scope.activeElement : document.activeElement;
        if (!first || !last) { event.preventDefault(); content.focus(); }
        else if (event.shiftKey && (active === first || active === content)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (active === last || active === content)) {
          event.preventDefault(); first.focus();
        }
      }}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
);
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
