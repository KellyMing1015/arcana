# Arcana

一个网页塔罗抽牌与 AI 解读原型。你可以提问、洗牌、切牌、抽取单牌或牌阵，随后阅读逐字出现的解读。对话和记忆功能尚未接入。

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

在浏览器打开 `http://127.0.0.1:4173/`。点击左上角 **ARCANA 设置**，添加供应商并填写名称、API Base URL、API Key，再点“获取模型”从列表选择模型；如果供应商不支持模型列表，也可手动填写模型名。最后点击“添加并使用”。以后可以在同一页面添加多个供应商并切换。再次运行时，只需执行启动命令。结束服务时按 `Control + C`。

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
- `assets/cards/`：从 Wikimedia Commons 下载的 78 张高清牌面，以及每张图的来源链接。牌面原画由 Pamela Colman Smith 绘制；该文件分类页将素材标为公有领域。网页使用 960 像素宽的版本，并转为 JPEG 以缩短加载时间。牌背仍使用原来的 Arcana 设计。
- `scripts/fetch_card_art.py`：需要重新获取图片时运行；依赖 macOS 自带的 `sips`。
- `settings.js`：页面中的供应商设置与本地保存。
- `app.py`：Flask 网站与 `/api/reading` 接口，负责校验问题和牌面、传送流式解读。
- `llm.py`：向 OpenAI 兼容格式的中转站发起请求；密钥只保存在后端环境变量中。
- `prompts/system.md`：解读师的语气和解读原则。

`POST /api/models` 使用供应商的 `/models` 接口拉取模型名。`POST /api/reading` 接收 `question`、`spread`、`cards`，以及可选的 `provider`。每张牌包含 `id`、`name`、`reversed`。解读返回 SSE 流：`{"content":"..."}`，结束时返回 `{"done":true}`；请求开始前的错误返回 `{"error":"具体原因"}`。若流已经开始，后续错误会作为同样结构的 SSE 消息返回。
