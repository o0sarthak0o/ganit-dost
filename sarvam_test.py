# One-off check that the Sarvam chat API works. Run: python3 sarvam_test.py
# Reads SARVAM_API_KEY from the environment, or from .env next to this file.
import os
from pathlib import Path

from sarvamai import SarvamAI

env_file = Path(__file__).with_name(".env")
if "SARVAM_API_KEY" not in os.environ and env_file.exists():
    for line in env_file.read_text().splitlines():
        name, sep, value = line.partition("=")
        if sep and name.strip() == "SARVAM_API_KEY":
            os.environ["SARVAM_API_KEY"] = value.strip().strip("\"'")

key = os.environ.get("SARVAM_API_KEY")
if not key:
    raise SystemExit("SARVAM_API_KEY is empty. Put your key in .env first.")

client = SarvamAI(api_subscription_key=key)
response = client.chat.completions(
    model="sarvam-105b-conversations",
    messages=[{"role": "user", "content": "7 और 8 का गुणा कितना होता है? एक वाक्य में बताइए।"}],
)
print(response.choices[0].message.content)
