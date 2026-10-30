---
name: music-extension-dev
description: 为「留声」开发、测试、打包和接入音乐源扩展。当用户说"接一个新平台""写一个音乐源扩展""把 Spotify/YouTube Music/Tidal 接进留声""扩展怎么开发"时使用。
version: 1
status: current
verify: node test-connector.mjs sample-source
---

# music-extension-dev — 音乐源扩展开发

把「接一个平台」变成可测试、可安装、可回退的独立进程，不改客户端源码。

## 先读

- 能力边界：[CAPABILITIES.md](CAPABILITIES.md)（哪些能改、哪些不能改）

- 协议：[`EXTENSIONS.md`](EXTENSIONS.md)
- 示例：`sample-source/`
- 测试器：`test-connector.mjs`

## 边界

扩展负责：

- 平台认证；
- 搜索；
- 解析曲目可下载流；
- 可选歌词 / 封面。

扩展不负责：

- 改客户端源码；
- 直接写音乐库；
- 直接写 active 扩展目录；
- 读取完整音乐文件内容。

## 标准流程

### 1. 建工作目录

```text
03_DATA/50_music/extensions-dev/<platform>/
  extension.json
  index.mjs
  fixtures/
```

不要直接在 `03_DATA/50_music/extensions/<id>/<version>` 里开发。

### 2. 写 manifest

```json
{
  "id": "spotify",
  "name": "Spotify",
  "version": "0.1.0",
  "description": "Spotify source connector",
  "runtime": "node",
  "entry": "index.mjs",
  "kind": "source",
  "capabilities": ["search", "resolve", "health"],
  "permissions": ["network", "auth"]
}
```

### 3. 实现 JSON-RPC

stdin/stdout，每行一个 JSON：

```js
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

rl.on('line', (line) => {
  const req = JSON.parse(line)
  if (req.method === 'describe') return send(req.id, {
    name: 'Spotify', version: '0.1.0',
    capabilities: ['search', 'resolve', 'health'],
  })
  if (req.method === 'health') return send(req.id, { ok: true })
  if (req.method === 'search') return send(req.id, { songs: [] })
  if (req.method === 'resolve') return send(req.id, { ok: false, error: 'not implemented' })
  send(req.id, { ok: false, error: 'unknown method' })
})
```

必须实现：

- `describe`：能力发现；
- `health`：无网/有网都可判断的轻量检查；
- `search`：返回 `{ songs: [...] }`；
- `resolve`：返回可下载流或受控下载。

可选 `lyrics` / `cover`。

### 4. 搜索结构

```json
{
  "songs": [{
    "id": "track-id",
    "title": "Title",
    "artist": "Artist",
    "album": "Album",
    "duration": 240,
    "cover": "https://...",
    "source": "spotify"
  }]
}
```

### 5. 测试

```bash
node test-connector.mjs 03_DATA/50_music/extensions-dev/spotify
```

测试器会启动扩展、发 `describe`、`health`、`search`，并检查返回结构。
只有这一步通过才好安装。

### 6. 安装

把整个开发目录（包含 `extension.json`）拖入客户端「扩展 → 从文件夹安装」，或由客户端安装器处理。
安装时会：

1. 校验 manifest；
2. 复制到独立版本目录；
3. 启动扩展做健康检查；
4. 通过后才启用。

### 7. 回退

旧版本保留在 `extensions/<id>/<version>/`。
客户端「扩展 → 回退」只切换 registry 指针，不重新下载。
启用安全模式会禁用所有外部扩展。

## 安全规则

- 凭据只从本机环境变量或客户端提供的凭据读取；
- 不把 token 写进 manifest、日志、示例或错误消息；
- 不执行未声明的文件写入；
- 网络请求必须有超时和错误处理；
- 扩展崩溃不能拖垮客户端。

## 交付清单

- [ ] `extension.json` 通过 manifest 校验
- [ ] `describe` / `health` / `search` 通过测试器
- [ ] README 说明认证方式和所需权限
- [ ] 没有密钥、Cookie、用户路径
- [ ] 安装后健康检查通过
- [ ] 旧版本可回退

## 给 Codex / Claude Code / DSH 的启动提示

```text
请使用 SKILL.md。
先读 EXTENSIONS.md 和示例扩展。
在 03_DATA/50_music/extensions-dev/<platform>/ 内开发：
- extension.json
- index.mjs
- 测试 fixture（不装真实密钥）
用 node test-connector.mjs <目录> 跑通。
不要修改客户端源码，不要写入 active 扩展目录。
最后给我：目录路径、测试输出、所需权限。
```






