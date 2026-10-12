'use client'

// M10.1 observability (Task 8-c) — shared visual language for the app's
// Recharts charts. Task 12-b: colors are now THEME-AWARE via useChartTheme()
// (light = Foundry-minimal: emerald-600 series on white cards with zinc-200
// grid; dark = the original zinc-950 look with emerald-400 series).
// CHART_COLORS / GRID_STROKE / AXIS_TICK stay exported for backwards
// compatibility, but new chart code should read useChartTheme() instead.

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'

// Tailwind palette constants (SVG props need literals, not class names).
// Kept for backwards compatibility — legacy dark-theme literals.
export const CHART_COLORS = {
  emerald400: '#34d399',
  emerald500: '#10b981',
  rose400: '#fb7185',
  rose500: '#f43f5e',
  amber400: '#fbbf24',
  zinc800: '#27272a',
  zinc950: '#09090b',
} as const

/** Legacy dark-theme grid stroke — kept for compatibility; prefer theme.grid. */
export const GRID_STROKE = 'rgba(39, 39, 42, 0.5)'

/** Recharts axis ticks — 10px mono zinc-500, matching the data-UI labels. */
export const AXIS_TICK = {
  fill: '#71717a',
  fontSize: 10,
  fontFamily: 'var(--font-geist-mono)',
} as const

export interface ChartTheme {
  /** Primary data series — emerald-600 (light) / emerald-400 (dark). */
  series: string
  /** Error/negative series — rose-600 (light) / rose-400 (dark). */
  error: string
  /** Warning/in-progress — amber-600 (light) / amber-400 (dark). */
  warn: string
  /** Grid + axis lines — zinc-200 (light) / zinc-800 (dark). */
  grid: string
  /** Axis tick text — zinc-500 on both themes. */
  tick: string
  /** Tooltip background — white (light) / zinc-900 (dark). */
  tooltipBg: string
  /** Tooltip border — zinc-200 (light) / zinc-800 (dark). */
  tooltipBorder: string
  /** Tooltip body text — zinc-900 (light) / zinc-100 (dark). */
  tooltipText: string
}

const LIGHT_THEME: ChartTheme = {
  series: '#059669', // emerald-600
  error: '#e11d48', // rose-600
  warn: '#d97706', // amber-600
  grid: '#e4e4e7', // zinc-200
  tick: '#71717a', // zinc-500
  tooltipBg: '#ffffff',
  tooltipBorder: '#e4e4e7', // zinc-200
  tooltipText: '#18181b', // zinc-900
}

const DARK_THEME: ChartTheme = {
  series: '#34d399', // emerald-400
  error: '#fb7185', // rose-400
  warn: '#fbbf24', // amber-400
  grid: '#27272a', // zinc-800
  tick: '#71717a', // zinc-500
  tooltipBg: '#18181b', // zinc-900
  tooltipBorder: '#27272a', // zinc-800
  tooltipText: '#f4f4f5', // zinc-100
}

/**
 * Theme-aware chart palette. `resolvedTheme` is undefined before hydration —
 * the light palette is the safe default (light is the app default theme).
 */
export function useChartTheme(): ChartTheme {
  const { resolvedTheme } = useTheme()
  return resolvedTheme === 'dark' ? DARK_THEME : LIGHT_THEME
}

/**
 * Recharts animationDuration: 0 when the user prefers reduced motion,
 * else the default 600ms reveal. Simple matchMedia check (nothing else in
 * the app animated, so there was no existing helper to reuse).
 */
export function useChartAnimationDuration(): number {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return reduced ? 0 : 600
}

/** Tooltip shell shared by every chart — themed bg/border/text, mono body. */
export function ChartTooltipShell({ children }: { children: React.ReactNode }) {
  const theme = useChartTheme()
  return (
    <div
      className="min-w-40 rounded-md border px-3 py-2 shadow-lg"
      style={{
        backgroundColor: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        color: theme.tooltipText,
      }}
    >
      {children}
    </div>
  )
}
