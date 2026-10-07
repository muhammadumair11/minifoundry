'use client'

// Monaco-based code editor shared by every coding surface in the platform
// (code workbooks on /transforms, pipeline derive expressions in the builder).
//
// Monaco (the VS Code editor engine — the same one real Foundry uses) is
// SELF-HOSTED from /monaco/vs (copied from node_modules at install time —
// no CDN dependency) and loaded via the AMD loader at runtime, so the Next.js
// bundler never touches it and workers resolve same-origin.
//
// Features the plain textarea could never give us: syntax highlighting for
// SQL/JS/Python, IntelliSense (schema-aware table/column completion for SQL,
// keyword/builtin/snippet completion for Python, TS-worker completion for JS),
// bracket matching + colorization, folding, minimap, multi-cursor, find
// (⌘F), and ⌘↵ / ⌘S run/save bindings wired to the host page.

import { lazy, Suspense, useEffect, useRef, type ComponentProps } from 'react'
import { loader } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor as MonacoEditorNS, languages as MonacoLanguagesNS, IRange, Position } from 'monaco-editor'
import { Loader2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'
import { useEditorFontSize } from '@/components/foundry/editor-prefs'

export type CodeEditorLanguage = 'sql' | 'javascript' | 'python' | 'plaintext'

export interface SchemaTable {
  name: string
  columns: { name: string; type: string }[]
}

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language?: CodeEditorLanguage
  /** 'full' = file editor (minimap, folding, line numbers). 'compact' = expression inputs. */
  variant?: 'full' | 'compact'
  fontSize?: number
  readOnly?: boolean
  placeholder?: string
  ariaLabel?: string
  /** ⌘/Ctrl+↵ */
  onRun?: () => void
  /** ⌘/Ctrl+S */
  onSave?: () => void
  /** SQL schema (dataset → columns) surfaced to IntelliSense. */
  schemaTables?: SchemaTable[]
  className?: string
}

// Self-hosted Monaco — must be configured before the loader fetches anything.
if (typeof window !== 'undefined') {
  loader.config({ paths: { vs: '/monaco/vs' } })
}

const MonacoEditorLazy = lazy(() => import('@monaco-editor/react'))

function MonacoEditor(props: ComponentProps<typeof MonacoEditorLazy>) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center gap-2 bg-muted/60 font-mono text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          loading editor…
        </div>
      }
    >
      <MonacoEditorLazy {...props} />
    </Suspense>
  )
}

// ── Themes ────────────────────────────────────────────────────────
// Both themes are defined together in beforeMount; the active one is chosen
// by the app theme (see `monacoTheme` in <CodeEditor/>).
//
// "minifoundry" (dark) — zinc-950 canvas with the platform's emerald accent.
// No blues/indigos: keywords emerald, strings amber, numbers orange, types
// violet, comments muted zinc.
// "minifoundry-light" (default) — white canvas, near-black text, Foundry-minimal:
// keywords emerald-700, strings amber-700, numbers orange-700, types violet-700,
// comments zinc-500 italic. NO blues/indigos.

function defineFoundryThemes(monaco: Monaco) {
  monaco.editor.defineTheme('minifoundry', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e4e4e7' },
      { token: 'comment', foreground: '71717a', fontStyle: 'italic' },
      { token: 'keyword', foreground: '34d399' },
      { token: 'keyword.json', foreground: 'fbbf24' },
      { token: 'string', foreground: 'fbbf24' },
      { token: 'string.escape', foreground: 'fde68a' },
      { token: 'string.verbatim', foreground: 'fbbf24' },
      { token: 'number', foreground: 'fb923c' },
      { token: 'number.hex', foreground: 'fb923c' },
      { token: 'regexp', foreground: 'f472b6' },
      { token: 'type', foreground: 'c4b5fd' },
      { token: 'type.identifier', foreground: 'c4b5fd' },
      { token: 'identifier', foreground: 'e4e4e7' },
      { token: 'variable', foreground: 'e4e4e7' },
      { token: 'variable.predefined', foreground: 'c4b5fd' },
      { token: 'function', foreground: 'e4e4e7' },
      { token: 'operator', foreground: 'a1a1aa' },
      { token: 'operators', foreground: 'a1a1aa' },
      { token: 'delimiter', foreground: '71717a' },
      { token: 'tag', foreground: '34d399' },
      { token: 'metatag', foreground: '34d399' },
      { token: 'attribute.name', foreground: 'c4b5fd' },
      { token: 'attribute.value', foreground: 'fbbf24' },
      { token: 'annotation', foreground: '34d399' },
      { token: 'predefined', foreground: '5eead4' },
    ],
    colors: {
      'editor.background': '#09090b',
      'editor.foreground': '#e4e4e7',
      'editorLineNumber.foreground': '#3f3f46',
      'editorLineNumber.activeForeground': '#34d399',
      'editorCursor.foreground': '#34d399',
      'editor.selectionBackground': '#10b98140',
      'editor.inactiveSelectionBackground': '#10b98122',
      'editor.lineHighlightBackground': '#18181b',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#27272a',
      'editorIndentGuide.activeBackground1': '#52525b',
      'editorWidget.background': '#101013',
      'editorWidget.border': '#27272a',
      'editorSuggestWidget.background': '#101013',
      'editorSuggestWidget.border': '#27272a',
      'editorSuggestWidget.selectedBackground': '#10b98126',
      'editorSuggestWidget.foreground': '#d4d4d8',
      'editorHoverWidget.background': '#101013',
      'editorHoverWidget.border': '#27272a',
      'editorBracketMatch.background': '#10b98130',
      'editorBracketMatch.border': '#34d39980',
      'editorError.foreground': '#fb7185',
      'editorWarning.foreground': '#fbbf24',
      'editorGutter.background': '#0a0a0c',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#0a0a0c',
      'scrollbarSlider.background': '#27272a80',
      'scrollbarSlider.hoverBackground': '#3f3f4680',
      'scrollbarSlider.activeBackground': '#52525b80',
      'input.background': '#0a0a0c',
      'input.border': '#27272a',
      'focusBorder': '#34d39960',
    },
  })

  monaco.editor.defineTheme('minifoundry-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '27272a' },
      { token: 'comment', foreground: '71717a', fontStyle: 'italic' },
      { token: 'keyword', foreground: '047857' },
      { token: 'keyword.json', foreground: 'b45309' },
      { token: 'string', foreground: 'b45309' },
      { token: 'string.escape', foreground: '92400e' },
      { token: 'string.verbatim', foreground: 'b45309' },
      { token: 'number', foreground: 'c2410c' },
      { token: 'number.hex', foreground: 'c2410c' },
      { token: 'regexp', foreground: 'be123c' },
      { token: 'type', foreground: '6d28d9' },
      { token: 'type.identifier', foreground: '6d28d9' },
      { token: 'identifier', foreground: '27272a' },
      { token: 'variable', foreground: '27272a' },
      { token: 'variable.predefined', foreground: '6d28d9' },
      { token: 'function', foreground: '27272a' },
      { token: 'operator', foreground: '71717a' },
      { token: 'operators', foreground: '71717a' },
      { token: 'delimiter', foreground: 'a1a1aa' },
      { token: 'tag', foreground: '047857' },
      { token: 'metatag', foreground: '047857' },
      { token: 'attribute.name', foreground: '6d28d9' },
      { token: 'attribute.value', foreground: 'b45309' },
      { token: 'annotation', foreground: '047857' },
      { token: 'predefined', foreground: '0f766e' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#27272a',
      'editorLineNumber.foreground': '#a1a1aa',
      'editorLineNumber.activeForeground': '#18181b',
      'editorCursor.foreground': '#18181b',
      'editor.selectionBackground': '#e4e4e7',
      'editor.inactiveSelectionBackground': '#e4e4e766',
      'editor.lineHighlightBackground': '#fafafa',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#f4f4f5',
      'editorIndentGuide.activeBackground1': '#d4d4d8',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#e4e4e7',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.border': '#e4e4e7',
      'editorSuggestWidget.selectedBackground': '#f4f4f5',
      'editorSuggestWidget.foreground': '#3f3f46',
      'editorHoverWidget.background': '#ffffff',
      'editorHoverWidget.border': '#e4e4e7',
      'editorBracketMatch.background': '#e4e4e7aa',
      'editorBracketMatch.border': '#a1a1aa80',
      'editorError.foreground': '#e11d48',
      'editorWarning.foreground': '#d97706',
      'editorGutter.background': '#fcfcfc',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#fafafa',
      'scrollbarSlider.background': '#e4e4e780',
      'scrollbarSlider.hoverBackground': '#d4d4d880',
      'scrollbarSlider.activeBackground': '#a1a1aa80',
      'input.background': '#ffffff',
      'input.border': '#e4e4e7',
      'focusBorder': '#18181b40',
    },
  })
}

// ── Language data ──────────────────────────────────────────────────────

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE',
  'BETWEEN', 'EXISTS', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'CROSS', 'ON', 'AS', 'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'HAVING',
  'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'WITH', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'TABLE', 'VIEW', 'DROP', 'ALTER', 'OVER', 'PARTITION',
]

const SQL_FUNCTIONS = [
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'ABS', 'COALESCE', 'NULLIF',
  'IFNULL', 'IIF', 'CAST', 'UPPER', 'LOWER', 'LENGTH', 'SUBSTR', 'TRIM',
  'REPLACE', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'DATE',
]

const SQL_SNIPPETS: { label: string; body: string; detail: string }[] = [
  {
    label: 'SELECT · FROM · WHERE',
    body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition}\nLIMIT ${4:50}',
    detail: 'basic query skeleton',
  },
  {
    label: 'JOIN · ON',
    body: 'JOIN ${1:table} ON ${2:a.id} = ${3:b.a_id}',
    detail: 'join clause',
  },
  {
    label: 'GROUP BY · COUNT',
    body: 'SELECT ${1:column}, COUNT(*) AS ${2:count}\nFROM ${3:table}\nGROUP BY ${1:column}\nORDER BY ${2:count} DESC',
    detail: 'aggregation skeleton',
  },
  {
    label: 'CASE · WHEN',
    body: 'CASE\n  WHEN ${1:condition} THEN ${2:value}\n  ELSE ${3:other}\nEND',
    detail: 'conditional expression',
  },
  {
    label: 'ROW_NUMBER · OVER',
    body: 'ROW_NUMBER() OVER (PARTITION BY ${1:col} ORDER BY ${2:col2} DESC) AS ${3:rn}',
    detail: 'window function',
  },
]

const PY_KEYWORDS = [
  'def', 'return', 'import', 'from', 'as', 'if', 'elif', 'else', 'for',
  'while', 'in', 'not', 'and', 'or', 'is', 'None', 'True', 'False', 'class',
  'try', 'except', 'finally', 'with', 'lambda', 'yield', 'pass', 'break',
  'continue', 'global', 'raise', 'assert', 'del', 'async', 'await',
]

const PY_BUILTINS = [
  'print', 'len', 'range', 'sorted', 'reversed', 'sum', 'min', 'max', 'map',
  'filter', 'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'enumerate', 'zip', 'round', 'abs', 'type', 'isinstance', 'any', 'all',
]

const PY_SNIPPETS: { label: string; body: string; detail: string }[] = [
  {
    label: 'transform(input)',
    body: 'def transform(input):\n    rows = input["rows"]\n    ${1}\n    return rows',
    detail: 'workbook entry point',
  },
  {
    label: 'input["rows"] / datasets',
    body: 'input["datasets"]["${1:Dataset Name}"]',
    detail: 'access any input dataset',
  },
  {
    label: 'sorted · key',
    body: 'rows = sorted(rows, key=lambda r: ${1:r["column"]})',
    detail: 'sort rows by a key',
  },
  {
    label: 'for · rows',
    body: 'for ${1:row} in rows:\n    ${2}',
    detail: 'iterate over rows',
  },
  {
    label: 'try / except',
    body: 'try:\n    ${1}\nexcept ${2:Exception} as e:\n    print(f"failed: {e}")',
    detail: 'error handling',
  },
]

const JS_SNIPPETS: { label: string; body: string; detail: string }[] = [
  {
    label: 'preview first rows',
    body: 'return input.rows.slice(0, ${1:10})',
    detail: 'pass the first rows through',
  },
  {
    label: 'map · add a column',
    body: 'return input.rows.map((row) => ({\n  ...row,\n  ${1:newColumn}: ${2:row.quantity * row.unitPrice},\n}))',
    detail: 'derive a column per row',
  },
  {
    label: 'filter · rows',
    body: 'return input.rows.filter((row) => ${1:row.status !== "delivered"})',
    detail: 'keep matching rows',
  },
  {
    label: 'input.datasets["…"]',
    body: 'input.datasets["${1:Dataset Name}"]',
    detail: 'access any input dataset',
  },
]

// ── Providers (registered once per Monaco load) ───────────────────────
// The SQL provider reads the latest schema through sqlSchemaRef so fresh
// dataset columns never require re-registration.

let providersRegistered = false
let sqlSchemaRef: SchemaTable[] = []

function wordRange(model: Monaco['editor']['ITextModel'], position: { lineNumber: number; column: number }): IRange {
  const word = model.getWordUntilPosition(position)
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  }
}

function ensureProviders(monaco: Monaco) {
  if (providersRegistered) return
  providersRegistered = true

  // JavaScript runs as the body of function(input){…} — the TS worker's
  // syntax validator would flag the top-level `return`, so diagnostics are
  // silenced (highlighting + completions stay fully active).
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  })

  // ── SQL: keywords + functions + schema tables/columns + snippets ──
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model: MonacoEditorNS.ITextModel, position: Position) => {
      const range = wordRange(model, position)
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      const items: MonacoLanguagesNS.CompletionItem[] = []

      // After a dot (or `alias.`) → columns only, scoped to the table when
      // the identifier before the dot matches one.
      const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.$/.exec(line)
      if (dotMatch) {
        const table = sqlSchemaRef.find(
          (t) => t.name.toLowerCase() === dotMatch[1].toLowerCase(),
        )
        const sources = table ? [table] : sqlSchemaRef
        for (const t of sources) {
          for (const c of t.columns) {
            items.push({
              label: c.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: c.name,
              detail: `${t.name} · ${c.type}`,
              range,
              sortText: `0${c.name}`,
            })
          }
        }
        return { suggestions: items }
      }

      for (const t of sqlSchemaRef) {
        items.push({
          label: t.name,
          kind: monaco.languages.CompletionItemKind.Class,
          insertText: t.name,
          detail: `dataset · ${t.columns.length} columns`,
          range,
          sortText: `0${t.name}`,
        })
      }
      for (const s of SQL_SNIPPETS) {
        items.push({
          label: s.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: s.detail,
          range,
          sortText: `1${s.label}`,
        })
      }
      for (const kw of SQL_KEYWORDS) {
        items.push({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw,
          detail: 'SQL keyword',
          range,
          sortText: `2${kw}`,
        })
      }
      for (const fn of SQL_FUNCTIONS) {
        items.push({
          label: fn,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: `${fn.toLowerCase()}($1)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: 'function',
          range,
          sortText: `3${fn}`,
        })
      }
      return { suggestions: items }
    },
  })

  // ── Python: keywords + builtins + workbook snippets ──
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '"', "'"],
    provideCompletionItems: (model: MonacoEditorNS.ITextModel, position: Position) => {
      const range = wordRange(model, position)
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      const items: MonacoLanguagesNS.CompletionItem[] = []

      // `input["…"]` → dataset names, `input["datasets"]["…"]` too.
      if (/input\["(datasets"\]\[")?$/.test(line.replace(/\s/g, '')) && sqlSchemaRef.length) {
        for (const t of sqlSchemaRef) {
          items.push({
            label: t.name,
            kind: monaco.languages.CompletionItemKind.Value,
            insertText: t.name,
            detail: `dataset · ${t.columns.length} columns`,
            range,
            sortText: `0${t.name}`,
          })
        }
      }

      for (const s of PY_SNIPPETS) {
        items.push({
          label: s.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: s.detail,
          range,
          sortText: `1${s.label}`,
        })
      }
      for (const kw of PY_KEYWORDS) {
        items.push({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw,
          detail: 'keyword',
          range,
          sortText: `2${kw}`,
        })
      }
      for (const b of PY_BUILTINS) {
        items.push({
          label: b,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: b,
          detail: 'builtin',
          range,
          sortText: `3${b}`,
        })
      }
      return { suggestions: items }
    },
  })

  // ── JavaScript: workbook-shaped snippets (TS worker already gives
  //    general completions + word-based suggestions) ──
  monaco.languages.registerCompletionItemProvider('javascript', {
    triggerCharacters: ['.', '"', "'"],
    provideCompletionItems: (model: MonacoEditorNS.ITextModel, position: Position) => {
      const range = wordRange(model, position)
      const items: MonacoLanguagesNS.CompletionItem[] = JS_SNIPPETS.map((s) => ({
        label: s.label,
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText: s.body,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        detail: s.detail,
        range,
        sortText: `1${s.label}`,
      }))
      return { suggestions: items }
    },
  })
}

// ── Options ────────────────────────────────────────────────────────────

const FONT_STACK =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"

function buildOptions(
  variant: 'full' | 'compact',
  fontSize: number,
  readOnly: boolean,
  ariaLabel?: string,
  placeholder?: string,
): MonacoEditorNS.IStandaloneEditorConstructionOptions {
  const base: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
    fontSize,
    lineHeight: Math.round(fontSize * 1.55),
    fontFamily: FONT_STACK,
    readOnly,
    ariaLabel,
    placeholder,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    cursorWidth: 2,
    renderLineHighlight: 'all',
    renderLineHighlightOnlyWhenFocus: true,
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    matchBrackets: 'near',
    tabSize: 2,
    insertSpaces: true,
    fixedOverflowWidgets: true,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    stickyScroll: { enabled: false },
    overviewRulerBorder: false,
    contextmenu: true,
  }

  if (variant === 'compact') {
    return {
      ...base,
      lineNumbers: 'off',
      lineDecorationsWidth: 12,
      folding: false,
      minimap: { enabled: false },
      renderLineHighlight: 'none',
      guides: { indentation: false },
      wordWrap: 'on',
      padding: { top: 8, bottom: 8 },
      overviewRulerLanes: 0,
      scrollbar: {
        ...base.scrollbar,
        vertical: 'auto',
        alwaysConsumeMouseWheel: false,
      },
    }
  }

  return {
    ...base,
    lineNumbersMinChars: 3,
    glyphMargin: false,
    // Narrow screens: the minimap eats precious horizontal space.
    minimap: {
      enabled: !(typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches),
      renderCharacters: false,
      maxColumn: 90,
    },
    folding: true,
    wordWrap: 'off',
    padding: { top: 10, bottom: 10 },
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestSelection: 'first',
    acceptSuggestionOnEnter: 'on',
    parameterHints: { enabled: true },
    wordBasedSuggestions: 'currentDocument',
    suggestFontSize: fontSize - 1,
  }
}

// ── Component ──────────────────────────────────────────────────────────

export function CodeEditor({
  value,
  onChange,
  language = 'plaintext',
  variant = 'full',
  fontSize,
  readOnly = false,
  placeholder,
  ariaLabel,
  onRun,
  onSave,
  schemaTables,
  className,
}: CodeEditorProps) {
  // Dual-theme: pick the Monaco theme from the app theme (next-themes).
  // The <MonacoEditor/> wrapper re-applies the `theme` prop on change
  // (monaco.editor.setTheme), so a light↔dark switch re-skins live editors.
  const { resolvedTheme } = useTheme()
  const monacoTheme = resolvedTheme === 'dark' ? 'minifoundry' : 'minifoundry-light'

  // Settings preference (Task 12-d): callers may pin a size; otherwise the
  // workspace-wide editor font size from /settings applies.
  const [preferredFontSize] = useEditorFontSize()
  const effectiveFontSize = fontSize ?? preferredFontSize

  // Keep the latest schema/handlers reachable from stable closures.
  const onRunRef = useRef(onRun)
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    sqlSchemaRef = schemaTables ?? []
    onRunRef.current = onRun
    onSaveRef.current = onSave
  })

  return (
    <div className={cn('relative w-full overflow-hidden', className)}>
      <MonacoEditor
        height="100%"
        width="100%"
        language={language}
        theme={monacoTheme}
        value={value ?? ''}
        onChange={(v) => onChange?.(v ?? '')}
        beforeMount={(monaco) => {
          defineFoundryThemes(monaco)
          ensureProviders(monaco)
        }}
        onMount={(editor, monaco) => {
          if (onRun) {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
              onRunRef.current?.(),
            )
          }
          if (onSave) {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
              onSaveRef.current?.(),
            )
          }
        }}
        options={buildOptions(variant, effectiveFontSize, readOnly, ariaLabel, placeholder)}
      />
    </div>
  )
}
