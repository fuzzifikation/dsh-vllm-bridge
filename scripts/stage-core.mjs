#!/usr/bin/env node
/**
 * Stage the vLLM-Copilot core as a local package, exactly as the bridge will
 * stage it from the installed extension in production (minus the compile: the
 * published VSIX already ships compiled `out/`, source tags do not, so the dev
 * loop compiles the pinned tag once into temp/).
 *
 * Output: temp/stage/vllm-copilot-core/ = { package.json, LICENSE, core/**.js }
 * with dependencies derived from the staged tree's own bare imports (never
 * hardcoded, so an upstream import addition breaks this script, not the user).
 *
 * Usage: node scripts/stage-core.mjs            (dev tree if present, else --ref tag)
 *        node scripts/stage-core.mjs --ref v1.37.0
 *        node scripts/stage-core.mjs --dir G:\vLLM-Copilot-public
 *                                                  stage an UNRELEASED core
 *                                                  straight from a local
 *                                                  working tree (compiled on
 *                                                  demand, the dev loop for
 *                                                  companion-API work before
 *                                                  any tag exists
 *
 * With no flag, a sibling `../vLLM-Copilot-public` working tree wins: the
 * companion API lives there long before it exists as a tag, and the rails'
 * VLLMC_EXT_DIR default is the same tree, so staging and gating can never
 * disagree about which core is under test. Pass --ref for the tag path.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageAdapter, stageCore } from '../shared/core-staging.mjs'

const DEFAULT_REF = 'v1.37.0'
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const work = path.join(repo, 'temp')
const upstream = path.join(work, 'upstream', 'vLLM-Copilot')

const refIndex = process.argv.indexOf('--ref')
const ref = refIndex >= 0 ? process.argv[refIndex + 1] : DEFAULT_REF
// --dir stages from a local working tree instead of a GitHub tag: the
// companion API exists in a checkout long before it exists as a tag, and the
// whole point of the dev loop is that nothing needs to be shipped for it to
// be testable. The compile-if-missing check below applies to that tree too.
const dirIndex = process.argv.indexOf('--dir')
let localDir = dirIndex >= 0 ? path.resolve(process.argv[dirIndex + 1]) : undefined
if (dirIndex >= 0 && !existsSync(path.join(localDir, 'package.json'))) {
  console.error(`FAIL: --dir ${localDir} has no package.json`)
  process.exit(1)
}
if (refIndex < 0 && dirIndex < 0) {
  const devTree = path.resolve(repo, '..', 'vLLM-Copilot-public')
  if (existsSync(path.join(devTree, 'package.json'))) {
    localDir = devTree
    console.log(`staging from the local working tree ${devTree} (pass --ref <tag> to stage a tag instead)`)
  }
}

const run = (cmd, args, opts = {}) => {
  // npm is a .cmd on Windows and needs a shell, and a shell concatenates its
  // arguments instead of escaping them, so the command is assembled as one
  // string here rather than passed as an argument vector.
  const shellMode = opts.shell === true
  const command = shellMode ? [cmd, ...args].join(' ') : cmd
  const r = spawnSync(command, shellMode ? [] : args, {
    cwd: opts.cwd ?? upstream,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: shellMode,
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    console.error(`FAIL: ${command} ${args.join(' ')} (exit ${r.status})`)
    console.error((r.stdout ?? '').slice(-2000), (r.stderr ?? '').slice(-2000))
    process.exit(1)
  }
  return r
}

const source = localDir ?? upstream
if (!localDir) {
  if (!existsSync(path.join(upstream, 'package.json'))) {
    mkdirSync(path.dirname(upstream), { recursive: true })
    run('git', ['clone', '--branch', ref, '--depth', '1', 'https://github.com/fuzzifikation/vLLM-Copilot.git', upstream], { cwd: work })
  } else {
    const current = run('git', ['describe', '--tags'], { cwd: upstream }).stdout.trim()
    if (current !== ref) {
      run('git', ['fetch', '--depth', '1', 'origin', `refs/tags/${ref}:refs/tags/${ref}`])
      run('git', ['checkout', '--detach', ref])
    }
  }
}

const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))
if (!existsSync(path.join(source, 'out', 'core', 'index.js'))) {
  if (!existsSync(path.join(source, 'node_modules'))) {
    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: source, shell: true })
  }
  run('npm', ['run', 'compile'], { cwd: source, shell: true })
}
if (!existsSync(path.join(source, 'out', 'core', 'index.js'))) {
  console.error('FAIL: upstream compile produced no out/core/index.js')
  process.exit(1)
}

const stage = path.join(work, 'stage', 'vllm-copilot-core')
// The staging math lives in shared/core-staging.mjs, the same module the
// extension calls in production, so the dev layout and the shipped layout
// cannot drift into two different things.
const staged = stageCore({
  coreDir: path.join(source, 'out', 'core'),
  sourceManifest: manifest,
  targetDir: stage,
  docsDir: source,
  description: `vLLM-Copilot editor-free core (compiled out/core of vLLM-Copilot ${manifest.version}, staged locally by the bridge).`,
})
// The profile installs the core's dependencies through pnpm in production; the
// dev stage needs its own node_modules so a bare import from the staged tree
// resolves without a root devDependency that could drift from what upstream
// actually declared.
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, shell: true })
console.log(`staged vllm-copilot-core@${staged.version} -> ${stage}`)
console.log(`dependencies derived from imports: ${Object.keys(staged.dependencies ?? {}).join(', ') || '(none)'}`)

// The plugin stages as a sibling so its `file:../vllm-copilot-core` dependency
// resolves identically in dev and production (vendor/ sibling layout).
const pluginStage = path.join(work, 'stage', 'dsh-adapter-vllmc')
stageAdapter({ pluginDir: path.join(repo, 'plugin'), targetDir: pluginStage })
console.log(`staged dsh-adapter-vllmc -> ${pluginStage}`)
