# Amazon Connect Email Handler

一个用于处理 Amazon Connect **邮件（EMAIL）** 联系的页面。参考自
[connect-ccp-custom-agent-chat](https://github.com/photosphere/connect-ccp-custom-agent-chat)，
顶部登录与座席状态区域保持一致，中间原来的聊天框替换为**排队邮件列表**。

## 功能

1. **顶部登录与状态**：使用 `amazon-connect-streams` 初始化 CCP，顶部的登录、退出、
   座席姓名与状态下拉框与参考页面保持一致。
2. **排队邮件列表**：调用
   [SearchContacts](https://docs.aws.amazon.com/connect/latest/APIReference/API_SearchContacts.html)
   查询配置文件中所配置队列里正在排队的邮件，并以列表形式显示明细。
3. **Assign to Me**：每行提供 “Assign to Me” 按钮，点击后调用
   [TransferContact](https://docs.aws.amazon.com/connect/latest/APIReference/API_TransferContact.html)
   将该邮件转接到当前登录座席的个人队列（通过 `UserId` 转接）。
4. **View 查看历史**：每行提供 “View” 按钮，点击后弹窗显示该邮件的历史来往记录，
   **按 contact id 分组**并展示每封邮件正文。后端链路：`ListAssociatedContacts`（邮件线程）
   → `ListContactReferences`（EMAIL_MESSAGE 引用）→ `GetAttachedFile`（预签名 URL）
   → 下载并解析邮件内容；正文在沙箱 iframe 中渲染（禁用脚本，防止 XSS）。
5. **AWS 凭证在环境变量中**：所有 AWS 凭证及 Connect 配置均放在 `.env` 文件。

> 说明：`SearchContacts` 与 `TransferContact` 是需要 AWS 凭证签名调用的服务端 API，
> 因此由 Node.js 后端（`server/index.js`）代理调用，前端页面只与本后端交互，凭证不会下发到浏览器。

## 目录结构

项目结构参考
[amazon-connect-realtime-dashboard](https://github.com/photosphere/amazon-connect-realtime-dashboard)：
前端使用 Vite（`email.html` + `src/main.js`），后端为独立的 Express 服务（`server/index.js`）。

```
.
├── email.html            # 前端页面（Vite 入口）
├── src/
│   └── main.js           # 前端逻辑（CCP 初始化、邮件列表、Assign to Me）
├── server/
│   └── index.js          # Node.js/Express 后端，代理调用 Connect API
├── .env                  # 实际配置（含 AWS 凭证，已加入 .gitignore）
├── .env.example          # 配置模板
├── vite.config.js        # Vite 配置（dev 端口 8080，/api 代理到 3001）
└── package.json
```

## 配置

复制模板并填写：

```bash
cp .env.example .env
```

`.env` 环境变量说明：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 后端监听端口，默认 3001（需与 `vite.config.js` 中的代理目标一致） |
| `AWS_REGION` | AWS 区域，如 `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS Access Key ID |
| `AWS_SECRET_ACCESS_KEY` | AWS Secret Access Key |
| `AWS_SESSION_TOKEN` | （可选）临时凭证的 Session Token |
| `CONNECT_INSTANCE_ID` | Amazon Connect 实例 ID（ARN 中的 UUID 部分） |
| `CONNECT_REGION` | 调用 Connect API 的区域（缺省用 `AWS_REGION`） |
| `CONNECT_TRANSFER_CONTACT_FLOW_ID` | 用于转接的流 ID（Transfer to agent / Transfer to queue / Inbound 流） |
| `CONNECT_QUEUE_IDS` | 需要监控的队列 ID 列表，多个用英文逗号分隔 |
| `SEARCH_LOOKBACK_DAYS` | SearchContacts 回溯天数，默认 7 |

> **CCP 初始化相关的值（`instanceURL`、`instanceCCPURL`、`instanceRegion`、
> `loginURL`、`logoutURL`）已硬编码在 `src/main.js` 顶部的常量区**，
> 如需切换实例请直接修改该文件。

## 所需 IAM 权限

后端使用的凭证需具备以下 Amazon Connect 权限：

- `connect:SearchContacts`
- `connect:TransferContact`
- `connect:ListUsers`（用于将当前座席用户名解析为 UserId）
- `connect:DescribeQueue`（用于把队列 ID 解析为队列名）
- `connect:ListAssociatedContacts`、`connect:ListContactReferences`、`connect:DescribeContact`、`connect:GetAttachedFile`（用于 View 查看邮件历史与正文）

## 运行

安装依赖：

```bash
npm install
```

### 开发模式（前端热更新 + 后端）

同时启动 Vite 开发服务器（8080）与后端 API（3001），`/api` 请求会自动代理到后端：

```bash
npm run dev
```

浏览器会自动打开 `http://localhost:8080/email.html`。

也可分别启动：

```bash
npm run dev:server   # 仅后端 API (3001)
npm run dev:client   # 仅前端 (8080)
```

### 生产模式

先构建前端产物到 `dist/`，再由后端统一托管：

```bash
npm run build
npm start
```

然后打开 `http://localhost:3001`。点击右上角“登录”完成 CCP 登录后，
座席信息会显示在顶部，排队邮件会自动加载，也可点击“刷新”或勾选“自动刷新”。

## 使用说明

- **登录**：点击“登录”弹出 Amazon Connect 登录窗口，登录成功后顶部显示座席姓名与状态。
- **排队邮件**：列表显示配置队列中仍在排队（未分配座席、未断开）的 EMAIL 联系明细，
  包含主题、渠道、队列、入队时间、等待时长与 Contact ID。
- **Assign to Me**：点击后将该邮件通过 `TransferContact` 转接到当前座席的个人队列。
  完成后列表会自动刷新。

## 备注

- `TransferContact` 仅支持 `TASK` 与 `EMAIL` 类型联系，且只能对活动中的联系调用。
- 若“Assign to Me”提示无法确定 UserId，请确认登录座席的用户名在实例中存在，
  并且凭证具备 `connect:ListUsers` 权限。
