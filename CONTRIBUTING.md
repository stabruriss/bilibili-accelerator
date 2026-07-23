# Contributing

感谢你愿意改进 Bilibili Accelerator。

## 开始之前

- 搜索现有 issue，避免重复报告。
- 一个 pull request 尽量只解决一个问题。
- 不要提交完整媒体 URL、cookie、token 或带 query string 的签名地址。
- CDN 行为可能随地区和时段变化；性能结论应附上地区、运营商和测试时间。

## 本地检查

需要 Node.js 18 或更高版本：

```bash
npm run check
npm test
```

当前测试不依赖第三方 npm 包。

## 修改原则

- 任何 URL 改写都必须保留 path、query 和签名字节。
- 不得通过替换 hostname 伪造 Akamai URL。
- 新增普通 UPOS host 前，需要确认 CORS、Range 和相同签名参数兼容。
- 测速必须避免与播放器启动流量并发争抢。
- 新行为应带有覆盖安全边界或回归场景的测试。

## Pull request

请在说明中写清：

- 改了什么，以及为什么。
- 对用户和网络请求行为的影响。
- 手动验证环境。
- 执行过的测试。

提交贡献即表示你同意以本项目的 MIT License 发布该贡献。
