'use client'

// Structured row editor for branch commits. Replaces raw JSON textarea
// with a table-based editor that shows columns and allows adding/editing rows.

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2, AlertCircle } from 'lucide-react'
import type { Row } from '@/lib/dataset-service'

interface BranchRowEditorProps {
  initialRows: Row[]
  onChange: (rows: Row[]) => void
  maxRows?: number
}

export default function BranchRowEditor({ initialRows, onChange, maxRows = 100 }: BranchRowEditorProps) {
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [columns, setColumns] = useState<string[]>(() => {
    const cols = new Set<string>()
    for (const row of initialRows) {
      for (const key of Object.keys(row)) cols.add(key)
    }
    return cols.size > 0 ? [...cols] : ['id', 'value']
  })
  const [newColName, setNewColName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const updateRows = useCallback((newRows: Row[]) => {
    setRows(newRows)
    onChange(newRows)
    setError(null)
  }, [onChange])

  const addRow = () => {
    if (rows.length >= maxRows) {
      setError(`Maximum ${maxRows} rows allowed`)
      return
    }
    const newRow: Row = {}
    for (const col of columns) newRow[col] = ''
    updateRows([...rows, newRow])
  }

  const removeRow = (index: number) => {
    updateRows(rows.filter((_, i) => i !== index))
  }

  const updateCell = (rowIndex: number, col: string, value: string) => {
    const newRows = [...rows]
    // Try to parse as number or boolean
    let parsed: unknown = value
    if (value === '') parsed = null
    else if (value === 'true') parsed = true
    else if (value === 'false') parsed = false
    else if (/^-?\d+\.?\d*$/.test(value) && !isNaN(Number(value))) parsed = Number(value)
    
    newRows[rowIndex] = { ...newRows[rowIndex], [col]: parsed }
    updateRows(newRows)
  }

  const addColumn = () => {
    const name = newColName.trim()
    if (!name || columns.includes(name)) return
    setColumns([...columns, name])
    setNewColName('')
    // Add column to existing rows
    updateRows(rows.map(r => ({ ...r, [name]: '' })))
  }

  const removeColumn = (col: string) => {
    setColumns(columns.filter(c => c !== col))
    updateRows(rows.map(r => {
      const newRow = { ...r }
      delete newRow[col]
      return newRow
    }))
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}

      {/* Column management */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Columns:</span>
        {columns.map(col => (
          <Badge key={col} variant="outline" className="gap-1 text-[10px]">
            {col}
            <button
              onClick={() => removeColumn(col)}
              className="ml-1 hover:text-rose-600"
              aria-label={`Remove column ${col}`}
            >
              ×
            </button>
          </Badge>
        ))}
        <div className="flex items-center gap-1">
          <Input
            value={newColName}
            onChange={e => setNewColName(e.target.value)}
            placeholder="Add column"
            className="h-6 w-24 text-xs"
            onKeyDown={e => e.key === 'Enter' && addColumn()}
          />
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={addColumn}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Row table */}
      <div className="max-h-64 overflow-auto rounded border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/50">
            <tr>
              <th className="w-8 p-1 text-center">#</th>
              {columns.map(col => (
                <th key={col} className="min-w-[80px] p-1 text-left font-medium">{col}</th>
              ))}
              <th className="w-8 p-1"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t">
                <td className="p-1 text-center text-muted-foreground">{rowIndex + 1}</td>
                {columns.map(col => (
                  <td key={col} className="p-0.5">
                    <Input
                      value={row[col] == null ? '' : String(row[col])}
                      onChange={e => updateCell(rowIndex, col, e.target.value)}
                      className="h-6 min-w-[60px] text-xs"
                    />
                  </td>
                ))}
                <td className="p-1">
                  <button
                    onClick={() => removeRow(rowIndex)}
                    className="text-muted-foreground hover:text-rose-600"
                    aria-label={`Remove row ${rowIndex + 1}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={addRow}>
          <Plus className="h-3 w-3" />
          Add row
        </Button>
      </div>
    </div>
  )
}
