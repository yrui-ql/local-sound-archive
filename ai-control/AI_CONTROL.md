# 留声 · AI 控制入口

留声提供本地 MCP 桥接和本地 HTTP 控制接口，AI 可以读取当前播放状态、搜索本地库并控制播放。

## 开启

设置 → AI 控制 → 开启。

开启后真实地址：

```text
http://127.0.0.1:18765/v1
```

只绑定 `127.0.0.1`，并需要本机配置里的 token。

## MCP 配置

客户端「AI 控制」面板点「复制 MCP 配置」，粘贴到支持 MCP 的客户端即可。

```json
{
  "mcpServers": {
    "lsa": {
      "command": "node",
      "args": [
        "<应用目录>\\ai-control\\mcp-server.mjs",
        "--config",
        "<数据目录>\\ai-control.json"
      ]
    }
  }
}
```

## AI 能做什么

- `music_status`：当前歌曲、播放状态、进度、音量、队列；
- `music_search`：搜索本地库；
- `music_play`：按歌名/歌手/URL 播放；
- `music_pause` / `music_resume`；
- `music_next` / `music_previous`；
- `music_seek`：跳到指定秒数；
- `music_volume`：0–100；
- `music_queue`：查看队列。

## 边界

- 只控制播放，不删除音乐、不改数据库、不整理文件；
- token 只保存在本机 `ai-control.json`，不写日志；
- AI 不能通过这个接口执行系统命令；
- 关闭开关或退出客户端后接口不可用。

