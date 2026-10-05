"""临时供应商错误与中途断流的回归检查，不调用真实模型。"""

import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import llm


def event(content=None, finish_reason=None):
    choice = {"delta": {"content": content} if content else {}}
    if finish_reason is not None:
        choice["finish_reason"] = finish_reason
    return ("data: " + json.dumps({"choices": [choice]}, ensure_ascii=False) + "\n\n").encode("utf-8")


class RelayReliabilityTests(unittest.TestCase):
    provider = {"baseUrl": "https://relay.example/v1", "apiKey": "test-key", "model": "test-model"}

    def test_temporary_server_errors_retry_once_before_streaming(self):
        for code in (502, 503, 504):
            with self.subTest(code=code):
                body = io.BytesIO(b"temporary failure")
                error = HTTPError("https://relay.example/v1/chat/completions", code, "Unavailable", {}, body)
                response = io.BytesIO(event("完整回复") + b"data: [DONE]\n\n")
                with patch.object(llm, "urlopen", side_effect=[error, response]) as send, patch.object(llm.time, "sleep"):
                    upstream = llm.open_chat_stream([], self.provider)
                self.assertIs(upstream, response)
                self.assertEqual(send.call_count, 2)
                self.assertTrue(body.closed)
                self.assertEqual(list(llm.iter_chat_text(upstream)), ["完整回复"])

    def test_repeated_temporary_failure_stops_after_one_retry(self):
        errors = [HTTPError("https://relay.example/v1", 503, "Unavailable", {}, io.BytesIO()) for _ in range(2)]
        with patch.object(llm, "urlopen", side_effect=errors) as send, patch.object(llm.time, "sleep"):
            with self.assertRaises(llm.LLMError):
                llm.open_chat_stream([], self.provider)
        self.assertEqual(send.call_count, 2)

    def test_authentication_quota_and_invalid_request_errors_are_not_retried(self):
        for code in (400, 401, 403, 402, 404, 429):
            with self.subTest(code=code):
                error = HTTPError("https://relay.example/v1", code, "Error", {}, io.BytesIO())
                with patch.object(llm, "urlopen", side_effect=error) as send, patch.object(llm.time, "sleep") as pause:
                    with self.assertRaises(llm.LLMError):
                        llm.open_chat_stream([], self.provider)
                send.assert_called_once()
                pause.assert_not_called()

    def test_unexpected_eof_does_not_turn_a_partial_response_into_success(self):
        chunks = llm.iter_chat_text(io.BytesIO(event("只收到半句话")))
        self.assertEqual(next(chunks), "只收到半句话")
        with self.assertRaisesRegex(llm.LLMError, "连接提前结束"):
            next(chunks)

    def test_finish_reason_is_supported_when_provider_omits_done_marker(self):
        response = io.BytesIO(event("完整回复") + event(finish_reason="stop"))
        self.assertEqual(list(llm.iter_chat_text(response)), ["完整回复"])

    def test_done_marker_without_trailing_blank_line_is_supported(self):
        response = io.BytesIO(event("完整回复") + b"data: [DONE]")
        self.assertEqual(list(llm.iter_chat_text(response)), ["完整回复"])

    def test_done_cannot_turn_a_truncated_or_blocked_answer_into_success(self):
        for reason, message in (("length", "长度上限"), ("content_filter", "拦截"),
                                ("tool_calls", "工具调用"), ("function_call", "工具调用"),
                                ("unknown", "未正常完成")):
            with self.subTest(reason=reason):
                response = io.BytesIO(event("只输出了一部分") + event(finish_reason=reason) + b"data: [DONE]\n\n")
                with self.assertRaisesRegex(llm.LLMError, message):
                    list(llm.iter_chat_text(response))

    def test_malformed_choices_fail_with_a_readable_error(self):
        response = io.BytesIO(b'data: {"choices":[null]}\n\n')
        with self.assertRaisesRegex(llm.LLMError, "无法识别"):
            list(llm.iter_chat_text(response))


if __name__ == "__main__":
    unittest.main()
