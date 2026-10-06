"""无需真实 API Key 的接口与中转协议检查。"""

import copy
import io
import json
import os
import socket
import sqlite3
import tempfile
import unittest
from datetime import datetime
from unittest.mock import patch
from urllib.error import HTTPError

import app as website
import llm


class ReadingTests(unittest.TestCase):
    def setUp(self):
        configuration = patch.dict(os.environ, {
            "LLM_BASE_URL": "https://relay.example/v1", "LLM_API_KEY": "test-key", "LLM_MODEL": "test-model",
        })
        configuration.start()
        self.addCleanup(configuration.stop)
        website.CONVERSATIONS.clear()
        self.database_directory = tempfile.TemporaryDirectory()
        website.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(self.database_directory.name, "arcana-test.db"),
            SESSION_COOKIE_SECURE=False,
        )
        website.initialize_database()
        # 普通接口测试不启动后台工作；实时调度测试会在自己的上下文中覆盖。
        for name in ("schedule_session", "schedule_failed"):
            scheduler = patch.object(website.profile_memory, name, return_value=False)
            scheduler.start()
            self.addCleanup(scheduler.stop)
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

    def tearDown(self):
        self.database_directory.cleanup()

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

    def test_formatted_framework_markers_never_reach_reading_text(self):
        variants = (
            "**ARCANA_FRAMEWORK:energy**\n完整解读",
            "`ARCANA\\_FRAMEWORK:relationship`\n完整解读",
            "```text\nARCANA_FRAMEWORK:choice\n```\n完整解读",
        )
        expected = ("energy", "relationship", "choice")
        for response, framework in zip(variants, expected):
            with self.subTest(response=response):
                events = list(website.iter_reading_events([response], 3))
                self.assertEqual(events[0], {
                    "framework": framework,
                    "positions": website.THREE_CARD_FRAMEWORKS[framework],
                })
                visible = "".join(event.get("content", "") for event in events)
                self.assertNotIn("ARCANA", visible)
                self.assertNotIn("FRAMEWORK", visible)
                self.assertIn("完整解读", visible)

    def test_framework_name_can_be_split_across_stream_chunks(self):
        events = list(website.iter_reading_events([
            "ARCANA_FRAMEWORK:e",
            "nergy\n完整解读",
        ], 3))
        self.assertEqual(events, [
            {"framework": "energy", "positions": website.THREE_CARD_FRAMEWORKS["energy"]},
            {"content": "完整解读"},
        ])

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

        enabled = {
            "enabled": True,
            "nickname": "小欧",
            "age": "28",
            "gender": "女",
            "zodiac": "天蝎座",
            "currentStatus": "正在转型做独立产品",
            "focusAreas": ["产品", "成长"],
        }
        disabled = {**enabled, "enabled": False}
        with patch.object(website, "open_chat_stream", side_effect=fake_upstream):
            self.client.post("/api/reading", json={**self.payload, "userInfo": enabled}, buffered=True)
            self.client.post("/api/reading", json={**self.payload, "userInfo": disabled}, buffered=True)
        self.assertIn("昵称：小欧", captured[0])
        self.assertIn("当前状态：正在转型做独立产品", captured[0])
        self.assertIn("关注方向：产品、成长", captured[0])
        self.assertNotIn("昵称：小欧", captured[1])

    def test_system_prompt_starts_with_current_shanghai_time(self):
        fixed = datetime(2026, 9, 25, 14, 7, tzinfo=website.ZoneInfo("Asia/Shanghai"))
        self.assertEqual(website.current_time_line(fixed), "当前时间：2026年9月25日 14:07，星期五")
        with patch.object(website, "current_time_line", return_value="当前时间：固定时间"):
            prompt = website.system_prompt_with_user_info(None)
        self.assertTrue(prompt.startswith(f"当前时间：固定时间\n{website.TIME_REASONING_RULE}\n"))
        self.assertIn("必须以第一行给出的东八区当前时间为唯一基准", prompt)

    def test_reading_and_every_follow_up_send_the_current_stage_prompt(self):
        """验证实际送出的消息，避免 prompt 文件存在却没有送给模型。"""
        base = (website.ROOT / "prompts" / "base.md").read_text(encoding="utf-8").strip()
        reading = (website.ROOT / "prompts" / "reading.md").read_text(encoding="utf-8").strip()
        conversation = (website.ROOT / "prompts" / "conversation.md").read_text(encoding="utf-8").strip()
        captured = []

        def fake_upstream(messages, _provider):
            captured.append(copy.deepcopy(messages))
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"response"}}]}\n\ndata: [DONE]\n\n')

        with patch.object(website, "open_chat_stream", side_effect=fake_upstream), \
                patch.object(website, "current_time_line", side_effect=["当前时间：初次", "当前时间：追问一", "当前时间：追问二"]):
            response = self.client.post("/api/reading", json={
                **self.payload, "userInfo": {"enabled": True, "nickname": "测试用户"},
            }, buffered=True)
            self.assertEqual(response.status_code, 200)
            events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
            conversation_id = events[0]["conversationId"]
            for message in ("我昨天开始学产品了", "我担心自己做不好"):
                follow = self.client.post("/api/follow-up", json={
                    "conversationId": conversation_id, "message": message,
                }, buffered=True)
                self.assertEqual(follow.status_code, 200)

        first_prompt = captured[0][0]["content"]
        self.assertTrue(first_prompt.startswith("当前时间：初次\n"))
        self.assertIn(base + "\n\n" + reading, first_prompt)
        self.assertNotIn(conversation, first_prompt)
        for index, sent in enumerate(captured[1:], start=1):
            with self.subTest(round=index):
                prompt = sent[0]["content"]
                self.assertTrue(prompt.startswith(f"当前时间：追问{'一' if index == 1 else '二'}\n"))
                self.assertIn(base + "\n\n" + conversation, prompt)
                self.assertNotIn(reading, prompt)
                self.assertNotIn("ARCANA_FRAMEWORK", prompt)
                self.assertIn("昵称：测试用户", prompt)
                self.assertEqual(sent[1], captured[0][1])
                self.assertEqual(sent[2], {"role": "assistant", "content": "response"})
        self.assertEqual(captured[2][3]["content"], "我昨天开始学产品了")
        stored = website.CONVERSATIONS[conversation_id]["messages"]
        self.assertEqual(stored[0]["content"], first_prompt)
        self.assertNotIn(website.FOLLOW_UP_HINT, json.dumps(stored, ensure_ascii=False))

    def test_follow_up_stage_keeps_history_but_refreshes_manually_edited_notes(self):
        self.client.post("/api/register", json={
            "email": "prompt-stage@example.com", "nickname": "测试用户", "password": "password123",
        })
        profile = {"enabled": True, "id": "prompt-stage-profile", "nickname": "测试用户"}
        history = '<reading_history>固定历史快照</reading_history>'
        old_notes = '<user_notes>编辑前的便签</user_notes>'
        new_notes = '<user_notes>用户编辑后的便签</user_notes>'
        captured = []

        def fake_upstream(messages, _provider):
            captured.append(copy.deepcopy(messages))
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"response"}}]}\n\ndata: [DONE]\n\n')

        with patch.object(website, "open_chat_stream", side_effect=fake_upstream), \
                patch.object(website, "load_reading_memory", return_value=history) as load_history, \
                patch.object(website, "load_user_notes_prompt", side_effect=[old_notes, new_notes]):
            response = self.client.post("/api/reading", json={**self.payload, "userInfo": profile}, buffered=True)
            self.assertEqual(response.status_code, 200)
            events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
            conversation_id = events[0]["conversationId"]
            follow = self.client.post("/api/follow-up", json={
                "conversationId": conversation_id, "message": "我又有新情况了", "userInfo": profile,
            }, buffered=True)
            self.assertEqual(follow.status_code, 200)
            disabled = self.client.post("/api/follow-up", json={
                "conversationId": conversation_id, "message": "继续聊", "userInfo": {"enabled": False},
            }, buffered=True)
            self.assertEqual(disabled.status_code, 200)
            load_history.assert_called_once_with(1, "prompt-stage-profile")

        self.assertIn(old_notes, captured[0][0]["content"])
        self.assertIn(new_notes, captured[1][0]["content"])
        self.assertNotIn(old_notes, captured[1][0]["content"])
        for sent in captured:
            self.assertIn(history, sent[0]["content"])
        self.assertIn(website.CONVERSATION_PROMPT, captured[1][0]["content"])
        self.assertIn(website.CONVERSATION_PROMPT, captured[2][0]["content"])
        self.assertNotIn(old_notes, captured[2][0]["content"])
        self.assertNotIn(new_notes, captured[2][0]["content"])

    def test_current_time_refresh_does_not_duplicate_time_rule(self):
        old_prompt = f"当前时间：旧时间\n{website.TIME_REASONING_RULE}\n原始规则"
        with patch.object(website, "current_time_line", return_value="当前时间：新时间"):
            refreshed = website.prompt_with_current_time(old_prompt)
        self.assertEqual(
            refreshed,
            f"当前时间：新时间\n{website.TIME_REASONING_RULE}\n原始规则",
        )

    def test_summary_instruction_is_only_added_for_recorded_readings(self):
        captured = []

        def fake_upstream(messages, _provider):
            captured.append(messages[1]["content"])
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"ARCANA_FRAMEWORK:cause\\nanswer"}}]}\n\ndata: [DONE]\n\n')

        with patch.object(website, "open_chat_stream", side_effect=fake_upstream):
            self.client.post("/api/register", json={"email": "reader@example.com", "nickname": "小欧", "password": "password123"})
            self.client.post("/api/reading", json={**self.payload, "recordHistory": True, "userInfo": {"enabled": True, "id": "user-1", "nickname": "小欧"}}, buffered=True)
            self.client.post("/api/reading", json={**self.payload, "recordHistory": True, "userInfo": {"enabled": False}}, buffered=True)
            self.client.post("/api/logout")
            self.client.post("/api/reading", json={**self.payload, "recordHistory": False}, buffered=True)
        self.assertIn("【总结】", captured[0])
        self.assertNotIn("【总结】", captured[1])
        self.assertNotIn("【总结】", captured[2])

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
        self.assertEqual(history[-1]["content"], "那我接下来先做什么？\n" + website.FOLLOW_UP_HINT)
        self.assertEqual(website.CONVERSATIONS[conversation_id]["messages"][-2]["content"], "那我接下来先做什么？")

    def test_follow_up_accepts_local_images_as_multimodal_content(self):
        conversation_id = "c" * 32
        website.CONVERSATIONS[conversation_id] = {
            "messages": [{"role": "system", "content": website.SYSTEM_PROMPT}],
            "rounds": 0,
            "busy": False,
            "updated_at": website.time.time(),
        }
        captured = []

        def fake_upstream(messages, _provider):
            captured.extend(messages)
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"image answer"}}]}\n\ndata: [DONE]\n\n')

        image = "data:image/jpeg;base64,YQ=="
        with patch.object(website, "open_chat_stream", side_effect=fake_upstream):
            response = self.client.post("/api/follow-up", json={"conversationId": conversation_id, "message": "看看这张图", "images": [image]}, buffered=True)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(captured[0]["content"].startswith("当前时间："))
        content = captured[-1]["content"]
        self.assertEqual(content[0], {"type": "text", "text": "看看这张图\n" + website.FOLLOW_UP_HINT})
        self.assertEqual(content[1], {"type": "image_url", "image_url": {"url": image}})
        stored_content = website.CONVERSATIONS[conversation_id]["messages"][-2]["content"]
        self.assertEqual(stored_content[0], {"type": "text", "text": "看看这张图"})

    def test_follow_up_removes_initial_summary_only_in_the_model_copy(self):
        conversation_id = "e" * 32
        initial = [
            {"role": "system", "content": website.SYSTEM_PROMPT},
            {"role": "user", "content": "最初的问题\n" + website.SUMMARY_INSTRUCTION},
            {"role": "assistant", "content": "完整解读。\n【总结】历史独立总结。"},
        ]
        website.CONVERSATIONS[conversation_id] = {
            "messages": copy.deepcopy(initial), "rounds": 0,
            "busy": False, "updated_at": website.time.time(),
        }
        self.client.post("/api/register", json={
            "email": "summary-history@example.com", "nickname": "测试用户", "password": "password123",
        })
        saved = self.client.post("/api/readings", json={
            "question": "最初的问题", "spread_type": "三牌阵", "cards": self.payload["cards"],
            "summary": "历史独立总结。", "full_reading": initial[2]["content"],
            "profile_id": "summary-profile", "profile_nickname": "测试用户",
        })
        self.assertEqual(saved.status_code, 201)
        previous_records = self.client.get("/api/readings").json
        captured = []

        def fake_upstream(messages, _provider):
            captured.extend(copy.deepcopy(messages))
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n')

        with patch.object(website, "open_chat_stream", side_effect=fake_upstream):
            response = self.client.post("/api/follow-up", json={
                "conversationId": conversation_id, "message": "这一句才是追问内容",
            }, buffered=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(captured[1]["content"], "最初的问题")
        self.assertEqual(captured[2]["content"], "完整解读。")
        self.assertNotIn(website.SUMMARY_INSTRUCTION, json.dumps(captured, ensure_ascii=False))
        self.assertNotIn("【总结】", captured[2]["content"])
        self.assertEqual(captured[-1]["content"], "这一句才是追问内容\n" + website.FOLLOW_UP_HINT)
        stored = website.CONVERSATIONS[conversation_id]["messages"]
        self.assertEqual(stored[:3], initial)
        self.assertEqual(stored[-2]["content"], "这一句才是追问内容")
        self.assertNotIn(website.FOLLOW_UP_HINT, json.dumps(stored, ensure_ascii=False))
        self.assertEqual(self.client.get("/api/readings").json, previous_records)

    def test_follow_up_summary_is_not_streamed_or_stored_across_chunk_boundaries(self):
        conversation_id = "f" * 32
        website.CONVERSATIONS[conversation_id] = {
            "messages": [{"role": "system", "content": website.SYSTEM_PROMPT}],
            "rounds": 0, "busy": False, "updated_at": website.time.time(),
        }
        texts = ["直白回应。\n【", "总", "结", "】不应该出现的内容", "后续也不能出现"]
        stream = io.BytesIO(("".join(
            "data: " + json.dumps({"choices": [{"delta": {"content": text}}]}, ensure_ascii=False) + "\n\n"
            for text in texts
        ) + "data: [DONE]\n\n").encode("utf-8"))
        with patch.object(website, "open_chat_stream", return_value=stream):
            response = self.client.post("/api/follow-up", json={
                "conversationId": conversation_id, "message": "那你建议我接下来怎么办",
            }, buffered=True)
        events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
        self.assertEqual("".join(event.get("content", "") for event in events), "直白回应。\n")
        self.assertTrue(events[-1]["done"])
        self.assertEqual(website.CONVERSATIONS[conversation_id]["messages"][-1]["content"], "直白回应。")

    def test_summary_stream_filter_preserves_plain_text_and_incomplete_marker(self):
        for split in range(1, len(website.SUMMARY_MARKER)):
            with self.subTest(split=split):
                result = list(website.iter_follow_up_text([
                    "回应" + website.SUMMARY_MARKER[:split], website.SUMMARY_MARKER[split:] + "总结",
                ]))
                self.assertEqual("".join(result), "回应")
        self.assertEqual("".join(website.iter_follow_up_text(["开场【", "普通括号内容】", "结尾【总"])), "开场【普通括号内容】结尾【总")

    def test_hidden_follow_up_summary_cannot_hide_an_incomplete_stream(self):
        conversation_id = "f" * 32
        initial = [{"role": "system", "content": website.SYSTEM_PROMPT}]
        website.CONVERSATIONS[conversation_id] = {
            "messages": copy.deepcopy(initial), "rounds": 0,
            "busy": False, "updated_at": website.time.time(),
        }
        event = json.dumps({"choices": [{"delta": {"content": "直白回应。\n【总结】隐藏内容"}}]}, ensure_ascii=False)
        stream = io.BytesIO(("data: " + event + "\n\n").encode("utf-8"))
        with patch.object(website, "open_chat_stream", return_value=stream), \
                patch.object(website, "schedule_profile_conversation") as schedule:
            response = self.client.post("/api/follow-up", json={
                "conversationId": conversation_id, "message": "那下一步怎么做？",
            }, buffered=True)
        events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
        self.assertEqual(events[0], {"content": "直白回应。\n"})
        self.assertIn("连接提前结束", events[-1]["error"])
        self.assertFalse(any(event.get("done") for event in events))
        session = website.CONVERSATIONS[conversation_id]
        self.assertEqual(session["messages"], initial)
        self.assertEqual(session["rounds"], 0)
        self.assertFalse(session["busy"])
        schedule.assert_not_called()

    def test_every_completed_response_schedules_memory_without_waiting_for_eighth_round(self):
        self.client.post("/api/register", json={
            "email": "realtime@example.com", "nickname": "测试用户", "password": "password123",
        })
        user_info = {"enabled": True, "id": "realtime-profile", "nickname": "测试用户"}

        def fake_upstream(_messages, _provider):
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"response"}}]}\n\ndata: [DONE]\n\n')

        with patch.object(website, "open_chat_stream", side_effect=fake_upstream), \
                patch.object(website.profile_memory, "schedule_session") as schedule, \
                patch.object(website.profile_memory, "schedule_failed") as retry_failed:
            reading = self.client.post("/api/reading", json={
                **self.payload, "userInfo": user_info,
            }, buffered=True)
            events = [json.loads(line[6:]) for line in reading.get_data(as_text=True).splitlines() if line.startswith("data: ")]
            conversation_id = events[0]["conversationId"]
            self.assertEqual(schedule.call_count, 1)
            retry_failed.assert_called_once_with(website.app.config["DATABASE"], 1, "realtime-profile")
            for round_number in (1, 2):
                response = self.client.post("/api/follow-up", json={
                    "conversationId": conversation_id, "message": "我准备转行做产品了", "userInfo": user_info,
                }, buffered=True)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(schedule.call_count, round_number + 1)
            schedule.assert_called_with(website.app.config["DATABASE"], 1, "realtime-profile", conversation_id)
            retry_failed.assert_called_once()
        with website.database_connection() as connection:
            persisted = connection.execute("SELECT dialogue FROM profile_memory_sessions WHERE id = ?", (conversation_id,)).fetchone()
        self.assertNotIn(website.FOLLOW_UP_HINT, persisted["dialogue"])

    def test_disabled_user_info_never_schedules_memory_for_reading_or_follow_up(self):
        self.client.post("/api/register", json={
            "email": "disabled-memory@example.com", "nickname": "测试用户", "password": "password123",
        })

        def fake_upstream(_messages, _provider):
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"response"}}]}\n\ndata: [DONE]\n\n')

        with patch.object(website, "open_chat_stream", side_effect=fake_upstream), \
                patch.object(website.profile_memory, "schedule_session") as schedule, \
                patch.object(website.profile_memory, "schedule_failed") as retry_failed:
            reading = self.client.post("/api/reading", json={
                **self.payload, "userInfo": {"enabled": False, "id": "inactive-profile"},
            }, buffered=True)
            events = [json.loads(line[6:]) for line in reading.get_data(as_text=True).splitlines() if line.startswith("data: ")]
            response = self.client.post("/api/follow-up", json={
                "conversationId": events[0]["conversationId"], "message": "我准备转行做产品了",
            }, buffered=True)
            self.assertEqual(response.status_code, 200)
            schedule.assert_not_called()
            retry_failed.assert_not_called()

    def test_follow_up_rejects_more_than_three_images(self):
        conversation_id = "d" * 32
        website.CONVERSATIONS[conversation_id] = {
            "messages": [], "rounds": 0, "busy": False, "updated_at": website.time.time(),
        }
        image = "data:image/png;base64,YQ=="
        response = self.client.post("/api/follow-up", json={"conversationId": conversation_id, "message": "", "images": [image] * 4})
        self.assertEqual(response.status_code, 400)

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

    def test_user_can_end_conversation_early(self):
        conversation_id = "b" * 32
        website.CONVERSATIONS[conversation_id] = {
            "messages": [], "rounds": 2, "busy": False, "updated_at": website.time.time(),
        }
        response = self.client.post("/api/conversation/end", json={"conversationId": conversation_id})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"ended": True})
        self.assertNotIn(conversation_id, website.CONVERSATIONS)
        follow = self.client.post("/api/follow-up", json={"conversationId": conversation_id, "message": "还在吗"})
        self.assertEqual(follow.status_code, 404)

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

    def test_cors_allows_configured_https_origin_behind_proxy(self):
        # 模拟线上：浏览器是 https，Flask 收到的是 http（Cloudflare Flexible + Nginx）
        origin = "https://arcana.ououm.com"
        with patch.object(website, "ALLOWED_ORIGINS", {origin}):
            allowed = self.client.options(
                "/api/reading",
                base_url="http://arcana.ououm.com",
                headers={"Origin": origin},
            )
            self.assertEqual(allowed.headers.get("Access-Control-Allow-Origin"), origin)
            # 白名单之外的来源仍然被拒
            with patch.object(website, "open_chat_stream") as upstream:
                denied = self.client.post(
                    "/api/reading",
                    json=self.payload,
                    base_url="http://arcana.ououm.com",
                    headers={"Origin": "https://evil.example"},
                )
            self.assertEqual(denied.status_code, 403)
            upstream.assert_not_called()

    def test_https_origin_rejected_without_config(self):
        # 不配置白名单时，就是线上现在的 bug：https 来源对不上 http 的 host_url
        with patch.object(website, "ALLOWED_ORIGINS", set()):
            with patch.object(website, "open_chat_stream") as upstream:
                denied = self.client.post(
                    "/api/reading",
                    json=self.payload,
                    base_url="http://arcana.ououm.com",
                    headers={"Origin": "https://arcana.ououm.com"},
                )
        self.assertEqual(denied.status_code, 403)
        upstream.assert_not_called()

    def test_only_public_files_are_served(self):
        with self.client.get("/") as home:
            self.assertEqual(home.status_code, 200)
        with self.client.get("/app.js") as script:
            self.assertEqual(script.status_code, 200)
        with self.client.get("/settings.js") as script:
            self.assertEqual(script.status_code, 200)
        with self.client.get("/auth.js") as script:
            self.assertEqual(script.status_code, 200)
        self.assertEqual(self.client.get("/.env.example").status_code, 404)
        self.assertEqual(self.client.get("/prompts/system.md").status_code, 404)


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.database_directory = tempfile.TemporaryDirectory()
        website.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(self.database_directory.name, "arcana-test.db"),
            SESSION_COOKIE_SECURE=False,
        )
        website.initialize_database()
        self.client = website.app.test_client()

    def tearDown(self):
        self.database_directory.cleanup()

    def register(self, email="reader@example.com", nickname="小欧"):
        return self.client.post("/api/register", json={
            "email": email,
            "nickname": nickname,
            "password": "correct-password",
        })

    def test_register_hashes_password_and_session_can_logout_and_login(self):
        registered = self.register(email="Reader@Example.com")
        self.assertEqual(registered.status_code, 201)
        self.assertEqual(registered.json["user"]["email"], "reader@example.com")
        with sqlite3.connect(website.app.config["DATABASE"]) as connection:
            password_hash = connection.execute("SELECT password_hash FROM users").fetchone()[0]
            encrypted_settings = connection.execute("SELECT encrypted_data FROM account_settings").fetchone()[0]
        self.assertNotEqual(password_hash, "correct-password")
        self.assertTrue(password_hash.startswith("$2"))
        self.assertNotIn("小欧", encrypted_settings)
        account_data = self.client.get("/api/account-data").json
        self.assertTrue(account_data["hasData"])
        self.assertEqual(len(account_data["profiles"]), 1)
        self.assertEqual(account_data["profiles"][0]["nickname"], "小欧")
        self.assertTrue(account_data["profiles"][0]["isActive"])
        self.assertEqual(account_data["profiles"][0]["age"], "")
        self.assertEqual(self.client.get("/api/me").status_code, 200)
        self.assertEqual(self.client.post("/api/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/me").status_code, 401)
        wrong = self.client.post("/api/login", json={"email": "reader@example.com", "password": "wrong-password"})
        self.assertEqual(wrong.status_code, 401)
        logged_in = self.client.post("/api/login", json={"email": "reader@example.com", "password": "correct-password"})
        self.assertEqual(logged_in.status_code, 200)

    def test_duplicate_email_and_weak_password_are_rejected(self):
        self.assertEqual(self.register().status_code, 201)
        self.assertEqual(self.register(nickname="另一个人").status_code, 409)
        weak = self.client.post("/api/register", json={"email": "new@example.com", "nickname": "新用户", "password": "short"})
        self.assertEqual(weak.status_code, 400)

    def test_readings_are_private_and_migration_preserves_records(self):
        self.assertEqual(self.client.get("/api/readings").status_code, 401)
        self.register()
        record = {
            "profile_id": "profile-xiao-ou",
            "profile_nickname": "小欧",
            "question": "我该怎么做？",
            "spread_type": "单牌",
            "cards": [{"id": "fool", "chinese": "愚者", "position": "此刻", "reversed": False}],
            "summary": "先停止拖延，今天完成第一步。",
            "full_reading": "完整解读内容。",
        }
        saved = self.client.post("/api/readings", json=record)
        self.assertEqual(saved.status_code, 201)
        migrated = self.client.post("/api/readings/migrate", json={"readings": [{
            **record,
            "question": "旧问题",
            "createdAt": 1750000000000,
        }]})
        self.assertEqual(migrated.status_code, 200)
        readings = self.client.get("/api/readings").json["readings"]
        self.assertEqual({item["question"] for item in readings}, {"我该怎么做？", "旧问题"})
        self.assertTrue(all(item["profile_id"] == "profile-xiao-ou" for item in readings))
        self.client.post("/api/logout")
        self.register(email="other@example.com", nickname="另一位")
        self.assertEqual(self.client.get("/api/readings").json["readings"], [])

    def test_user_can_delete_only_their_own_reading(self):
        self.register()
        record = {
            "profile_id": "profile-xiao-ou",
            "profile_nickname": "小欧",
            "question": "该结束了吗？",
            "spread_type": "单牌",
            "cards": [{"id": "fool", "chinese": "愚者", "position": "此刻", "reversed": False}],
            "summary": "停止消耗，今天做出决定。",
            "full_reading": "完整解读内容。",
        }
        reading_id = self.client.post("/api/readings", json=record).json["id"]
        self.client.post("/api/logout")
        self.register(email="other@example.com", nickname="另一位")
        self.assertEqual(self.client.delete(f"/api/readings/{reading_id}").status_code, 404)
        self.client.post("/api/logout")
        self.client.post("/api/login", json={"email": "reader@example.com", "password": "correct-password"})
        deleted = self.client.delete(f"/api/readings/{reading_id}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.client.get("/api/readings").json["readings"], [])

    def test_new_reading_requires_an_enabled_profile_owner(self):
        self.register()
        record = {
            "question": "我该怎么做？",
            "spread_type": "单牌",
            "cards": [{"id": "fool", "chinese": "愚者", "position": "此刻", "reversed": False}],
            "summary": "今天完成第一步。",
            "full_reading": "完整解读内容。",
        }
        response = self.client.post("/api/readings", json=record)
        self.assertEqual(response.status_code, 400)
        self.assertIn("启用一位用户", response.json["error"])

    def test_account_profiles_and_providers_are_encrypted_and_private(self):
        account_data = {
            "providerSettings": {
                "providers": [{
                    "id": "provider-one",
                    "name": "备用供应商",
                    "baseUrl": "https://relay.example/v1",
                    "apiKey": "private-provider-key",
                    "model": "model-one",
                }],
                "activeId": "provider-one",
            },
            "profiles": [{
                "id": "profile-xiao-ou",
                "nickname": "小欧",
                "age": "25",
                "gender": "女",
                "zodiac": "天秤座",
                "currentStatus": "正在做自己的产品",
                "focusAreas": ["事业", "成长"],
                "isActive": True,
            }],
        }
        self.assertEqual(self.client.get("/api/account-data").status_code, 401)
        self.register()
        empty = self.client.get("/api/account-data")
        self.assertTrue(empty.json["hasData"])
        self.assertEqual(empty.json["profiles"][0]["nickname"], "小欧")
        saved = self.client.put("/api/account-data", json=account_data)
        self.assertEqual(saved.status_code, 200)

        with sqlite3.connect(website.app.config["DATABASE"]) as connection:
            encrypted = connection.execute("SELECT encrypted_data FROM account_settings").fetchone()[0]
        self.assertNotIn("private-provider-key", encrypted)
        self.assertNotIn("正在做自己的产品", encrypted)

        restored = self.client.get("/api/account-data")
        self.assertTrue(restored.json["hasData"])
        self.assertEqual(restored.json["providerSettings"], account_data["providerSettings"])
        self.assertEqual(restored.json["profiles"], account_data["profiles"])

        self.client.post("/api/logout")
        self.register(email="other@example.com", nickname="另一个人")
        other = self.client.get("/api/account-data")
        self.assertTrue(other.json["hasData"])
        self.assertEqual(len(other.json["profiles"]), 1)
        self.assertEqual(other.json["profiles"][0]["nickname"], "另一个人")
        self.assertTrue(other.json["profiles"][0]["isActive"])

    def test_account_data_rejects_multiple_active_profiles(self):
        self.register()
        response = self.client.put("/api/account-data", json={
            "providerSettings": {"providers": [], "activeId": None},
            "profiles": [
                {"id": "one", "isActive": True},
                {"id": "two", "isActive": True},
            ],
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("最多只能启用一位", response.json["error"])


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
        self.assertEqual(send.call_args.kwargs["timeout"], llm.CHAT_STREAM_TIMEOUT_SECONDS)

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
