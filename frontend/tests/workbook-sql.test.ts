import { expect, test } from 'bun:test'
import { workbookSqlStarter, workbookTableNames } from '../src/lib/workbook-sql'

test('SQL bindings match the compute engine including reserved names and collisions', () => {
  expect(workbookTableNames(['Active Shipments', 'Dataset', 'dataset', 'Ünïcode Náme', '', '123'])).toEqual([
    'active_shipments', 'dataset_2', 'dataset_3', '_n_code_n_me', 'table', '123',
  ])
})

test('starter SQL refers to the selected first input and supports no-input workbooks', () => {
  expect(workbookSqlStarter(['123'])).toBe('SELECT *\nFROM "123"\nLIMIT 20')
  expect(workbookSqlStarter([])).toBe('SELECT 1 AS example')
})
