import { cn } from "~/lib/utils";

/**
 * The shop's stepping-stone mark (돌다리 = stone bridge): three pebbles, the middle one smiling,
 * on the storefront sign's charcoal navy. Same drawing as public/favicon.svg.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={cn("size-8 shrink-0", className)}>
      <rect width="64" height="64" rx="14" fill="#2e3d5a" />
      <ellipse cx="17" cy="35" rx="11" ry="9" fill="#d4d6da" transform="rotate(-12 17 35)" />
      <ellipse cx="47" cy="35" rx="11" ry="9" fill="#f4f4f2" transform="rotate(10 47 35)" />
      <path
        d="M32 21.5c7.6 0 13 4.9 13 11.6 0 6.4-5.6 10.9-13 10.9s-13-4.5-13-10.9C19 26.4 24.4 21.5 32 21.5Z"
        fill="#9ea4ae"
        stroke="#2e3d5a"
        strokeWidth="2.2"
      />
      <circle cx="27.6" cy="31" r="1.7" fill="#1e1e1e" />
      <circle cx="36.4" cy="31" r="1.7" fill="#1e1e1e" />
      <path d="M27 36q5 4.2 10 0" fill="none" stroke="#1e1e1e" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Mark + STONE BRIDGE wordmark (the sign's clean caps). `sub` is the small line under it. */
export function Logo({
  sub = "홍보글",
  className,
  markClassName,
}: {
  sub?: string | null;
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className={markClassName} />
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-extrabold tracking-[0.08em] text-primary">STONE BRIDGE</span>
        {sub && <span className="mt-1 text-[11px] font-medium text-muted-foreground">{sub}</span>}
      </span>
    </span>
  );
}

/** Black-and-white checkerboard from the shop's badge logo, as a faint decorative band. */
export function CheckerBand({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none", className)}
      style={{
        backgroundImage:
          "conic-gradient(currentColor 25%, transparent 0 50%, currentColor 0 75%, transparent 0)",
        backgroundSize: "24px 24px",
      }}
    />
  );
}
