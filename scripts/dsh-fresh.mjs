#!/usr/bin/env node
/**
 * dsh freshness and adoption rail.
 *
 * `node scripts/dsh-fresh.mjs`
 *   Reports npm `latest`/`alpha` against our certified pin and FAILS when
 *   `latest` drifts, so upstream movement becomes a red rail, not a production
 *   surprise. dsh's semver is decorative; never trust it silently.
 *
 * `node scripts/dsh-fresh.mjs --probe <version>`
 *   Certify a candidate WITHOUT adopting: temporarily point the plugin's
 *   dsh-llm peer at that version, re-stage, run the boot check, then restore
 *   every byte. Never writes config/dsh.json.
 *
 * `node scripts/dsh-fresh.mjs --adopt <version>`
 *   Probe first; on PASS write the pin and the peer permanently. A version
 *   that has not streamed through the harness is not adopted.
 *
 * Peer rule: `@deepseek-ai/dsh-llm` is NOT a dependency of the dsh package, it
 * is the lockstep sibling (`dsh@X` ships `dsh-llm@X`). dsh's plugin manager
 * polices our declared peer at install, so the peer must equal the target
 * version exactly, and that version must exist on npm.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeDshVersion, readPin, writePin } from './dsh-version.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_PKG = '@deepseek-ai/dsh'
const LLM_PKG = '@deepseek-ai/dsh-llm'
const pluginManifest = path.join(repoRoot, 'plugin', 'package.json')
const rootManifest = path.join(repoRoot, 'package.json')

const npmView = (args) => JSON.parse(execFileSync('npm', ['view', ...args, '--json'], { encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024 }))
const npmExists = (spec) => {
  try {
    return npmView([spec, 'version']) !== undefined
  } catch {
    return false
  }
}
function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n')
  renameSync(`${file}.tmp`, file)
}

function distTags() {
  return npmView([DSH_PKG, 'dist-tags'])
}

/** Set the plugin's declared dsh-llm peer (and the root devDependency used by fixtures). */
function setPeer(version) {
  const plugin = JSON.parse(readFileSync(pluginManifest, 'utf8'))
  plugin.peerDependencies = { ...plugin.peerDependencies, [LLM_PKG]: version }
  writeJson(pluginManifest, plugin)
  const root = JSON.parse(readFileSync(rootManifest, 'utf8'))
  if (root.devDependencies?.[LLM_PKG]) {
    root.devDependencies[LLM_PKG] = version
    writeJson(rootManifest, root)
  }
}

function restoreFrom(backups) {
  for (const [file, text] of backups) writeFileSync(file, text)
}

/**
 * Run the boot check against `version` with the peer it requires, restoring the
 * manifests afterwards. Stages first: dsh installs the staged plugin copy, so a
 * peer edit only takes effect once re-staged.
 */
function probe(version) {
  if (!npmExists(`${LLM_PKG}@${version}`)) {
    console.error(`FAIL: ${LLM_PKG}@${version} is not on npm. dsh and dsh-llm ship in lockstep; refusing to declare a peer that cannot resolve.`)
    return false
  }
  const backups = new Map([[pluginManifest, readFileSync(pluginManifest, 'utf8')], [rootManifest, readFileSync(rootManifest, 'utf8')]])
  try {
    setPeer(version)
    console.log(`staging with ${LLM_PKG}@${version} peer...`)
    const stage = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'stage-core.mjs')], { cwd: repoRoot, stdio: 'inherit' })
    if (stage.status !== 0) {
      console.error('FAIL: staging failed, candidate not certified.')
      return false
    }
    console.log(`certifying dsh ${version} with the boot check...`)
    const boot = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'step2-boot-check.mjs'), '--fresh'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, DSH_VERSION: version },
    })
    return boot.status === 0
  } finally {
    restoreFrom(backups)
  }
}

function adopt(version) {
  if (!probe(version)) {
    console.error(`dsh ${version} NOT adopted; pin stays ${readPin()}.`)
    process.exit(1)
  }
  writePin(version)
  console.log(`\nadopted dsh ${version} (peer ${LLM_PKG}@${version}).`)
  console.log('Re-run `npm install` to sync the lockfile, then `npm test`.')
}

const flagIndex = process.argv.findIndex((a) => a === '--adopt' || a === '--probe')
if (flagIndex !== -1) {
  const mode = process.argv[flagIndex]
  const version = process.argv[flagIndex + 1]
  if (!version) {
    console.error(`usage: node scripts/dsh-fresh.mjs ${mode} <exact-version>`)
    process.exit(2)
  }
  if (mode === '--adopt') adopt(version)
  else process.exit(probe(version) ? 0 : 1)
  process.exit(0)
}

const tags = distTags()
const { pinned, overridden } = describeDshVersion()
console.log(`${DSH_PKG}: latest=${tags.latest} alpha=${tags.alpha ?? '-'} | certified pin=${pinned}${overridden ? ' (DSH_VERSION override active)' : ''}`)
if (overridden) {
  console.log('DSH_VERSION is set: this run certifies a candidate, it does not move the pin.')
  process.exit(0)
}
if (tags.latest !== pinned) {
  console.error(`DRIFT: upstream latest ${tags.latest} != certified pin ${pinned}.`)
  console.error(`  probe:  node scripts/dsh-fresh.mjs --probe ${tags.latest}`)
  console.error(`  adopt:  node scripts/dsh-fresh.mjs --adopt ${tags.latest}`)
  process.exit(1)
}
console.log(`up to date: certified pin equals upstream latest (${pinned})`)
if (tags.alpha && tags.alpha !== tags.latest) {
  console.log(`alpha available for a canary: node scripts/dsh-fresh.mjs --probe ${tags.alpha}`)
}
