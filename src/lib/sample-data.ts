// MiniFoundry — built-in supply-chain sample packs + demo pipeline definition.
// All data is hand-authored and deterministic (no randomness, no external fetch),
// so seeds produce identical datasets on every run.

export type SampleRow = Record<string, unknown>

export interface SamplePack {
  name: string
  description: string
  rows: SampleRow[]
}

// ─── Suppliers (12 rows) ─────────────────────────────────────────────

const SUPPLIERS: SampleRow[] = [
  { id: 'SUP-001', name: 'Nordwind Elektronik', country: 'Germany', region: 'EMEA', rating: 4.6, leadTimeDays: 12, onTimePct: 97.2 },
  { id: 'SUP-002', name: 'Shenzhen BrightPath Electronics', country: 'China', region: 'APAC', rating: 4.2, leadTimeDays: 21, onTimePct: 94.8 },
  { id: 'SUP-003', name: 'Osaka Precision Parts', country: 'Japan', region: 'APAC', rating: 4.8, leadTimeDays: 9, onTimePct: 98.6 },
  { id: 'SUP-004', name: 'Austin Circuit Works', country: 'United States', region: 'NA', rating: 4.1, leadTimeDays: 14, onTimePct: 95.1 },
  { id: 'SUP-005', name: 'Cheonan Display Co.', country: 'South Korea', region: 'APAC', rating: 4.5, leadTimeDays: 11, onTimePct: 96.4 },
  { id: 'SUP-006', name: 'Penang MicroAssembly', country: 'Malaysia', region: 'APAC', rating: 3.9, leadTimeDays: 18, onTimePct: 92.7 },
  { id: 'SUP-007', name: 'Torino Metalworks', country: 'Italy', region: 'EMEA', rating: 3.7, leadTimeDays: 16, onTimePct: 90.3 },
  { id: 'SUP-008', name: 'Guadalajara Wiredev', country: 'Mexico', region: 'LATAM', rating: 3.8, leadTimeDays: 15, onTimePct: 91.5 },
  { id: 'SUP-009', name: 'Hanoi FlexTech', country: 'Vietnam', region: 'APAC', rating: 3.6, leadTimeDays: 24, onTimePct: 88.9 },
  { id: 'SUP-010', name: 'Eindhoven Photonix', country: 'Netherlands', region: 'EMEA', rating: 4.7, leadTimeDays: 10, onTimePct: 97.8 },
  { id: 'SUP-011', name: 'Gdansk Cable Systems', country: 'Poland', region: 'EMEA', rating: 4.0, leadTimeDays: 13, onTimePct: 93.4 },
  { id: 'SUP-012', name: 'Chennai VoltSource', country: 'India', region: 'APAC', rating: 3.5, leadTimeDays: 26, onTimePct: 87.2 },
]

// ─── Warehouses (6 rows) ─────────────────────────────────────────────

const WAREHOUSES: SampleRow[] = [
  { id: 'WH-01', name: 'Rotterdam Hub', city: 'Rotterdam', country: 'Netherlands', capacity: 42000 },
  { id: 'WH-02', name: 'Singapore Central', city: 'Singapore', country: 'Singapore', capacity: 58000 },
  { id: 'WH-03', name: 'Chicago Midway DC', city: 'Chicago', country: 'United States', capacity: 51000 },
  { id: 'WH-04', name: 'Hamburg Nord Depot', city: 'Hamburg', country: 'Germany', capacity: 36000 },
  { id: 'WH-05', name: 'Shenzhen South Bonded', city: 'Shenzhen', country: 'China', capacity: 64000 },
  { id: 'WH-06', name: 'Monterrey Crossdock', city: 'Monterrey', country: 'Mexico', capacity: 28000 },
]

// ─── Product catalog (drives shipments + inventory) ──────────────────

interface CatalogEntry {
  sku: string
  productName: string
  category: 'Electronics' | 'Components' | 'Materials'
  basePrice: number
}

const CATALOG: CatalogEntry[] = [
  { sku: 'SKU-1001', productName: 'Microcontroller MCU-32', category: 'Electronics', basePrice: 12.4 },
  { sku: 'SKU-1002', productName: 'OLED Display 2.4in', category: 'Electronics', basePrice: 23.9 },
  { sku: 'SKU-1003', productName: 'LiPo Battery 3000mAh', category: 'Electronics', basePrice: 18.75 },
  { sku: 'SKU-1004', productName: 'WiFi Module X2', category: 'Electronics', basePrice: 9.6 },
  { sku: 'SKU-1005', productName: 'GPS Sensor Patch', category: 'Electronics', basePrice: 15.2 },
  { sku: 'SKU-2001', productName: 'Ceramic Capacitor C1206', category: 'Components', basePrice: 0.42 },
  { sku: 'SKU-2002', productName: 'Resistor Array 10K', category: 'Components', basePrice: 0.18 },
  { sku: 'SKU-2003', productName: 'PCB Substrate 4L', category: 'Components', basePrice: 3.85 },
  { sku: 'SKU-2004', productName: 'Ribbon Cable 20P', category: 'Components', basePrice: 2.3 },
  { sku: 'SKU-2005', productName: 'Crystal Osc 16MHz', category: 'Components', basePrice: 0.65 },
  { sku: 'SKU-3001', productName: 'Aluminum Sheet 1mm', category: 'Materials', basePrice: 8.9 },
  { sku: 'SKU-3002', productName: 'Copper Wire 0.5mm', category: 'Materials', basePrice: 12.4 },
  { sku: 'SKU-3003', productName: 'ABS Pellets FR', category: 'Materials', basePrice: 4.15 },
  { sku: 'SKU-3004', productName: 'Thermal Paste GX', category: 'Materials', basePrice: 6.3 },
  { sku: 'SKU-3005', productName: 'Steel Casing Frame', category: 'Materials', basePrice: 19.8 },
]

// Status mix: ~40% delivered, ~30% in_transit, ~20% delayed, ~10% customs
const STATUS_CYCLE = [
  'delivered', 'in_transit', 'delivered', 'delayed', 'in_transit',
  'delivered', 'customs', 'delivered', 'in_transit', 'delayed',
] as const

const round2 = (n: number) => Math.round(n * 100) / 100

// ─── Shipments (60 rows, deterministic) ──────────────────────────────

const SHIPMENTS: SampleRow[] = Array.from({ length: 60 }, (_, i) => {
  const supplierIdx = (i * 7 + 3) % 12
  const warehouseIdx = (i * 3 + 1) % 6
  const entry = CATALOG[i % CATALOG.length]
  const quantity = 40 + ((i * 137) % 1960)
  const priceFactor = 1 + (((i % 5) - 2) * 0.03)
  const shipDate = new Date(Date.UTC(2024, 10, 4 + i)).toISOString().slice(0, 10)
  return {
    id: `SHP-${String(i + 1).padStart(4, '0')}`,
    supplierId: SUPPLIERS[supplierIdx].id as string,
    warehouseId: WAREHOUSES[warehouseIdx].id as string,
    sku: entry.sku,
    productName: entry.productName,
    category: entry.category,
    quantity,
    unitPrice: round2(entry.basePrice * priceFactor),
    status: STATUS_CYCLE[i % STATUS_CYCLE.length],
    shipDate,
    etaDays: 3 + ((i * 5) % 28),
  }
})

// ─── Inventory (40 rows, deterministic, unique sku+warehouse pairs) ──

const INVENTORY: SampleRow[] = Array.from({ length: 40 }, (_, i) => {
  const warehouseIdx = i % 6
  const entry = CATALOG[(Math.floor(i / 6) * 2 + (i % 2)) % CATALOG.length]
  const stock = 120 + ((i * 211) % 2400)
  const reorderPoint = 50 + ((i * 97) % 400)
  const costFactor = 0.8 + (i % 4) * 0.05
  return {
    sku: entry.sku,
    productName: entry.productName,
    warehouseId: WAREHOUSES[warehouseIdx].id as string,
    stock,
    reorderPoint,
    unitCost: round2(entry.basePrice * costFactor),
  }
})

// ─── Sample packs registry ───────────────────────────────────────────

export const SAMPLE_PACKS: Record<string, SamplePack> = {
  suppliers: {
    name: 'Suppliers',
    description: 'Global supplier master with ratings, lead times and on-time delivery %.',
    rows: SUPPLIERS,
  },
  warehouses: {
    name: 'Warehouses',
    description: 'Warehouse master with locations and storage capacity.',
    rows: WAREHOUSES,
  },
  shipments: {
    name: 'Shipments',
    description: 'Shipment line items with supplier, warehouse, SKU, status and ETA.',
    rows: SHIPMENTS,
  },
  inventory: {
    name: 'Inventory',
    description: 'Stock levels per SKU and warehouse with reorder points and unit cost.',
    rows: INVENTORY,
  },
}

// ─── Demo pipeline ───────────────────────────────────────────────────
// NOTE: datasetId uses the "__SHIPMENTS__" placeholder; src/lib/seed.ts
// replaces it with the real dataset id at seed time.

export interface DemoPipelineDef {
  name: string
  description: string
  graph: {
    nodes: { id: string; type: string; data: Record<string, unknown>; position: { x: number; y: number } }[]
    edges: { id: string; source: string; target: string }[]
  }
}

export const DEMO_PIPELINE: DemoPipelineDef = {
  name: 'Shipment Overview',
  description: 'Derive total value per shipment line, then filter out delivered shipments.',
  graph: {
    nodes: [
      {
        id: 'src-shipments',
        type: 'source',
        data: { datasetId: '__SHIPMENTS__' },
        position: { x: 80, y: 200 },
      },
      {
        id: 'derive-total-value',
        type: 'derive',
        data: { newColumn: 'totalValue', expression: 'row.quantity * row.unitPrice' },
        position: { x: 360, y: 200 },
      },
      {
        id: 'filter-not-delivered',
        type: 'filter',
        data: { column: 'status', operator: 'neq', value: 'delivered' },
        position: { x: 640, y: 200 },
      },
      {
        id: 'output-active-shipments',
        type: 'output',
        data: { name: 'Active Shipments' },
        position: { x: 920, y: 200 },
      },
    ],
    edges: [
      { id: 'edge-1', source: 'src-shipments', target: 'derive-total-value' },
      { id: 'edge-2', source: 'derive-total-value', target: 'filter-not-delivered' },
      { id: 'edge-3', source: 'filter-not-delivered', target: 'output-active-shipments' },
    ],
  },
}
