# YeeMagine 微信助手

把 YeeMagine 平台的 Agent 接进你的微信：对话、生图、查积分。一个 Worker 只服务你自己。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Kylsky/yeemagine-agent-worker)

> 首版实现，尚未完成真实微信与生产平台的端到端验收。

## 部署

### 1. 部署 Worker

点击上方按钮，按 Cloudflare 向导完成部署。向导里的配置项**可以先留空**；如果向导要求填写 Secret，先填一个占位值，第 4 步再替换。

### 2. 复制 Worker 地址

打开部署好的 Worker，页面上会显示它的地址，形如 `https://名称.账户.workers.dev`。不需要自定义域名。

### 3. 在平台创建应用

在平台「用户信息 → 授权应用」点击「创建应用」，填入上一步的地址。地址填错了可以在「编辑」里修改。

> 需要平台管理员先在「系统设置」里开启开放授权。

### 4. 填写配置

在 Cloudflare「Workers 和 Pages → 你的 Worker → 设置 → 变量和机密」中填写平台给出的 4 项，保存后重新部署：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `PLATFORM_BASE_URL` | 文本 | 平台地址，需能从公网通过 HTTPS 访问 |
| `PLATFORM_USER_ID` | 文本 | 平台显示的用户 ID（不是邮箱） |
| `OAUTH_CLIENT_ID` | 文本 | 应用的 Client ID |
| `OAUTH_CLIENT_SECRET` | 密钥 | 应用的 Client Secret |

### 5. 授权并扫码

打开 Worker 页面 → 使用平台账户授权 → 生成微信二维码 → 微信扫码确认。之后关掉网页也能正常收发。

## 在微信里使用

| 命令 | 作用 |
| --- | --- |
| 直接发文字 | 和 Agent 对话 |
| `/image 描述` | 生成图片，先报价，回复「确认」才执行 |
| `/new` | 开始新对话 |
| `/model`、`/model 序号` | 查看、切换模型 |
| `/balance` | 查看积分 |
| `/status` | 查看连接和任务状态 |
| `/cancel` | 取消当前任务 |
| `/help` | 查看全部命令 |

中文命令同样可用：`/新对话` `/生图` `/模型` `/余额` `/状态` `/取消`。

- **参考图**：先发图片，30 分钟内再发要求。最多 4 张，单张不超过 8 MB。
- **补充问题**：有选项时回复序号即可；多个问题按 `1=答案` 分行回复。
- **一次一个任务**：任务进行中不接新消息，可以先 `/cancel`。
- **普通斜杠文字**：用 `//` 开头，例如 `//help` 会原样发送 `/help`。

## 隐私

- 只处理扫码本人发来的私聊消息。
- 不保存消息正文、生成结果、图片、二维码和验证码，只加密保存连接所需的凭证。
- 平台授权失效或被撤销时，自动清除本地凭证和微信连接。
- 默认关闭 Worker 日志。自行开启日志可能记录授权码、验证码等敏感信息。
- 加密密钥默认和数据存在同一个 Durable Object 里，挡不住存储整体泄露；需要分开保存时见下方「高级配置」。

详见 [隐私与威胁边界](docs/privacy.md)。

## 常见问题

**页面一直提示还差几项配置**
确认 4 项都已保存并重新部署。`PLATFORM_BASE_URL` 不能是 localhost，也不能带路径。

**提示 Client Secret 不正确**
平台上重置过密钥后，需要把新密钥更新到 `OAUTH_CLIENT_SECRET`。

**网页登录过期了**
重新点授权即可，已连接的微信会保留。

**换了 Worker 地址**
先在平台「编辑」应用改地址，再到新地址重新授权、扫码。

**改了平台地址、用户 ID 或 Client ID**
本地连接会被清空，需要重新授权、扫码。只改 Client Secret 不受影响。

**平台暂停了开放授权**
连接会保留，平台恢复后自动继续。

**偶尔收到重复回复**
网络中断时可能重发同一段回复，不会重复扣积分。

**费用**
长轮询会持续消耗 Cloudflare 用量；对话和生图消耗平台积分。

## 高级配置（可选）

| 名称 | 作用 |
| --- | --- |
| `PUBLIC_BASE_URL` | 锁定唯一的 Worker 地址 |
| `CREDENTIAL_ENCRYPTION_KEY` | 64 位十六进制密钥，让加密密钥和数据分开保存 |

修改这两项会清空本地连接，需要重新授权、扫码。

## 本地开发

需要 Node.js 22+。

```sh
npm ci
cp .dev.vars.example .dev.vars   # 只填测试环境凭证，不要提交
npm test
npm run check
npm run dev
```

完整登录需要 HTTPS 回调，普通 HTTP 的 localhost 走不通授权。发布用 `npm run deploy`，或使用 Cloudflare 的 Git 集成自动部署。

更多文档：[协议与架构](docs/architecture.md) · [验收清单](docs/acceptance.md)

## 许可证

MIT。微信协议参考腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)，部署按钮参考 [Moni](https://github.com/ISheepp/Moni) 和 [Cloudflare 文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)，来源记录见 [NOTICE](NOTICE)。本项目不是腾讯或 Cloudflare 的官方产品。
