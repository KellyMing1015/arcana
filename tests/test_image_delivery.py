"""Verify the pictures delivered to phones, without changing the original assets."""

from io import BytesIO
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
import app as website


class ImageDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.client = website.app.test_client()
        website.resized_image.cache_clear()

    def test_all_78_mobile_card_images_decode_and_reduce_total_download(self):
        paths = sorted((website.ROOT / "assets" / "cards").glob("*.webp"))
        self.assertEqual(len(paths), 78)
        original_bytes = 0
        mobile_bytes = 0
        for path in paths:
            with self.subTest(card=path.name):
                with Image.open(path) as original:
                    expected_height = round(original.height * 480 / original.width)
                with self.client.get(f"/assets/cards/{path.name}?v=20261006-images&w=480") as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.mimetype, "image/webp")
                    with Image.open(BytesIO(response.data)) as mobile:
                        mobile.load()
                        self.assertEqual(mobile.size, (480, expected_height))
                    original_bytes += path.stat().st_size
                    mobile_bytes += len(response.data)
        self.assertLess(mobile_bytes, original_bytes * 0.6)

    def test_fixed_card_widths_preserve_ratio_and_original_size(self):
        path = website.ROOT / "assets" / "cards" / "fool.webp"
        original_bytes = path.read_bytes()
        with Image.open(path) as original:
            original_size = original.size
        for width in (320, 480, 640, 960):
            with self.subTest(width=width):
                with self.client.get(f"/assets/cards/fool.webp?w={width}") as response:
                    self.assertEqual(response.status_code, 200)
                    with Image.open(BytesIO(response.data)) as delivered:
                        delivered.load()
                        self.assertEqual(delivered.size, (width, round(original_size[1] * width / original_size[0])))
                    if width == original_size[0]:
                        self.assertEqual(response.data, original_bytes)
        with self.client.get("/assets/cards/fool.webp?v=2") as original:
            self.assertEqual(original.data, original_bytes)

    def test_card_back_is_smaller_and_starfield_is_unchanged(self):
        path = website.ROOT / "assets" / "ui" / "card-back-engraved.webp"
        with self.client.get("/assets/ui/card-back-engraved.webp?v=20261006-images&w=480") as response:
            self.assertEqual(response.status_code, 200)
            self.assertLess(len(response.data), path.stat().st_size * 0.5)
            with Image.open(BytesIO(response.data)) as delivered:
                delivered.load()
                self.assertEqual(delivered.size, (480, 720))
        starfield = website.ROOT / "assets" / "ui" / "starfield-night-sparse.webp"
        with self.client.get("/assets/ui/starfield-night-sparse.webp?v=20261006-images") as response:
            self.assertEqual(response.data, starfield.read_bytes())
        with self.client.get("/assets/ui/starfield-night-sparse.webp?w=480") as response:
            self.assertEqual(response.status_code, 400)

    def test_get_head_and_conditional_cache_agree(self):
        path = "/assets/cards/fool.webp?v=20261006-images&w=480"
        with patch.object(website.Image, "open", wraps=Image.open) as decode:
            with self.client.get(path) as response:
                self.assertEqual(response.status_code, 200)
                headers = dict(response.headers)
                data = response.data
            with self.client.head(path) as response:
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data, b"")
                self.assertEqual(int(response.headers["Content-Length"]), len(data))
                self.assertEqual(response.headers["ETag"], headers["ETag"])
            with self.client.get(path, headers={"If-None-Match": headers["ETag"]}) as response:
                self.assertEqual(response.status_code, 304)
                self.assertEqual(response.data, b"")
                self.assertIn("immutable", response.headers["Cache-Control"])
            with self.client.get(path, headers={"If-Modified-Since": headers["Last-Modified"]}) as response:
                self.assertEqual(response.status_code, 304)
            self.assertEqual(decode.call_count, 1)
        self.assertEqual(headers["Cache-Control"], "public, max-age=31536000, immutable")
        with self.client.get("/assets/cards/fool.webp?w=480") as response:
            self.assertNotIn("immutable", response.headers["Cache-Control"])

    def test_source_change_invalidates_variant_and_smaller_original_is_not_enlarged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "assets" / "cards"
            folder.mkdir(parents=True)
            path = folder / "fool.webp"
            Image.new("RGB", (640, 960), "#ff0000").save(path, format="WEBP")
            previous_time = path.stat().st_mtime_ns
            with patch.object(website, "ROOT", root):
                with self.client.get("/assets/cards/fool.webp?w=320") as response:
                    old_etag = response.headers["ETag"]
                    old_data = response.data
                Image.new("RGB", (640, 960), "#0000ff").save(path, format="WEBP")
                os.utime(path, ns=(previous_time + 2_000_000_000, previous_time + 2_000_000_000))
                with self.client.get("/assets/cards/fool.webp?w=320", headers={"If-None-Match": old_etag}) as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertNotEqual(response.headers["ETag"], old_etag)
                    self.assertNotEqual(response.data, old_data)
                with self.client.get("/assets/cards/fool.webp?w=960") as response:
                    self.assertEqual(response.data, path.read_bytes())
                    with Image.open(BytesIO(response.data)) as delivered:
                        self.assertEqual(delivered.size, (640, 960))

    def test_invalid_sizes_missing_images_and_private_files_are_rejected(self):
        for width in ("", "0", "1", "481", "9999999", "0320", "-320", "320.0", "abc"):
            with self.subTest(width=width):
                with self.client.get(f"/assets/cards/fool.webp?w={width}") as response:
                    self.assertEqual(response.status_code, 400)
        for path in (
            "/assets/cards/does-not-exist.webp?w=320", "/assets/cards/sources.json?w=320",
            "/assets/cards/../../arcana.db?w=320", "/assets/ui/../../.env?w=480",
            "/assets/ui/not-public.webp?w=480", "/arcana.db?w=320", "/.env?w=320",
        ):
            with self.subTest(path=path):
                with self.client.get(path) as response:
                    self.assertEqual(response.status_code, 404)
        with self.client.get("/assets/ui/card-back-engraved.webp?w=640") as response:
            self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
