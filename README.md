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

在浏览器打开 `http://127.0.0.1:4173/`。点击左上角 **ARCANA 设置**，可以分别进入“供应商”和“用户信息”。供应商页面填写名称、API Base URL、API Key，再点“获取模型”从列表选择模型；如果供应商不支持模型列表，也可手动填写模型名。用户信息页面可以保存多人资料，并用每行右侧开关选择本次解读使用的用户；全部关闭时不会发送个人信息。再次运行时，只需执行启动命令。结束服务时按 `Control + C`。

请用上面的本地网址打开，不能直接双击 `index.html`：`file://` 页面无法连接 Flask 解读接口。

配置保存在当前浏览器的本地存储中，包含 API Key；换浏览器或清除网站数据后，需要重新填写。解读时浏览器会把当前供应商配置交给本机 Flask，由 Flask 调用中转站。当前是本地开发原型，不要把这个存储方案直接用于公开部署。

## 可选：服务端默认配置

如果更希望把密钥放在后端，可以复制 `.env.example` 为 `.env`，填写三个值：

```text
LLM_BASE_URL=https://你的中转站地址/v1
LLM_API_KEY=你的密钥
LLM_MODEL=中转站支持的模型名
```

`LLM_BASE_URL` 填到 `/v1` 为止，程序会自动补上 `/chat/completions`。未在页面选中供应商时，网站使用这组服务端配置。`.env` 已被 `.gitignore` 排除，不要上传到 GitHub。修改 `.env` 后需要重启 Flask。

## 文件说明

- `index.html`、`styles.css`、`cards.js`、`app.js`：抽牌页面、78 张牌的资料和交互。
- `assets/cards/`：从 Wikimedia Commons 下载的 78 张高清牌面，以及每张图的来源链接。牌面原画由 Pamela Colman Smith 绘制；该文件分类页将素材标为公有领域。网页使用 960 像素宽的 WebP 版本，以缩短加载时间。牌背仍使用原来的 Arcana 设计。
- `assets/ui/card-back-cream-magic-v3.png`：抽牌流程统一使用的奶油魔法风卡背；侧边留白，保留四角与中央图案。
- `assets/ui/rabbit-single-color.png`、`assets/ui/dove-single-color.png`：首页使用的单色兔子与鸽子装饰。
- `scripts/fetch_card_art.py`：需要重新获取图片时运行；使用 `requirements.txt` 中的 Pillow。
- `settings.js`：页面中的供应商和用户信息设置，数据保存在浏览器 localStorage。
- `app.py`：Flask 网站、首次解读和继续追问接口，负责校验数据、保存当前牌局的对话历史并传送流式回复。
- `llm.py`：向 OpenAI 兼容格式的中转站发起请求；密钥只保存在后端环境变量中。
- `prompts/system.md`：解读师的语气和解读原则。

`POST /api/models` 使用供应商的 `/models` 接口拉取模型名。`POST /api/reading` 接收 `question`、`spread`、`cards`、`userInfo`，以及可选的 `provider`。三牌阵只调用一次模型：模型先选择六种解读框架之一，前端再更新牌位标题。首次解读会返回 `conversationId`。`POST /api/follow-up` 使用这个编号读取完整历史，并允许每次请求传入新的供应商配置；一副牌最多追问 8 轮。用户也可以通过 `POST /api/conversation/end` 提前结束本次对话。对话暂存在 Flask 进程内，服务重启或超过 6 小时后需要重新抽牌。所有文字都通过 SSE 流式返回；请求开始前的错误返回 `{"error":"具体原因"}`。
