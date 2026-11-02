# AI Chat MVP

`React + Node BFF` 的 AI 对话项目，覆盖：

- 流式对话（SSE）
- **刷新 / 断线后续传**（事件缓冲 + `Last-Event-ID` 回放）
- 自定义 Agent（人设 + 模型 + 工具开关）
- 多模型、多 provider，支持用户自带 key（BYOK）
- 工具调用（function calling）
- 文档上传 → 切块 → 向量化 → 检索 → 重排（RAG）
- 图片型 PDF 的 OCR 兜底（`qwen-vl-ocr`）
- Skills（SKILL.md，按需注入）
- MCP（仅 HTTP / Streamable HTTP）
- 访问码 + 限流

> 聊天记录存在浏览器 IndexedDB，**服务端不存任何对话**。

---

## 快速开始

```bash
cp .env.example .env      # 填 key；不填就是 mock 模式
npm install
npm run dev               # 前端 5173 / 后端 8787
```

生产：

```bash
npm run build
npm start                 # 单端口 8787 托管 dist
```

自检（另开一个终端，先启动 server）：

```bash
npm run smoke             # 23 项：流式、续传、取消、RAG、PDF、Skills、异常
```

---

## 接多家模型（服务端 key + 用户自带 key）

```bash
cp providers.example.json providers.json
```

```json
[
  {
    "id": "qwen",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "env:DASHSCOPE_API_KEY",
    "models": ["qwen3.7-plus", "qwen-flash"]
  },
  {
    "id": "deepseek",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "env:LLM_API_KEY",
    "models": ["deepseek-flash", "deepseek-v4-pro"]
  },
  {
    "id": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "",
    "models": ["gpt-4.1-nano"]
  }
]
```

规则：

- `"apiKey": "env:XXX"` → 读环境变量（推荐，密钥不进仓库）
- `"apiKey": ""` → **让用户自己填**（BYOK）
- 用户填的 key 存在**服务端会话内存**，浏览器只拿到 provider 名称，**拿不到 key 原文**
- 保存 key 时服务端会请求 `GET {baseUrl}/models` 校验；**只有 200 才保存**，401/403、网络不通、网关不支持都会拒绝并提示原因
- 启动时也会异步校验 `providers.json` 里的服务端 key，只打日志，不阻塞启动
- 服务端有 key 的模型，用户不用填；没有的，右侧面板会出现输入框
- 如果所有 provider 都没 key → 自动进入 Mock 模式

下拉框显示成 `qwen/qwen-flash`、`openai/gpt-4.1-nano`。

---

## 视频 / 图片生成（万相）

右侧面板「助手」里有两个默认关闭的开关：**视频生成**、**图片生成**。打开后，模型分别多出两个工具：

| 工具 | 作用 |
|---|---|
| `generate_video({ prompt, model, size })` | 提交文生视频任务，服务端最多等待 `VIDEO_POLL_SECONDS` 秒 |
| `check_video({ task_id? })` | 查询视频任务，省略 task_id 时查本租户最近一次 |
| `generate_image({ prompt, model, size, n })` | 提交文生图任务，最多等待 `IMAGE_POLL_SECONDS` 秒 |
| `check_image({ task_id? })` | 查询图片任务，同上 |

两者都走阿里云百炼的**万相**，和聊天不是同一套协议（异步任务：提交 → task_id → 轮询），复用 `DASHSCOPE_API_KEY`，不需要额外 provider。

```env
# 视频：turbo 支持 480P/720P 更快，plus 仅 720P 画质更好
VIDEO_MODEL=wanx2.1-t2v-turbo
VIDEO_MODELS=wanx2.1-t2v-turbo,wanx2.1-t2v-plus
VIDEO_SIZE=832*480
VIDEO_POLL_SECONDS=120

# 图片：turbo 更快，wanx-v1 支持 style
IMAGE_MODEL=wanx2.1-t2i-turbo
IMAGE_MODELS=wanx2.1-t2i-turbo,wanx-v1
IMAGE_SIZE=1024*1024
IMAGE_N=1                  # 1-4 张；wanx-v1 接口默认是 4，这里强制 1
IMAGE_POLL_SECONDS=60
```

注意 **`wanx2.1` 带 x**：文档模型列表里的 `wan2.1-t2v-turbo` 接口会报 `Model not exist`（代码里做了别名兼容）。

几个已知边界：

- 视频通常 1–5 分钟，图片 10–30 秒；超过等待时间会返回 `task_id`，模型需要再调 `check_*`
- 厂商返回的 URL **约 24 小时过期**，要长期保存得自己转存
- 视频按「分辨率 × 时长」、图片按「张数」计费；失败任务通常不计费
- 免费额度按模型独立计算（北京地域、90 天），额度耗尽不会自动降级；建议在控制台开启「免费额度用完即停」

---

## 访问码、多用户隔离与限流

公网部署前至少设一个访问码：

```env
ACCESS_CODE=alice,bob,carol   # 逗号分隔，一人一个；留空 = 不鉴权
AUTH_MAX_FAILS=10             # 同一 IP 连续输错多少次后锁定
AUTH_LOCK_MINUTES=15          # 锁定分钟数
RATE_LIMIT_PER_HOUR=100       # 每个 IP 每小时
DAILY_LIMIT=1000              # 全站每天
HOST=0.0.0.0                  # 只在反代后面时建议 127.0.0.1
TRUST_PROXY=false             # 同机反代 loopback；一跳远程反代 1
```

- 每个访问码派生一个独立租户（`sha256(code)` 前 16 位）：**文档、技能、MCP 连接、对话流全部隔离**
- 本地会话、草稿、系统提示词也按访问码分开；旧版本没有租户信息的会话会在侧栏提示「认领 / 删除」
- 侧栏底部可退出当前访问码：会注销服务端 session、清 cookie 和本地存码
- 默认**不信任** `X-Forwarded-For`，直连客户端无法伪造 `req.ip`；如果前面有反向代理，按实际部署设置 `TRUST_PROXY`：
  - 同机 nginx：`TRUST_PROXY=loopback`
  - 一跳远程反代：`TRUST_PROXY=1`
  - 不要在生产用 `TRUST_PROXY=true`
- 只在反代后面时建议 `HOST=127.0.0.1`，公网只开放反代端口
- 前端首次打开要求输入访问码，通过后写入 HttpOnly cookie（EventSource 也能带上）
- 服务端也接受 `X-Access-Code` 头，方便脚本调用；它和登录共用失败计数，连续错误同样会锁定该 IP
- 登录失败单独计数：连续输错 `AUTH_MAX_FAILS`（默认 10）次后锁定该 IP `AUTH_LOCK_MINUTES`（默认 15）分钟，失败响应另有 200ms 固定延迟
- 超限返回 429（带 `Retry-After`）
- 只设一个码时，用这个码的人共享同一空间

数据落点：

```
data/tenants/<tenant>/index.json   # 每个租户的文档（DATA_DIR）
skills/<tenant>/<name>/SKILL.md    # 每个租户的技能（SKILLS_DIR）
skills/_defaults/                  # 默认技能模板
```

路径可用 `DATA_DIR` / `SKILLS_DIR` 覆盖；当前服务器分别指向站点目录下的 `data` 和 `skills`。

**别忘了在模型厂商后台设消费上限**，这是最后一道保险。

---

## 目录

```
server/
├── index.mjs      # 路由：chat / upload / skills / mcp
├── llm.mjs        # LLM 流式解析（OpenAI 兼容）
├── runs.mjs       # Agent 循环 + 事件缓冲（断流续传的核心）
├── rag.mjs        # 切块 / embedding / 向量检索 / BM25 兜底
├── providers.mjs  # 多 provider 与模型解析
├── skills.mjs     # SKILL.md 读写与注入
├── mcp.mjs        # MCP HTTP 客户端
├── dashscope-task.mjs # 百炼异步任务：提交 / 查询 / 轮询
├── video.mjs      # 万相文生视频
├── image.mjs      # 万相文生图
├── tools.mjs      # 工具注册与执行
├── auth.mjs       # 访问码会话
└── ratelimit.mjs  # 每 IP / 全站限流
src/
├── App.tsx        # 会话、流式订阅、恢复
├── api.ts         # REST + EventSource
├── db.ts          # IndexedDB
└── components/    # 消息、右侧面板
skills/            # SKILL.md 目录（可直接编辑）
```

---

## 关键设计（面试可讲）

### 1. 断流续传

```
POST /api/chat        → 立刻返回 runId，后台开始生成
GET  /api/chat/:id/stream?last=0
                      → 回放事件 1..N，然后持续推送
刷新页面 / 断网重连   → EventSource 自动带 Last-Event-ID，从断点继续
```

每次 `emit` 分配递增 `id`，事件留在内存缓冲（TTL 30 分钟）。
前端把 `lastEventId` 和消息内容放在同一次 IndexedDB 写入里，避免重复 token。
刷新后直接从本地 `lastEventId` 接流，不再先查 run 状态——即使 run 已经结束，30 分钟内也能完整回放，服务端会在末尾补一个 `done`。

### 2. tool_call 分片聚合

模型返回的 `arguments` 是流式碎片，按 `index` 累加字符串，**流结束后**才 `JSON.parse`。

### 3. RAG 两段式

- 预检索：命中片段编号后注入 `<context>`
- 追加检索：`rag_search` 作为工具，模型可自己再查

没有 embedding key 时自动降级到 BM25。

### 4. Skill 渐进式披露

平时只把 `name + description` 放进上下文；选中的技能才把正文注入 system，可多选（最多 5 个）。
不手动选时，模型可以调用 `use_skill` 工具按需加载（描述匹配才加载），加载结果只在当轮生效。

### 5. MCP 只做 HTTP

浏览器不能 spawn 进程，stdio 需要 BFF 桥接——本项目明确不做。
公开部署时这也更安全。

3 个免费预设（DeepWiki / Context7 / Exa）在打开应用时自动连接，已经连着的会跳过；单个不可达不影响聊天，可以在面板里手动重试。服务端按租户 + URL 去重，多标签页或重复点击不会连出多条。

Exa 免费 MCP 有速率限制。需要更高额度时，在 `.env` 里设置 `EXA_API_KEY=...`，服务端连接 `mcp.exa.ai` 时会自动附加 `?exaApiKey=...`；key 只留在服务端，不会通过 `/api/state` 返回给前端。

---

## 部署（阿里云轻量服务器 + CentOS 8 + systemd + 宝塔 Nginx）

这个项目是**单实例 + 本地磁盘**架构：run 缓冲、BYOK key、MCP 连接、限流都在内存，文档和技能在磁盘。不要开多副本；推荐一台新加坡轻量服务器 + 一个数据目录。

> 当前线上环境：CentOS 8（EOL）、769MB 内存、Node 24 静态二进制、systemd、宝塔 Nginx、Let's Encrypt。

### 1. 服务器和安全组

- 新加坡轻量服务器，CentOS 8（项目实际环境）或 Ubuntu 22.04+。
- 安全组入方向只开：`22`（你的 IP）、`80`、`443`。**不要开放 8787**。
- 域名 A 记录指向服务器公网 IP；证书用宝塔申请 Let's Encrypt。
- 769MB 内存建议关闭不需要的 MySQL，并配置 3GB Swap。

### 2. 安装 Node 24

服务器使用 Node 24 静态二进制，放到 `/usr/local/bin/node`：

```bash
node -v
npm -v
```

项目要求 Node `>=22.13.0`。

### 3. 上传文件

只上传运行所需内容：

```text
dist/                  # 本地 npm run build 的产物
server/                # BFF 源码
skills/_defaults/      # 默认技能模板
package.json
package-lock.json
providers.example.json
```

不要上传 `node_modules/`、`src/`、`data/`、`.env`。

### 4. 配置环境变量

在站点目录创建 `.env`：

```env
PORT=8787
HOST=127.0.0.1
TRUST_PROXY=loopback
DATA_DIR=/www/wwwroot/aichat.liberorreactproject.beer/data
SKILLS_DIR=/www/wwwroot/aichat.liberorreactproject.beer/skills
ACCESS_CODE=换成长随机串
DASHSCOPE_API_KEY=...
```

复制 provider 模板：

```bash
cp providers.example.json providers.json
```

`providers.json` 里的 `env:XXX` 会从 `.env` 读取，密钥不要写进 JSON。

### 5. 安装运行时依赖

```bash
NODE_OPTIONS=--max-old-space-size=512 npm ci --omit=dev
```

769MB 内存下不建议在服务器跑 `npm run build`；前端在本地构建后上传。

### 6. systemd 管理 Node

创建 `/etc/systemd/system/aichat.service`：

```ini
[Unit]
Description=AI Chat MVP
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/www/wwwroot/aichat.liberorreactproject.beer
EnvironmentFile=/www/wwwroot/aichat.liberorreactproject.beer/.env
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/node server/index.mjs
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aichat
sudo systemctl status aichat --no-pager
```

### 7. 宝塔 Nginx 反向代理

站点根目录不直接用静态文件，`/` 反向代理到：

```text
http://127.0.0.1:8787
```

关键配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

`proxy_buffering off` 和长超时是 SSE 流式输出 / 刷新续传的必需项。

敏感路径直接 404：

```nginx
location = /providers.json { return 404; }
location ^~ /server/ { return 404; }
location ^~ /data/ { return 404; }
location ^~ /skills/ { return 404; }
location ^~ /node_modules/ { return 404; }
```

Node 只监听 `127.0.0.1:8787`，公网只开 Nginx 的 80/443。

### 8. HTTPS

在宝塔站点 SSL 中申请 Let's Encrypt 证书，签发后打开“强制 HTTPS”。

- HTTP 会自动 301 到 HTTPS；
- 证书到期前在宝塔续期；
- 如果使用 DNS 验证，续期时需要重新添加 TXT 记录。

### 9. 内存与 Swap

769MB 内存下建议：

```bash
sudo systemctl disable --now mysqld

sudo fallocate -l 2G /swapfile2
sudo chmod 600 /swapfile2
sudo mkswap /swapfile2
sudo swapon /swapfile2
echo '/swapfile2 none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 10. Nginx 开机自启

宝塔的 Nginx 默认不一定有 systemd 服务。可以创建一个：

```ini
[Unit]
Description=Baota Nginx
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
PIDFile=/www/server/nginx/logs/nginx.pid
ExecStartPre=/www/server/nginx/sbin/nginx -t
ExecStart=/www/server/nginx/sbin/nginx
ExecReload=/www/server/nginx/sbin/nginx -s reload
ExecStop=/bin/kill -s QUIT $MAINPID
Restart=on-failure
RestartSec=3
LimitNOFILE=65535
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nginx
```

### 11. 数据、更新和限制

- 文档和技能都在 `data/` / `skills/`，备份：
  ```bash
  tar -czf data-$(date +%F).tgz data skills
  ```
- 前端更新：本地 `npm run build`，上传新的 `dist/`，一般不需要重启 Node。
- 后端更新：上传 `server/`，然后：
  ```bash
  sudo systemctl restart aichat
  ```
- 重启会丢失：进行中的 run、BYOK key、MCP 连接、限流计数。用户重新打开页面会自动重登并自动连接预设 MCP；BYOK 需要重填。
- **单实例**：不要开多副本，内存状态不共享。
- **SSE**：必须保持 `proxy_buffering off;` 和长超时。
- **HTTPS**：宝塔强制 HTTPS；语音输入需要 HTTPS（localhost 除外）。
## 已知限制

- 只支持 HTTP 类型 MCP；stdio 需要 BFF spawn 进程，本项目不做
- 访问码不是账号体系：没有找回密码、不能自助改密码，泄露就换一个
- 本地历史按访问码隔离，但同一浏览器换码后仍共用 IndexedDB；旧版本无租户数据需在侧栏认领或删除
- MCP SSRF 防护会解析 DNS 并拒绝私网/链路本地/元数据地址；DNS rebinding 和重定向仍有理论风险
- 移动端只做了基础适配：侧栏抽屉、设置面板全屏、safe-area、16px 输入框；复杂表格/超长公式未专门优化
- 不支持 `.docx`，请转 PDF 或 txt/md
- 图片型 PDF 需要配置 OCR（`qwen-vl-ocr`），否则会提示解析不出文本
- 流式 Markdown 每次全量重渲染，超长回答会有性能损耗
- 访问码不是账号体系：没有找回密码、不能自助改密码，泄露就换一个；请用足够长的随机串
- 限流和登录锁定都按 IP：默认不信任 `X-Forwarded-For`，直连无法伪造；如果前面有反代，必须按实际跳数设置 `TRUST_PROXY`，否则所有用户会共用反代 IP，限流会误伤

---

## 演示脚本

1. 上传一份 PDF → 打开「文档检索」→ 问文档里的内容，看引用
2. 选 `contract-review` 技能 → 再问一次，对比输出结构
3. 发一个长回答 → 中途按 F5 → 回来仍在继续
4. MCP 面板填 `https://mcp.deepwiki.com/mcp` → 问一个仓库相关问题
