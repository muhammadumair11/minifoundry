// MiniFoundry — centralized ontology visual maps (Task 3-c).
// Maps API string keys (icon names, colors, cardinalities, operations) to
// Tailwind classes / lucide components. All classes are written as literals
// so Tailwind's scanner picks them up.

import { createElement } from 'react'
import {
  Box,
  Boxes,
  Building2,
  Cpu,
  Database,
  Factory,
  Globe,
  Layers,
  Package,
  Ship,
  Truck,
  Warehouse,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ActionOperation, LinkCardinality, OntologyColorKey } from '@/lib/foundry-types'

// ─── Icon name → component (API sends lucide-style name strings) ─────

const ICON_MAP: Record<string, LucideIcon> = {
  box: Box,
  boxes: Boxes,
  building: Building2,
  cpu: Cpu,
  database: Database,
  factory: Factory,
  globe: Globe,
  layers: Layers,
  package: Package,
  ship: Ship,
  truck: Truck,
  warehouse: Warehouse,
  wrench: Wrench,
}

/** Resolve an object type's icon; unknown/missing names fall back to Box. */
export function getOntologyIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Box
  return ICON_MAP[name.toLowerCase()] ?? Box
}

/** Render an API icon name directly as an element (lint-safe dynamic icon). */
export function OntologyIcon({
  name,
  className,
}: {
  name: string | null | undefined
  className?: string
}) {
  return createElement(getOntologyIcon(name), { className, 'aria-hidden': true })
}

/** Icon choices offered in the "New object type" dialog. */
export const ONTOLOGY_ICON_CHOICES = [
  'box',
  'truck',
  'factory',
  'warehouse',
  'package',
  'cpu',
  'wrench',
  'globe',
] as const

// ─── Color key → Tailwind classes ─────────────────────────────────────

export interface OntologyColorClasses {
  /** Border class for icon rings / chips. */
  border: string
  /** Translucent background tint. */
  bg: string
  /** Icon / text color. */
  text: string
  /** Solid dot color (legends). */
  dot: string
}

const COLOR_CLASSES: Record<OntologyColorKey, OntologyColorClasses> = {
  emerald: {
    border: 'border-emerald-500/40',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500 dark:bg-emerald-400',
  },
  teal: {
    border: 'border-teal-500/40',
    bg: 'bg-teal-500/10',
    text: 'text-teal-600 dark:text-teal-400',
    dot: 'bg-teal-500 dark:bg-teal-400',
  },
  amber: {
    border: 'border-amber-500/40',
    bg: 'bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500 dark:bg-amber-400',
  },
  rose: {
    border: 'border-rose-500/40',
    bg: 'bg-rose-500/10',
    text: 'text-rose-600 dark:text-rose-400',
    dot: 'bg-rose-500 dark:bg-rose-400',
  },
  orange: {
    border: 'border-orange-500/40',
    bg: 'bg-orange-500/10',
    text: 'text-orange-600 dark:text-orange-400',
    dot: 'bg-orange-500 dark:bg-orange-400',
  },
  zinc: {
    border: 'border-border',
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    dot: 'bg-zinc-400 dark:bg-zinc-500',
  },
}

/** Resolve color classes for an API color key; unknown falls back to zinc. */
export function getObjectColorClasses(color: string | null | undefined): OntologyColorClasses {
  if (!color) return COLOR_CLASSES.zinc
  return COLOR_CLASSES[color.toLowerCase() as OntologyColorKey] ?? COLOR_CLASSES.zinc
}

export const ONTOLOGY_COLOR_CHOICES = [
  'emerald',
  'teal',
  'amber',
  'rose',
  'orange',
  'zinc',
] as const

// ─── Cardinality badges (1—N teal / N—N orange) ───────────────────────

export function getCardinalityClasses(cardinality: string | null | undefined): string {
  return cardinality === 'many-to-many'
    ? 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400'
    : 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-400'
}

export function getCardinalityLabel(cardinality: string | null | undefined): string {
  return cardinality === 'many-to-many' ? 'N—N' : '1—N'
}

// ─── Action operations (create emerald / update amber / delete rose) ──

export interface OperationClasses {
  badge: string
  button: string
}

const OPERATION_CLASSES: Record<ActionOperation, OperationClasses> = {
  create: {
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    button: 'bg-primary text-primary-foreground hover:bg-primary/90',
  },
  update: {
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    button: 'bg-primary text-primary-foreground hover:bg-primary/90',
  },
  delete: {
    badge: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400',
    button:
      'bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:text-zinc-950 dark:hover:bg-rose-400',
  },
}

export function getOperationClasses(operation: string | null | undefined): OperationClasses {
  if (operation === 'create') return OPERATION_CLASSES.create
  if (operation === 'delete') return OPERATION_CLASSES.delete
  return OPERATION_CLASSES.update
}
