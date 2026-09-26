# Arcana

一个网页塔罗抽牌与 AI 解读原型。你可以提问、长按牌面洗牌、滑动切牌、抽取单牌或牌阵，随后在单屏结果页阅读解读，并进入独立聊天页围绕同一副牌继续追问。结果页的解读卡片和聊天消息区各自滚动，输入框始终固定在对话页底部。

## 首次运行

在这个文件夹打开终端，依次运行：

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

启动网站：

```sh
.venv/bin/python app.py
```

如果 VPS 上已经有 `.venv`，直接启动即可。`app.py` 会检查 Flask、邮箱密码加密和环境变量读取所需的运行依赖；发现缺失时，会自动按 `requirements.txt` 安装后继续启动。因此日常从 GitHub 拉取更新时，不需要额外增加安装命令。

在浏览器打开 `http://127.0.0.1:4173/`。点击左上角 **ARCANA 设置**，可以进入“供应商”“用户信息”和“历史牌阵”；首页右上角显示“未登录”或当前账号昵称。供应商页面填写名称、API Base URL、API Key，再点“获取模型”从列表选择模型；如果供应商不支持模型列表，也可手动填写模型名。用户信息页面可以保存多人资料，并用每行右侧开关选择本次解读使用的用户；全部关闭时不会发送个人信息。再次运行时，只需执行启动命令。结束服务时按 `Control + C`。

请用上面的本地网址打开，不能直接双击 `index.html`：`file://` 页面无法连接 Flask 解读接口。

登录后，供应商配置和解读用的多人档案会同步到账号；整个设置数据包使用服务器密钥加密后存入 `arcana.db`。浏览器仍保留当前账号的本地副本以供页面使用，退出登录时会清除这份账号缓存。首次使用此版本登录时，如果账号还没有云端设置，会自动上传当前浏览器已有的设置。账号密码只保存 bcrypt 哈希。未登录仍可正常添加本地设置、抽牌和解读，但不会写入云端历史。

## 可选：服务端默认配置

如果更希望把密钥放在后端，可以复制 `.env.example` 为 `.env`，填写三个值：

```text
LLM_BASE_URL=https://你的中转站地址/v1
LLM_API_KEY=你的密钥
LLM_MODEL=中转站支持的模型名
ARCANA_SECRET_KEY=一串足够长且随机的服务器密钥
ARCANA_COOKIE_SECURE=0
```

`LLM_BASE_URL` 填到 `/v1` 为止，程序会自动补上 `/chat/completions`。未在页面选中供应商时，网站使用这组服务端配置。`ARCANA_SECRET_KEY` 同时用于保护登录 Session，并派生账号设置的数据加密密钥；VPS 上必须填写、不能公开，投入使用后也不能随意更换，否则旧的加密设置将无法读取。`ARCANA_COOKIE_SECURE` 本机 HTTP 调试保持 `0`；VPS 配好 HTTPS 后改成 `1`。`.env` 和 `arcana.db` 都已被 `.gitignore` 排除，不会上传到 GitHub。修改 `.env` 后需要重启 Flask。

注册接口会校验邮箱格式和唯一性。真正向邮箱发送验证码或验证链接还需要接入邮件服务商；当前版本没有发送验证邮件。

## 文件说明

- `index.html`、`styles.css`、`cards.js`、`app.js`：抽牌页面、78 张牌的资料和交互。
- `assets/cards/`：从 Wikimedia Commons 下载的 78 张高清牌面，以及每张图的来源链接。牌面原画由 Pamela Colman Smith 绘制；该文件分类页将素材标为公有领域。网页使用 960 像素宽的 WebP 版本，以缩短加载时间。牌背仍使用原来的 Arcana 设计。
- `assets/ui/card-back-cream-magic-v3.png`：抽牌流程统一使用的奶油魔法风卡背；中央双圆环完整闭合，下半张由上半张旋转 180°生成，正位与逆位外观完全一致。
- `assets/ui/rabbit-single-color.png`、`assets/ui/dove-single-color.png`：首页使用的单色兔子与鸽子装饰。
- `scripts/fetch_card_art.py`：需要重新获取图片时运行；使用 `requirements.txt` 中的 Pillow。
- `settings.js`：页面中的供应商和用户信息设置，数据保存在浏览器 localStorage。
- `auth.js`：登录注册页面、账号菜单、本地历史迁移和云端历史页面。
- `app.py`：Flask 网站、账号与历史接口、首次解读和继续追问接口。
- `arcana.db`：首次启动自动创建的 SQLite 数据库，保存在服务器本地，不进入 Git。
- `llm.py`：向 OpenAI 兼容格式的中转站发起请求；密钥只保存在后端环境变量中。
- `prompts/system.md`：解读师的语气和解读原则。

`POST /api/models` 使用供应商的 `/models` 接口拉取模型名。`POST /api/reading` 接收 `question`、`spread`、`cards`、`userInfo`，以及可选的 `provider`。三牌阵只调用一次模型：模型先选择六种解读框架之一，前端再更新牌位标题。首次解读会返回 `conversationId`。`POST /api/follow-up` 使用这个编号读取完整历史，并允许每次请求传入新的供应商配置；一副牌最多追问 8 轮。用户也可以通过 `POST /api/conversation/end` 提前结束本次对话。对话暂存在 Flask 进程内，服务重启或超过 6 小时后需要重新抽牌。所有文字都通过 SSE 流式返回；请求开始前的错误返回 `{"error":"具体原因"}`。

账号接口包括 `POST /api/register`、`POST /api/login`、`GET /api/me` 和 `POST /api/logout`。`GET/PUT /api/account-data` 负责读取和更新当前账号的加密供应商与用户资料。云端历史接口包括 `POST /api/readings`、`GET /api/readings` 和 `POST /api/readings/migrate`。所有账号数据接口都从 Session 中取得当前用户编号，客户端不能指定其他用户。
