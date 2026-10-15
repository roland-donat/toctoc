import type { SVGProps } from "react"
import { cn } from "@/lib/utils"

// The shell pattern and the eye are cut out of the mascot: they show the color behind it, set with --tortue-hole
// where the mascot sits on something other than the page background.
const HOLE = "var(--tortue-hole, var(--color-background))"
const HOLE_FILL = { fill: HOLE }
const HOLE_STROKE = { stroke: HOLE }

/**
 * The mascot: a sagacious turtle ("tortue sagace"), slow and steady like a door-to-door round. Drawn in currentColor
 * so it takes the color of its context.
 */
export function Tortue({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 40" fill="none" aria-hidden="true" className={className} {...props}>
      <path d="M6 27 L1 29 L6 30 Z" fill="currentColor" />
      <rect x="11" y="25" width="7" height="10" rx="3" fill="currentColor" />
      <rect x="38" y="25" width="7" height="10" rx="3" fill="currentColor" />
      <path d="M44 27 C47 22 52 19 56 19 C61 19 63 23 63 26 C63 29 60 31 56 31 L46 31 Z" fill="currentColor" />
      <circle cx="58" cy="24" r="1.6" style={HOLE_FILL} />
      <path d="M5 29 C5 14 16 4 28 4 C40 4 50 14 50 29 Z" fill="currentColor" />
      <path
        d="M27.5 10 L34 14 L34 21 L27.5 25 L21 21 L21 14 Z M27.5 10 L27.5 5 M34 14 L42 10 M34 21 L44 25 M27.5 25 L27.5 29 M21 21 L11 25 M21 14 L13 10"
        style={HOLE_STROKE}
        strokeWidth="1.6"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path d="M4 29 L51 29" style={HOLE_STROKE} strokeWidth="1.4" opacity="0.55" />
    </svg>
  )
}

/** A glass of "lait fraise", the strawberry milk of the 2022 campaign videos. Its colors are its own. */
export function LaitFraise({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 40" fill="none" aria-hidden="true" className={className} {...props}>
      <path d="M23 1 L17 16" stroke="#d1271c" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M5 10 L27 10 L24 38 L8 38 Z" fill="#fff" stroke="#212320" strokeWidth="2" strokeLinejoin="round" />
      <path d="M6.2 17 L25.8 17 L24 37 L8 37 Z" fill="#f7b6cf" />
      <path d="M6.2 17 C10 19 14 15 16 17 C18 19 22 15 25.8 17" stroke="#ed5fb1" strokeWidth="1.6" />
      <circle cx="12" cy="26" r="1.4" fill="#fff" opacity="0.8" />
      <circle cx="18" cy="31" r="1" fill="#fff" opacity="0.8" />
    </svg>
  )
}

/** The wordmark: the mascot and the name, set in the black weight of the title face. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-display text-xl leading-none font-black tracking-tight uppercase", className)}>
      <Tortue className="h-6 w-auto" />
      TOCTOC
    </span>
  )
}
