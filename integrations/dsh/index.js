/**
 * travel-archive ↔ DeepSeek Harness — five read-only tools over the local job
 * server in `pipeline/`.
 *
 * **Why HTTP and not imports.** The server is the only writer of the archive
 * (`docs/invariants.md`): a plugin that opened `index.json` itself would be a
 * second reader that silently disagrees with it, and the one thing this archive
 * refuses to put on disk — the decrypted screenshot descriptions — only exists
 * behind that server, opened in the reader.
 *
 * **Why no `@deepseek-ai/*` imports.** A profile plugin resolves from its own
 * directory outward, which lands inside `app.asar`, which the ESM linker cannot
 * enter. Plain JS with `node:` built-ins is the shape that loads.
 *
 * **Why everything falls back to `pipeline/data`.** With no server running the
 * mirror holds identical bytes (a save writes local first), so the tools keep
 * answering — labelled, never silently — instead of failing shut. What the
 * mirror cannot answer (the job table, `/health`) says so and names the command
 * that starts the server.
 *
 * Read-only on purpose: every route used here is a GET, no job is ever started
 * (`analyze` spends money), and nothing writes. `grep -nE 'method|POST|PUT|PATCH|DELETE'`
 * over this file finds no request that could change the archive.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable plugin name for diagnostics. */
export const name = 'travel-archive'

/** Hard dependency: without the tool registry this plugin does nothing. */
export const inject = ['tools']

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** The mirror's default home, used when nothing points at it explicitly. */
const DEFAULT_DATA_DIR = join(MODULE_DIR, '..', '..', 'pipeline', 'data')

const START_HINT = 'start it: npm run build -w pipeline && npm run serve -w pipeline'

/** The schema this file was written against; a newer index is reported, not trusted. */
const KNOWN_SCHEMA_VERSION = 14

/** One tool call may return this much text — past it a result is narrowed, not dumped. */
const OUT_LIMIT = 4000

/** And this many rows. */
const ROWS_LIMIT = 30

/**
 * Brief rows (date · place · id, no caption) are a third of the height, so a
 * page of them covers a day or a list of places without paging — as long as the
 * page still fits in one answer: 40 rows of a long id is what `OUT_LIMIT` holds.
 */
const BRIEF_ROWS_LIMIT = 40

/** `lang` reads month shards instead of `search.json`, so its range is bounded. */
const LANG_MONTHS_LIMIT = 12

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:18419',
  timeoutMs: 8_000,
  cacheTtlMs: 5 * 60_000,
}

/** Resolved once in `apply`; Cordis restarts the plugin when the row's config changes. */
let CFG = { ...DEFAULTS, dataDir: DEFAULT_DATA_DIR }

/**
 * A failure this plugin decided on.
 *
 * `kind` is what the caller needs to know: `offline` means the server could not
 * be reached (a mirror was tried, or this route has none), `server` means it
 * answered and refused — which must not be retried from disk, because a 421 or a
 * 403 is a statement about who is asking, not about availability.
 */
class ArchiveError extends Error {
  constructor(kind, message, status = 0) {
    super(message)
    this.name = 'ArchiveError'
    this.kind = kind
    /** The HTTP status, when the server answered with one. */
    this.status = status
  }
}

/* --- textKey ------------------------------------------------------------- */

/**
 * `textKey` from `shared/src/types.ts` (cyrb53, 53 bits, base 36), copied
 * verbatim — translation files are keyed by it, so an implementation that is
 * merely similar reads every translation as missing.
 *
 * Copied rather than imported because this plugin resolves from the harness's
 * profile, where `@travel-archive/shared` is not installed and the repo's
 * TypeScript would need a build. `smoke.mjs` checks it against the real shard
 * translation file, so a divergence shows up as a failed run, not as silent
 * English.
 */
function textKey(text) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/* --- reading: the server, or the mirror ---------------------------------- */

/** Successful reads only; a failure is retried on the next call. */
const readCache = new Map()

/**
 * When a connection-level failure was last seen, per baseUrl. A half-dead server
 * costs one timeout per route; remembering the miss briefly means the next call
 * answers from the mirror instead of waiting again. Ten seconds, not a minute:
 * the common case is starting the server while using these tools, and a miss
 * remembered for a minute keeps saying "not running" after it started.
 */
const connectFailures = new Map()
const CONNECT_FAILURE_TTL = 10_000

/** The parsed objects are megabytes (index 9.4 MB, search 7.3 MB), so bound them. */
const CACHE_ENTRIES_LIMIT = 24
const CACHE_BYTES_LIMIT = 64 * 1024 * 1024

/** A cheap size for the eviction watermark, without serialising megabytes twice. */
function roughBytes(data) {
  if (!data || typeof data !== 'object') return 1024
  const photos = Array.isArray(data.photos) ? data.photos.length : data.photos && typeof data.photos === 'object' ? Object.keys(data.photos).length : 0
  const entries = data.entries && typeof data.entries === 'object' ? Object.keys(data.entries).length : 0
  const rows = (Array.isArray(data.months) ? data.months.length : 0) + (Array.isArray(data.sections) ? data.sections.length : 0)
  return Math.max(1024, photos * 260 + entries * 160 + rows * 900)
}

/** Insert and keep the map in use order, dropping the oldest past either limit. */
function remember(key, entry) {
  readCache.delete(key)
  readCache.set(key, entry)
  let total = 0
  for (const value of readCache.values()) total += value.bytes ?? 0
  while (readCache.size > CACHE_ENTRIES_LIMIT || total > CACHE_BYTES_LIMIT) {
    const oldest = readCache.keys().next().value
    if (oldest === undefined || oldest === key) break
    total -= readCache.get(oldest)?.bytes ?? 0
    readCache.delete(oldest)
  }
}

/**
 * Where a route's bytes live under `pipeline/data`, or `null` when the answer is
 * the server's alone to give.
 *
 * The mapping is the mirror's own layout (`pipeline/data/index.json`,
 * `photos/<month>.json`, `i18n/<lang>/…`), which is what makes the offline
 * fallback possible at all.
 */
function mirrorPath(route) {
  if (route === '/archive/index') return ['index.json']
  if (route === '/archive/search') return ['search.json']
  let m = /^\/archive\/shard\/(\d{4}-\d{2})$/.exec(route)
  if (m) return ['photos', `${m[1]}.json`]
  m = /^\/archive\/i18n\/([\w-]+)\/index$/.exec(route)
  if (m) return ['i18n', m[1], 'index.json']
  m = /^\/archive\/i18n\/([\w-]+)\/shard\/(\d{4}-\d{2})$/.exec(route)
  if (m) return ['i18n', m[1], 'photos', `${m[2]}.json`]
  return null
}

/** What to do about a status the server chose to answer with. */
function statusHint(status) {
  if (status === 421) {
    return ' — this server only answers a Host that names it (loopback, the machine name, or ARCHIVE_EXTRA_HOSTS). Check baseUrl.'
  }
  if (status === 401 || status === 403) {
    return ' — the server refuses this client: it is bound to loopback and checks both the request host and, for writes, the origin. Nothing was read from disk instead.'
  }
  if (status === 404) return ' — that file is not in the archive (yet).'
  if (status >= 500) return ' — the server failed; its body is above.'
  return ''
}

/** A one-line reason from a fetch rejection, without the multi-line stack `cause` chain. */
function describeNet(error) {
  if (!error) return 'no response'
  const cause = error.cause
  if (cause && typeof cause.code === 'string') return `${error.message} (${cause.code})`
  if (typeof error.code === 'string') return `${error.message} (${error.code})`
  return error.message ?? String(error)
}

/**
 * One JSON route: the server first, the mirror second, and a labelled result
 * either way. Returns `{ data, source: 'server' | 'mirror' }`.
 */
async function readJson(route) {
  // Keyed by where it came from as well as by route: the same route answers
  // differently for a different server or a different mirror.
  const key = `${CFG.baseUrl}|${CFG.dataDir}|${route}`
  const hit = readCache.get(key)
  if (hit && Date.now() - hit.at < CFG.cacheTtlMs) {
    remember(key, hit)
    return hit
  }

  const url = CFG.baseUrl + route
  let offlineReason = null
  const justFailed = connectFailures.get(CFG.baseUrl)
  if (justFailed && Date.now() - justFailed.at < CONNECT_FAILURE_TTL) {
    offlineReason = `${justFailed.reason}, ${Math.round((Date.now() - justFailed.at) / 1000)}s ago`
  } else {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(CFG.timeoutMs),
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const detail = body.trim() ? `\n  ${body.trim().slice(0, 200)}` : ''
        // Refused, not unreachable: falling back would answer a different question.
        throw new ArchiveError('server', `GET ${route} → HTTP ${res.status} ${res.statusText}${statusHint(res.status)}${detail}`, res.status)
      }
      const type = res.headers.get('content-type') ?? ''
      let data
      try {
        data = await res.json()
      } catch (error) {
        // A 200 that is not JSON is a *broken* server, not an absent one. Falling
        // back here would answer from a mirror that may be weeks old — the app
        // hit exactly this against a page that served its SPA shell for any path.
        throw new ArchiveError(
          'server',
          `GET ${route} → HTTP 200 but the body is not JSON (content-type: ${type || 'none'}; ${describeNet(error)}). Not reading the mirror instead: the server is answering, and its answer is wrong.`,
        )
      }
      const entry = { data, source: 'server', at: Date.now(), bytes: Number(res.headers.get('content-length')) || roughBytes(data) }
      connectFailures.delete(CFG.baseUrl)
      remember(key, entry)
      return entry
    } catch (error) {
      if (error instanceof ArchiveError) throw error
      offlineReason = describeNet(error)
      connectFailures.set(CFG.baseUrl, { at: Date.now(), reason: offlineReason })
    }
  }

  const rel = mirrorPath(route)
  if (!rel) {
    throw new ArchiveError(
      'offline',
      `GET ${route} has no mirror file — ${CFG.baseUrl} is not running (${offlineReason}).\n  ${START_HINT}`,
    )
  }

  const path = join(CFG.dataDir, ...rel)
  try {
    const text = await readFile(path, 'utf8')
    const data = JSON.parse(text)
    const entry = { data, source: 'mirror', at: Date.now(), bytes: Buffer.byteLength(text) }
    remember(key, entry)
    return entry
  } catch (error) {
    const why = error && typeof error.code === 'string' ? `${error.code} (${error.message.split('\n')[0]})` : String(error?.message ?? error)
    throw new ArchiveError(
      'offline',
      `${CFG.baseUrl} is not running (${offlineReason}) and the mirror file cannot be read either.\n  mirror: ${path}\n  reason: ${why}\n  ${START_HINT}`,
    )
  }
}

/** The banner every fallback result carries, so no answer pretends to be live. */
function banner(entry) {
  if (entry.source !== 'mirror') return ''
  return `⚠ The server is not running (${CFG.baseUrl}), so this comes from the pipeline/data mirror and may lag OneDrive. ${START_HINT}`
}

/** True when the index is newer than this file understands. */
function schemaWarning(index) {
  const version = Number(index?.schemaVersion)
  if (!Number.isFinite(version) || version <= KNOWN_SCHEMA_VERSION) return ''
  return `⚠ The index is schema ${version}; these tools were written against ${KNOWN_SCHEMA_VERSION}. Missing fields are ignored rather than guessed — upgrade the plugin.`
}

/* --- formatting ---------------------------------------------------------- */

/** How many sections the no-argument listing shows before telling you to narrow. */
const SECTION_LIST_LIMIT = ROWS_LIMIT

/**
 * Cut an answer at the last complete line, so what is left is whole sentences
 * rather than half a stop in a day listing. The count says how much was shown,
 * because "truncated at 4000" is only true if the cut landed on the limit.
 */
function clipText(text) {
  if (text.length <= OUT_LIMIT) return text
  const room = text.slice(0, OUT_LIMIT - 160)
  const lastBreak = room.lastIndexOf('\n')
  const body = lastBreak > room.length / 2 ? room.slice(0, lastBreak) : room
  return `${body}\n… truncated at ${body.length} of ${text.length} characters — narrow it (month=, from/to, limit=, brief).`
}

function int(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function stamp(iso) {
  if (typeof iso !== 'string' || iso.length < 16) return String(iso ?? '—')
  return iso.slice(0, 16).replace('T', ' ')
}

/** `2017-07-17T13:24:06Z` → `13:24`; anything else is passed through. */
function clock(iso) {
  return typeof iso === 'string' && iso.length >= 16 && iso.includes('T') ? iso.slice(11, 16) : String(iso ?? '')
}

function minutes(startedAt, finishedAt) {
  const start = Date.parse(startedAt ?? '')
  const end = Date.parse(finishedAt ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return (end - start) / 60_000
}

function oneLine(text, limit) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

function compact(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function joinParts(parts, separator = ' · ') {
  return parts.filter((p) => typeof p === 'string' && p.trim() !== '').join(separator)
}

/**
 * A short reference for a photo: `p2615` for `2EDA5BB960073185!2615`.
 *
 * Full ids are 30+ characters and get copied by hand between tool calls, so the
 * short form is what the tools print. It is derived from the id (not assigned),
 * which means it stays the same across calls and across languages, and an id
 * that cannot be shortened (screen captures, whose suffix is not a number) is
 * printed in full rather than given a misleading alias.
 */
function aliasOf(id) {
  const short = typeof id === 'string' ? /!(\d+)$/.exec(id) : null
  return short ? `p${short[1]}` : id
}

/** Read an alias back to its bare suffix, so `p2615` and `2615` are one lookup. */
function suffixOf(reference) {
  const alias = /^p(\d+)$/i.exec(reference)
  if (alias) return alias[1]
  return reference.includes('!') ? reference.slice(reference.indexOf('!') + 1) : reference
}

function lines(parts) {
  return parts.filter((l) => typeof l === 'string' && l !== '').join('\n')
}

function number(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : String(n ?? '—')
}

function monthOf(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null
}

/** Inclusive month list between two `YYYY-MM(-DD)` dates. */
function monthsBetween(from, to) {
  const out = []
  let [y, m] = from.slice(0, 7).split('-').map(Number)
  const [ty, tm] = to.slice(0, 7).split('-').map(Number)
  if (!y || !m || !ty || !tm) return out
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
    if (out.length > 600) break
  }
  return out
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isMonth(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)
}

/* --- translations -------------------------------------------------------- */

/**
 * `lang → Map(textKey → translation)` for one of the two sidecar files.
 *
 * Two shapes are in play: the index carries day/trip text plus the owner's
 * hand edits (`owner`, `tripOwner`), a month shard carries captions. Both key on
 * `textKey`, so one reader serves both.
 */
const translationCache = new Map()

async function translationsFor(lang, route) {
  const key = `${CFG.dataDir}|${lang}|${route}`
  const hit = translationCache.get(key)
  if (hit && Date.now() - hit.at < CFG.cacheTtlMs) return hit
  const entry = await readJson(route)
  const file = entry.data ?? {}
  const table = {
    entries: file.entries ?? {},
    owner: file.owner ?? {},
    tripOwner: file.tripOwner ?? {},
  }
  const wrapped = { ...table, source: entry.source, at: Date.now() }
  translationCache.set(key, wrapped)
  return wrapped
}

/**
 * The text to show for one original string, and where it came from.
 *
 * Order: the owner's hand-written edit in that language (a correction always
 * beats a translation), then the translation file, then the original text — so a
 * missing translation degrades to English rather than to nothing.
 */
function translated(table, original, edit) {
  if (typeof edit === 'string' && edit !== '') return { text: edit, via: 'edit' }
  if (typeof original !== 'string' || original === '') return { text: original ?? '', via: 'empty' }
  const entry = table?.entries?.[textKey(original)]
  if (entry && typeof entry.t === 'string' && entry.t !== '') return { text: entry.t, via: entry.via ?? 'mt' }
  return { text: original, via: 'original' }
}

/** Which languages the archive offers, as `{ source, available }`. */
function languagesOf(index) {
  const langs = index?.languages
  if (!langs || typeof langs !== 'object') return { source: 'en', available: [] }
  return {
    source: typeof langs.source === 'string' ? langs.source : 'en',
    available: Array.isArray(langs.available) ? langs.available.filter((l) => typeof l === 'string') : [],
  }
}

/**
 * Which languages the archive actually has.
 *
 * `index.languages` is the intended source, but it is optional and *absent* on
 * archives whose translations were written by an older build — and it is written
 * by whatever pass ran last, so trusting it alone reports "none" over a directory
 * full of `zh-Hans` files. The mirror's `i18n/` directory is the evidence, so the
 * two are unioned: the index names the intent, the disk names what a reader can
 * actually open.
 */
async function existingLanguages(index) {
  const langs = new Set(languagesOf(index).available)
  try {
    const entries = await readdir(join(CFG.dataDir, 'i18n'), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // A directory left behind by a half-finished translation is not a language:
      // it would pass the existence check and then answer every lookup with
      // nothing, which reads as "this archive says nothing about that".
      if (await holdsTranslation(join(CFG.dataDir, 'i18n', entry.name))) langs.add(entry.name)
    }
  } catch {
    // No mirror (or no i18n directory): the index is all there is to go on.
  }
  return [...langs].sort()
}

/** At least one real file, or the language does not exist yet. */
async function holdsTranslation(dir) {
  try {
    if ((await readdir(dir)).includes('index.json')) return true
  } catch {
    return false
  }
  try {
    return (await readdir(join(dir, 'photos'))).some((name) => name.endsWith('.json'))
  } catch {
    return false
  }
}

/**
 * Refuse a language the archive does not have, naming the ones it does — an
 * unknown lang that quietly returned English would be the exact kind of
 * plausible answer `docs/working-style.md` calls out.
 *
 * `lang=<source>` returns `null`: reading the source language *is* reading the
 * originals, and every reader already treats `null` that way. Returning the tag
 * instead sent it looking for `i18n/en/`, which does not exist — a 404 in two
 * tools and a silent "0 hits" in the third.
 */
async function checkLang(index, lang) {
  if (lang === undefined || lang === null || lang === '') return null
  if (typeof lang !== 'string') throw new ArchiveError('usage', 'lang must be a string such as "zh-Hans".')
  const { source } = languagesOf(index)
  if (lang === source) return null
  const available = await existingLanguages(index)
  if (available.includes(lang)) return lang
  const known = available.length ? available.join(', ') : 'none'
  throw new ArchiveError('usage', `No "${lang}" translation in this archive — source is "${source}", available: ${known}. Omit lang to read the original.`)
}

/* --- tool 1: status ------------------------------------------------------ */

async function runStatus() {
  const out = []
  let health = null
  let status = null
  let online = true
  try {
    health = (await readJson('/health')).data
    status = (await readJson('/archive/status')).data
  } catch (error) {
    if (!(error instanceof ArchiveError) || error.kind !== 'offline') throw error
    online = false
    out.push(`⚠ The server is not running (${CFG.baseUrl}). These numbers come from the pipeline/data mirror and may lag OneDrive.`, START_HINT)
  }

  let index = null
  let indexEntry = null
  // No catch: the health call above has already decided whether this archive is
  // reachable at all, so a failure here is the answer, not something to absorb.
  indexEntry = await readJson('/archive/index')
  index = indexEntry.data

  const warning = schemaWarning(index)
  if (warning) out.push(warning)
  if (indexEntry && indexEntry.source === 'mirror' && online) {
    out.push(`⚠ /archive/index was read from the mirror while the server answered other routes (${CFG.baseUrl}) — the mirror may lag.`)
  }

  const months = Array.isArray(index?.months) ? index.months : []
  const sections = Array.isArray(index?.sections) ? index.sections : []
  const langs = languagesOf(index)
  const available = await existingLanguages(index)
  const photoTotal = months.reduce((n, m) => n + (Number(m.photoCount) || 0), 0)
  const analyzedTotal = months.reduce((n, m) => n + (Number(m.analyzedCount) || 0), 0)
  const analyzableTotal = months.reduce((n, m) => n + (Number(m.representativeCount) || 0), 0)
  const daysTotal = sections.reduce((n, s) => n + (Array.isArray(s.days) ? s.days.length : 0), 0)
  const span = months.length ? `${months[0].month} → ${months[months.length - 1].month}` : 'no months'

  if (online) {
    const totals = status?.totals ?? {}
    out.push(joinParts([
      `archive ${compact(health?.version) || 'unknown version'}`,
      'server online',
      CFG.baseUrl,
    ]))
    out.push(joinParts([
      `signed in: ${health?.signedIn ?? status?.signedIn ? 'yes' : 'no'}`,
      `content: ${compact(health?.content) || '—'}`,
      `schema ${compact(status?.schemaVersion ?? index?.schemaVersion)}`,
      `index built ${stamp(index?.generatedAt)}`,
    ]))
    out.push(joinParts([
      `photos ${number(totals.photos ?? photoTotal)}`,
      `analyzed ${number(totals.analyzed ?? analyzedTotal)}`,
      `analyzable ${number(totals.analyzable ?? analyzableTotal)}`,
      `days ${number(totals.days ?? daysTotal)}`,
      `sections ${number(totals.sections ?? sections.length)}`,
      `months ${number((status?.months ?? months).length)} (${span})`,
    ]))
    out.push(`translations: source ${langs.source}, available ${available.length ? available.join(', ') : 'none'}`)
    const running = health?.running
    out.push(running ? `running: ${describeJob(running)}` : 'running: none (one job at a time)')
    const last = health?.lastFinished
    out.push(last ? `last finished: ${describeJob(last, { withLog: false })}` : 'last finished: nothing recorded')
  } else {
    out.push(joinParts([
      `archive schema ${compact(index?.schemaVersion)}`,
      `index built ${stamp(index?.generatedAt)}`,
      `mirror ${CFG.dataDir}`,
    ]))
    out.push(joinParts([
      `photos ${number(photoTotal)}`,
      `analyzed ${number(analyzedTotal)}`,
      `analyzable ${number(analyzableTotal)}`,
      `days ${number(daysTotal)}`,
      `sections ${number(sections.length)}`,
      `months ${number(months.length)} (${span})`,
    ]))
    out.push(`translations: source ${langs.source}, available ${available.length ? available.join(', ') : 'none'}`)
    out.push('running: unknown without the server — the job table lives in its memory. History is in pipeline/data/jobs (<archive_jobs> reads it off disk when offline).')
    const tail = await readTail(join(CFG.dataDir, 'serve.log'), 600)
    if (tail) out.push('', 'serve.log (last lines):', tail)
  }

  out.push('', 'Tools: archive_status · archive_search · archive_trip · archive_photo · archive_jobs (all read-only; no job is ever started)')
  return lines(out)
}

/** One job as a line: what it is, how far, and why it stopped. */
function describeJob(job, { withLog = true } = {}) {
  const progress = job?.progress ?? {}
  // Clamped: a job whose `done` walks backwards would otherwise print 103%.
  const percent =
    Number(progress.total) > 0
      ? Math.max(0, Math.min(100, Math.floor((Number(progress.done) / Number(progress.total)) * 100)))
      : null
  const parts = [
    `${compact(job?.kind) || 'job'} ${compact(job?.status) || ''}`.trim(),
    progress.phase ? compact(progress.phase) : '',
    Number(progress.total) > 0 ? `${percent}% ${number(progress.done)}/${number(progress.total)}` : '',
    progress.message ? `"${oneLine(progress.message, 90)}"` : '',
    // `/health`'s `lastFinished` carries no `startedAt`; a job record does.
    typeof job?.startedAt === 'string' && job.startedAt.length >= 16 ? `started ${stamp(job.startedAt)}` : '',
    typeof job?.startedAt === 'string' && job.startedAt.length >= 16 ? '' : job?.finishedAt ? `finished ${stamp(job.finishedAt)}` : '',
  ]
  const took = minutes(job?.startedAt, job?.finishedAt)
  if (took !== null) parts.push(`${took < 1 ? '<1' : Math.round(took)} min`)
  if (job?.error) parts.push(`error: ${oneLine(job.error, 160)}`)
  const result = job?.result && typeof job.result === 'object' ? Object.entries(job.result).filter(([, v]) => v !== 0) : []
  if (result.length) parts.push(result.map(([k, v]) => `${k}=${v}`).join(' '))
  const log = Array.isArray(job?.log) ? job.log : []
  if (withLog && log.length) parts.push(`last log: ${oneLine(log[log.length - 1], 120)}`)
  return joinParts(parts)
}

/** The tail of a text file, for the offline `serve.log` hint. */
async function readTail(path, maxChars) {
  try {
    const text = await readFile(path, 'utf8')
    const trimmed = text.trimEnd()
    return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed
  } catch {
    return ''
  }
}

/* --- tool 2: search ------------------------------------------------------ */

const MONTH_SCOPE_HINT = `Pass month=YYYY-MM, or from=/to= spanning at most ${LANG_MONTHS_LIMIT} months.`

/**
 * Search the archive.
 *
 * Two routes, because the two indexes hold different text: `search.json` is the
 * fast one but its captions are **lowercased at build time**, so a translation
 * key computed from them matches nothing. Reading a language therefore walks the
 * month shards (original capitalisation) plus that month's translation file, and
 * is bounded to a year of months so one call cannot pull the whole library.
 */
async function runSearch({ q, month, from, to, lang, limit, offset, sort, brief }) {
  const needle = typeof q === 'string' ? q.trim() : ''
  if (!needle) throw new ArchiveError('usage', 'archive_search needs q — a word from a caption, a tag, a place, or a date (YYYY-MM-DD).')

  // `brief` rows carry only date · place · id, so more of them fit in the same
  // output budget: enumerating a day or a list of places is the common case.
  const terse = brief === true
  const rows = int(limit, terse ? 30 : 8, 1, terse ? BRIEF_ROWS_LIMIT : ROWS_LIMIT)
  const skip = int(offset, 0, 0, 100000)
  let order = 'newest'
  if (sort !== undefined && sort !== null && sort !== '') {
    if (sort !== 'newest' && sort !== 'oldest') {
      throw new ArchiveError('usage', `sort must be "newest" or "oldest", got "${sort}".`)
    }
    order = sort
  }
  const searchEntry = await readJson('/archive/search')
  const search = searchEntry.data ?? {}
  const index = (await readJson('/archive/index')).data ?? {}
  const language = await checkLang(index, lang)
  const low = needle.toLowerCase()
  const prefix = typeof search.idPrefix === 'string' ? search.idPrefix : ''

  const photos = Array.isArray(search.photos) ? search.photos : []
  const trips = Array.isArray(search.trips) ? search.trips : []

  /**
   * `date → place`, because `search.json` will not give it: its `days` rows are
   * `[date, blob]` where the blob is the whole day's text (summary and stops
   * pasted together) — good to match against, useless to display. The index's
   * day records hold the real short place name.
   */
  const placeOf = new Map()
  for (const section of Array.isArray(index.sections) ? index.sections : []) {
    for (const day of Array.isArray(section?.days) ? section.days : []) {
      if (typeof day?.date === 'string' && typeof day?.place === 'string' && day.place !== '') placeOf.set(day.date, day.place)
    }
  }

  const out = []
  out.push(banner(searchEntry))

  // A trip name is the shortest path to a whole story, so it is offered first.
  const tripHits = trips.filter((t) => Array.isArray(t) && typeof t[1] === 'string' && t[1].toLowerCase().includes(low))
  if (tripHits.length) {
    out.push(`Trip names matching "${needle}":`)
    for (const t of tripHits.slice(0, 5)) out.push(`  ${t[1]} · ${t[2]} → ${t[3]} · archive_trip id=${t[0]}`)
  }

  let found = []
  let scanned = 0
  let translatedCount = 0

  if (!language) {
    const monthFilter = isMonth(month) ? month : null
    if (month && !monthFilter) throw new ArchiveError('usage', `month must be YYYY-MM, got "${month}".`)
    for (const row of photos) {
      if (!Array.isArray(row)) continue
      const [id, date, blob, tags] = row
      if (typeof date !== 'string') continue
      if (monthFilter && !date.startsWith(monthFilter)) continue
      if (isDate(from) && date < from) continue
      if (isDate(to) && date > to) continue
      scanned += 1
      // `blob` is the caption with the place names appended, and `tags` a
      // space-separated string — both are display-trimmed below, never trusted as
      // the caption a shard would give.
      const tagText = typeof tags === 'string' ? tags : Array.isArray(tags) ? tags.join(' ') : ''
      const haystack = `${blob ?? ''} ${tagText} ${date} ${placeOf.get(date) ?? ''}`
      if (!haystack.toLowerCase().includes(low)) continue
      found.push({ id: `${prefix}${id}`, date, text: compact(blob), place: placeOf.get(date) ?? '' })
    }
  } else {
    const scope = languageMonths({ month, from, to })
    for (const m of scope) {
      let shard
      let table
      try {
        shard = (await readJson(`/archive/shard/${m}`)).data ?? {}
        table = await translationsFor(language, `/archive/i18n/${language}/shard/${m}`)
      } catch (error) {
        // A month with no translation file yet is normal (404) and costs only
        // the translation; a 403, a 421 or a 500 is not, and swallowing it would
        // report fewer hits as if the archive had answered.
        if (error instanceof ArchiveError && error.kind === 'server' && error.status === 404) continue
        throw error
      }
      for (const [id, photo] of Object.entries(shard.photos ?? {})) {
        const date = typeof photo?.takenAt === 'string' ? photo.takenAt.slice(0, 10) : ''
        if (isDate(from) && date < from) continue
        if (isDate(to) && date > to) continue
        scanned += 1
        const original = typeof photo?.caption === 'string' ? photo.caption : ''
        const shown = translated(table, original).text
        if (shown !== original) translatedCount += 1
        const haystack = `${shown} ${original} ${Array.isArray(photo?.tags) ? photo.tags.join(' ') : ''} ${date} ${compact(photo?.place)} ${compact(placeOf.get(date))}`
        if (!haystack.toLowerCase().includes(low)) continue
        found.push({ id, date, text: shown, place: compact(photo?.place) || compact(placeOf.get(date)) })
      }
    }
  }

  // One order for both paths: the date decides, the id breaks the tie.
  found.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (order === 'newest') found.reverse()

  const page = found.slice(skip, skip + rows)
  const scopeText = !language
    ? isMonth(month)
      ? `month ${month}`
      : isDate(from) || isDate(to)
        ? `${from ?? '…'} → ${to ?? '…'}`
        : 'the whole archive'
    : `${language} over ${languageMonths({ month, from, to }).length} month(s)`

  const more = found.length > skip + page.length
  out.push(
    `search "${needle}" in ${scopeText} · ${found.length} hit(s) · ${order === 'newest' ? 'newest first' : 'oldest first'}${more || skip > 0 ? `, showing ${page.length} from offset ${number(skip)}` : ''} · ${terse ? 'brief' : language ? `lang ${language}` : 'lang original'} · scanned ${number(scanned)} photo(s)`,
  )
  if (found.length === 0) {
    out.push(
      `No match. Searched ${number(scanned)} photo(s) in ${scopeText}${photos.length === 0 ? ' — search.json is empty, so the archive may never have been scanned' : ''}.`,
      `Try a different word, widen the scope, or check the index date with archive_status. Captions are English originals unless lang= is given.`,
    )
  } else if (page.length === 0) {
    out.push(
      `offset ${number(skip)} is past the last hit — ${number(found.length)} hit(s) in total, so offsets ${number(found.length - 1)} and below have rows.`,
    )
  }
  for (const row of page) {
    // Brief rows trade the caption for more of them: enumerating a day or a list
    // of places is the common need, and the caption comes from archive_photo.
    const reference = aliasOf(row.id)
    out.push(
      terse
        ? joinParts([row.date || '—', row.place || '—', reference])
        : joinParts([row.date || '—', row.place, oneLine(row.text, 180) || '(no caption)', reference]),
    )
  }
  if (language && !terse) {
    out.push(`Translation coverage in scope: ${number(translatedCount)} of ${number(scanned)} scanned photo(s) had "${language}" text.`)
  }
  if (more) {
    out.push(`… ${number(found.length - skip - page.length)} more: call again with offset=${number(skip + page.length)}.`)
  }
  if (page.length) {
    const shortens = page.some((row) => aliasOf(row.id) !== row.id)
    out.push(
      '',
      'Next: archive_photo id=<the last field> for one photo, or archive_trip id=<…> for the days around it.',
      shortens
        ? 'References are short ids such as p2615: archive_photo takes them exactly as printed.'
        : 'These ids cannot be shortened (their suffix is not a number), so pass them exactly as printed.',
    )
  }
  return lines(out)
}

/** The months a `lang` search will read, refusing a scope that is too wide. */
function languageMonths({ month, from, to }) {
  if (isMonth(month)) return [month]
  if (month) throw new ArchiveError('usage', `month must be YYYY-MM, got "${month}".`)
  if (!isDate(from) && !isDate(to)) {
    throw new ArchiveError(
      'usage',
      `lang= reads month shards (search.json's captions are lowercased, so they cannot be translated). ${MONTH_SCOPE_HINT}`,
    )
  }
  if (from && !isDate(from)) throw new ArchiveError('usage', `from must be YYYY-MM-DD, got "${from}".`)
  if (to && !isDate(to)) throw new ArchiveError('usage', `to must be YYYY-MM-DD, got "${to}".`)
  const start = isDate(from) ? from : `${to.slice(0, 7)}-01`
  const end = isDate(to) ? to : `${from.slice(0, 7)}-01`
  const scope = monthsBetween(start, end)
  if (scope.length === 0) throw new ArchiveError('usage', `Empty range: from ${from ?? '…'} is after to ${to ?? '…'}.`)
  if (scope.length > LANG_MONTHS_LIMIT) {
    throw new ArchiveError(
      'usage',
      `lang= is limited to ${LANG_MONTHS_LIMIT} months per call (${scope.length} requested) because every month costs two files.\n  ${MONTH_SCOPE_HINT} Or omit lang and read the originals from the whole archive.`,
    )
  }
  return scope
}

/* --- tool 3: trip -------------------------------------------------------- */

/**
 * The section a date belongs to. A month section covers every day of its month,
 * so "what happened on 2017-07-18" would otherwise answer with July; a trip is
 * what `date=` is asking for, and among trips that overlap, the narrowest is the
 * specific visit rather than the season around it.
 */
function sectionForDate(sections, date) {
  const covering = sections.filter((s) => isDate(s.startDate) && isDate(s.endDate) && s.startDate <= date && date <= s.endDate)
  const trips = covering
    .filter((s) => s.kind === 'trip')
    .sort((a, b) => Date.parse(a.endDate) - Date.parse(a.startDate) - (Date.parse(b.endDate) - Date.parse(b.startDate)))
  return trips[0] ?? covering[0] ?? null
}

/**
 * One trip (or month section) with its narrative and days, translated when asked.
 *
 * The narrative is the archive's longest text and the reason this tool exists:
 * it is written from the day summaries and is the one place the shape of a trip
 * is stated rather than inferred from captions.
 */
async function runTrip({ id, name, date, lang, days: daysArg, day, offset: offsetArg }) {
  const indexEntry = await readJson('/archive/index')
  const index = indexEntry.data ?? {}
  const sections = (Array.isArray(index.sections) ? index.sections : []).filter((s) => s && typeof s.id === 'string')
  const out = [banner(indexEntry)]
  const warning = schemaWarning(index)
  if (warning) out.push(warning)

  const language = await checkLang(index, lang)
  const wantDays = int(daysArg, 40, 1, 40)
  const skipDays = int(offsetArg, 0, 0, 500)
  // `day=` is a one-day question, and it also stands in for `date=` when picking
  // the section, so `archive_trip day=2026-08-31` needs no other argument.
  const only = isDate(day) ? day : null
  const anchor = only ?? date
  // A single day and a page of days are different questions; accepting both
  // would mean silently ignoring one of them.
  if (only && (offsetArg !== undefined || daysArg !== undefined)) {
    throw new ArchiveError(
      'usage',
      `day=${only} prints exactly that one day, so days= and offset= do not apply. Drop them, or drop day= to page through the trip with offset=/days=.`,
    )
  }

  let trip = null
  if (typeof id === 'string' && id.trim()) {
    const wanted = id.trim()
    trip = sections.find((s) => s.id === wanted) ?? null
    if (!trip) {
      const near = sections.filter((s) => s.id.toLowerCase().includes(wanted.toLowerCase())).slice(0, 6)
      throw new ArchiveError(
        'usage',
        near.length
          ? `No section with id "${wanted}". Did you mean: ${near.map((s) => `${s.id} (${s.name})`).join('; ')}`
          : `No section with id "${wanted}". ${sections.length} section(s) exist — call archive_trip with no id to list them.`,
      )
    }
  } else if (typeof name === 'string' && name.trim()) {
    const low = name.trim().toLowerCase()
    const matches = sections.filter((s) => typeof s.name === 'string' && s.name.toLowerCase().includes(low))
    if (matches.length === 0) {
      throw new ArchiveError('usage', `No trip name contains "${name}". Call archive_trip with no arguments to list the ${sections.length} sections.`)
    }
    if (matches.length > 1) {
      throw new ArchiveError(
        'usage',
        `"${name}" matches ${matches.length} sections — pass id= to pick one:\n${matches.slice(0, 10).map((s) => `  ${s.id} · ${s.name} · ${s.startDate} → ${s.endDate}`).join('\n')}`,
      )
    }
    trip = matches[0]
  } else if (isDate(anchor)) {
    trip = sectionForDate(sections, anchor)
    if (!trip) {
      const near = sections.filter((s) => isDate(s.startDate) && Math.abs(Date.parse(s.startDate) - Date.parse(anchor)) < 21 * 864e5).slice(0, 6)
      throw new ArchiveError(
        'usage',
        `${anchor} is not inside any section (the archive has ${sections.length}).` +
          (near.length ? `\nNearest: ${near.map((s) => `${s.id} (${s.startDate} → ${s.endDate})`).join('; ')}` : '\nDays outside a trip live in the month sections; archive_search by date finds the photos.'),
      )
    }
  } else {
    if (sections.length === 0) {
      return lines([...out, `The index has no sections yet — organize has not run, so there are no trips to read. Months: ${(index.months ?? []).length}.`])
    }
    const list = sections
      .slice()
      .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))
      .slice(0, SECTION_LIST_LIMIT)
    return lines([
      ...out,
      `${sections.length} section(s), newest first${sections.length > list.length ? ` (showing ${list.length})` : ''}:`,
      ...list.map((s) => `  ${s.startDate} → ${s.endDate} · ${s.kind} · ${s.name} · ${(s.days ?? []).length} day(s) · id=${s.id}`),
      '',
      'Read one with archive_trip id=<id>, or name=<part of the name>, or date=YYYY-MM-DD.',
    ])
  }

  const table = language ? await translationsFor(language, `/archive/i18n/${language}/index`) : null
  const tripEdit = table?.tripOwner?.[trip.id] ?? null
  const nameText = translated(table, trip.name, tripEdit?.name).text
  const narrative = translated(table, trip.edits?.narrative ?? trip.narrative, tripEdit?.narrative).text

  out.push(
    joinParts([
      nameText,
      `${trip.startDate} → ${trip.endDate}`,
      `${(trip.days ?? []).length} day(s)`,
      trip.kind,
      `id=${trip.id}`,
    ]),
  )
  if (Array.isArray(trip.places) && trip.places.length) {
    out.push(`Places: ${trip.places.map((p) => translated(table, p).text).join(' · ')}`)
  }

  if (narrative && narrative.trim()) {
    out.push('', `Narrative${trip.narrativeGeneratedAt ? ` (generated ${stamp(trip.narrativeGeneratedAt)})` : ''}:`)
    out.push(narrative.length > 1600 ? `${narrative.slice(0, 1600)}… (narrative continues; read the day summaries below)` : narrative)
  } else {
    out.push('', 'Narrative: not written yet (trip narratives cost a model call, so they are never produced as a side effect).')
  }

  const dayList = Array.isArray(trip.days) ? trip.days : []
  // A date= question is about that day, so start there instead of at day one.
  // `findIndex` gives -1 when the day is after the last one; clamping with
  // `Math.max(0, …)` turned that into "start at day one" while the header went on
  // claiming it had started at the requested date.
  const at = isDate(anchor) ? dayList.findIndex((d) => d.date >= anchor) : -1
  const scanFrom = isDate(anchor) ? (at < 0 ? Math.max(0, dayList.length - 1) : at) : 0
  let from = scanFrom + skipDays
  let want = wantDays
  if (only) {
    const at = dayList.findIndex((d) => d.date === only)
    if (at < 0) {
      const lo = dayList[0]?.date ?? '—'
      const hi = dayList[dayList.length - 1]?.date ?? '—'
      throw new ArchiveError(
        'usage',
        `${only} is not a day of "${trip.name}" (${lo} → ${hi}, ${dayList.length} day(s)). Call archive_trip id=${trip.id} to see the days, or archive_search from=${only} to=${only} q=<word> for the photos of that day.`,
      )
    }
    from = at
    want = 1
  }
  const shown = dayList.slice(from, from + want)
  if (dayList.length) {
    if (isDate(anchor) && at < 0) {
      const last = dayList[dayList.length - 1]?.date ?? 'unknown'
      out.push('', `Note: ${anchor} is after the last day of this section (${last}), so the list starts there.`)
    }
    out.push(
      '',
      only
        ? `Day ${only} (${from + 1} of ${dayList.length}):`
        : `Days${shown.length < dayList.length ? ` (${shown.length} of ${dayList.length}, from ${shown[0]?.date ?? '—'})` : ''}:`,
    )
    // A single day is asked for in full: the six-stop cap exists to keep a whole
    // trip readable, and it is exactly what hides the eighth museum of a day.
    const segCap = only ? 40 : 6
    for (const dayRow of shown) {
      const edit = table?.owner?.[dayRow.date] ?? null
      const summary = translated(table, dayRow.edits?.summary ?? dayRow.summary, edit?.summary).text
      const place = translated(table, dayRow.place).text
      out.push(joinParts([dayRow.date, place, `${(dayRow.photoIds ?? []).length} photo(s)`]))
      if (summary && summary.trim()) out.push(`   ${oneLine(summary, 320)}`)
      const segments = Array.isArray(dayRow.segments) ? dayRow.segments : []
      for (const seg of segments.slice(0, segCap)) {
        const title = translated(table, seg.title).text
        out.push(`   · ${joinParts([title, seg.kind, seg.startTime && seg.endTime ? `${clock(seg.startTime)}–${clock(seg.endTime)}` : '', `${(seg.photoIds ?? []).length} photo(s)`])}`)
      }
      if (segments.length > segCap) out.push(`   · …and ${segments.length - segCap} more stop(s)`)
    }
    if (!only && shown.length === 0) {
      out.push(`offset ${number(skipDays)} is past the last day — this trip has ${number(dayList.length)}.`)
    } else if (!only && from + shown.length < dayList.length) {
      const rest = dayList.length - from - shown.length
      out.push(`… ${rest} more day(s): offset=${from + shown.length} to continue, or days=${Math.min(40, rest + shown.length)} to widen (max 40).`)
    }
  }

  if (language) {
    const daysWithText = dayList.filter((d) => typeof d.summary === 'string' && d.summary !== '').length
    const translatedDays = dayList.filter((d) => {
      const edit = table?.owner?.[d.date] ?? null
      return translated(table, d.edits?.summary ?? d.summary, edit?.summary).via !== 'original'
    }).length
    out.push('', `Coverage: ${translatedDays} of ${daysWithText} day summary/summaries and ${narrative && translated(table, trip.edits?.narrative ?? trip.narrative, tripEdit?.narrative).via !== 'original' ? 'the' : 'no'} narrative carry "${language}".`)
  }
  return lines(out)
}

/* --- tool 4: photo ------------------------------------------------------- */

/**
 * One photo's record: what it is, where and when, and the URL that shows it.
 *
 * The thumbnail is a URL rather than an image because the tool result is text;
 * the reader (or the app) is what turns it into pixels.
 */
async function runPhoto({ id, month, date, lang }) {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (!raw) throw new ArchiveError('usage', 'archive_photo needs id — the short reference archive_search printed (p2615), the bare suffix, or the full id (…!2615).')

  const searchEntry = await readJson('/archive/search')
  const search = searchEntry.data ?? {}
  const prefix = typeof search.idPrefix === 'string' ? search.idPrefix : ''
  // `p2615` is an alias, but a real suffix could itself start with "p", so the
  // reference as given is looked up first and reading it as an alias is the
  // fallback. Otherwise photo `!p123` would be shadowed by photo `!123`.
  const candidates = raw.includes('!') ? [raw] : [`${prefix}${raw}`]
  if (!raw.includes('!')) {
    const aliased = `${prefix}${suffixOf(raw)}`
    if (aliased !== candidates[0]) candidates.push(aliased)
  }

  let targetMonth = isMonth(month) ? month : isDate(date) ? date.slice(0, 7) : null
  if (month && !isMonth(month)) throw new ArchiveError('usage', `month must be YYYY-MM, got "${month}".`)
  if (!targetMonth) {
    // The search index knows every photo's date; use it before asking again.
    const rows = Array.isArray(search.photos) ? search.photos : []
    for (const candidate of candidates) {
      const suffix = candidate.slice(candidate.lastIndexOf('!') + 1)
      const hit = rows.find((p) => Array.isArray(p) && String(p[0]) === suffix)
      if (hit && typeof hit[1] === 'string') {
        targetMonth = hit[1].slice(0, 7)
        break
      }
    }
  }
  if (!targetMonth) {
    throw new ArchiveError(
      'usage',
      `Cannot tell which month ${candidates[0]} lives in — photos are stored per month (photos/<month>.json), so pass month=YYYY-MM or date=YYYY-MM-DD. It was not found in search.json either, which may mean the index predates the photo.`,
    )
  }

  const index = (await readJson('/archive/index')).data ?? {}
  const language = await checkLang(index, lang)
  const shardEntry = await readJson(`/archive/shard/${targetMonth}`)
  const photos = shardEntry.data?.photos ?? {}
  let fullId = null
  let photo = null
  for (const candidate of candidates) {
    const record = photos[candidate]
    if (record) {
      fullId = candidate
      photo = record
      break
    }
  }
  if (!photo) {
    const sample = Object.keys(photos).slice(0, 3).join(', ')
    throw new ArchiveError(
      'usage',
      `No photo ${candidates[0]} in ${targetMonth} (that shard holds ${Object.keys(photos).length} photo(s)${sample ? `, e.g. ${sample}` : ''}).\n  The month may be wrong, or the id may be from another archive build — archive_search the caption to get the id that exists.`,
    )
  }

  const table = language ? await translationsFor(language, `/archive/i18n/${language}/shard/${targetMonth}`) : null
  const caption = translated(table, photo.caption).text
  const tags = Array.isArray(photo.tags) ? photo.tags.map((t) => translated(table, t).text) : []
  const place = translated(table, photo.place).text

  const out = [banner(shardEntry)]
  const reference = aliasOf(fullId)
  out.push(joinParts([reference === fullId ? fullId : `${reference} (${fullId})`, photo.takenAt ?? '—', place, photo.contentType]))

  // Size first: "is this portrait or landscape, and how large can it print" is
  // the question before any caption, and it is already on the record.
  const w = Number(photo.width)
  const h = Number(photo.height)
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    const orientation = w === h ? 'square' : w > h ? 'landscape' : 'portrait'
    const size = Number.isFinite(Number(photo.bytes)) ? `${(Number(photo.bytes) / 1048576).toFixed(1)} MB` : ''
    out.push(joinParts([`Source: ${w}×${h} (${orientation}, ${(w / h).toFixed(2)}:1)`, size ? `${size} original` : '']))
  }
  out.push(`Caption: ${caption && caption.trim() ? caption : '(not analyzed yet)'}`)
  if (tags.length) out.push(`Tags: ${tags.join(', ')}`)
  if (photo.placeNames && typeof photo.placeNames === 'object') {
    const names = Object.entries(photo.placeNames).map(([k, v]) => `${k}: ${compact(v)}`)
    if (names.length) out.push(`Place names: ${names.join(' · ')}`)
  }
  if (photo.gps && typeof photo.gps === 'object') {
    // Print it only when a coordinate is actually there: `compact()` returns ''
    // for a missing value, so a fallback after it never fires and the line ends
    // up as `GPS: , ` — a field that looks read but is empty.
    const lat = compact(photo.gps.lat ?? photo.gps.latitude)
    const lon = compact(photo.gps.lon ?? photo.gps.lng)
    if (lat && lon) out.push(`GPS: ${lat}, ${lon}`)
    else if (lat || lon) out.push(`GPS: ${lat || '?'}, ${lon || '?'} (one coordinate only)`)
  }
  const flags = [
    photo.notable && `notable: ${compact(photo.notable)}`,
    photo.quality && `quality: ${compact(photo.quality)}`,
    photo.visibility && `visibility: ${compact(photo.visibility)}`,
    photo.screenshot === true && 'screenshot',
    photo.sensitive === true && 'sensitive',
    photo.video === true && 'video',
  ]
  if (flags.filter(Boolean).length) out.push(`Flags: ${flags.filter(Boolean).join(' · ')}`)
  if (photo.analyzedAt) out.push(`Analyzed: ${stamp(photo.analyzedAt)}`)
  if (typeof photo.extractedText === 'string' && photo.extractedText.trim()) {
    out.push(`Text in image: ${oneLine(photo.extractedText, 200)}`)
  }
  if (photo.fileName) out.push(`File: ${photo.fileName}`)

  const encoded = encodeURIComponent(fullId)
  const originalSize = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${w}×${h} original` : 'original'
  out.push(
    '',
    // Measured, not assumed: `small` is a 404, `range` requests are ignored, and
    // renditions are built on demand, so the first fetch of a large photo can be
    // slow and a burst of them answers 503. The sizes above are the record's, so
    // nothing here guesses dimensions by downloading the image.
    'Renditions (built on demand: the first request for a photo can be slow, and a burst of them answers 503):',
    `  medium  grid size                   ${CFG.baseUrl}/thumb/medium/${encoded}`,
    `  large   the large rendition's width ${CFG.baseUrl}/thumb/large/${encoded}`,
    `  full    ${originalSize}${' '.repeat(Math.max(1, 21 - originalSize.length))} ${CFG.baseUrl}/thumb/full/${encoded}`,
    shardEntry.source === 'mirror' ? '(the server is down, so these URLs will not open until it is started)' : '',
  )
  if (language) {
    out.push(`Language: ${language}${caption === photo.caption ? ' — no translation for this caption, showing the original' : ''}`)
  }
  return lines(out)
}

/* --- tool 5: jobs -------------------------------------------------------- */

/**
 * What the pipeline is doing and what it last did.
 *
 * Read-only by design: this tool never starts a job. `analyze` spends money, so
 * starting it is the owner's decision and belongs in the app or a terminal, not
 * in a tool an agent reaches for while looking around.
 */
async function runJobs({ limit }) {
  const rows = int(limit, 6, 1, 20)
  const out = []

  let live = null
  let historyEntry = null
  try {
    live = (await readJson('/jobs')).data
    historyEntry = await readJson('/jobs/history')
  } catch (error) {
    if (!(error instanceof ArchiveError) || error.kind !== 'offline') throw error
    const records = await jobsFromDisk(rows)
    if (records.length === 0) {
      throw new ArchiveError(
        'offline',
        `${CFG.baseUrl} is not running and no finished job exists in ${join(CFG.dataDir, 'jobs')}.\n  ${START_HINT}\n  (The job table lives in the server's memory, so a live job can only be reported while it runs.)`,
      )
    }
    out.push(`⚠ The server is not running (${CFG.baseUrl}) — these are the finished jobs on disk, oldest state included. ${START_HINT}`)
    out.push(`running: unknown (job state lives in the server's memory)`)
    out.push('', `History (${records.length}):`)
    for (const job of records) out.push(`  ${describeJob(job, { withLog: false })}`)
    return lines(out)
  }

  const running = (Array.isArray(live) ? live : []).filter((j) => j && (j.status === 'running' || j.status === 'queued'))
  if (running.length) {
    out.push(`Running (${running.length}/${Array.isArray(live) ? live.length : 0} tracked):`)
    for (const job of running) out.push(`  ${describeJob(job)}`)
  } else {
    out.push('Running: none (the server runs one job at a time).')
  }

  const history = Array.isArray(historyEntry?.data) ? historyEntry.data : []
  out.push('', `History${history.length > rows ? ` (${rows} of ${history.length}, newest first)` : ''}:`)
  if (history.length === 0) out.push('  No job has ever finished on this machine.')
  for (const job of history.slice(0, rows)) out.push(`  ${describeJob(job, { withLog: false })}`)

  const failed = history.slice(0, rows).filter((j) => j?.status === 'failed' && j?.error)
  if (failed.length) out.push('', `Failures above: ${failed.length} — the error text is on the line.`)
  out.push('', 'This tool only reads. Starting scan/analyze/organize/trip is the owner’s choice (analyze costs money); it happens in the app or `npm run serve -w pipeline`.')
  return lines(out)
}

/** Finished jobs straight off the mirror, for the no-server case. */
async function jobsFromDisk(limit) {
  const dir = join(CFG.dataDir, 'jobs')
  let names = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const records = await Promise.all(
    names.map(async (n) => {
      try {
        return JSON.parse(await readFile(join(dir, n), 'utf8'))
      } catch {
        return null // A file caught mid-write is complete on the next read.
      }
    }),
  )
  return records
    .filter((r) => r && typeof r.startedAt === 'string')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
}

/* --- definitions --------------------------------------------------------- */

/** The model-facing text of every result, clipped once so no tool has to remember. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Human- and model-readable lines.' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: clipText(String(value?.text ?? '')) }],
}

const TOOLS = [
  {
    name: 'archive_status',
    description:
      'Is the travel-archive healthy, and how much is in it? Reports the server version and commit, sign-in, schema version, photo/day/trip totals, the month span, which translation languages exist, and the running and last-finished pipeline job. Falls back to the pipeline/data mirror when the local server is not running and says so.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: () => runStatus(),
  },
  {
    name: 'archive_search',
    description:
      'Search the photo archive by a word from a caption, a tag, a place name, or a date (YYYY-MM-DD). Returns newest-first rows of date · place · caption · photo id, and trip names that match. A big result is walked with offset and sort=oldest; brief rows (date · place · id) fit three times as many, for enumerating a day or a place. Pass lang to read the archive in a translation (e.g. "zh-Hans"); without it the English originals are searched, which is one fast index read. With lang the search reads month shards, so give month= or a from/to range of at most 12 months.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Word or phrase to look for; case-insensitive. A date (YYYY-MM-DD) matches that day.' },
        month: { type: 'string', description: 'Limit to one month, YYYY-MM.' },
        from: { type: 'string', description: 'Earliest date, YYYY-MM-DD (inclusive).' },
        to: { type: 'string', description: 'Latest date, YYYY-MM-DD (inclusive).' },
        lang: { type: 'string', description: 'Read in this translation language, e.g. "zh-Hans". Omit for the originals.' },
        limit: { type: 'number', description: 'Rows to return: 1-30, or 1-40 with brief. Default 8, or 30 with brief.' },
        offset: { type: 'number', description: 'Skip this many hits; the answer says how many remain. Use with sort=oldest to walk a day in one direction.' },
        sort: {
          type: 'string',
          enum: ['newest', 'oldest'],
          description: 'Date order. Default "newest", which is the first date in a result.',
        },
        brief: {
          type: 'boolean',
          description: 'Rows of date · place · id only, no caption — for counting, enumerating a day, or finding a place. Read the caption afterwards with archive_photo.',
        },
      },
      required: ['q'],
      additionalProperties: false,
    },
    run: (args) => runSearch(args),
  },
  {
    name: 'archive_trip',
    description:
      'Read one trip (or month section): its name, dates, places, the written narrative, and each day with its place, summary and stops. Choose it with id=, name= (part of the name), or date= (YYYY-MM-DD inside it); with none of them the tool lists every section. Pass day=YYYY-MM-DD for that single day in full — every stop, not the first six — which is the call to make when a trip is too long to read, or offset=/days= to page through its days. Pass lang to read it in a translation.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Section id, e.g. "trip-shenyang-dalian-and-lushun-2017-07-17".' },
        name: { type: 'string', description: 'Part of the section name; must match exactly one section.' },
        date: { type: 'string', description: 'YYYY-MM-DD; picks the section containing that day, and starts the day list there.' },
        day: {
          type: 'string',
          description:
            'YYYY-MM-DD; prints that one day with every stop, and picks the section by itself. Use it instead of date= when the answer is about a single day.',
        },
        lang: { type: 'string', description: 'Read in this translation language, e.g. "zh-Hans".' },
        days: { type: 'number', description: 'Days to print, 1-40. Default 40.' },
        offset: {
          type: 'number',
          description: 'Skip this many days before printing, to page through a long trip. The answer says how many remain.',
        },
      },
      additionalProperties: false,
    },
    run: (args) => runTrip(args),
  },
  {
    name: 'archive_photo',
    description:
      'One photo’s record: pixel size, bytes and orientation, taken date, place, caption, tags, GPS, quality and content flags, the text found in the image, and the three rendition URLs (medium, large, full). Use the short reference archive_search printed (p2615). Pass lang to read the caption and tags in a translation. One photo per call: to choose among many, search with brief=true first, then read the few that matter.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Photo reference from archive_search: the short form as printed (p2615), the bare suffix (2615), or the full id (…!2615).',
        },
        month: { type: 'string', description: 'YYYY-MM the photo is filed under; only needed when the index cannot place the id.' },
        date: { type: 'string', description: 'YYYY-MM-DD of the photo, as an alternative to month.' },
        lang: { type: 'string', description: 'Read in this translation language, e.g. "zh-Hans".' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (args) => runPhoto(args),
  },
  {
    name: 'archive_jobs',
    description:
      'The pipeline job table: what is running now (with progress and the last log line) and what finished recently, newest first, with counts and error text. Reads only — it never starts a job, so nothing here can spend money. Works without the server by reading the finished jobs on disk, and says so.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'History rows to return, 1-20. Default 6.' },
      },
      additionalProperties: false,
    },
    run: (args) => runJobs(args),
  },
]

/** Turn one of the above into a registered tool definition. */
function toolDefinition(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        return { text: await spec.run(args ?? {}) }
      } catch (error) {
        // A failure the model must act on is thrown, not returned as prose: a
        // plausible-looking empty result is what makes an agent invent.
        if (error instanceof ArchiveError) throw new Error(error.message)
        throw error
      }
    },
  }
}

/* --- plugin -------------------------------------------------------------- */

function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const baseUrl =
    typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim().replace(/\/+$/, '') : DEFAULTS.baseUrl
  const dataDir = typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir.trim() : DEFAULT_DATA_DIR
  return {
    baseUrl,
    dataDir,
    timeoutMs: int(raw.timeoutMs, DEFAULTS.timeoutMs, 500, 120_000),
    cacheTtlMs: int(raw.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 24 * 60 * 60_000),
  }
}

/**
 * Mount the tools.
 *
 * Config is resolved once here rather than per call: Cordis disposes and re-runs
 * `apply` when the row's config changes, so a per-call read would only add a
 * mutation path.
 *
 * @param ctx Host plugin context.
 * @param config Bundle-row configuration: {@link resolveConfig}.
 */
export function apply(ctx, config = {}) {
  CFG = { ...resolveConfig(config) }
  // A re-apply means new settings: anything cached was read under the old ones.
  readCache.clear()
  translationCache.clear()
  for (const spec of TOOLS) {
    ctx.effect(() => ctx.tools.register(toolDefinition(spec)), `travel-archive: ${spec.name}`)
  }
}

/** Exported for `smoke.mjs`, which checks `textKey` against the real translation file. */
export const internals = { textKey, resolveConfig, mirrorPath, monthsBetween, translated }
