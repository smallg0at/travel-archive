/**
 * smoke.mjs — prove the plugin loads and answers, without a harness restart.
 *
 * Run it with the Electron binary standing in for Node (there is no `node` on
 * PATH on this machine) and with forward slashes, because a backslash path inside
 * `-e` gets mangled by the Windows argument parser:
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & 'C:\Users\small\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' `
 *       -e "(async()=>{await import('file:///C:/Code/proj/integrations/dsh/smoke.mjs')})()"
 *
 * It checks six things the plan promised: the five tools register; each one
 * answers against the live server; `textKey` still matches the real translation
 * file (a copy that drifted reads every translation as missing); a Chinese search
 * returns Chinese text; a dead server degrades to the mirror with a banner
 * instead of failing shut; and an unreadable mirror fails loudly with both
 * probed paths and the start command.
 */

import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, '..', '..', 'pipeline', 'data')
const DEAD = 'http://127.0.0.1:18999'

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Mount the plugin with a fake Cordis context and collect what it registered. */
async function mount(mod, config) {
  const tools = new Map()
  const ctx = {
    effect: (fn) => fn(),
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  mod.apply(ctx, config)
  return tools
}

/**
 * A throwaway HTTP server on a free loopback port, for the "not the archive" cases.
 * `close` drops live connections first: the client keeps them alive, and
 * `server.close()` alone would wait for them and hang the run.
 */
async function serveWith(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}

/** Run one tool and return `{ text, ms }`; a throw comes back as `{ error, ms }`. */
async function run(tools, name, args = {}) {
  const started = Date.now()
  const definition = tools.get(name)
  if (!definition) return { error: `no tool named ${name}`, ms: 0 }
  try {
    const value = await definition.execute(args)
    const text = definition.output.render(args, value).map((block) => block.text ?? '').join('\n')
    return { text, ms: Date.now() - started }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }
  }
}

const firstLine = (text) => (text ?? '').split('\n')[0]

async function main() {
  const mod = await import('./index.js')

  check(
    'plugin exports the Host plugin shape',
    typeof mod.apply === 'function' && mod.name === 'travel-archive' && Array.isArray(mod.inject) && mod.inject.includes('tools'),
    `apply/name/inject = ${typeof mod.apply}/${mod.name}/${JSON.stringify(mod.inject)}`,
  )

  const tools = await mount(mod, {})
  const expected = ['archive_jobs', 'archive_photo', 'archive_search', 'archive_status', 'archive_trip']
  check('registers exactly the five tools', [...tools.keys()].sort().join(',') === expected.join(','), [...tools.keys()].join(', '))
  const shaped = [...tools.values()].every(
    (d) => d.parameters?.type === 'object' && typeof d.output?.render === 'function' && typeof d.execute === 'function',
  )
  check('every definition declares parameters, output.render and execute', shaped)

  const status = await run(tools, 'archive_status')
  check(
    'archive_status answers the live server',
    Boolean(status.text && status.text.includes('server online') && /photos [\d,]/.test(status.text)),
    `${status.ms} ms · ${firstLine(status.text)}`,
  )

  const search = await run(tools, 'archive_search', { q: 'Dalian', limit: 5 })
  check(
    'archive_search finds the Dalian trip photos',
    Boolean(search.text && /hit\(s\)/.test(search.text) && /·\s*(p\d+|[A-Za-z0-9]+!\w+)\s*$/m.test(search.text)),
    `${search.ms} ms · ${firstLine(search.text)}`,
  )

  const listed = await run(tools, 'archive_trip', {})
  const tripId = /id=(\S+)/.exec(listed.text ?? '')?.[1]
  const trip = await run(tools, 'archive_trip', { id: tripId, days: 2 })
  check(
    'archive_trip reads one section by id',
    Boolean(tripId && trip.text && trip.text.includes(tripId)),
    `id=${tripId} · ${trip.ms} ms`,
  )

  // A month section covers the same day, and it is not what date= is asking for.
  const byDate = await run(tools, 'archive_trip', { date: '2017-07-18', days: 1 })
  check(
    'archive_trip date= picks the trip, not the month around it',
    Boolean(byDate.text && /·\s*trip\s*·/.test(byDate.text) && byDate.text.includes('from 2017-07-18')),
    firstLine(byDate.text) + ` · ${byDate.ms} ms`,
  )

  // --- paging: one day, and a big result in pages --------------------------
  // Why these exist: an agent asked for one day of a long trip got the whole trip
  // clipped at 4000 chars, and could not page the result — it guessed words
  // instead of walking the days.
  const dayView = await run(tools, 'archive_trip', { day: '2026-08-31' })
  const stopLines = (dayView.text ?? '').split('\n').filter((line) => line.startsWith('   · '))
  check(
    'archive_trip day= prints that one day in full',
    Boolean(dayView.text?.includes('Day 2026-08-31') && stopLines.length > 6),
    `${stopLines.length} stop(s) · ${dayView.ms} ms`,
  )

  const dayConflict = await run(tools, 'archive_trip', { day: '2026-08-31', offset: 2 })
  check(
    'day= refuses offset=/days= instead of ignoring one of them',
    /do not apply/.test(dayConflict.error ?? ''),
    firstLine(dayConflict.error),
  )

  const brief = await run(tools, 'archive_search', { q: 'Wien', from: '2026-08-31', to: '2026-08-31', brief: true, limit: 10, sort: 'oldest' })
  const briefRows = (brief.text ?? '').split('\n').filter((line) => /^\d{4}-\d{2}-\d{2} · /.test(line))
  check(
    'brief rows are date · place · id, with no caption',
    briefRows.length > 0 && briefRows.every((line) => line.split(' · ').length === 3 && /·\s*(p\d+|[A-Za-z0-9]+!\w+)$/.test(line)),
    `${briefRows.length} row(s) · ${brief.ms} ms`,
  )

  const page1 = await run(tools, 'archive_search', { q: 'Wien', from: '2026-08-31', to: '2026-08-31', brief: true, limit: 5, sort: 'oldest' })
  const page2 = await run(tools, 'archive_search', { q: 'Wien', from: '2026-08-31', to: '2026-08-31', brief: true, limit: 5, sort: 'oldest', offset: 5 })
  const ids = (text) =>
    (text ?? '')
      .split('\n')
      .filter((line) => /^\d{4}-\d{2}-\d{2} · /.test(line))
      .map((line) => line.split(' · ').pop())
  const firstPage = ids(page1.text)
  const secondPage = ids(page2.text)
  check(
    'offset pages the same result without repeating a row',
    firstPage.length > 0 && secondPage.length > 0 && secondPage.every((id) => !firstPage.includes(id)),
    `${firstPage.length}+${secondPage.length} rows, ${firstPage.filter((id) => secondPage.includes(id)).length} repeated`,
  )

  const newestFirst = await run(tools, 'archive_search', { q: 'Dalian', brief: true, limit: 5 })
  const oldestFirst = await run(tools, 'archive_search', { q: 'Dalian', brief: true, limit: 5, sort: 'oldest' })
  const dateOf = (text) => (text ?? '').split('\n').find((line) => /^\d{4}-\d{2}-\d{2} · /.test(line))?.slice(0, 10)
  check(
    'sort=oldest reverses the order',
    Boolean(dateOf(newestFirst.text) && dateOf(oldestFirst.text) && dateOf(newestFirst.text) > dateOf(oldestFirst.text)),
    `newest ${dateOf(newestFirst.text)} vs oldest ${dateOf(oldestFirst.text)}`,
  )

  const photoId = /·\s*(p\d+|[A-Za-z0-9]+!\w+)\s*$/m.exec(search.text ?? '')?.[1]
  const photo = await run(tools, 'archive_photo', { id: photoId })
  check(
    'archive_photo reads one photo by id',
    Boolean(photoId && photo.text && photo.text.includes('/thumb/medium/')),
    `id=${photoId} · ${photo.ms} ms`,
  )
  check(
    'archive_photo states the pixel size and the three renditions',
    Boolean(photo.text && /Source: \d+×\d+ \((landscape|portrait|square),/.test(photo.text) && /\/thumb\/large\//.test(photo.text) && /\/thumb\/full\//.test(photo.text)),
    firstLine(photo.text?.split('\n').find((l) => l.startsWith('Source:')) ?? ''),
  )

  // The short reference: what search printed last is what photo must take back.
  const shortRef = /·\s*(p\d+)\s*$/m.exec(search.text ?? '')?.[1]
  const byAlias = shortRef ? await run(tools, 'archive_photo', { id: shortRef }) : null
  check(
    'the short reference search printed is accepted back by archive_photo',
    Boolean(byAlias?.text && byAlias.text.includes('!') && byAlias.text.includes('Source:')),
    shortRef ? `${shortRef} · ${byAlias.ms} ms` : 'no short reference in the last row',
  )

  const jobs = await run(tools, 'archive_jobs', { limit: 3 })
  check('archive_jobs reads the job table', Boolean(jobs.text && /History/.test(jobs.text)), `${jobs.ms} ms`)

  // --- translations -------------------------------------------------------
  const shard = JSON.parse(await readFile(join(DATA, 'photos', '2015-09.json'), 'utf8'))
  const translated = JSON.parse(await readFile(join(DATA, 'i18n', 'zh-Hans', 'photos', '2015-09.json'), 'utf8'))
  const captions = Object.values(shard.photos).map((p) => p.caption).filter((c) => typeof c === 'string' && c !== '')
  const keyed = captions.filter((c) => Boolean(translated.entries?.[mod.internals.textKey(c)]))
  check(
    'textKey still matches the real translation file',
    captions.length > 0 && keyed.length === captions.length,
    `${keyed.length}/${captions.length} captions keyed in 2015-09`,
  )

  const zhEntries = Object.values(translated.entries ?? {}).filter(
    (e) => typeof e?.t === 'string' && /\p{Script=Han}/u.test(e.t),
  )
  const phrase = zhEntries.length ? zhEntries[0].t.replace(/\s+/g, '').slice(0, 4) : ''
  const zhSearch = await run(tools, 'archive_search', { q: phrase, month: '2015-09', lang: 'zh-Hans', limit: 3 })
  check(
    'archive_search reads the Chinese sidecar',
    Boolean(phrase && zhSearch.text && zhSearch.text.includes(phrase) && /Translation coverage/.test(zhSearch.text)),
    `q="${phrase}" · ${zhSearch.ms} ms · ${firstLine(zhSearch.text)}`,
  )

  const badLang = await run(tools, 'archive_search', { q: 'a', month: '2015-09', lang: 'fr' })
  check('an unknown lang is refused, naming the ones that exist', /No "fr" translation/.test(badLang.error ?? ''), firstLine(badLang.error))

  const tooWide = await run(tools, 'archive_search', { q: 'a', from: '2016-01-01', to: '2020-12-01', lang: 'zh-Hans' })
  check('a lang range wider than 12 months is refused', /limited to 12 months/.test(tooWide.error ?? ''), firstLine(tooWide.error))

  // --- offline ------------------------------------------------------------
  const offlineTools = await mount(mod, { baseUrl: DEAD })
  const offlineStatus = await run(offlineTools, 'archive_status')
  check(
    'a dead server degrades to the mirror, with a banner and the start command',
    Boolean(offlineStatus.text && /not running/.test(offlineStatus.text) && /npm run serve/.test(offlineStatus.text)),
    `${offlineStatus.ms} ms · ${firstLine(offlineStatus.text)}`,
  )
  const offlineSearch = await run(offlineTools, 'archive_search', { q: 'Dalian', limit: 2 })
  check(
    'archive_search still answers from the mirror offline',
    Boolean(offlineSearch.text && /⚠/.test(offlineSearch.text) && /hit\(s\)/.test(offlineSearch.text)),
    `${offlineSearch.ms} ms`,
  )
  const offlineJobs = await run(offlineTools, 'archive_jobs', { limit: 2 })
  check(
    'archive_jobs reads finished jobs off disk offline',
    Boolean(offlineJobs.text?.includes('not running') || /npm run serve/.test(offlineJobs.error ?? '')),
    offlineJobs.text ? 'read data/jobs' : firstLine(offlineJobs.error),
  )

  const unreadable = await mount(mod, { baseUrl: DEAD, dataDir: 'C:/no/such/archive/data' })
  const broken = await run(unreadable, 'archive_search', { q: 'Dalian' })
  check(
    'an unreadable mirror fails loudly, naming both probed paths',
    Boolean(broken.error && broken.error.includes('mirror:') && broken.error.includes('npm run serve')),
    firstLine(broken.error),
  )

  const noServerOnly = await run(unreadable, 'archive_jobs', { limit: 1 })
  check('a server-only route offline says which command starts it', /npm run serve/.test(noServerOnly.error ?? ''), firstLine(noServerOnly.error))

  // --- the failures that look like answers --------------------------------
  // A 200 served by something that is not the archive (an SPA shell, a proxy's
  // error page) used to walk into the offline path and be reported as "the
  // server is not running", over a mirror that may be weeks old.
  const html = await serveWith((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>not the archive</title>')
  })
  const htmlTools = await mount(mod, { baseUrl: html.baseUrl })
  const notJson = await run(htmlTools, 'archive_search', { q: 'Dalian' })
  check(
    'a 200 that is not JSON is reported as broken, not as offline',
    /not JSON/.test(notJson.error ?? '') && !/not running/.test(notJson.error ?? ''),
    firstLine(notJson.error),
  )
  await html.close()

  // A month whose translation file the server refuses must fail the search, not
  // quietly return the other months.
  const mirrorFiles = {
    '/archive/index': ['index.json'],
    '/archive/search': ['search.json'],
  }
  const refusing = await serveWith((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path.startsWith('/archive/i18n/')) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"error":"denied"}')
      return
    }
    const shard = /^\/archive\/shard\/(\d{4}-\d{2})$/.exec(path)
    const file = mirrorFiles[path] ?? (shard ? ['photos', `${shard[1]}.json`] : null)
    if (!file) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"no such route"}')
      return
    }
    readFile(join(DATA, ...file), 'utf8').then(
      (text) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(text)
      },
      () => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":"unreadable"}')
      },
    )
  })
  const refusingTools = await mount(mod, { baseUrl: refusing.baseUrl })
  const refused = await run(refusingTools, 'archive_search', { q: 'projector', month: '2015-09', lang: 'zh-Hans' })
  check(
    'a language search fails when the server refuses a month, instead of reporting fewer hits',
    /HTTP 403/.test(refused.error ?? ''),
    firstLine(refused.error),
  )
  await refusing.close()

  // `lang=<source>` is reading the originals: it must not go looking for an
  // `i18n/en/` that does not exist (a 404 in two tools, "0 hits" in the third).
  const sourceLang = await run(tools, 'archive_search', { q: 'Dalian', lang: 'en', limit: 3 })
  check(
    'lang=<source> behaves exactly like no lang',
    Boolean(sourceLang.text && /hit\(s\)/.test(sourceLang.text) && !/lang en/.test(sourceLang.text)),
    firstLine(sourceLang.text),
  )
  const sourceTrip = await run(tools, 'archive_trip', { day: '2026-08-31', lang: 'en' })
  check(
    'lang=<source> on a trip answers instead of 404ing',
    Boolean(sourceTrip.text?.includes('Day 2026-08-31')),
    firstLine(sourceTrip.text) || firstLine(sourceTrip.error),
  )

  // A photo with no GPS must not print an empty GPS field.
  const shardPhotos = Object.entries(JSON.parse(await readFile(join(DATA, 'photos', '2015-09.json'), 'utf8')).photos)
  const noGps = shardPhotos.find(([, photo]) => !photo.gps)
  const noGpsPhoto = noGps ? await run(tools, 'archive_photo', { id: noGps[0], month: '2015-09' }) : null
  check(
    'a photo without GPS omits the field',
    Boolean(noGps && noGpsPhoto.text && !/GPS:\s*,/.test(noGpsPhoto.text)),
    noGps ? `${noGps[0]} · ${noGpsPhoto.ms} ms` : 'no photo without gps in 2015-09',
  )

  // An answer clipped at 4000 characters must not cut mid-line: the model reading
  // it cannot tell a half-written stop from a short one.
  const wide = await run(tools, 'archive_search', { q: 'the', limit: 30 })
  const clip = /… truncated at (\d+) of (\d+) characters/.exec(wide.text ?? '')
  check(
    'a clipped answer ends on a line boundary and says how much it showed',
    Boolean(clip && Number(clip[1]) < 4000 && Number(clip[2]) > Number(clip[1]) && (wide.text ?? '').length <= 4000),
    clip ? `${clip[1]} of ${clip[2]} characters shown` : 'not clipped — the call no longer overflows',
  )

  // A suffix may itself look like an alias. `p123` has to mean the photo whose
  // suffix is literally `p123` when one exists, and only fall back to `123`.
  const demo = await mkdtemp(join(tmpdir(), 'archive-smoke-'))
  try {
    await mkdir(join(demo, 'photos'), { recursive: true })
    const at = '2020-01-01T00:00:00.000Z'
    await writeFile(
      join(demo, 'search.json'),
      JSON.stringify({
        schemaVersion: 2,
        builtAt: at,
        idPrefix: 'DEMO!',
        photos: [
          ['123', '2020-01-01', 'plain photo', ''],
          ['p123', '2020-01-01', 'letter photo', ''],
        ],
        days: [],
        trips: [],
      }),
    )
    await writeFile(
      join(demo, 'index.json'),
      JSON.stringify({
        schemaVersion: 14,
        generatedAt: at,
        months: [{ month: '2020-01', label: 'January 2020', photoCount: 2, representativeCount: 2, analyzedCount: 2 }],
        sections: [],
      }),
    )
    await writeFile(
      join(demo, 'photos', '2020-01.json'),
      JSON.stringify({
        month: '2020-01',
        generatedAt: at,
        photos: {
          'DEMO!123': { id: 'DEMO!123', takenAt: at, caption: 'plain photo', width: 100, height: 100 },
          'DEMO!p123': { id: 'DEMO!p123', takenAt: at, caption: 'letter photo', width: 100, height: 100 },
        },
      }),
    )
    const shadow = await mount(mod, { baseUrl: DEAD, dataDir: demo, cacheTtlMs: 0 })
    const letter = await run(shadow, 'archive_photo', { id: 'p123' })
    const plain = await run(shadow, 'archive_photo', { id: '123' })
    check(
      'the reference is looked up as given before it is read as an alias',
      Boolean(letter.text?.includes('letter photo') && plain.text?.includes('plain photo')),
      `p123 → ${firstLine(letter.text ?? letter.error)}`,
    )
  } finally {
    await rm(demo, { recursive: true, force: true })
  }

  // A server that accepts the connection and never answers is the expensive case:
  // every route waits for the timeout, and `archive_status` reads two routes.
  const hang = await serveWith(() => {})
  const hangTools = await mount(mod, { baseUrl: hang.baseUrl, timeoutMs: 400 })
  const firstHang = await run(hangTools, 'archive_status')
  const secondHang = await run(hangTools, 'archive_status')
  check(
    'a half-dead server is not re-timed on every call',
    Boolean(firstHang.text && firstHang.text.includes('not running') && secondHang.ms < firstHang.ms),
    `first ${firstHang.ms} ms, then ${secondHang.ms} ms`,
  )
  await hang.close()

  // --- read-only guarantee ------------------------------------------------
  const source = await readFile(join(HERE, 'index.js'), 'utf8')
  const writes = /\bmethod\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]|fetch\([^)]*['"]\/(jobs\/(scan|analyze|organize|trip|translate|screens|collect|analyze\/auto\/stop)|jobs\/[\w-]+\/cancel)/.exec(source)
  check('the source contains no write request', writes === null, writes ? writes[0] : 'no POST/PUT/PATCH/DELETE, no job start')

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) {
    console.log(`failed: ${failed.map((c) => c.name).join('; ')}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('smoke crashed:', error)
  process.exitCode = 1
})
