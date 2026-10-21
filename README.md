# YeeMagine 微信 Agent Worker

把自己的 YeeMagine 平台账户连接到微信，在微信里对话、切换模型、查积分、上传参考图和生成图片。每个 Worker 服务 **一个平台账户和一个微信账户**。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Kylsky/yeemagine-agent-worker)

> 当前为首版实现，尚未完成真实微信与生产平台端到端验收。点击上方按钮可进入 Cloudflare 官方部署向导。不要把源码测试通过等同于生产验收。

## 功能

- 仅通过本平台 OAuth 授权码 + PKCE 登录，精确校验配置的 userId 和 Client ID。
- 微信二维码登录、验证码、长轮询、断线退避及定时恢复。
- 文本与图片输入、文字与图片输出；不支持群聊、语音、视频、文件。
- 平台 Agent 报价必须先展示，再由用户回复“确认”；报价变化后重新确认。
- 一个活动任务，不排队；平台提交使用消息 HMAC 幂等键。
- AES-GCM 加密持久凭证与回复地址。Worker 不持久保存消息正文、生成结果正文、图片、二维码内容、验证码或积分余额。
- 一个 SQLite Durable Object；无需 D1、KV、R2、外部数据库或常驻服务器。

旧方案中的 business 多用户模式不在本版范围内。多个用户应各自部署、各自创建个人 OAuth 应用。

## 一键部署

### 1. 创建 Worker

点击上方按钮，在 Cloudflare 授权 GitHub 并按页面提示复制仓库、部署。配置文件会自动声明 Durable Object 和定时任务。

首次部署还没有 Worker 域名及平台应用时，可先保留配置为空：页面会显示缺失项，**不会开放未认证的配置接口或消息服务**。若部署向导要求 Secret 值，先填写随机占位值，随后必须替换。

### 2. 在平台登记应用

1. 平台管理员启用个人 OAuth 功能，并确认 Agent、积分、图片服务可用。
2. 打开平台「用户中心 → 授权应用」，创建个人应用。
3. 填写刚部署的 Worker HTTPS 根地址，例如 `https://your-worker.your-subdomain.workers.dev`。
4. 保存平台给出的 Client ID、Client Secret 和所有者 userId。回调地址固定为 Worker 根地址加 `/auth/callback`。

平台须已部署个人 OAuth 接口。普通 OpenAI 兼容 API 或其他 OAuth 提供方不能直接替代。

### 3. 配置变量和机密

在 Cloudflare「Workers & Pages → 当前 Worker → 设置 → 变量和机密」中填写，保存部署后生效。

| 名称 | 类型 | 内容 |
|---|---|---|
| `PLATFORM_BASE_URL` | 文本 | 平台 HTTPS 根地址，不能包含路径、查询参数或用户名 |
| `PUBLIC_BASE_URL` | 文本 | 当前 Worker HTTPS 根地址，必须与平台登记地址一致 |
| `OAUTH_CLIENT_ID` | 文本 | 个人应用 Client ID |
| `PLATFORM_USER_ID` | 文本 | 应用所有者 userId，作为字符串精确匹配 |
| `OAUTH_CLIENT_SECRET` | Secret | 应用 Client Secret |
| `CREDENTIAL_ENCRYPTION_KEY` | Secret | 独立随机生成的 32 字节密钥，以 64 位十六进制表示 |

在自己的终端生成加密密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

请勿把真实值写入 Git、Issue 或日志。不要重复使用 Client Secret 作为加密密钥。`keep_vars` 保留控制台设置的普通变量；Secret 通过 Cloudflare 单独管理。

### 4. 授权并扫码

打开 Worker 页面 → 使用平台账户授权 → 生成微信二维码 → 微信扫码确认。如微信要求验证码，在页面输入。页面关闭后，已连接的 Worker 仍通过 Durable Object alarm 工作。

变更平台地址、Worker 地址、Client ID、userId 或加密密钥会使本地状态清空，需要重新授权、扫码。更新 Client Secret 不清空状态。若浏览器会话过期，重新授权也会建立全新连接。

本仓库不包含真实平台域名或凭证；部署时使用你自己的平台应用和 Cloudflare 账户。

## 微信命令

| 命令 | 用途 |
|---|---|
| `/help`、`/帮助` | 帮助 |
| `/models`、`/model`、`/模型` | 模型列表 |
| `/model 1`、`/模型 1` | 切换模型 |
| `/balance`、`/余额` | 当前积分余额 |
| `/status`、`/状态` | 当前连接及任务状态 |
| `/new`、`/新对话` | 清空参考图，开始新对话 |
| `/cancel`、`/取消` | 请求取消当前任务 |
| `/image 描述`、`/生图 描述` | 图片生成 |

直接发送文字即可对话。先发参考图，再在 30 分钟内发要求；最多保留 4 张参考图，单张上限 8 MiB。该上限为实现保护值，仍需在真实微信链路中验证。引用消息的斜杠命令不执行；未知命令不提交平台；`//` 可转义为普通斜杠文本。

报价后发送「确认」或「取消」。补充信息只有一个问题时直接回答，多个问题用 `1=答案` 分行回答；单个图片问题可直接发送图片。多个问题包含图片时，可在同一条消息中附图，并使用 `1=图片1` 指向本条消息的第一张图片。

## 运行与隐私

- 每个实例只接受扫码所绑定用户的私聊消息。OAuth owner 与配置不匹配时拒绝连接。
- OAuth 访问令牌自动刷新；`invalid_grant` 或刷新后仍 401 时清除本地授权、微信连接及任务状态。
- 平台 `OAUTH_DISABLED` 表示暂停，保留凭证并退避恢复。`invalid_client` 应检查 Client Secret。
- 微信 `-14` 冷却一小时；其他故障指数退避，最长十分钟。定时任务每十分钟检查是否缺少 alarm。
- 消息去重最多保留 500 个 HMAC / 3 天，回复进度只存分段计数。网络中断可能产生重复回复；**不承诺微信投递 exactly-once**。
- 断开微信会清除本地微信与对话状态，但不会取消平台已接受的任务。先用 `/cancel` 再断开；平台已有聊天记录不会被删除。
- 凭证加密不代表部署管理员无法解密。Cloudflare 平台备份/保留策略也不受应用内删除控制。
- 默认关闭 Worker observability，无应用日志、分析脚本或第三方字体。主动开启日志/请求采样可能暴露 OAuth code 或微信验证码，请自行评估。
- 长轮询、alarm、存储和外部调用会消耗 Cloudflare 配额，平台对话/生图消耗平台积分；一键部署不代表免费运行。

详见 [隐私与威胁边界](docs/privacy.md)、[协议与架构](docs/architecture.md)、[验收清单](docs/acceptance.md)。

## 本地开发

需要 Node.js 22+。

```sh
npm ci
cp .dev.vars.example .dev.vars
# 仅在本地 .dev.vars 中填入测试环境凭证；不要提交
npm test
npm run check
npm run dev
```

`test` 为源码单元/流程测试；`check` 仅检查 JS 语法和配置约束，不编译。真实 OAuth 使用 Secure Cookie 和 HTTPS 回调，本地联调需配置受控 HTTPS 域名并在测试平台登记，普通 HTTP localhost 不支持完整登录。

发布时执行 `npm run deploy` 或通过 Cloudflare Git 集成部署。不提供 `build` 脚本，Wrangler 部署时负责打包；本次开发未执行部署或编译。

## 上游与许可证

本项目采用 MIT。微信协议依据腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)，部署入口参考 [Moni](https://github.com/ISheepp/Moni) 和 [Cloudflare Deploy 按钮文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。协议版本及来源记录见 [NOTICE](NOTICE)。本项目不是腾讯或 Cloudflare 官方产品。
