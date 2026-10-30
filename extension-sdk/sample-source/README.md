# Sample Source

这是「留声」扩展协议的可运行示例。

测试：

```bash
node test-connector.mjs sample-source
```

它返回一首示例歌曲，但 `resolve` 故意失败，避免伪装成能真正下载的来源。真实扩展应把 `resolve` 接到平台授权的流地址，或实现受控下载。



