"""Current-session restoration, with isolated cookies/database and mocked model output."""

import copy
import io
import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch

import app as website


class ConversationResumeTests(unittest.TestCase):
    def setUp(self):
        configuration = patch.dict(os.environ, {
            "LLM_BASE_URL": "https://relay.example/v1",
            "LLM_API_KEY": "test-key",
            "LLM_MODEL": "test-model",
        })
        configuration.start()
        self.addCleanup(configuration.stop)
        website.CONVERSATIONS.clear()
        self.original_config = {
            key: website.app.config[key]
            for key in ("TESTING", "DATABASE", "SESSION_COOKIE_SECURE")
        }
        self.database_directory = tempfile.TemporaryDirectory()
        website.app.config.update(
            TESTING=True,
            DATABASE=os.path.join(self.database_directory.name, "resume-test.db"),
            SESSION_COOKIE_SECURE=False,
        )
        website.initialize_database()
        with website.database_connection() as connection:
            for number in (1, 2):
                connection.execute(
                    "INSERT INTO users (email, nickname, password_hash) VALUES (?, ?, ?)",
                    (f"resume-{number}@example.com", f"测试用户{number}", "unused-test-password"),
                )
        for name in ("schedule_session", "schedule_failed"):
            scheduler = patch.object(website.profile_memory, name, return_value=False)
            scheduler.start()
            self.addCleanup(scheduler.stop)
        self.client = website.app.test_client()
        self.payload = {
            "question": "我该如何开始新的工作？", "spread": 1,
            "cards": [{"id": "fool", "name": "愚者", "reversed": False}],
        }

    def tearDown(self):
        website.CONVERSATIONS.clear()
        website.app.config.update(self.original_config)
        self.database_directory.cleanup()

    def sign_in(self, user_id):
        with self.client.session_transaction() as session:
            session.clear()
            if user_id is not None:
                session["user_id"] = user_id

    @staticmethod
    def model_stream(text):
        content = json.dumps({"choices": [{"delta": {"content": text}}]}, ensure_ascii=False)
        return io.BytesIO(f"data: {content}\n\ndata: [DONE]\n\n".encode("utf-8"))

    def start_reading(self):
        with patch.object(website, "open_chat_stream", return_value=self.model_stream("首次解读正文")):
            response = self.client.post("/api/reading", json=self.payload, buffered=True)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return next(
            json.loads(line[6:])["conversationId"]
            for line in response.get_data(as_text=True).splitlines()
            if line.startswith("data: ") and "conversationId" in line
        )

    def follow_up(self, conversation_id, text="下一步怎么做？", images=None, answer="先从一件小事开始。"):
        with patch.object(website, "open_chat_stream", return_value=self.model_stream(answer)):
            response = self.client.post("/api/follow-up", json={
                "conversationId": conversation_id, "message": text, **({"images": images} if images else {}),
            }, buffered=True)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response

    def test_returns_only_completed_follow_ups_without_prompts_or_initial_reading(self):
        conversation_id = self.start_reading()
        self.follow_up(conversation_id)
        self.follow_up(conversation_id, "我会紧张", answer="可以先给自己一点时间。" + website.SUMMARY_MARKER + "隐藏总结")
        response = self.client.get(f"/api/conversation/{conversation_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {
            "conversationId": conversation_id, "rounds": 2, "closed": False, "busy": False,
            "messages": [
                {"role": "user", "text": "下一步怎么做？"},
                {"role": "assistant", "text": "先从一件小事开始。"},
                {"role": "user", "text": "我会紧张"},
                {"role": "assistant", "text": "可以先给自己一点时间。"},
            ],
        })
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        encoded = response.get_data(as_text=True)
        for hidden in ("首次解读正文", "实际抽到的牌", website.FOLLOW_UP_HINT, "隐藏总结", "test-key"):
            self.assertNotIn(hidden, encoded)

    def test_image_only_message_is_restored_with_original_empty_text(self):
        conversation_id = self.start_reading()
        image = "data:image/png;base64,aW1hZ2U="
        self.follow_up(conversation_id, "", images=[image])
        response = self.client.get(f"/api/conversation/{conversation_id}")
        self.assertEqual(response.json["messages"][0], {"role": "user", "text": "", "images": [image]})

    def test_every_account_session_is_private_even_without_personal_background(self):
        self.sign_in(1)
        conversation_id = self.start_reading()
        self.assertEqual(website.CONVERSATIONS[conversation_id]["memory_user_id"], 1)
        for user_id in (2, None):
            with self.subTest(user_id=user_id):
                self.sign_in(user_id)
                denied = self.client.get(f"/api/conversation/{conversation_id}")
                self.assertEqual(denied.status_code, 403)
                self.assertEqual(denied.json["code"], "conversation_owner_mismatch")
                ended = self.client.post("/api/conversation/end", json={"conversationId": conversation_id})
                self.assertEqual(ended.status_code, 403)
                with patch.object(website, "open_chat_stream") as upstream:
                    follow = self.client.post("/api/follow-up", json={"conversationId": conversation_id, "message": "不能读取"})
                self.assertEqual(follow.status_code, 403)
                upstream.assert_not_called()
        self.sign_in(1)
        self.assertEqual(self.client.get(f"/api/conversation/{conversation_id}").status_code, 200)

    def test_guests_are_bound_to_the_browser_cookie_for_read_follow_up_and_end(self):
        conversation_id = self.start_reading()
        self.assertEqual(self.client.get(f"/api/conversation/{conversation_id}").status_code, 200)
        stranger = website.app.test_client()
        self.assertEqual(stranger.get(f"/api/conversation/{conversation_id}").status_code, 403)
        self.assertEqual(stranger.post("/api/conversation/end", json={"conversationId": conversation_id}).status_code, 403)
        with patch.object(website, "open_chat_stream") as upstream:
            follow = stranger.post("/api/follow-up", json={"conversationId": conversation_id, "message": "猜到编号也不能读"})
        self.assertEqual(follow.status_code, 403)
        upstream.assert_not_called()
        self.follow_up(conversation_id)

    def test_guest_auth_probe_preserves_current_conversation_on_refresh(self):
        conversation_id = self.start_reading()
        with self.client.session_transaction() as session:
            browser_id = session["conversation_browser_id"]
        auth = self.client.get("/api/me")
        self.assertEqual(auth.status_code, 401)
        with self.client.session_transaction() as session:
            self.assertEqual(dict(session), {"conversation_browser_id": browser_id})
        restored = self.client.get(f"/api/conversation/{conversation_id}")
        self.assertEqual(restored.status_code, 200)
        self.follow_up(conversation_id)
        self.assertEqual(self.client.get(f"/api/conversation/{conversation_id}").json["rounds"], 1)

    def test_invalid_account_cookie_is_cleared_without_losing_valid_guest_binding(self):
        self.sign_in(1)
        private_conversation = self.start_reading()
        self.sign_in(None)
        guest_conversation = self.start_reading()
        with self.client.session_transaction() as session:
            browser_id = session["conversation_browser_id"]
            session["user_id"] = 999
            session["old_account_data"] = "must-not-survive"
        auth = self.client.get("/api/me")
        self.assertEqual(auth.status_code, 401)
        with self.client.session_transaction() as session:
            self.assertEqual(dict(session), {"conversation_browser_id": browser_id})
        self.assertEqual(self.client.get(f"/api/conversation/{private_conversation}").status_code, 403)
        self.assertEqual(self.client.get(f"/api/conversation/{guest_conversation}").status_code, 200)
        self.follow_up(guest_conversation)

    def test_invalid_guest_binding_is_not_preserved_by_auth_probe(self):
        for invalid in ("short", "g" * 64, 123, None):
            with self.subTest(invalid=invalid):
                with self.client.session_transaction() as session:
                    session["conversation_browser_id"] = invalid
                    session["user_id"] = 999
                self.assertEqual(self.client.get("/api/me").status_code, 401)
                with self.client.session_transaction() as session:
                    self.assertEqual(dict(session), {})

    def test_ending_preserves_read_only_messages_and_does_not_allow_another_round(self):
        conversation_id = self.start_reading()
        self.follow_up(conversation_id)
        before = self.client.get(f"/api/conversation/{conversation_id}").json
        ended = self.client.post("/api/conversation/end", json={"conversationId": conversation_id})
        self.assertEqual(ended.json, {"ended": True})
        restored = self.client.get(f"/api/conversation/{conversation_id}").json
        self.assertEqual(restored, {**before, "closed": True})
        with patch.object(website, "open_chat_stream") as upstream:
            follow = self.client.post("/api/follow-up", json={"conversationId": conversation_id, "message": "已结束不能再问"})
        self.assertEqual(follow.status_code, 409)
        upstream.assert_not_called()
        self.assertEqual(self.client.post("/api/conversation/end", json={"conversationId": conversation_id}).json, {"ended": True})

    def test_busy_state_is_visible_and_cannot_be_ended_or_expired_mid_response(self):
        conversation_id = self.start_reading()
        session = website.CONVERSATIONS[conversation_id]
        session["busy"] = True
        session["updated_at"] = time.time() - website.CONVERSATION_TTL - 1
        before = copy.deepcopy(session)
        response = self.client.get(f"/api/conversation/{conversation_id}")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["busy"])
        self.assertEqual(response.json["messages"], [])
        ended = self.client.post("/api/conversation/end", json={"conversationId": conversation_id})
        self.assertEqual(ended.status_code, 409)
        self.assertEqual(website.CONVERSATIONS[conversation_id], before)

    def test_polling_does_not_extend_ttl_and_expiration_is_explicit(self):
        conversation_id = self.start_reading()
        session = website.CONVERSATIONS[conversation_id]
        original_time = session["updated_at"]
        response = self.client.get(f"/api/conversation/{conversation_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(session["updated_at"], original_time)
        session["updated_at"] = time.time() - website.CONVERSATION_TTL - 1
        expired = self.client.get(f"/api/conversation/{conversation_id}")
        self.assertEqual(expired.status_code, 404)
        self.assertEqual(expired.json["code"], "conversation_expired")
        self.assertNotIn(conversation_id, website.CONVERSATIONS)
        missing = self.client.get(f"/api/conversation/{'f' * 32}")
        self.assertEqual(missing.status_code, 404)

    def test_invalid_id_and_untrusted_origin_cannot_read_conversations(self):
        self.assertEqual(self.client.get("/api/conversation/not-an-id").status_code, 400)
        conversation_id = self.start_reading()
        denied = self.client.get(f"/api/conversation/{conversation_id}", headers={"Origin": "https://untrusted.example"})
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(self.client.options(f"/api/conversation/{conversation_id}").status_code, 204)

    def test_last_round_is_restored_as_closed_without_changing_confirmed_round(self):
        conversation_id = self.start_reading()
        website.CONVERSATIONS[conversation_id]["rounds"] = 7
        self.follow_up(conversation_id, "最后一轮")
        restored = self.client.get(f"/api/conversation/{conversation_id}").json
        self.assertEqual(restored["rounds"], 8)
        self.assertTrue(restored["closed"])
        self.assertFalse(restored["busy"])

    def test_explicit_end_schedules_notes_once_with_the_final_state(self):
        conversation_id = self.start_reading()
        self.follow_up(conversation_id)
        with patch.object(website, "schedule_profile_conversation") as scheduler:
            ended = self.client.post("/api/conversation/end", json={"conversationId": conversation_id})
            self.assertEqual(ended.status_code, 200)
            scheduler.assert_called_once()
            called_id, snapshot = scheduler.call_args.args
            self.assertEqual(called_id, conversation_id)
            self.assertTrue(snapshot["closed"])
            self.assertFalse(snapshot["busy"])
            self.assertEqual(snapshot["rounds"], 1)
            self.assertEqual(snapshot["updated_at"], website.CONVERSATIONS[conversation_id]["updated_at"])
            self.client.post("/api/conversation/end", json={"conversationId": conversation_id})
            scheduler.assert_called_once()

    def test_explicit_end_blocks_new_requests_but_can_replay_the_completed_one(self):
        conversation_id = self.start_reading()
        payload = {"conversationId": conversation_id, "message": "下一步怎么做？", "requestId": "a" * 32}
        with patch.object(website, "open_chat_stream", return_value=self.model_stream("先迈出一步。")) as upstream:
            first = self.client.post("/api/follow-up", json=payload, buffered=True)
            self.assertEqual(first.status_code, 200)
            self.client.post("/api/conversation/end", json={"conversationId": conversation_id})
            replay = self.client.post("/api/follow-up", json=payload, buffered=True)
            events = [json.loads(line[6:]) for line in replay.get_data(as_text=True).splitlines() if line.startswith("data: ")]
            self.assertEqual(events[-1], {"done": True, "rounds": 1, "closed": True})
            rejected = self.client.post("/api/follow-up", json={**payload, "requestId": "b" * 32}, buffered=True)
            self.assertEqual(rejected.status_code, 409)
            upstream.assert_called_once()
        self.assertEqual(website.CONVERSATIONS[conversation_id]["rounds"], 1)

    def test_reading_session_module_is_public(self):
        response = self.client.get("/reading-session.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("javascript", response.content_type)


if __name__ == "__main__":
    unittest.main()
