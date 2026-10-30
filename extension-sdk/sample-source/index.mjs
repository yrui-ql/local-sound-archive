import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

rl.on('line', (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request.method === 'describe') {
    return send(request.id, {
      name: 'Sample Source',
      version: '0.1.0',
      capabilities: ['search', 'resolve', 'health'],
    })
  }
  if (request.method === 'health') return send(request.id, { ok: true })
  if (request.method === 'search') {
    return send(request.id, {
      songs: [{
        id: 'demo-1',
        title: '示例歌曲',
        artist: 'Sample Artist',
        album: 'Sample Album',
        duration: 180,
        source: 'sample-source',
      }],
    })
  }
  if (request.method === 'resolve') {
    return send(request.id, { ok: false, error: '示例不提供真实下载流' })
  }
  send(request.id, { ok: false, error: 'unknown method: ' + request.method })
})
