"""用临时账号检查头像保存、账号隔离与真实图片校验。"""

import base64
import io
import os
import sqlite3
import tempfile
import unittest

from PIL import Image
import app as website


def image_data(size=(256, 256), image_format="JPEG", metadata=False):
    output = io.BytesIO()
    image = Image.new("RGB", size, "#19213a")
    options = {}
    if metadata:
        exif = Image.Exif()
        exif[270] = "private-photo-description"
        options["exif"] = exif
    image.save(output, format=image_format, **options)
    raw = output.getvalue() + (b"PRIVATE_TRAILING_METADATA" if metadata else b"")
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")


class AvatarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = "disposable-avatar-password"
        cls.password_hash = website.bcrypt.generate_password_hash(cls.password).decode("utf-8")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        old_config = {key: website.app.config.get(key) for key in ("DATABASE", "TESTING", "SESSION_COOKIE_SECURE")}
        self.addCleanup(lambda: website.app.config.update(old_config))
        website.app.config.update(TESTING=True, DATABASE=os.path.join(self.directory.name, "avatar.db"), SESSION_COOKIE_SECURE=False)
        website.initialize_database()
        with website.database_connection() as connection:
            for nickname in ("first", "second"):
                connection.execute("INSERT INTO users (email, nickname, password_hash) VALUES (?, ?, ?)", (f"{nickname}@example.test", nickname, self.password_hash))
            self.first, self.second = [row["id"] for row in connection.execute("SELECT id FROM users ORDER BY id")]
        self.client = website.app.test_client()
        with self.client.session_transaction() as session:
            session["user_id"] = self.first

    def upload(self, avatar, **extra):
        return self.client.put("/api/avatar", json={"avatar": avatar, "userId": self.first, **extra})

    def test_avatar_persists_after_login(self):
        response = self.upload(image_data())
        self.assertEqual(response.status_code, 200)
        saved = response.get_json()["avatar"]
        self.assertEqual(self.client.get("/api/me").get_json()["user"]["avatar"], saved)
        self.client.post("/api/logout")
        response = self.client.post("/api/login", json={"email": "first@example.test", "password": self.password})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["user"]["avatar"], saved)

    def test_real_jpeg_has_no_photo_metadata(self):
        response = self.upload(image_data(metadata=True))
        self.assertEqual(response.status_code, 200)
        raw = base64.b64decode(response.get_json()["avatar"].split(",", 1)[1])
        self.assertNotIn(b"private-photo-description", raw)
        self.assertNotIn(b"PRIVATE_TRAILING_METADATA", raw)
        with Image.open(io.BytesIO(raw)) as image:
            self.assertEqual(image.size, (256, 256))
            self.assertEqual(image.format, "JPEG")
            self.assertFalse(image.getexif())

    def test_upload_only_changes_current_account_avatar(self):
        before = self.client.get("/api/account-data").get_json()
        self.assertEqual(self.upload(image_data(), user_id=self.second).status_code, 200)
        with website.database_connection() as connection:
            self.assertTrue(connection.execute("SELECT avatar FROM users WHERE id = ?", (self.first,)).fetchone()["avatar"])
            self.assertEqual(connection.execute("SELECT avatar FROM users WHERE id = ?", (self.second,)).fetchone()["avatar"], "")
        self.assertEqual(self.client.get("/api/account-data").get_json(), before)

    def test_stale_account_upload_is_rejected(self):
        with self.client.session_transaction() as session:
            session["user_id"] = self.second
        self.assertEqual(self.upload(image_data()).status_code, 409)
        self.assertEqual(self.client.get("/api/me").get_json()["user"]["avatar"], "")

    def test_anonymous_and_foreign_page_cannot_upload(self):
        anonymous = website.app.test_client()
        self.assertEqual(anonymous.put("/api/avatar", json={"avatar": image_data()}).status_code, 401)
        response = self.client.put("/api/avatar", json={"avatar": image_data()}, headers={"Origin": "https://foreign.example"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get("/api/me").get_json()["user"]["avatar"], "")

    def test_forged_svg_wrong_format_and_wrong_size_are_rejected(self):
        svg = "data:image/jpeg;base64," + base64.b64encode(b'<svg onload="alert(1)"></svg>').decode("ascii")
        for avatar in (svg, image_data(image_format="PNG"), image_data(size=(512, 256))):
            with self.subTest(avatar=avatar[:30]):
                self.assertEqual(self.upload(avatar).status_code, 400)
        self.assertEqual(self.client.get("/api/me").get_json()["user"]["avatar"], "")

    def test_invalid_payload_and_base64_are_rejected(self):
        for avatar in (None, 42, {}, "data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64,not-valid!", "data:image/jpeg;base64,"):
            with self.subTest(avatar=avatar):
                self.assertEqual(self.upload(avatar).status_code, 400)
        for payload in (None, [], "avatar"):
            self.assertEqual(self.client.put("/api/avatar", json=payload).status_code, 400)

    def test_image_and_request_size_limits(self):
        oversized = "data:image/jpeg;base64," + base64.b64encode(b"x" * (website.MAX_AVATAR_BYTES + 1)).decode("ascii")
        self.assertEqual(self.upload(oversized).status_code, 400)
        response = self.client.put("/api/avatar", data=b" " * (website.MAX_AVATAR_REQUEST_BYTES + 1), content_type="application/json")
        self.assertEqual(response.status_code, 413)

    def test_clear_restores_default_avatar(self):
        self.assertEqual(self.upload(image_data()).status_code, 200)
        self.assertEqual(self.upload("").status_code, 200)
        self.assertEqual(self.client.get("/api/me").get_json()["user"]["avatar"], "")

    def test_old_database_migration_keeps_data_and_can_repeat(self):
        old_database = os.path.join(self.directory.name, "old.db")
        with sqlite3.connect(old_database) as connection:
            connection.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)")
            connection.execute("INSERT INTO users (email, nickname, password_hash) VALUES ('old@example.test', 'old nickname', ?)", (self.password_hash,))
        website.app.config["DATABASE"] = old_database
        website.initialize_database()
        website.initialize_database()
        with website.database_connection() as connection:
            user = connection.execute("SELECT * FROM users").fetchone()
            self.assertEqual(user["nickname"], "old nickname")
            self.assertEqual(user["password_hash"], self.password_hash)
            self.assertEqual(user["avatar"], "")


if __name__ == "__main__":
    unittest.main()
