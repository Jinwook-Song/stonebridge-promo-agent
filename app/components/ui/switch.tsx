import * as React from "react";
import { cn } from "~/lib/utils";

/** On/off toggle; the 44px tap area is the whole button, the track is just the picture. */
function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange"> & { checked: boolean; onCheckedChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "group flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-6 w-10 items-center rounded-full border p-0.5 transition-colors",
          checked ? "border-primary bg-primary" : "border-input bg-muted",
        )}
      >
        <span
          className={cn("size-5 rounded-full bg-white shadow-xs transition-transform", checked && "translate-x-4")}
        />
      </span>
    </button>
  );
}

export { Switch };
