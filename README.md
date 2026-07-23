# Bilibili Accelerator

[简体中文](README.md) | [English](README.en.md)

[![CI](https://github.com/stabruriss/bilibili-accelerator/actions/workflows/ci.yml/badge.svg)](https://github.com/stabruriss/bilibili-accelerator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-00aeec.svg)](LICENSE)
[![Install userscript](https://img.shields.io/badge/Install-userscript-00aeec.svg)](https://raw.githubusercontent.com/stabruriss/bilibili-accelerator/main/bilibili-accelerator.user.js)

这是一个油猴脚本，用来解决观看 B站时明明网速够，视频却仍然卡顿的问题。

- 内置 4 条常用 CDN 线路，通过切换 CDN 改善视频播放。
- 内置自动测速，可以自动选择当前表现最佳的 CDN。
- 支持手动指定 CDN，也可以随时开关自动测速。
- 选择「B站原始」即可关闭线路切换，恢复 B站原始播放地址。

本项目与哔哩哔哩（Bilibili）无隶属或官方合作关系。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击
   **[安装 Bilibili Accelerator](https://raw.githubusercontent.com/stabruriss/bilibili-accelerator/main/bilibili-accelerator.user.js)**。
3. 如果已经安装其他会改写 B站 CDN 地址的脚本，请先禁用它们。
4. 打开或刷新任意 B站视频页。

脚本带有 `@updateURL`，Tampermonkey 可以从本仓库的 `main` 分支检查更新。

## 它解决什么问题

在部分海外网络中，`curl` 或普通下载测速可能很快，但浏览器播放器的
DASH 分片仍会间歇超时、卡缓冲。固定换到一个 CDN 也不一定可靠，因为：

- B站 API 会按视频返回不同的原生主备线路。
- Akamai URL 依赖原生 `hdnts` 签名，不能只替换 hostname。
- 同一 hostname 的边缘节点和实际路径可能随时间变化。
- 只看峰值 Mbps 无法反映超时、首包延迟和最慢一次请求。

Bilibili Accelerator 使用当前视频可访问的真实 URL 做小范围 Range
测试，再根据缓存的健康记录安排下一份播放地址，不阻塞视频启动。

## 安全边界

- 保留 B站 API 原生返回的完整主备 URL。
- Akamai 只使用 API 原样提供、带有效签名的 URL。
- 普通 UPOS host 只从代码内白名单生成，不接受页面或用户任意注入。
- PCDN 地址会被降到官方 CDN 之后。
- 全部测试失败时恢复 B站原始线路。
- 不保存完整媒体 URL、签名、cookie 或 token。
- 不发送分析、遥测或用户数据。

## 控制面板

视频页会显示一个可拖动的半透明闪电圆点：

- 蓝色：脚本正在接管线路。
- 黄色：等待安全测速窗口。
- 红色：测速失败或设置保存失败。
- 灰色：正在使用「B站原始」。

点击圆点展开 `Bilibili Accelerator` 面板。可选择：

- **自动选择**：使用有效测速结果重排线路。
- **B站原始**：完全不修改播放地址，也是面板中的总停用入口。
- **Cosov / Aliov / 香港 EQ**：手动放到首位，仍保留原生线路回退。
- **原生 Akamai**：仅当当前视频 API 确实返回签名 Akamai URL 时可选。

选择后点击「刷新并应用」。每条实际 CDN 线路会显示 Mbps、TTFB、
成功状态和上次完整测速时间。

底部的「自动测速」开关只控制后台测试，不改变已经选择的线路：

- 开启：缓存需要复核或过期时，在新播放地址出现后后台测试。
- 关闭：不再启动后台测试；「重新测速」仍可手动强制完整测试。

## 自动选择逻辑

完整测速会对每条候选线路串行读取两个 256 KiB Range：

1. 两个 Range 都完成才视为健康。
2. 优先比较成功率，再比较两次请求中较慢的一次完成时间。
3. 两条健康线路相差不超过 15% 时，保持 B站 API 原始顺序，避免抖动。
4. Mbps 是便于观察的吞吐指标，不会单独决定赢家。

缓存和复核策略：

- 完整成功结果缓存 4 小时。
- 失败结果缓存 15 分钟，过期后只重测对应失败线路。
- 实际首选线路每 15 分钟最多做一次单 Range 轻量复核。
- 轻量复核失败或明显变慢时，升级为完整测速。
- 测速会先延迟 1.2 秒，并等待视频暂停或至少 15 秒缓冲。

## 权限与隐私

Userscript 使用 `@grant none`，只匹配：

- `https://www.bilibili.com/*`
- `https://m.bilibili.com/*`

它会向 B站原生 CDN 及内置的官方 UPOS 候选发送小型 Range 请求。
本地仅在 `localStorage` 保存线路选择、自动测速偏好、入口坐标，以及按
host 汇总的成功次数、测速速度、TTFB、最差耗时和时间戳。

提交 issue 时请勿粘贴完整媒体 URL。URL 可能包含短期签名或其他敏感参数；
请只保留 hostname，并涂掉 query string。

## 兼容性

主要开发和测试环境是桌面版 Chromium 浏览器与 Tampermonkey。其他
userscript 管理器或浏览器可能可用，但目前不作为正式兼容目标。

本脚本只处理 CDN 地址，不会修改播放器的
`nc_disable / rp_disable / p2p_disable` 等设置。

## 本地开发

需要 Node.js 18 或更高版本，不需要安装运行时依赖：

```bash
npm run check
npm test
```

主要文件：

- `bilibili-accelerator.user.js`：可直接安装的 userscript。
- `bilibili-accelerator.test.js`：URL、安全边界、缓存和浏览器拦截测试。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按
[SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE) © 2026 stabruriss
