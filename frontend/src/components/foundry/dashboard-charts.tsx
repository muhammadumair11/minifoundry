'use client'

// Task 14-d — chart renderers for dashboard widgets. Mirrors the established
// Recharts patterns (run-trend-card / usage-dashboard): useChartTheme() colors,
// AXIS_TICK ticks, ChartTooltipShell tooltips. The categorical slice palette
// lives HERE (chart-kit doesn't export one — noted in the worklog).

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TooltipProps } from 'recharts'
import {
  AXIS_TICK,
  ChartTooltipShell,
  useChartAnimationDuration,
  useChartTheme,
} from '@/components/foundry/charts/chart-kit'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DashboardWidgetType } from '@/lib/foundry-types'

// Categorical palette (light-theme hexes used on both themes for slice identity;
// emerald/amber/rose/teal/orange/zinc — no blue/indigo, per house rules).
export const WIDGET_PALETTE = [
  '#059669', // emerald-600
  '#d97706', // amber-600
  '#e11d48', // rose-600
  '#0d9488', // teal-600
  '#ea580c', // orange-600
  '#a16207', // yellow-700
  '#7c2d12', // orange-900
  '#4d7c0f', // lime-700
  '#9f1239', // rose-800
  '#3f6212', // lime-800
] as const

/** [{ name, value }] — the aggregated shape served by POST …/data. */
export interface NameValueRow {
  name: string
  value: number
}

/** Compact number label: ints get thousands separators, floats keep 2 decimals. */
export function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Number.isInteger(v)) return v.toLocaleString('en-US')
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** Truncate long category labels for axis ticks / legends. */
function truncate(s: string, max = 12): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ─── Tooltips ─────────────────────────────────────────────────────────

function AggregateTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null
  const point = (payload[0].payload ?? {}) as NameValueRow
  const name = typeof label === 'string' ? label : point.name
  return (
    <ChartTooltipShell>
      <p className="max-w-48 truncate font-mono text-[11px] text-muted-foreground" title={name}>
        {name}
      </p>
      <p className="font-mono text-sm font-semibold tabular-nums">{fmtValue(point.value)}</p>
    </ChartTooltipShell>
  )
}

function PieTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0].payload as NameValueRow
  return (
    <ChartTooltipShell>
      <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: payload[0].payload?.fill ?? WIDGET_PALETTE[0] }}
          aria-hidden
        />
        {point.name}
      </p>
      <p className="font-mono text-sm font-semibold tabular-nums">{fmtValue(point.value)}</p>
    </ChartTooltipShell>
  )
}

// ─── XY charts (bar / line / area) ────────────────────────────────────

function XyChart({ rows, kind }: { rows: NameValueRow[]; kind: 'bar' | 'line' | 'area' }) {
  const theme = useChartTheme()
  const animationDuration = useChartAnimationDuration()
  const animated = animationDuration > 0

  return (
    <ResponsiveContainer width="100%" height="100%">
      {kind === 'bar' ? (
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ ...AXIS_TICK, fill: theme.tick }}
            tickLine={false}
            axisLine={{ stroke: theme.grid }}
            tickFormatter={(v: string) => truncate(String(v))}
            minTickGap={12}
          />
          <YAxis
            width={38}
            tick={{ ...AXIS_TICK, fill: theme.tick }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmtValue(v)}
          />
          <Tooltip content={<AggregateTooltip />} cursor={{ fill: theme.grid, opacity: 0.4 }} />
          <Bar
            dataKey="value"
            fill={theme.series}
            radius={[3, 3, 0, 0]}
            maxBarSize={40}
            animationDuration={animationDuration}
            isAnimationActive={animated}
          />
        </BarChart>
      ) : kind === 'line' ? (
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ ...AXIS_TICK, fill: theme.tick }}
            tickLine={false}
            axisLine={{ stroke: theme.grid }}
            tickFormatter={(v: string) => truncate(String(v))}
            minTickGap={12}
          />
          <YAxis
            width={38}
            tick={{ ...AXIS_TICK, fill: theme.tick }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmtValue(v)}
          />
          <Tooltip content={<AggregateTooltip />} cursor={{ stroke: theme.tick, strokeDasharray: '3 3' }} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={theme.series}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3, fill: theme.series, stroke: theme.tooltipBg, strokeWidth: 1 }}
            animationDuration={animationDuration}
            isAnimationActive={animated}
          />
        </LineChart>
      ) : (
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="dw-area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.series} stopOpacity={0.28} />
              <stop offset="100%" stopColor={theme.series} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ ...AXIS_TICK, fill: theme.tick }}
            tickLine={false}
            axisLine={{ stroke: theme.grid }}
            tickFormatter={(v: string) => truncate(String(v))}
            minTickGap={12}
          />
          <YAxis
            width={38}
            tick={{ ...AXIS_TICK, fill: theme.tick }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmtValue(v)}
          />
          <Tooltip content={<AggregateTooltip />} cursor={{ stroke: theme.tick, strokeDasharray: '3 3' }} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={theme.series}
            strokeWidth={2}
            fill="url(#dw-area-fill)"
            animationDuration={animationDuration}
            isAnimationActive={animated}
          />
        </AreaChart>
      )}
    </ResponsiveContainer>
  )
}

// ─── Pie (legend + themed palette cycling) ────────────────────────────

function PieCard({ rows }: { rows: NameValueRow[] }) {
  const theme = useChartTheme()
  const data = rows.map((r, i) => ({ ...r, fill: WIDGET_PALETTE[i % WIDGET_PALETTE.length] }))
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <Tooltip content={<PieTooltip />} />
        <Legend
          verticalAlign="bottom"
          height={28}
          iconSize={8}
          formatter={(value: string) => (
            <span className="font-mono text-[10px] text-muted-foreground">{truncate(value, 16)}</span>
          )}
        />
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="42%"
          outerRadius="72%"
          paddingAngle={2}
          stroke={theme.tooltipBg}
          strokeWidth={1}
          isAnimationActive={false}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.fill} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  )
}

// ─── Stat (big number) ────────────────────────────────────────────────

function StatCard({ rows }: { rows: NameValueRow[] }) {
  const value = rows[0]?.value
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 py-2">
      <p className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">
        {value === undefined ? '—' : fmtValue(value)}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">rows aggregated</p>
    </div>
  )
}

// ─── Table (compact raw rows) ─────────────────────────────────────────

function TableCard({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = rows.length > 0 ? Object.keys(rows[0]).slice(0, 6) : []
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
      <Table className="text-[13px]">
        <TableHeader className="sticky top-0 bg-muted/40">
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => (
              <TableHead key={c} className="h-8 px-2 font-mono text-[11px] text-muted-foreground">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell key={c} className="max-w-40 truncate px-2 py-1.5 font-mono text-[11px]">
                  {row[c] === null || row[c] === undefined ? '—' : String(row[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ─── Dispatcher ───────────────────────────────────────────────────────

export function WidgetVisual({
  type,
  rows,
}: {
  type: DashboardWidgetType
  rows: Record<string, unknown>[]
}) {
  if (type === 'stat') return <StatCard rows={toNameValue(rows)} />
  if (type === 'table') return <TableCard rows={rows} />
  if (type === 'pie') return <PieCard rows={toNameValue(rows)} />
  return <XyChart rows={toNameValue(rows)} kind={type} />
}

/** Defensive row conversion: [{ name, value }] with a numeric value filter. */
function toNameValue(rows: Record<string, unknown>[]): NameValueRow[] {
  return rows
    .filter((r) => r && typeof r.value === 'number')
    .map((r) => ({ name: String(r.name ?? '(empty)'), value: r.value as number }))
}
