'use client'

import { useMemo, useState } from 'react'
import Link from '@/components/link'
import { Check, Copy, Database, ExternalLink, Globe, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type SourceKind = 'Direct URL' | 'Download file' | 'Discover'
type Source = {
  name: string
  kind: SourceKind
  topic: string
  url: string
  summary: string
  use: string
  access?: string
  example?: { url: string; format: 'JSON' | 'CSV'; dataPath?: string }
}

// Platform links and example endpoints only. This page does not generate or seed data.
const SOURCES: Source[] = [
  {
    name: 'JSONPlaceholder', kind: 'Direct URL', topic: 'Practice API',
    url: 'https://jsonplaceholder.typicode.com/',
    summary: 'A public practice API with users, posts, comments, and other related records.',
    use: 'Paste the example URL into a JSON REST connector. Try users and posts as two datasets.',
    example: { url: 'https://jsonplaceholder.typicode.com/users', format: 'JSON' },
  },
  {
    name: 'Open Library', kind: 'Direct URL', topic: 'Books',
    url: 'https://openlibrary.org/dev/docs/api/search',
    summary: 'Book and author records from the Open Library search API.',
    use: 'Use a JSON REST connector and set Data path to docs.',
    example: {
      url: 'https://openlibrary.org/search.json?q=data+engineering&fields=key,title,first_publish_year,edition_count&limit=50',
      format: 'JSON', dataPath: 'docs',
    },
  },
  {
    name: 'USGS Earthquake Feeds', kind: 'Direct URL', topic: 'Earthquakes',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/csv.php',
    summary: 'Frequently updated earthquake observations in spreadsheet format.',
    use: 'Paste a feed URL into a CSV REST connector. Use a shorter time window if a feed grows too large.',
    example: { url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.csv', format: 'CSV' },
  },
  {
    name: 'NASA EONET', kind: 'Direct URL', topic: 'Natural events',
    url: 'https://eonet.gsfc.nasa.gov/docs/v3',
    summary: 'NASA metadata for wildfires, storms, volcanoes, and other natural events.',
    use: 'Use a JSON REST connector and set Data path to events.',
    example: { url: 'https://eonet.gsfc.nasa.gov/api/v3/events?limit=50&status=all', format: 'JSON', dataPath: 'events' },
  },
  {
    name: 'NYC Open Data', kind: 'Direct URL', topic: 'City services',
    url: 'https://data.cityofnewyork.us/',
    summary: 'Public city datasets, including 311 service requests and transport data.',
    use: 'Use a small JSON query URL in a REST connector. The example requests 100 rows.',
    example: { url: 'https://data.cityofnewyork.us/resource/fhrw-4uyv.json?$limit=100', format: 'JSON' },
  },
  {
    name: 'Open Brewery DB', kind: 'Direct URL', topic: 'Places',
    url: 'https://api.openbrewerydb.org/docs/',
    summary: 'An open directory of breweries with location and business details.',
    use: 'Paste the example URL into a JSON REST connector.',
    example: { url: 'https://api.openbrewerydb.org/v1/breweries?per_page=50', format: 'JSON' },
  },
  {
    name: 'Vega Datasets', kind: 'Direct URL', topic: 'Teaching data',
    url: 'https://github.com/vega/vega-datasets',
    summary: 'Small datasets used by Vega and other visualization tools.',
    use: 'Use the direct JSON URL in a REST connector, or download a CSV/JSON file from the repository.',
    example: { url: 'https://vega.github.io/vega-datasets/data/cars.json', format: 'JSON' },
  },
  {
    name: 'Kaggle Datasets', kind: 'Download file', topic: 'Many topics',
    url: 'https://www.kaggle.com/datasets', access: 'Account may be needed',
    summary: 'Community datasets across business, sports, science, and machine learning.',
    use: 'Download a dataset, extract it if zipped, then upload a CSV or JSON file on Connectors.',
  },
  {
    name: 'UCI Machine Learning Repository', kind: 'Download file', topic: 'Machine learning',
    url: 'https://archive.ics.uci.edu/datasets',
    summary: 'Research and teaching datasets, including many small tabular collections.',
    use: 'Choose a dataset with a CSV or JSON file, extract any ZIP, then upload the file.',
  },
  {
    name: 'Our World in Data', kind: 'Download file', topic: 'Global trends',
    url: 'https://ourworldindata.org/',
    summary: 'Charts and data on health, population, energy, and the environment.',
    use: 'Open a chart, download its displayed data as CSV, extract it if needed, then upload.',
  },
  {
    name: 'Data.gov', kind: 'Download file', topic: 'US public data',
    url: 'https://catalog.data.gov/',
    summary: 'A catalog of datasets published by US government organizations.',
    use: 'Follow a dataset to the publisher, download a CSV or JSON resource, then upload it.',
  },
  {
    name: 'World Bank Open Data', kind: 'Download file', topic: 'Development',
    url: 'https://data.worldbank.org/',
    summary: 'Country indicators covering population, economy, health, and education.',
    use: 'Choose an indicator, download CSV, extract the ZIP if provided, then upload a manageable file.',
  },
  {
    name: 'Eurostat', kind: 'Download file', topic: 'Europe',
    url: 'https://ec.europa.eu/eurostat/databrowser/',
    summary: 'European statistics on regions, employment, trade, and more.',
    use: 'Use the data browser to download a CSV subset, then upload the CSV.',
  },
  {
    name: 'FRED', kind: 'Download file', topic: 'Economics',
    url: 'https://fred.stlouisfed.org/',
    summary: 'Economic time series from the Federal Reserve Bank of St. Louis.',
    use: 'Find a series, download observations as CSV, then upload the file.',
  },
  {
    name: 'Hugging Face Datasets', kind: 'Download file', topic: 'AI and text',
    url: 'https://huggingface.co/datasets', access: 'Some datasets are gated',
    summary: 'Community datasets for text, audio, images, and tabular tasks.',
    use: 'Choose a public, small tabular CSV or JSON file from a dataset repository and upload it.',
  },
  {
    name: 'OpenML', kind: 'Download file', topic: 'Machine learning',
    url: 'https://www.openml.org/search?type=data',
    summary: 'A searchable collection of machine learning datasets and tasks.',
    use: 'Download a dataset and export it to CSV if its original file is ARFF, then upload.',
  },
  {
    name: 'Zenodo', kind: 'Download file', topic: 'Research',
    url: 'https://zenodo.org/',
    summary: 'Research datasets and supporting files shared by their authors.',
    use: 'Find a record with a CSV or JSON file, check its license, download the file, then upload.',
  },
  {
    name: 'UNdata', kind: 'Download file', topic: 'Global statistics',
    url: 'https://data.un.org/',
    summary: 'Statistical tables from United Nations data sources.',
    use: 'Choose a table with a CSV download, save it locally, then upload the CSV.',
  },
  {
    name: 'CDC Data', kind: 'Download file', topic: 'Public health',
    url: 'https://data.cdc.gov/',
    summary: 'US public health datasets and dashboards.',
    use: 'Choose a tabular dataset and download a CSV subset for upload.',
  },
  {
    name: 'NASA Open Data', kind: 'Download file', topic: 'Space and Earth',
    url: 'https://data.nasa.gov/',
    summary: 'NASA public datasets on missions, research, and Earth observation.',
    use: 'Find a dataset with a CSV or JSON download and upload that file.',
  },
  {
    name: 'Google Dataset Search', kind: 'Discover', topic: 'Search engine',
    url: 'https://datasetsearch.research.google.com/',
    summary: 'Searches datasets hosted across many different repositories.',
    use: 'Open a result at its publisher, then look for a CSV/JSON download or a direct public URL.',
  },
  {
    name: 'GitHub', kind: 'Discover', topic: 'Code repositories',
    url: 'https://github.com/search?q=dataset+csv&type=repositories',
    summary: 'Many projects publish small example data files alongside their code.',
    use: 'Find a CSV or JSON file, review its license, then download and upload it. Use a raw file URL for REST.',
  },
]

const FILTERS: Array<'All' | SourceKind> = ['All', 'Direct URL', 'Download file', 'Discover']

export default function DataSourcesPage() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All')
  const [copied, setCopied] = useState<string | null>(null)
  const shown = useMemo(() => {
    const search = query.trim().toLowerCase()
    return SOURCES.filter((source) =>
      (filter === 'All' || source.kind === filter) &&
      (!search || `${source.name} ${source.topic} ${source.summary}`.toLowerCase().includes(search)),
    )
  }, [filter, query])

  async function copyUrl(source: Source) {
    if (!source.example) return
    try {
      await navigator.clipboard.writeText(source.example.url)
      setCopied(source.name)
      window.setTimeout(() => setCopied((current) => current === source.name ? null : current), 2000)
    } catch {
      setCopied(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-8">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Database className="size-4 text-muted-foreground" aria-hidden />
            <h1 className="text-sm font-medium tracking-tight">Sample data &amp; sources</h1>
            <span className="font-mono text-xs text-muted-foreground">{SOURCES.length} platforms</span>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            A learning gallery of public data you can bring into MiniFoundry. These are examples,
            not connected or managed platform data; use Connectors to import your own data.
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="h-8 text-xs">
          <Link href="/connectors">Open Connectors</Link>
        </Button>
      </div>

      <div className="mb-5 grid gap-3 rounded-lg border border-border bg-muted/30 p-4 text-xs text-muted-foreground sm:grid-cols-3">
        <p><span className="font-medium text-foreground">1. Pick a platform.</span> Use Direct URL for a live REST connector, or download a CSV/JSON file.</p>
        <p><span className="font-medium text-foreground">2. Import it.</span> Open Connectors, test a REST URL or upload the file.</p>
        <p><span className="font-medium text-foreground">3. Explore.</span> Inspect the versioned dataset, then build a transform, pipeline, or dashboard.</p>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search platforms or topics..." aria-label="Search data platforms" className="pl-8 text-sm" />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter data platforms">
          {FILTERS.map((item) => (
            <Button key={item} variant={filter === item ? 'secondary' : 'ghost'} size="sm" className="h-8 text-xs" onClick={() => setFilter(item)} aria-pressed={filter === item}>
              {item}
            </Button>
          ))}
        </div>
      </div>

      <p className="mb-3 font-mono text-[11px] text-muted-foreground">Showing {shown.length} platforms</p>
      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No platforms match that search.</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {shown.map((source) => (
            <Card key={source.name} className="flex min-w-0 flex-col">
              <CardHeader className="p-4 pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {source.name}
                  </CardTitle>
                  <Badge variant="outline" className="font-normal text-[10px]">{source.kind}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{source.topic}{source.access ? ` · ${source.access}` : ''}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3 p-4 pt-1 text-xs">
                <p className="text-foreground">{source.summary}</p>
                <p className="text-muted-foreground"><span className="font-medium text-foreground">Use here:</span> {source.use}</p>
                {source.example && (
                  <div className="rounded-md border border-border bg-muted/40 p-2.5">
                    <p className="mb-1 font-medium text-muted-foreground">
                      Example {source.example.format} URL{source.example.dataPath ? ` · Data path: ${source.example.dataPath}` : ''}
                    </p>
                    <code className="block break-all font-mono text-[11px] text-foreground">{source.example.url}</code>
                  </div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  <Button asChild variant="outline" size="sm" className="h-8 text-xs">
                    <a href={source.url} target="_blank" rel="noopener noreferrer">Visit platform <ExternalLink className="size-3" aria-hidden /></a>
                  </Button>
                  {source.example && (
                    <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => void copyUrl(source)} aria-label={`Copy ${source.name} example URL`}>
                      {copied === source.name ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
                      {copied === source.name ? 'Copied' : 'Copy URL'}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="mt-5 text-xs text-muted-foreground">
        REST connectors accept public CSV or JSON URLs with a 10-second fetch limit, a 2 MB response limit,
        and at most 5,000 rows. Downloads may need extracting or narrowing before upload. Check each
        source&apos;s license and access terms.
      </p>
    </div>
  )
}
