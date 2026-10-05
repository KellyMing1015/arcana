"""OpenAI 兼容 Chat Completions 的流式中转。"""

import json
import logging
import os
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


TIMEOUT_SECONDS = 60
TRANSIENT_HTTP_CODES = {502, 503, 504}
logger = logging.getLogger(__name__)


class LLMError(Exception):
    def __init__(self, message, status_code=502):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _settings(provider=None, require_model=True):
    if provider is not None and not isinstance(provider, dict):
        raise LLMError("供应商配置格式不正确。", 400)
    if provider is None:
        values = {
            "LLM_BASE_URL": os.getenv("LLM_BASE_URL", ""),
            "LLM_API_KEY": os.getenv("LLM_API_KEY", ""),
            "LLM_MODEL": os.getenv("LLM_MODEL", ""),
        }
    else:
        values = {
            "LLM_BASE_URL": provider.get("baseUrl"),
            "LLM_API_KEY": provider.get("apiKey"),
            "LLM_MODEL": provider.get("model", ""),
        }
        if any(not isinstance(value, str) for value in values.values()):
            raise LLMError("请填写供应商地址、API Key 和模型名。", 400)
    base_url = values["LLM_BASE_URL"].strip().rstrip("/")
    api_key = values["LLM_API_KEY"].strip()
    model = values["LLM_MODEL"].strip()
    required = [
        ("LLM_BASE_URL", base_url),
        ("LLM_API_KEY", api_key),
    ]
    if require_model:
        required.append(("LLM_MODEL", model))
    missing = [name for name, value in required if not value]
    if missing:
        if provider is not None:
            raise LLMError("请填写供应商地址、API Key 和模型名。", 400)
        raise LLMError("请先设置环境变量：" + "、".join(missing), 503)

    parsed = urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.query or parsed.fragment or parsed.username or parsed.password or len(base_url) > 2048:
        raise LLMError("供应商地址应是完整的 http(s) 地址，例如 https://example.com/v1。", 400 if provider else 503)
    if provider is not None and parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise LLMError("远程供应商请使用 https 地址。", 400)
    if len(api_key) > 4096 or len(model) > 200:
        raise LLMError("API Key 或模型名太长，请检查填写内容。", 400 if provider else 503)
    if any(character in value for value in (base_url, api_key, model) for character in ("\r", "\n")):
        raise LLMError("供应商配置不能包含换行。", 400 if provider else 503)
    return base_url, api_key, model


def _http_error_message(error):
    if error.code in (401, 403):
        return LLMError("API Key 无效，或没有访问所选模型的权限。", 502)
    if error.code == 402:
        return LLMError("中转站额度不足，请检查账户余额。", 502)
    if error.code == 429:
        return LLMError("请求过于频繁或额度不足，请稍后重试并检查账户额度。", 502)
    if error.code == 404:
        return LLMError("模型或接口地址不存在，请检查 LLM_MODEL 和 LLM_BASE_URL。", 502)
    if error.code == 400:
        return LLMError("中转站未接受这次请求，请检查模型名和接口兼容性。", 502)
    return LLMError("中转站暂时无法完成解读，请稍后重试。", 502)


def _stream_error_message(details):
    if isinstance(details, dict):
        code = str(details.get("code") or details.get("type") or "").lower()
        message = str(details.get("message") or "").lower()
    else:
        code = ""
        message = str(details).lower()
    description = f"{code} {message}"
    if any(word in description for word in ("invalid_api_key", "authentication", "unauthorized")):
        return LLMError("API Key 无效，或没有访问所选模型的权限。")
    if any(word in description for word in ("insufficient_quota", "quota_exceeded", "billing", "balance")):
        return LLMError("中转站额度不足，请检查账户余额。")
    if any(word in description for word in ("model_not_found", "model does not exist")):
        return LLMError("模型不存在，请检查 LLM_MODEL。")
    return LLMError("中转站返回错误，请检查模型、额度或稍后重试。")


def friendly_error(error):
    if isinstance(error, LLMError):
        return error
    if isinstance(error, (socket.timeout, TimeoutError)):
        return LLMError("连接中转站超时（60 秒），请稍后重试。", 504)
    if isinstance(error, URLError):
        if isinstance(error.reason, (socket.timeout, TimeoutError)):
            return LLMError("连接中转站超时（60 秒），请稍后重试。", 504)
        return LLMError("无法连接中转站，请检查 LLM_BASE_URL 和网络连接。", 502)
    if isinstance(error, OSError):
        return LLMError("连接中转站时中断，请稍后重试。", 502)
    return LLMError("解读暂时失败，请稍后重试。", 502)


def open_chat_stream(messages, provider=None):
    """连接上游。HTTP 状态错误在返回 Flask SSE 前就会被捕获。"""
    base_url, api_key, model = _settings(provider)
    body = json.dumps({
        "model": model,
        "messages": messages,
        "stream": True,
    }, ensure_ascii=False).encode("utf-8")
    request = Request(
        f"{base_url}/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    # Only retry an explicit temporary server error before a stream is opened.
    # Never replay a response that has already started generating text.
    for attempt in range(2):
        try:
            return urlopen(request, timeout=TIMEOUT_SECONDS)
        except HTTPError as error:
            error.close()
            if attempt == 0 and error.code in TRANSIENT_HTTP_CODES:
                logger.warning("LLM upstream temporarily unavailable: http_%s; retrying once", error.code)
                time.sleep(0.5)
                continue
            logger.warning("LLM upstream request failed: http_%s", error.code)
            raise _http_error_message(error) from error
        except (URLError, OSError, TimeoutError) as error:
            logger.warning("LLM upstream connection failed: %s", type(error).__name__)
            raise friendly_error(error) from error


def list_models(provider):
    """按 OpenAI 兼容的 GET /models 获取可用模型 ID。"""
    if provider is None:
        raise LLMError("请先填写供应商地址和 API Key。", 400)
    base_url, api_key, _ = _settings(provider, require_model=False)
    request = Request(
        f"{base_url}/models",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            payload = json.load(response)
    except HTTPError as error:
        error.close()
        if error.code == 404:
            raise LLMError("这个供应商没有提供模型列表，请手动填写模型名。") from error
        raise _http_error_message(error) from error
    except (URLError, OSError, TimeoutError) as error:
        raise friendly_error(error) from error
    except (ValueError, UnicodeDecodeError) as error:
        raise LLMError("供应商返回的模型列表格式不正确，请手动填写模型名。") from error
    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise LLMError("供应商没有返回 OpenAI 兼容的模型列表，请手动填写模型名。")
    models = []
    seen = set()
    for item in items:
        model_id = item.get("id") if isinstance(item, dict) else None
        if isinstance(model_id, str) and model_id and len(model_id) <= 200 and model_id not in seen:
            models.append(model_id)
            seen.add(model_id)
    if not models:
        raise LLMError("供应商没有返回可用模型，请手动填写模型名。")
    return models[:1000]


def iter_chat_text(response):
    """逐个解析 OpenAI 格式 SSE，只产出 choices[0].delta.content 文本。"""
    data_lines = []
    finished = False

    def parse_event(lines):
        if not lines:
            return None, False, False
        data = "\n".join(lines)
        if data == "[DONE]":
            return None, True, True
        try:
            payload = json.loads(data)
        except json.JSONDecodeError as error:
            raise LLMError("中转站返回了无法识别的流式数据。") from error
        if isinstance(payload, dict) and payload.get("error"):
            raise _stream_error_message(payload["error"])
        choices = payload.get("choices", []) if isinstance(payload, dict) else []
        if not choices:
            return None, False, False
        if not isinstance(choices, list) or not isinstance(choices[0], dict):
            raise LLMError("中转站返回了无法识别的流式数据。")
        choice = choices[0]
        delta = choice.get("delta") or {}
        if not isinstance(delta, dict):
            raise LLMError("中转站返回了无法识别的流式数据。")
        content = delta.get("content")
        reason = choice.get("finish_reason")
        if reason and reason != "stop":
            logger.warning("LLM upstream did not finish a text response normally")
            if reason == "length":
                raise LLMError("模型回复达到长度上限，回应尚未完整，请重试或缩短问题。")
            if reason == "content_filter":
                raise LLMError("所选模型拦截了这次回应，请调整问题后重试。")
            if reason in ("tool_calls", "function_call"):
                raise LLMError("模型返回了工具调用，未完成解读，请检查所选模型的接口兼容性。")
            raise LLMError("模型未正常完成回应，请重试。")
        terminal = reason == "stop"
        return content if isinstance(content, str) and content else None, False, terminal

    try:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                content, done, terminal = parse_event(data_lines)
                data_lines = []
                finished = finished or terminal
                if done:
                    return
                if content:
                    yield content
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip(" "))
        content, done, terminal = parse_event(data_lines)
        if content:
            yield content
        if not (finished or done or terminal):
            logger.warning("LLM upstream stream ended without a completion marker")
            raise LLMError("解读连接提前结束，回应尚未完成，请重试。")
    except (URLError, OSError, TimeoutError) as error:
        raise friendly_error(error) from error
