"""慢首字、流间等待、客户端取消和同一追问重试；全部使用受控假流。"""

import copy
import io
import json
import os
import tempfile
import time
import unittest
from threading import Event
from unittest.mock import patch

import app as website


def upstream_text(text):
    return ("data: " + json.dumps({"choices": [{"delta": {"content": text}}]}, ensure_ascii=False)
            + "\n\n").encode("utf-8")


def parsed_events(body):
    if isinstance(body, bytes):
        body = body.decode("utf-8")
    return [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]


class PausedStream:
    """在指定 SSE 数据之后等待测试放行，模拟慢模型而不需要真实联网。"""

    def __init__(self, before=b"", after=None):
        self.before = before
        self.after = after if after is not None else upstream_text("完整回应") + b"data: [DONE]\n\n"
        self.waiting = Event()
        self.release = Event()
        self.closed = Event()

    def __iter__(self):
        yield from io.BytesIO(self.before)
        self.waiting.set()
        if not self.release.wait(3):
            raise TimeoutError("test did not release fake model")
        yield from io.BytesIO(self.after)

    def close(self):
        self.closed.set()


class StreamHeartbeatTests(unittest.TestCase):
    conversation_id = "a" * 32
    request_id = "d77e039f-e165-407b-b521-33c203cb8acb"
    provider = {"baseUrl": "https://relay.example/v1", "apiKey": "private-test-key", "model": "fake-model"}

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        website.app.config.update(TESTING=True, DATABASE=os.path.join(self.directory.name, "test.db"))
        website.initialize_database()
        website.CONVERSATIONS.clear()
        website.CONVERSATIONS[self.conversation_id] = {
            "messages": [{"role": "system", "content": website.SYSTEM_PROMPT}],
            "rounds": 0, "busy": False, "updated_at": time.time(),
        }
        self.client = website.app.test_client()
        self.payload = {
            "conversationId": self.conversation_id, "message": "我想知道下一步怎么办",
            "provider": self.provider, "requestId": self.request_id,
        }
        heartbeat = patch.object(website, "SSE_HEARTBEAT_SECONDS", 0.02)
        heartbeat.start()
        self.addCleanup(heartbeat.stop)

    def assert_completed_once(self, body):
        events = parsed_events(body)
        self.assertEqual(events[-1], {"done": True, "rounds": 1, "closed": False})
        session = website.CONVERSATIONS[self.conversation_id]
        self.assertEqual(session["rounds"], 1)
        self.assertEqual(len(session["messages"]), 3)
        self.assertFalse(session["busy"])

    def test_response_and_heartbeats_arrive_while_upstream_connection_is_still_opening(self):
        opening = Event()
        release = Event()
        stream = io.BytesIO(upstream_text("完整回应") + b"data: [DONE]\n\n")

        def delayed_open(_messages, _provider):
            opening.set()
            if not release.wait(3):
                raise TimeoutError("fake connection was not released")
            return stream

        with patch.object(website, "open_chat_stream", side_effect=delayed_open) as upstream:
            try:
                started = time.monotonic()
                response = self.client.post("/api/follow-up", json=self.payload, buffered=False)
                self.assertLess(time.monotonic() - started, 0.75)
                self.assertTrue(opening.wait(0.75))
                iterator = iter(response.response)
                self.assertEqual(next(iterator), b": keep-alive\n\n")
                self.assertEqual(next(iterator), b": keep-alive\n\n")
                self.assertEqual(website.CONVERSATIONS[self.conversation_id]["rounds"], 0)
                release.set()
                self.assert_completed_once(b"".join(iterator))
                upstream.assert_called_once()
                self.assertTrue(stream.closed)
            finally:
                release.set()
                if "response" in locals():
                    response.close()

    def test_slow_first_text_still_sends_heartbeats_and_only_then_commits(self):
        stream = PausedStream()
        with patch.object(website, "open_chat_stream", return_value=stream):
            try:
                response = self.client.post("/api/follow-up", json=self.payload, buffered=False)
                iterator = iter(response.response)
                self.assertEqual(next(iterator), b": keep-alive\n\n")
                self.assertTrue(stream.waiting.wait(0.75))
                self.assertEqual(next(iterator), b": keep-alive\n\n")
                self.assertEqual(website.CONVERSATIONS[self.conversation_id]["rounds"], 0)
                stream.release.set()
                self.assert_completed_once(b"".join(iterator))
                self.assertTrue(stream.closed.wait(0.75))
            finally:
                stream.release.set()
                if "response" in locals():
                    response.close()

    def test_wait_between_text_chunks_has_heartbeats_without_repeating_text(self):
        stream = PausedStream(before=upstream_text("前半句"), after=upstream_text("后半句") + b"data: [DONE]\n\n")
        with patch.object(website, "open_chat_stream", return_value=stream):
            try:
                response = self.client.post("/api/follow-up", json=self.payload, buffered=False)
                iterator = iter(response.response)
                first = next(iterator)
                self.assertEqual(first, b": keep-alive\n\n")
                content = next(iterator)
                self.assertEqual(parsed_events(content), [{"content": "前半句"}])
                self.assertTrue(stream.waiting.wait(0.75))
                self.assertEqual(next(iterator), b": keep-alive\n\n")
                stream.release.set()
                body = content + b"".join(iterator)
                self.assert_completed_once(body)
                self.assertEqual("".join(e.get("content", "") for e in parsed_events(body)), "前半句后半句")
            finally:
                stream.release.set()
                if "response" in locals():
                    response.close()

    def test_client_cancel_during_slow_open_releases_busy_and_does_not_commit_background_work(self):
        opening = Event()
        release = Event()
        stream = PausedStream()
        original = copy.deepcopy(website.CONVERSATIONS[self.conversation_id]["messages"])

        def delayed_open(_messages, _provider):
            opening.set()
            release.wait(3)
            return stream

        with patch.object(website, "open_chat_stream", side_effect=delayed_open) as upstream:
            try:
                response = self.client.post("/api/follow-up", json=self.payload, buffered=False)
                self.assertTrue(opening.wait(0.75))
                response.close()
                session = website.CONVERSATIONS[self.conversation_id]
                self.assertFalse(session["busy"])
                self.assertEqual(session["rounds"], 0)
                self.assertEqual(session["messages"], original)
                release.set()
                self.assertTrue(stream.closed.wait(0.75))
                self.assertEqual(session["messages"], original)
                upstream.assert_called_once()
            finally:
                release.set()
                stream.release.set()

    def test_client_cancel_after_partial_text_does_not_save_or_replay_the_partial_answer(self):
        stream = PausedStream(before=upstream_text("只有半截"))
        original = copy.deepcopy(website.CONVERSATIONS[self.conversation_id]["messages"])
        with patch.object(website, "open_chat_stream", return_value=stream):
            try:
                response = self.client.post("/api/follow-up", json=self.payload, buffered=False)
                iterator = iter(response.response)
                next(iterator)
                self.assertEqual(parsed_events(next(iterator)), [{"content": "只有半截"}])
                self.assertTrue(stream.waiting.wait(0.75))
                response.close()
                stream.release.set()
                self.assertTrue(stream.closed.wait(0.75))
                session = website.CONVERSATIONS[self.conversation_id]
                self.assertFalse(session["busy"])
                self.assertEqual(session["rounds"], 0)
                self.assertEqual(session["messages"], original)
                self.assertNotIn("last_completed_request", session)
            finally:
                stream.release.set()

    def test_client_cancel_is_seen_on_upstream_comment_even_without_visible_text(self):
        class CommentStream(PausedStream):
            def __iter__(self):
                self.waiting.set()
                self.release.wait(3)
                yield b": OPENROUTER PROCESSING\n"
                # If cancellation is only checked on visible text, this wait keeps the worker alive.
                self.reached_second_wait = True
                self.finish.wait(3)
                yield b"data: [DONE]\n\n"

        stream = CommentStream()
        stream.finish = Event()
        stream.reached_second_wait = False
        with patch.object(website, "open_chat_stream", return_value=stream):
            try:
                response = self.client.post("/api/follow-up", json=self.payload, buffered=False)
                self.assertTrue(stream.waiting.wait(0.75))
                response.close()
                stream.release.set()
                self.assertTrue(stream.closed.wait(0.75))
                self.assertFalse(stream.reached_second_wait)
                session = website.CONVERSATIONS[self.conversation_id]
                self.assertFalse(session["busy"])
                self.assertEqual(session["rounds"], 0)
            finally:
                stream.release.set()
                stream.finish.set()

    def test_hidden_summary_waiting_for_completion_keeps_sending_heartbeats(self):
        stream = PausedStream(
            before=upstream_text("完整回应【总结】隐藏内容"), after=b"data: [DONE]\n\n",
        )
        with patch.object(website, "open_chat_stream", return_value=stream):
            try:
                response = self.client.post("/api/follow-up", json=self.payload, buffered=False)
                iterator = iter(response.response)
                next(iterator)
                content = next(iterator)
                self.assertEqual(parsed_events(content), [{"content": "完整回应"}])
                self.assertTrue(stream.waiting.wait(0.75))
                self.assertEqual(next(iterator), b": keep-alive\n\n")
                stream.release.set()
                self.assert_completed_once(content + b"".join(iterator))
            finally:
                stream.release.set()
                if "response" in locals():
                    response.close()

    def test_completed_request_is_replayed_without_calling_model_or_using_another_round(self):
        stream = io.BytesIO(upstream_text("完整回应") + b"data: [DONE]\n\n")
        with patch.object(website, "open_chat_stream", return_value=stream) as upstream:
            first = self.client.post("/api/follow-up", json=self.payload, buffered=True)
            snapshot = copy.deepcopy(website.CONVERSATIONS[self.conversation_id])
            retry = self.client.post("/api/follow-up", json=self.payload, buffered=True)
        self.assert_completed_once(first.data)
        self.assert_completed_once(retry.data)
        self.assertEqual(parsed_events(first.data), parsed_events(retry.data))
        self.assertEqual(website.CONVERSATIONS[self.conversation_id]["messages"], snapshot["messages"])
        upstream.assert_called_once()

    def test_same_request_id_with_different_content_info_or_provider_is_rejected(self):
        stream = io.BytesIO(upstream_text("完整回应") + b"data: [DONE]\n\n")
        with patch.object(website, "open_chat_stream", return_value=stream):
            self.client.post("/api/follow-up", json=self.payload, buffered=True)
        changed = (
            {"message": "一个新问题"}, {"userInfo": {"enabled": False}},
            {"provider": {**self.provider, "model": "another-model"}},
        )
        for values in changed:
            with self.subTest(values=values), patch.object(website, "open_chat_stream") as upstream:
                response = self.client.post("/api/follow-up", json={**self.payload, **values}, buffered=True)
                self.assertEqual(response.status_code, 409)
                self.assertIn("内容已改变", response.json["error"])
                upstream.assert_not_called()
        self.assertEqual(website.CONVERSATIONS[self.conversation_id]["rounds"], 1)

    def test_incomplete_stream_has_no_cached_success_and_same_id_can_retry(self):
        first = io.BytesIO(upstream_text("只有半截"))
        retry = io.BytesIO(upstream_text("完整回应") + b"data: [DONE]\n\n")
        with patch.object(website, "open_chat_stream", side_effect=[first, retry]) as upstream:
            failed = self.client.post("/api/follow-up", json=self.payload, buffered=True)
            session = website.CONVERSATIONS[self.conversation_id]
            self.assertTrue(parsed_events(failed.data)[-1].get("error"))
            self.assertEqual(session["rounds"], 0)
            self.assertNotIn("last_completed_request", session)
            succeeded = self.client.post("/api/follow-up", json=self.payload, buffered=True)
        self.assert_completed_once(succeeded.data)
        self.assertEqual(upstream.call_count, 2)

    def test_success_committed_but_final_browser_frame_discarded_does_not_use_another_round(self):
        stream = io.BytesIO(upstream_text("完整回应") + b"data: [DONE]\n\n")
        with patch.object(website, "open_chat_stream", return_value=stream) as upstream:
            first = self.client.post("/api/follow-up", json=self.payload, buffered=False)
            iterator = iter(first.response)
            next(iterator)  # Initial keep-alive.
            self.assertEqual(parsed_events(next(iterator)), [{"content": "完整回应"}])
            next(iterator)  # Server committed and sent done; simulate browser losing this frame.
            first.close()
            retry = self.client.post("/api/follow-up", json=self.payload, buffered=True)
        self.assert_completed_once(retry.data)
        upstream.assert_called_once()

    def test_progress_and_error_logs_do_not_contain_question_prompt_or_provider_key(self):
        stream = io.BytesIO(upstream_text("不应该被记录的模型回答") + b"data: [DONE]\n\n")
        with self.assertLogs(website.app.logger, level="INFO") as logs, \
                patch.object(website, "open_chat_stream", return_value=stream):
            self.client.post("/api/follow-up", json=self.payload, buffered=True)
        output = "\n".join(logs.output)
        self.assertIn("phase=opening", output)
        self.assertIn("phase=first_text", output)
        self.assertIn("phase=completed rounds=1", output)
        self.assertNotIn(self.payload["message"], output)
        self.assertNotIn(self.provider["apiKey"], output)
        self.assertNotIn("不应该被记录的模型回答", output)
        self.assertNotIn(website.SYSTEM_PROMPT, output)

    def test_eighth_round_retry_can_replay_even_after_conversation_is_closed(self):
        website.CONVERSATIONS[self.conversation_id]["rounds"] = 7
        stream = io.BytesIO(upstream_text("收牌结束") + b"data: [DONE]\n\n")
        with patch.object(website, "open_chat_stream", return_value=stream) as upstream:
            first = self.client.post("/api/follow-up", json=self.payload, buffered=True)
            retry = self.client.post("/api/follow-up", json=self.payload, buffered=True)
        self.assertEqual(parsed_events(first.data)[-1], {"done": True, "rounds": 8, "closed": True})
        self.assertEqual(parsed_events(retry.data)[-1], {"done": True, "rounds": 8, "closed": True})
        self.assertEqual(website.CONVERSATIONS[self.conversation_id]["rounds"], 8)
        upstream.assert_called_once()

    def test_request_id_validation_does_not_open_model_or_mark_session_busy(self):
        for value in ("short", "../" + "a" * 32, "a" * 65, 123):
            with self.subTest(value=value), patch.object(website, "open_chat_stream") as upstream:
                response = self.client.post("/api/follow-up", json={**self.payload, "requestId": value})
                self.assertEqual(response.status_code, 400)
                self.assertFalse(website.CONVERSATIONS[self.conversation_id]["busy"])
                upstream.assert_not_called()

    def test_slow_reading_sends_conversation_id_and_heartbeat_before_first_text(self):
        stream = PausedStream(after=upstream_text("完整解读") + b"data: [DONE]\n\n")
        payload = {
            "question": "我想知道下一步怎么办", "spread": 1, "provider": self.provider,
            "cards": [{"id": "fool", "name": "愚者", "reversed": False}],
        }
        with patch.object(website, "open_chat_stream", return_value=stream):
            try:
                response = self.client.post("/api/reading", json=payload, buffered=False)
                iterator = iter(response.response)
                conversation_id = parsed_events(next(iterator))[0]["conversationId"]
                self.assertEqual(next(iterator), b": keep-alive\n\n")
                self.assertTrue(stream.waiting.wait(0.75))
                self.assertEqual(next(iterator), b": keep-alive\n\n")
                self.assertNotIn(conversation_id, website.CONVERSATIONS)
                stream.release.set()
                events = parsed_events(b"".join(iterator))
                self.assertTrue(events[-1]["done"])
                self.assertEqual(website.CONVERSATIONS[conversation_id]["rounds"], 0)
            finally:
                stream.release.set()
                if "response" in locals():
                    response.close()


if __name__ == "__main__":
    unittest.main()
