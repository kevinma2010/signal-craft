# 测试策略

## 分层

- 单元测试：单个 parser、状态模块、缓存、去重、错误和降级分支；全部依赖通过 mock 或注入 adapter 隔离。
- E2E 测试：四类连接器并行抓取后，串联翻译缓存、归档、seen、state 与 lock；使用真实文件系统和确定性 adapter。
- 真实 smoke：只用于人工验证来源可达性和已安装的外部 CLI，不进入 CI，避免网络、账号和限流导致不稳定。

## 单元用例

| 模块 | 关键用例 |
| --- | --- |
| CLI | 参数契约、缺失参数、30 天回看上限 |
| Sanitizer | 可执行节点、危险 URL、tracking pixel、图片与媒体链接保留 |
| URL/seen | tracking 参数、稳定 fingerprint、重复追加、90 天裁剪 |
| Sources | YAML 加载、overlay add/disable/weight、重复 ID、非法 schema |
| State/lock | 迁移备份、未来版本拒绝、连续失败、活动锁、陈旧锁接管 |
| RSS/Atom | 两种格式、podcast enclosure、部分/全部失败、staged/seen 去重 |
| GitHub | releases、maintainer discussions、分页、部分失败、token 脱敏 |
| YouTube | feed、native subtitles、Deepgram fallback、预算、缺 `yt-dlp` 降级 |
| X | 官方 headless 参数、严格 JSON 校验、一次重试、缺 CLI/登录降级 |
| Collection ledger | provider/source checkpoint、配置 fingerprint、归档后提交、失败来源缺口、首次回填边界 |
| X API budget | 默认关闭、usage 预检、四层预算、预留与结算、禁止分页、熔断、成功响应不重试 |
| Translation | 缺 key、cache hit、API 成功/失败、并发 immutable cache |
| Archive/JSONL | 月度归档幂等、seen 提交、非法 JSONL |
| Run audit | 不可变写入、严格 schema、X 正文完整性统计、禁止程序日志字段与路径穿越 |

## E2E 用例

`tests/e2e/pipeline.test.ts` 验证：

1. 加载 default pack 与用户 overlay。
2. 获取运行锁；第二个运行被拒绝。
3. 并行运行 RSS、GitHub、YouTube、X 连接器。
4. 产出 article、release、post、video 共 5 条规范化内容。
5. 命中 immutable translation cache。
6. 归档到月度 JSONL，并提交 seen 与 state。
7. 清空 inbox 后重跑；所有内容被 seen 去重，新增数为 0。
8. 释放运行锁。

第二条 E2E 验证类别失败隔离：RSS 全失败时 GitHub 仍完成归档，且 `state.json` 只推进 GitHub 时间戳。

第三条 E2E 使用同一批归档条目读取日报和周报窗口，断言窗口读取不调用任何 connector，并验证周报读取最近 7 天原始条目而非日报文本。

第四条 E2E 启用 mock X API：运行前读取远端 usage，预算内只获取 checkpoint 后的新 Post；同一区间重跑采集与读取报告窗口均不产生额外 billable response，并验证跨来源共享每轮预算。

## 命令

```bash
bun run test:unit
bun run test:e2e
bun test
bun run typecheck
bun run lint
```

CI 使用 mock，不需要真实 API key、Grok 登录或 `yt-dlp`。真实 Deepgram、Grok、GitHub 限流与 YouTube 下载只在人工 smoke 中验证，并使用临时目录。
