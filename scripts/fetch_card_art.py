"""Download the 78 public-domain Geldard/RWS cards from Wikimedia Commons.

Requires only Python 3 and macOS's built-in sips. The 960px-wide Wikimedia
thumbnails are converted to quality-90 JPEGs for practical web delivery.
"""

import json
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "cards"
API = "https://commons.wikimedia.org/w/api.php"
SUFFIX = " (Rider-Waite Smith tarot deck).png"
USER_AGENT = "Arcana/1.0 (local tarot art project; Wikimedia Commons assets)"

MAJOR = {
    "fool": "The Fool", "magician": "The Magician",
    "priestess": "The High Priestess", "empress": "The Empress",
    "emperor": "The Emperor", "hierophant": "The Hierophant",
    "lovers": "The Lovers", "chariot": "The Chariot",
    "strength": "Strength", "hermit": "The Hermit",
    "wheel": "Wheel of Fortune", "justice": "Justice",
    "hanged": "The Hanged Man", "death": "Death",
    "temperance": "Temperance", "devil": "The Devil",
    "tower": "The Tower", "star": "The Star", "moon": "The Moon",
    "sun": "The Sun", "judgement": "Judgement", "world": "The World",
}
RANKS = (
    "Ace", "Two", "Three", "Four", "Five", "Six", "Seven",
    "Eight", "Nine", "Ten", "Page", "Knight", "Queen", "King",
)


def expected_cards():
    cards = dict(MAJOR)
    for suit in ("wands", "cups", "swords", "pentacles"):
        for rank, name in enumerate(RANKS, start=1):
            if rank == 1 and suit in ("swords", "pentacles"):
                name = "One"
            cards[f"{suit}-{rank}"] = f"{name} of {suit.title()}"
    assert len(cards) == 78
    return cards


def get_bytes(url):
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def image_info(titles):
    result = {}
    for offset in range(0, len(titles), 20):
        params = urllib.parse.urlencode({
            "action": "query", "titles": "|".join(titles[offset:offset + 20]),
            "prop": "imageinfo", "iiprop": "url|extmetadata",
            "iiurlwidth": 960, "format": "json", "formatversion": 2,
        })
        data = json.loads(get_bytes(f"{API}?{params}"))
        for page in data["query"]["pages"]:
            if "imageinfo" not in page:
                raise RuntimeError(f"Missing source image: {page['title']}")
            info = page["imageinfo"][0]
            license_name = info["extmetadata"]["LicenseShortName"]["value"]
            if license_name != "Public domain":
                raise RuntimeError(f"Unexpected license for {page['title']}: {license_name}")
            result[page["title"]] = info
    return result


def save_card(card_id, title, info):
    target = OUTPUT / f"{card_id}.jpg"
    if target.is_file() and target.stat().st_size > 100_000:
        return
    image = get_bytes(info["thumburl"])
    if not image.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError(f"Unexpected image data for {title}")
    with tempfile.TemporaryDirectory(prefix="arcana-card-") as temp:
        original = Path(temp) / "source.png"
        converted = Path(temp) / "card.jpg"
        original.write_bytes(image)
        subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "90",
             str(original), "--out", str(converted)],
            check=True, stdout=subprocess.DEVNULL,
        )
        if converted.stat().st_size < 100_000:
            raise RuntimeError(f"Converted image too small: {title}")
        converted.replace(target)


def main():
    cards = expected_cards()
    titles = {card_id: f"File:{name}{SUFFIX}" for card_id, name in cards.items()}
    info = image_info(list(titles.values()))
    if set(info) != set(titles.values()):
        raise RuntimeError("Wikimedia did not return all 78 expected cards")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            pool.submit(save_card, card_id, title, info[title]): card_id
            for card_id, title in titles.items()
        }
        for number, future in enumerate(as_completed(futures), start=1):
            future.result()
            print(f"{number}/78 {futures[future]}", flush=True)
    manifest = {
        card_id: {"file": f"{card_id}.jpg", "source": info[title]["descriptionurl"]}
        for card_id, title in titles.items()
    }
    (OUTPUT / "sources.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
