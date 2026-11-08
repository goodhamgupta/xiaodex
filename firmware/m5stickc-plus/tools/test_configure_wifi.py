#!/usr/bin/env python3
"""Offline tests for USB Wi-Fi/bridge provisioning command construction."""

import contextlib
import io
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import configure_wifi


TOKEN = "bridge-token-1234567890"


class CommandTests(unittest.TestCase):
    def test_bridge_only_excludes_wifi_credentials_and_does_not_prompt(self):
        args = configure_wifi.parse_args(
            [
                "--port",
                "/dev/cu.usbserial-M5",
                "--bridge-only",
                "--host",
                "192.168.1.20",
                "--bridge-port",
                "9000",
            ]
        )
        environment = {
            "CODEX_BUDDY_TOKEN": TOKEN,
            # These deliberately invalid values must be ignored in this mode.
            "CODEX_BUDDY_WIFI_SSID": "x" * 33,
            "CODEX_BUDDY_WIFI_PASSWORD": "x" * 65,
        }
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(
            configure_wifi.getpass,
            "getpass",
            side_effect=AssertionError("bridge-only provisioning prompted for Wi-Fi"),
        ):
            command, expected = configure_wifi.build_command(args)

        self.assertEqual(expected, "bridge_config")
        self.assertEqual(
            command,
            {
                "cmd": "bridge_config",
                "host": "192.168.1.20",
                "port": 9000,
                "token": TOKEN,
            },
        )
        self.assertNotIn("ssid", command)
        self.assertNotIn("password", command)

    def test_full_provisioning_still_includes_wifi_credentials(self):
        args = configure_wifi.parse_args(
            [
                "--port",
                "/dev/cu.usbserial-M5",
                "--ssid",
                "Test-Network",
                "--host",
                "192.168.1.20",
            ]
        )
        with mock.patch.dict(
            os.environ,
            {
                "CODEX_BUDDY_TOKEN": TOKEN,
                "CODEX_BUDDY_WIFI_PASSWORD": "wifi-secret",
            },
            clear=True,
        ):
            command, expected = configure_wifi.build_command(args)

        self.assertEqual(expected, "wifi_config")
        self.assertEqual(command["ssid"], "Test-Network")
        self.assertEqual(command["password"], "wifi-secret")
        self.assertEqual(command["host"], "192.168.1.20")
        self.assertEqual(command["token"], TOKEN)

    def test_forget_needs_no_environment_configuration(self):
        args = configure_wifi.parse_args(
            ["--port", "/dev/cu.usbserial-M5", "--forget"]
        )
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                configure_wifi.build_command(args),
                ({"cmd": "wifi_forget"}, "wifi_forget"),
            )

    def test_bridge_only_validates_endpoint_port_and_token(self):
        args = configure_wifi.parse_args(
            [
                "--port",
                "/dev/cu.usbserial-M5",
                "--bridge-only",
                "--host",
                "192.168.1.20",
                "--bridge-port",
                "0",
            ]
        )
        with mock.patch.dict(os.environ, {"CODEX_BUDDY_TOKEN": TOKEN}, clear=True):
            with self.assertRaisesRegex(SystemExit, "between 1 and 65535"):
                configure_wifi.build_command(args)

        args.bridge_port = 8787
        with mock.patch.dict(os.environ, {"CODEX_BUDDY_TOKEN": "too-short"}, clear=True):
            with self.assertRaisesRegex(SystemExit, "16-96 character"):
                configure_wifi.build_command(args)

    def test_forget_and_bridge_only_are_mutually_exclusive(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                configure_wifi.parse_args(
                    [
                        "--port",
                        "/dev/cu.usbserial-M5",
                        "--forget",
                        "--bridge-only",
                    ]
                )


if __name__ == "__main__":
    unittest.main()
