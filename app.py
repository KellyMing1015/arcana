"""Arcana 网页与流式塔罗解读 API。"""

import json
import re
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

from llm import LLMError, friendly_error, iter_chat_text, list_models, open_chat_stream


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
SYSTEM_PROMPT = (ROOT / "prompts" / "system.md").read_text(encoding="utf-8").strip()
POSITIONS = {
    1: ["此刻"],
    3: ["第1张", "第2张", "第3张"],
    10: ["现状", "交叉影响", "潜意识", "过去", "意识", "近期", "自我", "环境", "希望与恐惧", "可能走向"],
}
THREE_CARD_FRAMEWORKS = {
    "timeline": ["过去", "现在", "未来"],
    "cause": ["问题", "原因", "建议"],
    "outcome": ["现状", "阻碍", "结果"],
    "relationship": ["对方想法", "感受", "行动"],
    "choice": ["选择A", "选择B", "建议"],
    "energy": ["整体能量", "关键影响", "建议"],
}
DEFAULT_FRAMEWORK = "timeline"
PUBLIC_FILES = {"index.html", "app.js", "cards.js", "settings.js", "styles.css"}
DEV_ORIGINS = {"http://127.0.0.1:4173", "http://localhost:4173"}

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024


def allowed_origin():
    origin = request.headers.get("Origin")
    if not origin:
        return True
    return origin in DEV_ORIGINS or origin == request.host_url.rstrip("/")


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin and allowed_origin():
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Vary"] = "Origin"
    return response


@app.get("/")
def home():
    return send_from_directory(ROOT, "index.html")


@app.get("/assets/cards/<filename>")
def card_image(filename):
    if not filename.endswith(".webp") or not filename.removesuffix(".webp").replace("-", "").isalnum():
        return jsonify(error="牌面图片不存在。"), 404
    return send_from_directory(ROOT / "assets" / "cards", filename)


@app.get("/<path:filename>")
def public_file(filename):
    if filename not in PUBLIC_FILES:
        return jsonify(error="页面不存在。"), 404
    return send_from_directory(ROOT, filename)


def validate_payload(payload):
    if not isinstance(payload, dict):
        raise LLMError("请发送包含问题和牌面的 JSON 数据。", 400)
    question = payload.get("question")
    spread = payload.get("spread")
    cards = payload.get("cards")
    if not isinstance(question, str) or not question.strip():
        raise LLMError("请先输入你的问题。", 400)
    question = question.strip()
    if len(question) > 2000:
        raise LLMError("问题太长，请控制在 2000 字以内。", 400)
    if type(spread) is not int or spread not in POSITIONS:
        raise LLMError("牌阵类型无效。", 400)
    if not isinstance(cards, list) or len(cards) != spread:
        raise LLMError(f"这个牌阵需要 {spread} 张牌。", 400)
    seen = set()
    normalized = []
    for index, card in enumerate(cards):
        if not isinstance(card, dict):
            raise LLMError("牌面数据格式不正确。", 400)
        card_id = card.get("id")
        name = card.get("name")
        reversed_card = card.get("reversed")
        if not isinstance(card_id, str) or not card_id or len(card_id) > 40 or card_id in seen:
            raise LLMError("牌面编号无效或重复。", 400)
        if not isinstance(name, str) or not name.strip() or len(name) > 40 or "\n" in name:
            raise LLMError("牌面名称无效。", 400)
        if type(reversed_card) is not bool:
            raise LLMError("请标明每张牌的正位或逆位。", 400)
        seen.add(card_id)
        normalized.append({
            "id": card_id,
            "name": name.strip(),
            "position": POSITIONS[spread][index],
            "orientation": "逆位" if reversed_card else "正位",
        })
    return question, spread, normalized


def build_messages(question, spread, cards):
    spread_name = {1: "单牌", 3: "三牌阵", 10: "凯尔特十字"}[spread]
    lines = [
        f"用户问题：{question}",
        f"牌阵：{spread_name}",
        "实际抽到的牌（顺序就是牌阵顺序）：",
    ]
    lines.extend(
        f"{index}. {card['position']}：{card['name']}（{card['orientation']}）"
        for index, card in enumerate(cards, start=1)
    )
    if spread == 3:
        lines.append("请先根据问题类型在六种三牌框架中选最合适的一种，按系统要求输出框架标记，再按选定位置解读这三张牌。")
    lines.append("请只根据这个问题和这些实际抽到的牌解读，不要加入未抽到的牌。")
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(lines)},
    ]


def sse(payload):
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


def iter_reading_events(chunks, spread):
    """从同一次流式回复取出三牌框架标记，再继续输出解读文字。"""
    chunks = iter(chunks)
    if spread != 3:
        for chunk in chunks:
            yield {"content": chunk}
        return

    opening = ""
    for chunk in chunks:
        opening = (opening + chunk).lstrip("\ufeff \t\r\n")
        if "\n" not in opening and len(opening) < 180:
            continue
        first_line, _, rest = opening.partition("\n")
        match = re.fullmatch(r"ARCANA_FRAMEWORK:\s*([a-z_]+)\s*", first_line.strip())
        framework = match.group(1) if match and match.group(1) in THREE_CARD_FRAMEWORKS else DEFAULT_FRAMEWORK
        yield {"framework": framework, "positions": THREE_CARD_FRAMEWORKS[framework]}
        if first_line.strip().startswith("ARCANA_FRAMEWORK:"):
            if rest:
                yield {"content": rest}
        elif opening:
            yield {"content": opening}
        break
    else:
        if not opening:
            return
        match = re.fullmatch(r"ARCANA_FRAMEWORK:\s*([a-z_]+)\s*", opening.strip())
        framework = match.group(1) if match and match.group(1) in THREE_CARD_FRAMEWORKS else DEFAULT_FRAMEWORK
        yield {"framework": framework, "positions": THREE_CARD_FRAMEWORKS[framework]}
        if not opening.strip().startswith("ARCANA_FRAMEWORK:"):
            yield {"content": opening}
        return

    for chunk in chunks:
        yield {"content": chunk}


@app.route("/api/models", methods=["POST", "OPTIONS"])
def models():
    if not allowed_origin():
        return jsonify(error="此页面来源不允许访问模型接口。"), 403
    if request.method == "OPTIONS":
        return Response(status=204)
    try:
        payload = request.get_json(silent=True)
        provider = payload.get("provider") if isinstance(payload, dict) else None
        return jsonify(models=list_models(provider))
    except Exception as error:
        friendly = friendly_error(error)
        return jsonify(error=friendly.message), friendly.status_code


@app.route("/api/reading", methods=["POST", "OPTIONS"])
def reading():
    if not allowed_origin():
        return jsonify(error="此页面来源不允许访问解读接口。"), 403
    if request.method == "OPTIONS":
        return Response(status=204)
    try:
        payload = request.get_json(silent=True)
        question, spread, cards = validate_payload(payload)
        upstream = open_chat_stream(build_messages(question, spread, cards), payload.get("provider"))
        chunks = iter_reading_events(iter_chat_text(upstream), spread)
        try:
            first = next(chunks, None)
        except Exception:
            upstream.close()
            raise
        if first is None:
            upstream.close()
            raise LLMError("中转站没有返回解读文字，请检查所选模型。")
    except Exception as error:
        friendly = friendly_error(error)
        return jsonify(error=friendly.message), friendly.status_code

    @stream_with_context
    def generate():
        try:
            yield sse(first)
            has_text = bool(first.get("content"))
            for event in chunks:
                yield sse(event)
                has_text = has_text or bool(event.get("content"))
            if has_text:
                yield sse({"done": True})
            else:
                yield sse({"error": "中转站没有返回解读文字，请检查所选模型。"})
        except Exception as error:
            yield sse({"error": friendly_error(error).message})
        finally:
            upstream.close()

    return Response(generate(), content_type="text/event-stream; charset=utf-8", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
    })


@app.errorhandler(404)
def not_found(_error):
    return jsonify(error="页面或接口不存在。"), 404


@app.errorhandler(405)
def method_not_allowed(_error):
    return jsonify(error="请求方式不支持。"), 405


@app.errorhandler(413)
def payload_too_large(_error):
    return jsonify(error="提交的数据太大。"), 413


@app.errorhandler(500)
def server_error(_error):
    return jsonify(error="服务暂时出了问题，请稍后重试。"), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=4173, threaded=True)
