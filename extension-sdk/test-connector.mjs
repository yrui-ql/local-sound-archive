#!/usr/bin/env node
/**
 * 扩展连接器本地测试器。
 *
 *   node test-connector.mjs sample-source
 *   node test-connector.mjs 03_DATA/50_music/extensions/<id>/<version> --query "晴天"
 *
 * 校验：manifest、入口、describe、health、search 返回结构。
 * 不联网、不修改安装目录；只启动一次子进程。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

const target = path.resolve(process.argv[2] || '.')
const query = process.argv.includes('--query')
  ? process.argv[process.argv.indexOf('--query') + 1] || 'test'
  : 'test'

function fail(msg) { console.error('✖ ' + msg); process.exit(1) }
function ok(msg) { console.log('✔ ' + msg) }

let manifestPath = path.join(target, 'extension.json')
if (!fs.existsSync(manifestPath)) manifestPath = path.join(target, 'manifest.json')
if (!fs.existsSync(manifestPath)) fail('找不到 extension.json: ' + target)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
if (!manifest.id || !manifest.version || !manifest.entry) fail('manifest 缺少 id/version/entry')
const entry = path.join(target, manifest.entry)
if (!fs.existsSync(entry)) fail('入口不存在: ' + entry)
const runtime = manifest.runtime || 'node'
if (runtime !== 'node') fail('当前测试器只支持 node runtime')
ok(manifest.id + '@' + manifest.version)
ok('entry ' + manifest.entry)

const child = spawn(process.execPath, [entry], {
  cwd: target,
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
})
const rl = readline.createInterface({ input: child.stdout })
let nextId = 1
const pending = new Map()
rl.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const waiter = pending.get(message.id)
  if (waiter) { pending.delete(message.id); waiter(message) }
})
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 超时')) }, 5000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const describe = await call('describe')
  if (!describe.result) fail('describe 没有 result')
  ok('describe ' + JSON.stringify(describe.result).slice(0, 240))
  const health = await call('health')
  if (!health.result) fail('health 没有 result')
  ok('health ' + JSON.stringify(health.result))
  if ((describe.result.capabilities || []).includes('search')) {
    const search = await call('search', { query, limit: 5 })
    if (!search.result || !Array.isArray(search.result.songs)) fail('search 必须返回 { songs: [] }')
    ok('search ' + search.result.songs.length + ' 条')
    for (const song of search.result.songs.slice(0, 5)) {
      if (!song.title || !song.artist) fail('search 结果必须包含 title/artist')
    }
  }
  ok('扩展测试通过')
} catch (error) {
  fail(error.message)
} finally {
  child.stdin.end()
  setTimeout(() => { try { child.kill() } catch { } }, 60)
}

