#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "garminconnect>=0.3.15,<0.4",
# ]
# ///
"""
Local Garmin Connect token helper.

This script uses the `garminconnect` Python library to perform an interactive
login, handle MFA, and upload DI tokens to a self-hosted bridge. Printing the
sensitive payload requires the explicit --print-tokens option.

IMPORTANT: garminconnect 0.3.x uses Garmin's DI (Device Intelligence) token
flow. The payload contains di_token / di_refresh_token / di_client_id, not
OAuth1/OAuth2 tokens.

Requirements:
    pip install -r requirements-garmin.txt

Usage:
    uv run https://raw.githubusercontent.com/markuspaschi/endurance-training-bridge/main/scripts/garmin-mcp-tokens.py --upload-url https://your-api.example.com/auth/garmin/tokens
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import venv
import getpass
import argparse
import urllib.error
import urllib.parse
import urllib.request


def prompt(text: str) -> str:
    return input(text).strip()


def prompt_mfa() -> str:
    print("\nGarmin Connect MFA required.")
    print("Check your email / authenticator app for the code.")
    return getpass.getpass("MFA code: ").strip()


class MfaPrompt:
    """Stateful MFA prompt so we can ask once and return the code."""

    def __init__(self):
        self._code = None

    def __call__(self) -> str:
        if self._code is not None:
            return self._code
        self._code = prompt_mfa()
        return self._code


def extract_di_tokens(client) -> dict:
    """
    Extract DI tokens from the garminconnect client.
    The wrapper object and the inner client object are checked.
    """
    targets = [client, getattr(client, "client", None)]

    di_token = None
    di_refresh_token = None
    di_client_id = None

    for target in targets:
        if target is None:
            continue
        di_token = di_token or getattr(target, "di_token", None)
        di_refresh_token = di_refresh_token or getattr(target, "di_refresh_token", None)
        di_client_id = di_client_id or getattr(target, "di_client_id", None)

    if not di_token:
        raise RuntimeError(
            "Could not extract DI token from the garminconnect client.\n"
            f"Wrapper attributes: {[a for a in dir(client) if not a.startswith('_')]}\n"
            f"Inner attributes: {[a for a in dir(getattr(client, 'client', client)) if not a.startswith('_')] if hasattr(client, 'client') else 'N/A'}"
        )

    return {
        "di_token": di_token,
        "di_refresh_token": di_refresh_token,
        "di_client_id": di_client_id,
    }


def run_with_temporary_dependency() -> int:
    """Run this helper in a disposable venv when garminconnect is unavailable."""
    if os.environ.get("ENDURANCE_HELPER_BOOTSTRAPPED") == "1":
        print("Error: the temporary Garmin connector environment could not be loaded.")
        return 1

    print("Preparing a temporary Garmin connector (nothing is installed globally)...")
    with tempfile.TemporaryDirectory(prefix="endurance_bridge_") as environment_dir:
        venv.EnvBuilder(with_pip=True, clear=True).create(environment_dir)
        python = os.path.join(
            environment_dir,
            "Scripts" if os.name == "nt" else "bin",
            "python.exe" if os.name == "nt" else "python",
        )
        subprocess.run(
            [
                python,
                "-m",
                "pip",
                "install",
                "--quiet",
                "--disable-pip-version-check",
                "--index-url",
                "https://pypi.org/simple",
                "garminconnect>=0.3.15,<0.4",
            ],
            check=True,
        )
        environment = os.environ.copy()
        environment["ENDURANCE_HELPER_BOOTSTRAPPED"] = "1"
        completed = subprocess.run([python, os.path.abspath(__file__), *sys.argv[1:]], env=environment)
        return completed.returncode


def upload_tokens(url: str, payload: dict, api_key: str) -> dict:
    """Upload tokens directly without printing them to the terminal."""
    parsed = urllib.parse.urlparse(url)
    is_local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}
    if parsed.scheme != "https" and not is_local_http:
        raise RuntimeError("Upload URL must use HTTPS (HTTP is allowed only for localhost).")

    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Token upload failed ({error.code}): {body}") from error


def main():
    parser = argparse.ArgumentParser(description="Authenticate with Garmin and export DI tokens.")
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument(
        "--upload-url",
        help="POST the token payload directly to this URL instead of printing it",
    )
    output.add_argument(
        "--print-tokens",
        action="store_true",
        help="print the sensitive token payload for manual self-hosted setup",
    )
    parser.add_argument(
        "--athlete-id",
        help="fallback identifier when the Garmin profile does not include one",
    )
    args = parser.parse_args()

    try:
        from garminconnect import Garmin
    except ImportError:
        try:
            sys.exit(run_with_temporary_dependency())
        except (OSError, subprocess.SubprocessError) as error:
            print(f"Error: could not prepare the temporary connector: {error}")
            sys.exit(1)

    print("Garmin Connect DI token helper")
    print("-" * 40)
    print("Unofficial connector: use only with an account you own and at your own risk.\n")

    access_key = None
    if args.upload_url:
        access_key = os.environ.get("GARMIN_ACCESS_KEY") or getpass.getpass(
            "Private connection key from the website (leave blank to create one): "
        )
        if not access_key:
            access_key = f"etb_{secrets.token_urlsafe(32)}"
        if len(access_key.encode("utf-8")) < 32:
            raise RuntimeError("The private connection key must be at least 32 bytes.")

    email = prompt("Email: ")
    password = getpass.getpass("Password: ")

    if not email or not password:
        print("Email and password are required.")
        sys.exit(1)

    # Temp directory for any token dump the library might write
    token_dir = tempfile.mkdtemp(prefix="garmin_tokens_")

    try:
        print("\nAuthenticating with Garmin Connect...")
        mfa_handler = MfaPrompt()
        client = Garmin(email=email, password=password, prompt_mfa=mfa_handler)
        client.login()

        print("Login successful. Extracting DI tokens...")

        # Try the library's dump first; if it fails, read attributes directly.
        try:
            inner = getattr(client, "client", client)
            if hasattr(inner, "dump"):
                inner.dump(token_dir)
        except Exception as e:
            print(f"Note: library dump failed ({e}), reading tokens directly.")

        di_tokens = extract_di_tokens(client)

        # Fetch profile so we can suggest a stable athlete id
        try:
            profile = client.get_user_profile()
            profile_id = profile.get("id") or profile.get("userProfileId") or args.athlete_id
            if not profile_id:
                raise RuntimeError("Garmin profile did not include an athlete ID")
            athlete_id = str(profile_id)
            athlete_name = profile.get("displayName") or profile.get("fullName") or "Garmin athlete"
        except Exception as e:
            if not args.athlete_id:
                raise RuntimeError(
                    "Could not determine the Garmin athlete ID. Retry with --athlete-id."
                ) from e
            athlete_id = args.athlete_id
            athlete_name = "Garmin athlete"

        payload = {
            "athleteId": athlete_id,
            "athleteName": athlete_name,
            "tokens": di_tokens,
        }

        if args.upload_url:
            result = upload_tokens(args.upload_url, payload, access_key)
            print(f"\nTokens uploaded successfully for athlete {result.get('athleteId', athlete_id)}.")
            print("Pairing complete. The website can now find your athlete from the private key.")
            print("Save these values in a password manager for recovery:")
            print(f"Athlete ID: {result.get('athleteId', athlete_id)}")
            print(f"Private connection key: {access_key}")
        else:
            print("\nWARNING: the following values grant access to your Garmin account data.")
            print("Do not paste them into an issue, chat, commit, or untrusted website.")
            print("\n" + "=" * 60)
            print("Sensitive Garmin token payload:")
            print("=" * 60)
            print(json.dumps(payload, indent=2))

    finally:
        shutil.rmtree(token_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
