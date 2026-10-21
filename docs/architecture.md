# 协议与架构

```text
浏览器 ── OAuth / 扫码 / 断开 ── Worker HTTP ── 唯一 ConnectionDO
                                            │ SQLite 加密状态
                                            │ alarm 长轮询、任务轮询
                                            ├── 微信 iLink API / CDN
                                            └── YeeMagine OAuth / Agent API
Cron 每 10 分钟 ── 缺失 alarm 时补建 ────────────┘
```

## 模块

- `index.js`：Worker 路由、安全响应头、DO 包装与 Cron。
- `connection.js`：认证、扫码、消息、命令、报价确认、回复进度、生命周期。
- `state.js`：SQLite 状态；同步 SQL 写入，不跨网络事务。
- `platform.js`：固定 origin 的 OAuth / Agent 请求、限长响应。
- `weixin.js`：iLink 请求、二维码、媒体协议。只向微信 API 发送 bot token。
- `crypto.js`：随机数、HMAC、PKCE、AES-GCM。
- `commands.js`：命令与 Unicode 分段、报价和问题展示。

## 调度与恢复

alarm 开始先设置备份 alarm；检查平台身份后拉取当前任务快照、长轮询微信、逐条处理消息、再检查任务。每批设置处理时间预算，未全部处理时保留旧游标，下轮重新拉取并按 HMAC 去重。平台提交使用稳定幂等键；图片上传成功后只保留资源 ID 以保证提交重试的引用稳定。

消息处理与平台网络 I/O 不持有 SQLite 事务。外部响应后校验连接代次；断开或重新授权后，旧任务不能覆盖新状态。已经发出的上游请求无法撤回，用户断开前应主动取消任务。

平台完成结果只在内存中读取。按确定顺序发送文字分段和图片，每段成功后保存计数。发送成功但保存之前故障仍可能重复投递，稳定 client_id 不能视为上游保证的去重契约。上传图片响应丢失可能留下平台孤立资源，但不会重新扣生成积分。

## 平台接口

固定根地址，无需额外 `/api` 前缀：

- GET `/oauth/authorize`、`/oauth/me`；POST `/oauth/token`、`/oauth/revoke`。
- GET `/v1/account/balance`、`/v1/agent/models`。
- POST `/v1/agent/threads`、`/v1/agent/threads/:id/messages`。
- GET `/v1/agent/runs/:id`；POST 其 `/confirmation`、`/user-input`、`/cancel`。
- POST `/v1/agent/images`；GET `/v1/agent/resources/:id/content`。

平台须实现不轮换的固定 refresh token、消息幂等键、应用级资源隔离、真实费用确认和受限 Agent 工具。Worker 不自行计算积分、不调用模型供应商、不执行模型生成的 URL 或脚本。

## 微信版本

协议按 NOTICE 固定版本实现，未来上游更改需要重新核验。QR scan 查询支持 need_verifycode、scaned_but_redirect、confirmed 等状态；binded_redirect 不凭空恢复凭证，要求重新扫码。

上下文 token 来自收件消息，缺失时不尝试主动群发。仅接受已绑定 owner 的完成态用户私聊消息。图片最大 8 MiB，网络响应实行流式计数上限。当前未实现微信 typing 或 lifecycle 通知；对话以立即确认消息提示处理状态。
