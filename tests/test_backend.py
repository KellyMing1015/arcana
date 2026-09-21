"""无需真实 API Key 的接口与中转协议检查。"""

import io
import json
import os
import socket
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import app as website
import llm


class ReadingTests(unittest.TestCase):
    def setUp(self):
        website.CONVERSATIONS.clear()
        self.client = website.app.test_client()
        self.payload = {
            "question": "我该如何看待这段关系？",
            "spread": 3,
            "cards": [
                {"id": "fool", "name": "愚者（THE FOOL）", "reversed": False},
                {"id": "moon", "name": "月亮（THE MOON）", "reversed": True},
                {"id": "star", "name": "星星（THE STAR）", "reversed": False},
            ],
        }

    def test_stream_uses_only_the_sent_cards_and_positions(self):
        sent_messages = []

        def fake_upstream(messages, provider):
            sent_messages.extend(messages)
            self.assertIsNone(provider)
            events = (
                'data: {"choices":[{"delta":{"content":"ARCANA_"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"FRAMEWORK:cause\\n我看到"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"你的犹豫"}}]}\n\n'
                'data: [DONE]\n\n'
            )
            return io.BytesIO(events.encode("utf-8"))

        with patch.object(website, "open_chat_stream", side_effect=fake_upstream) as upstream:
            response = self.client.post("/api/reading", json=self.payload, buffered=True)

        self.assertEqual(response.status_code, 200)
        upstream.assert_called_once()
        self.assertIn("text/event-stream", response.content_type)
        events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
        self.assertRegex(events[0]["conversationId"], r"^[0-9a-f]{32}$")
        self.assertEqual(events[1:], [
            {"framework": "cause", "positions": ["问题", "原因", "建议"]},
            {"content": "我看到"}, {"content": "你的犹豫"},
            {"done": True, "rounds": 0, "closed": False},
        ])
        self.assertEqual(sent_messages[0]["role"], "system")
        self.assertIn("ARCANA_FRAMEWORK", sent_messages[0]["content"])
        user_prompt = sent_messages[1]["content"]
        for text in ("我该如何看待这段关系？", "第1张：愚者（THE FOOL）（正位）", "第2张：月亮（THE MOON）（逆位）", "第3张：星星（THE STAR）（正位）"):
            self.assertIn(text, user_prompt)

    def test_unknown_framework_uses_default_without_showing_marker(self):
        stream = io.BytesIO(
            b'data: {"choices":[{"delta":{"content":"ARCANA_FRAMEWORK:unknown\\nRead the cards."}}]}\n\n'
            b'data: [DONE]\n\n'
        )
        with patch.object(website, "open_chat_stream", return_value=stream):
            response = self.client.post("/api/reading", json=self.payload, buffered=True)
        events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
        self.assertEqual(events[1], {"framework": "timeline", "positions": ["过去", "现在", "未来"]})
        self.assertEqual(events[2], {"content": "Read the cards."})

    def test_six_frameworks_keep_their_three_positions(self):
        for key, positions in website.THREE_CARD_FRAMEWORKS.items():
            with self.subTest(framework=key):
                events = list(website.iter_reading_events([f"ARCANA_FRAMEWORK:{key}\n解读"], 3))
                self.assertEqual(events, [
                    {"framework": key, "positions": positions},
                    {"content": "解读"},
                ])

    def test_incomplete_marker_is_not_shown_as_reading(self):
        events = list(website.iter_reading_events(["ARCANA_FRAMEWORK:cause"], 3))
        self.assertEqual(events, [{"framework": "cause", "positions": ["问题", "原因", "建议"]}])

    def test_selected_page_provider_reaches_relay(self):
        provider = {"baseUrl": "https://relay.example/v1", "apiKey": "key", "model": "model"}
        response_stream = io.BytesIO(b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
        with patch.object(website, "open_chat_stream", return_value=response_stream) as upstream:
            response = self.client.post("/api/reading", json={**self.payload, "provider": provider}, buffered=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(upstream.call_args.args[1], provider)

    def test_enabled_user_info_is_added_to_system_prompt_and_disabled_info_is_not(self):
        captured = []
        stream = lambda: io.BytesIO(b'data: {"choices":[{"delta":{"content":"ARCANA_FRAMEWORK:cause\\nanswer"}}]}\n\ndata: [DONE]\n\n')

        def fake_upstream(messages, _provider):
            captured.append(messages[0]["content"])
            return stream()

        enabled = {"enabled": True, "nickname": "小欧", "age": "28", "gender": "女", "zodiac": "天蝎座", "status": "正在转型做独立产品"}
        disabled = {**enabled, "enabled": False}
        with patch.object(website, "open_chat_stream", side_effect=fake_upstream):
            self.client.post("/api/reading", json={**self.payload, "userInfo": enabled}, buffered=True)
            self.client.post("/api/reading", json={**self.payload, "userInfo": disabled}, buffered=True)
        self.assertIn("昵称：小欧", captured[0])
        self.assertIn("当前状态：正在转型做独立产品", captured[0])
        self.assertNotIn("昵称：小欧", captured[1])

    def test_follow_up_uses_full_history_and_can_switch_provider(self):
        calls = []
        streams = [
            io.BytesIO(b'data: {"choices":[{"delta":{"content":"ARCANA_FRAMEWORK:cause\\ninitial reading"}}]}\n\ndata: [DONE]\n\n'),
            io.BytesIO(b'data: {"choices":[{"delta":{"content":"follow-up answer"}}]}\n\ndata: [DONE]\n\n'),
        ]

        def fake_upstream(messages, provider):
            calls.append((messages, provider))
            return streams.pop(0)

        second_provider = {"baseUrl": "https://backup.example/v1", "apiKey": "key", "model": "backup-model"}
        with patch.object(website, "open_chat_stream", side_effect=fake_upstream):
            first = self.client.post("/api/reading", json=self.payload, buffered=True)
            first_events = [json.loads(line[6:]) for line in first.get_data(as_text=True).splitlines() if line.startswith("data: ")]
            conversation_id = first_events[0]["conversationId"]
            follow = self.client.post("/api/follow-up", json={"conversationId": conversation_id, "message": "那我接下来先做什么？", "provider": second_provider}, buffered=True)

        follow_events = [json.loads(line[6:]) for line in follow.get_data(as_text=True).splitlines() if line.startswith("data: ")]
        self.assertEqual(follow_events, [{"content": "follow-up answer"}, {"done": True, "rounds": 1, "closed": False}])
        self.assertEqual(calls[1][1], second_provider)
        history = calls[1][0]
        self.assertEqual([item["role"] for item in history], ["system", "user", "assistant", "user"])
        self.assertEqual(history[-2]["content"], "initial reading")
        self.assertEqual(history[-1]["content"], "那我接下来先做什么？")

    def test_eighth_follow_up_closes_conversation_and_ninth_is_rejected(self):
        conversation_id = "a" * 32
        website.CONVERSATIONS[conversation_id] = {
            "messages": [{"role": "system", "content": website.SYSTEM_PROMPT}, {"role": "user", "content": "question"}, {"role": "assistant", "content": "reading"}],
            "rounds": 0,
            "busy": False,
            "updated_at": website.time.time(),
        }
        sent_messages = []

        def fake_upstream(messages, _provider):
            sent_messages.append(messages)
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n')

        with patch.object(website, "open_chat_stream", side_effect=fake_upstream) as upstream:
            for round_number in range(1, 9):
                response = self.client.post("/api/follow-up", json={"conversationId": conversation_id, "message": f"follow {round_number}"}, buffered=True)
                events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
                self.assertEqual(events[-1]["rounds"], round_number)
            self.assertTrue(events[-1]["closed"])
            self.assertIn("第八次", sent_messages[-1][0]["content"])
            rejected = self.client.post("/api/follow-up", json={"conversationId": conversation_id, "message": "one more"})
            self.assertEqual(rejected.status_code, 409)
            self.assertEqual(upstream.call_count, 8)

    def test_models_endpoint_returns_provider_list(self):
        provider = {"baseUrl": "https://relay.example/v1", "apiKey": "key"}
        with patch.object(website, "list_models", return_value=["model-a", "model-b"]) as fetch_models:
            response = self.client.post("/api/models", json={"provider": provider})
        self.assertEqual(response.json, {"models": ["model-a", "model-b"]})
        fetch_models.assert_called_once_with(provider)

    def test_validation_and_missing_configuration_are_json_errors(self):
        invalid = self.client.post("/api/reading", json={**self.payload, "cards": []})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(set(invalid.json), {"error"})

        with patch.dict(os.environ, {"LLM_BASE_URL": "", "LLM_API_KEY": "", "LLM_MODEL": ""}):
            missing = self.client.post("/api/reading", json=self.payload)
        self.assertEqual(missing.status_code, 503)
        self.assertIn("LLM_API_KEY", missing.json["error"])

    def test_cors_rejects_other_sites_before_upstream_call(self):
        with patch.object(website, "open_chat_stream") as upstream:
            denied = self.client.post("/api/reading", json=self.payload, headers={"Origin": "https://unknown.example"})
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(set(denied.json), {"error"})
        upstream.assert_not_called()
        allowed = self.client.options("/api/reading", headers={"Origin": "http://localhost:4173"})
        self.assertEqual(allowed.headers["Access-Control-Allow-Origin"], "http://localhost:4173")

    def test_only_public_files_are_served(self):
        with self.client.get("/") as home:
            self.assertEqual(home.status_code, 200)
        with self.client.get("/app.js") as script:
            self.assertEqual(script.status_code, 200)
        with self.client.get("/settings.js") as script:
            self.assertEqual(script.status_code, 200)
        self.assertEqual(self.client.get("/.env.example").status_code, 404)
        self.assertEqual(self.client.get("/prompts/system.md").status_code, 404)


class RelayTests(unittest.TestCase):
    def test_compatible_post_url_and_private_key_header(self):
        values = {"LLM_BASE_URL": "https://relay.example/v1/", "LLM_API_KEY": "private-key", "LLM_MODEL": "chosen-model"}
        with patch.dict(os.environ, values), patch.object(llm, "urlopen", return_value=io.BytesIO(b"")) as send:
            llm.open_chat_stream([{"role": "user", "content": "你好"}])
        req = send.call_args.args[0]
        self.assertEqual(req.full_url, "https://relay.example/v1/chat/completions")
        self.assertEqual(req.get_header("Authorization"), "Bearer private-key")
        body = json.loads(req.data)
        self.assertEqual(body["model"], "chosen-model")
        self.assertIs(body["stream"], True)
        self.assertEqual(send.call_args.kwargs["timeout"], 60)

    def test_page_provider_overrides_environment_without_persisting_on_server(self):
        provider = {"baseUrl": "https://another-relay.example/v1", "apiKey": "browser-key", "model": "browser-model"}
        with patch.dict(os.environ, {"LLM_BASE_URL": "https://env.example/v1", "LLM_API_KEY": "env-key", "LLM_MODEL": "env-model"}), patch.object(llm, "urlopen", return_value=io.BytesIO(b"")) as send:
            llm.open_chat_stream([{"role": "user", "content": "你好"}], provider)
        req = send.call_args.args[0]
        self.assertEqual(req.full_url, "https://another-relay.example/v1/chat/completions")
        self.assertEqual(req.get_header("Authorization"), "Bearer browser-key")
        self.assertEqual(json.loads(req.data)["model"], "browser-model")

    def test_page_provider_rejects_insecure_remote_url(self):
        provider = {"baseUrl": "http://relay.example/v1", "apiKey": "test-key", "model": "model"}
        with self.assertRaisesRegex(llm.LLMError, "https"):
            llm.open_chat_stream([], provider)

    def test_model_list_uses_openai_compatible_endpoint(self):
        provider = {"baseUrl": "https://relay.example/v1", "apiKey": "key"}
        response = io.BytesIO(b'{"data":[{"id":"model-a"},{"id":"model-b"},{"id":"model-a"}]}')
        with patch.object(llm, "urlopen", return_value=response) as send:
            models = llm.list_models(provider)
        self.assertEqual(models, ["model-a", "model-b"])
        request = send.call_args.args[0]
        self.assertEqual(request.full_url, "https://relay.example/v1/models")
        self.assertEqual(request.get_header("Authorization"), "Bearer key")
        self.assertEqual(request.get_method(), "GET")

    def test_upstream_auth_and_timeout_have_friendly_errors(self):
        values = {"LLM_BASE_URL": "https://relay.example/v1", "LLM_API_KEY": "bad-key", "LLM_MODEL": "model"}
        http_error = HTTPError("https://relay.example/v1/chat/completions", 401, "Unauthorized", {}, io.BytesIO())
        with patch.dict(os.environ, values), patch.object(llm, "urlopen", side_effect=http_error):
            with self.assertRaisesRegex(llm.LLMError, "API Key 无效"):
                llm.open_chat_stream([])
        with patch.dict(os.environ, values), patch.object(llm, "urlopen", side_effect=socket.timeout()):
            with self.assertRaisesRegex(llm.LLMError, "超时"):
                llm.open_chat_stream([])

    def test_quota_error_inside_sse_is_friendly(self):
        stream = io.BytesIO(b'data: {"error":{"code":"insufficient_quota","message":"quota exceeded"}}\n\n')
        with self.assertRaisesRegex(llm.LLMError, "额度不足"):
            list(llm.iter_chat_text(stream))


if __name__ == "__main__":
    unittest.main()
