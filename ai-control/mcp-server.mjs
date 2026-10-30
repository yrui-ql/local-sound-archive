#!/usr/bin/env node
/**
 * 留声 · 本地 MCP 桥
 *
 * 用法：
 *   node mcp-server.mjs --config <ai-control.json>
 *
 * 它只连接 127.0.0.1，不监听公网，不执行任意命令。
 */
import fs from 'node:fs'
import readline from 'node:readline'

const args = process.argv.slice(2)
const configIndex = args.indexOf('--config')
const configPath = configIndex >= 0 ? args[configIndex + 1] : process.env.LSA_AI_CONFIG
if (!configPath || !fs.existsSync(configPath)) {
  console.error('缺少 ai-control.json（--config 或 LSA_AI_CONFIG）')
  process.exit(1)
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
if (!config.port || !config.token) {
  console.error('ai-control.json 缺少 port/token')
  process.exit(1)
}
const base = `http://127.0.0.1:${config.port}/v1`

async function api(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-LSA-Token': config.token,
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { ok: false, error: text || res.statusText } }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

const TOOLS = [
  {
    name: 'music_status',
    description: '读取当前歌曲、播放状态、播放进度、音量和队列。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'music_search',
    description: '搜索本地音乐库。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名、歌手或专辑关键词' },
        limit: { type: 'number', description: '最多返回数量，默认 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'music_play',
    description: '按歌名/歌手/URL 播放一首本地歌曲。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名或歌手' },
        url: { type: 'string', description: 'music_search 返回的本地 URL' },
      },
    },
  },
  {
    name: 'music_pause',
    description: '暂停当前播放。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'music_resume',
    description: '继续播放。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'music_next',
    description: '播放下一首。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'music_previous',
    description: '播放上一首。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'music_seek',
    description: '跳转到当前歌曲的指定秒数。',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: '目标秒数，从 0 开始' } },
      required: ['seconds'],
    },
  },
  {
    name: 'music_volume',
    description: '设置音量，0–100。',
    inputSchema: {
      type: 'object',
      properties: { volume: { type: 'number', description: '0–100' } },
      required: ['volume'],
    },
  },
  {
    name: 'music_queue',
    description: '读取当前播放队列。',
    inputSchema: { type: 'object', properties: {} },
  },
]

const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const sendError = (id, message) => process.stdout.write(JSON.stringify({
  jsonrpc: '2.0', id, error: { code: -32000, message: String(message) },
}) + '\n')

async function callTool(name, input) {
  if (name === 'music_status') return api('/status')
  if (name === 'music_queue') return api('/command', { method: 'POST', body: JSON.stringify({ action: 'queueList' }) })
  if (name === 'music_search') {
    const q = encodeURIComponent(String(input?.query || ''))
    const limit = Math.max(1, Math.min(100, Number(input?.limit) || 20))
    return api(`/library?query=${q}&limit=${limit}`)
  }
  if (name === 'music_pause') return api('/command', { method: 'POST', body: JSON.stringify({ action: 'pause' }) })
  if (name === 'music_resume') return api('/command', { method: 'POST', body: JSON.stringify({ action: 'resume' }) })
  if (name === 'music_next') return api('/command', { method: 'POST', body: JSON.stringify({ action: 'next' }) })
  if (name === 'music_previous') return api('/command', { method: 'POST', body: JSON.stringify({ action: 'previous' }) })
  if (name === 'music_play') return api('/command', { method: 'POST', body: JSON.stringify({ action: 'play', args: input || {} }) })
  if (name === 'music_seek') return api('/command', { method: 'POST', body: JSON.stringify({ action: 'seek', args: { seconds: Number(input?.seconds) || 0 } }) })
  if (name === 'music_volume') return api('/command', { method: 'POST', body: JSON.stringify({ action: 'volume', args: { volume: Number(input?.volume) || 0 } }) })
  throw new Error('unknown tool: ' + name)
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
rl.on('line', async (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (!message || !message.method) return
  const id = message.id
  try {
    if (message.method === 'initialize') {
      return send(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'lsa-ai-control', version: '1.0.0' },
      })
    }
    if (message.method === 'notifications/initialized') return
    if (message.method === 'ping') return send(id, {})
    if (message.method === 'tools/list') return send(id, { tools: TOOLS })
    if (message.method === 'tools/call') {
      const name = message.params?.name
      const input = message.params?.arguments || {}
      try {
        const result = await callTool(name, input)
        return send(id, { content: [{ type: 'text', text: JSON.stringify(result) }] })
      } catch (error) {
        return send(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message }) }], isError: true })
      }
    }
    if (id !== undefined) sendError(id, 'unknown method: ' + message.method)
  } catch (error) {
    if (id !== undefined) sendError(id, error.message)
    else console.error(error.message)
  }
})

