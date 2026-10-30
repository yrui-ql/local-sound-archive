# 留声 · 扩展接入协议 v1

核心客户端不读取第三方代码；扩展是独立进程，通过本地 JSON-RPC 与客户端通信。
内置网易云 / QQ / 汽水继续保留，外部平台通过扩展接入。

## 先看这里：开发一个扩展

1. 客户端「扩展 → 安装示例」，确认协议链路可跑。
2. 点「复制 Agent 指令」，交给 Codex / Claude Code / DSH。
3. Agent 使用 Skill：`SKILL.md`。
4. Agent 在 `03_DATA/50_music/extensions-dev/<platform>/` 生成草稿。
5. 运行：

```bash
node test-connector.mjs 03_DATA/50_music/extensions-dev/<platform>
```

6. 测试通过后，回到客户端「扩展 → 从文件夹安装」。
7. 健康检查通过后启用；出问题点「回退」或开「安全模式」。

人类开发者同样按这七步走，把 Agent 换成编辑器即可。

## 能力边界

先看 [CAPABILITIES.md](CAPABILITIES.md)：明确哪些能力稳定、哪些是协议预览、哪些不允许。

## Skill

仓库内置：`SKILL.md`

它告诉 Agent：

- 先读本协议和 sample；
- 只写 `extensions-dev`；
- 必须实现 `describe / health / search / resolve`；
- 必须跑测试器；
- 不写 active 目录、不写密钥、不改客户端源码。

## 目录结构


```text
03_DATA/50_music/extensions/
  registry.json
  <extension-id>/
    <version>/
      extension.json
      index.mjs
```

`registry.json` 保存 active / last-good 版本。安装新版本不会覆盖旧版本。

## extension.json

```json
{
  "id": "sample-source",
  "name": "Sample Source",
  "version": "0.1.0",
  "description": "示例连接器",
  "runtime": "node",
  "entry": "index.mjs",
  "kind": "source",
  "capabilities": ["search", "resolve", "health"],
  "permissions": ["network"]
}
```

- `id`：小写字母、数字、`.`、`_`、`-`
- `version`：安装后不可在原目录覆盖；新版本使用新目录
- `kind`：`source`（音源）、`metadata`、`lyrics`、`cover`
- `runtime`：默认 `node`，也可使用本机可执行文件
- 权限是声明式的，客户端在启用前展示给用户

## JSON-RPC

stdin/stdout，每行一个 JSON。客户端启动扩展后发：

```json
{"jsonrpc":"2.0","id":1,"method":"describe"}
```

扩展返回：

```json
{"jsonrpc":"2.0","id":1,"result":{"name":"Sample Source","version":"0.1.0","capabilities":["search","resolve","health"]}}
```

方法：

- `describe`：能力发现
- `health`：健康检查
- `search`：统一搜索结果
- `resolve`：返回可下载流或受控下载结果
- `lyrics` / `cover`：可选

搜索结果结构：

```json
{
  "songs": [{
    "id": "track-id",
    "title": "Title",
    "artist": "Artist",
    "album": "Album",
    "duration": 240,
    "cover": "https://...",
    "source": "sample-source"
  }]
}
```

## 安装与回退

1. 安装到 staging；
2. 校验 manifest 与入口；
3. 启动扩展执行 `describe` 健康检查；
4. 健康检查通过后写 active；
5. 旧 active 记为 last-good；
6. 回退只切换 registry 指针，不重新下载；
7. 连续失败或用户手动开启安全模式：全部外部扩展禁用，核心功能照常运行。

扩展异常不能阻止客户端启动。

## Agent 开发入口

设置 → 扩展 → 开发工具可检测本机 Codex / Claude Code / DSH，并打开独立工作区。
Agent 只能在 `extensions-dev` 中生成草稿；安装需要健康检查，发布需要用户确认。

给 Agent 的固定规则：

- 不修改主客户端源码；
- 不读取音乐文件内容；
- 不写入 active 版本目录；
- 凭据从环境变量或客户端提供的本地凭据读取，不写进 manifest / 日志；
- 先输出可测试的 `extension.json` 和 `index.mjs`。




