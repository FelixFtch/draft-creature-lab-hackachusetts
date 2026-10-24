"""Provider presets, URL policy, key handling, payload quirks and health."""
import json
import unittest

from providers import (HttpTransport, OpenAICompatibleProvider, PRESETS, ProviderError, Secret, build_role,
                       message_content, normalise_base_url, read_key)
from tests.helpers import SECRET, FakeTransport, MockProvider, completion, provider, role

IMAGE_MESSAGES = [{"role": "system", "content": "Be brief."},
                  {"role": "user", "content": [{"type": "text", "text": "Answer in JSON"},
                                               {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}]
TEXT_MESSAGES = [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi, reply in JSON"}]


class PresetTests(unittest.TestCase):
    def test_presets_have_expected_endpoints(self):
        self.assertEqual(PRESETS["ollama"]["base_url"], "http://127.0.0.1:11434/v1")
        self.assertEqual(PRESETS["lmstudio"]["base_url"], "http://127.0.0.1:1234/v1")
        self.assertEqual(PRESETS["dashscope"]["base_url"], "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
        self.assertEqual(PRESETS["dashscope-cn"]["base_url"], "https://dashscope.aliyuncs.com/compatible-mode/v1")
        self.assertEqual(PRESETS["zhipu"]["base_url"], "https://api.z.ai/api/paas/v4")
        self.assertEqual(PRESETS["zhipu-cn"]["base_url"], "https://open.bigmodel.cn/api/paas/v4")
        self.assertEqual(PRESETS["gemini"]["base_url"], "https://generativelanguage.googleapis.com/v1beta/openai")
        self.assertEqual(PRESETS["openai"]["base_url"], "https://api.openai.com/v1")
        self.assertEqual(PRESETS["openrouter"]["base_url"], "https://openrouter.ai/api/v1")
        for name, preset in PRESETS.items():
            with self.subTest(name=name):
                for key in ("label", "key_env", "health", "params", "defaults"):
                    self.assertIn(key, preset)

    def test_default_models_per_role(self):
        env = {"DASHSCOPE_API_KEY": "sk-abcdefgh", "ZHIPUAI_API_KEY": "abcdefgh.ijkl", "GEMINI_API_KEY": "AIzaTestKey",
               "OPENAI_API_KEY": "sk-openai-test", "OPENROUTER_API_KEY": "sk-or-test-key"}
        expected = {"dashscope": ("qwen3.8-flash", "qwen3.8-flash"), "zhipu": ("glm-4.7-flash", "glm-4.6v-flash"),
                    "gemini": ("gemini-3.8-flash", "gemini-3.8-flash"), "openai": ("gpt-6-luna", "gpt-6-luna"),
                    "openrouter": ("qwen/qwen3.8-flash", "qwen/qwen3.8-flash")}
        for name, (brain, eyes) in expected.items():
            with self.subTest(name=name):
                self.assertEqual(build_role("brain", {"provider": name}, env, {}).model, brain)
                self.assertEqual(build_role("eyes", {"provider": name}, env, {}).model, eyes)
        with self.assertRaises(ValueError):
            build_role("brain", {"provider": "ollama"}, {}, {})  # local models are chosen by the setup script

    def test_workspace_domains_for_dashscope(self):
        cfg = build_role("brain", {"provider": "dashscope", "model": "qwen3.8-flash", "workspace_id": "ws-123"}, {}, {})
        self.assertEqual(cfg.base_url, "https://ws-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1")
        cfg = build_role("brain", {"provider": "dashscope-cn", "model": "qwen3.8-flash"}, {"DASHSCOPE_WORKSPACE_ID": "abc"}, {})
        self.assertEqual(cfg.base_url, "https://abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")
        with self.assertRaises(ValueError):
            build_role("brain", {"provider": "dashscope-us", "model": "qwen3.8-flash"}, {}, {})
        with self.assertRaises(ValueError):
            build_role("brain", {"provider": "dashscope", "model": "x", "workspace_id": "bad.domain/evil"}, {}, {})
        with self.assertRaises(ValueError):
            build_role("brain", {"provider": "zhipu", "model": "x", "workspace_id": "abc"}, {}, {})

    def test_base_url_policy(self):
        ok = [("ollama", "http://localhost:11500/v1"), ("ollama", "http://127.0.0.1:11434/v1/chat/completions"),
              ("custom", "https://gateway.example.com/v1"), ("custom", "http://[::1]:8080/v1"),
              ("dashscope", "https://my.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"),
              ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/")]
        for preset, url in ok:
            with self.subTest(url=url):
                self.assertFalse(normalise_base_url(url, preset).endswith("/"))
        bad = [("custom", "http://example.com/v1"), ("custom", "ftp://127.0.0.1/v1"),
               ("custom", "https://user:pass@example.com/v1"), ("custom", "https://example.com/v1?key=abc"),
               ("custom", "https://example.com/v1#frag"), ("ollama", "https://ollama.example.com/v1"),
               ("openai", "https://evil.example.com/v1"), ("dashscope", "https://aliyuncs.com.evil.net/v1"),
               ("gemini", "http://generativelanguage.googleapis.com/v1beta/openai"), ("custom", "https://exa mple.com/v1")]
        for preset, url in bad:
            with self.subTest(url=url), self.assertRaises(ValueError):
                normalise_base_url(url, preset)

    def test_role_validation(self):
        bad = [{"provider": "nope", "model": "m"}, {"provider": "custom", "model": "m"},
               {"provider": "ollama", "model": "has space"}, {"provider": "ollama", "model": "m", "api_key": "sk-123"},
               {"provider": "ollama", "model": "m", "api_key_env": "sk-not-an-env-name!"},
               {"provider": "ollama", "model": "m", "timeout_seconds": 0}, {"provider": "ollama", "model": "m", "max_tokens": 10},
               {"provider": "ollama", "model": "m", "temperature": 5}, {"provider": "ollama", "model": "m", "reasoning_effort": "ultra"},
               {"provider": "ollama", "model": "m", "extra_body": {"model": "other"}},
               {"provider": "ollama", "model": "m", "extra_body": {"messages": []}}]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                build_role("brain", raw, {}, {})


class KeyTests(unittest.TestCase):
    def test_key_sources_and_format(self):
        key, error, name = read_key(["A", "B"], {"B": SECRET}, {})
        self.assertEqual((key.reveal(), error, name), (SECRET, None, "B"))
        key, error, _ = read_key(["A"], {}, {"A": SECRET})
        self.assertEqual(key.reveal(), SECRET)
        key, error, _ = read_key(["A"], {"A": "has spaces in it"}, {})
        self.assertIsNone(key); self.assertEqual(error, "invalid_api_key_format")
        key, error, _ = read_key(["A"], {"A": "line1\r\nInjected: x"}, {})
        self.assertIsNone(key)
        self.assertEqual(read_key(["A"], {}, {})[:2], (None, None))

    def test_key_never_in_repr_or_public_info(self):
        cfg = build_role("brain", {"provider": "custom", "base_url": "https://gw.example.com/v1", "model": "m",
                                   "api_key_env": "MY_KEY"}, {"MY_KEY": SECRET}, {})
        for text in (repr(cfg), str(cfg.key), repr(cfg.key), json.dumps(cfg.public()), repr(Secret(SECRET))):
            self.assertNotIn(SECRET, text)
        self.assertEqual(cfg.key.reveal(), SECRET)

    def test_key_only_in_authorization_header(self):
        transport = FakeTransport([completion("{}", model="m")])
        p = provider({"provider": "custom", "base_url": "https://gw.example.com/v1", "model": "m", "api_key_env": "K"},
                     transport, env={"K": SECRET})
        p.complete(TEXT_MESSAGES)
        call = transport.calls[0]
        self.assertEqual(call["headers"]["Authorization"], "Bearer " + SECRET)
        self.assertNotIn(SECRET, call["url"])
        self.assertNotIn(SECRET, json.dumps(call["payload"]))

    def test_missing_cloud_key_makes_no_request(self):
        transport = FakeTransport()
        p = provider({"provider": "gemini"}, transport, role_name="brain")
        with self.assertRaises(ProviderError) as caught:
            p.complete(TEXT_MESSAGES)
        self.assertEqual(caught.exception.code, "provider_missing_key")
        self.assertIn("GEMINI_API_KEY", str(caught.exception))
        health = p.health()
        self.assertEqual(health["error"], "provider_missing_key")
        self.assertFalse(health["ready"])
        self.assertEqual(transport.calls, [])


class PayloadTests(unittest.TestCase):
    def payload(self, raw, messages=TEXT_MESSAGES, env=None, **kwargs):
        transport = FakeTransport([completion("{}", model=raw.get("model", "m"))])
        p = provider(raw, transport, env=env or {"DASHSCOPE_API_KEY": "sk-abcdefgh", "ZHIPUAI_API_KEY": "abcdefgh.ij",
                                                 "GEMINI_API_KEY": "AIzaTestKey1", "OPENAI_API_KEY": "sk-openai-1",
                                                 "OPENROUTER_API_KEY": "sk-or-v1-abc"})
        p.complete(messages, **kwargs)
        return transport.calls[0]

    def test_dashscope_disables_thinking_and_merges_system_for_images(self):
        call = self.payload({"provider": "dashscope", "model": "qwen3.8-flash"}, IMAGE_MESSAGES, json_mode=True)
        payload = call["payload"]
        self.assertIs(payload["enable_thinking"], False)
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual([m["role"] for m in payload["messages"]], ["user"])
        self.assertEqual(payload["messages"][0]["content"][0]["text"], "Be brief.")
        text_call = self.payload({"provider": "dashscope", "model": "qwen3.8-flash"}, TEXT_MESSAGES)
        self.assertEqual(text_call["payload"]["messages"][0]["role"], "system")
        self.assertFalse(call["local"])

    def test_openai_uses_completion_tokens_and_no_temperature(self):
        payload = self.payload({"provider": "openai"}, max_tokens=300, temperature=0.7)["payload"]
        self.assertEqual(payload["max_completion_tokens"], 300)
        self.assertNotIn("max_tokens", payload)
        self.assertNotIn("temperature", payload)
        self.assertEqual(payload["reasoning_effort"], "none")

    def test_gemini_reasoning_budget_and_zhipu_thinking(self):
        payload = self.payload({"provider": "gemini"}, max_tokens=128)["payload"]
        self.assertEqual(payload["reasoning_effort"], "low")
        self.assertGreaterEqual(payload["max_tokens"], 2048)
        payload = self.payload({"provider": "zhipu", "model": "glm-4.6v-flash"})["payload"]
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        headers = self.payload({"provider": "openrouter"})["headers"]
        self.assertEqual(headers["X-Title"], "Draft Creature Lab")

    def test_ollama_options_from_config(self):
        call = self.payload({"provider": "ollama", "model": "qwen3.5:4b", "reasoning_effort": "none", "max_tokens": 700,
                             "temperature": 0.2}, json_mode=True, max_tokens=100, temperature=0.9)
        payload = call["payload"]
        self.assertEqual((payload["reasoning_effort"], payload["max_tokens"], payload["temperature"]), ("none", 700, 0.2))
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertNotIn("Authorization", call["headers"])
        self.assertTrue(call["local"])
        self.assertTrue(call["url"].startswith("http://127.0.0.1:11434/v1/chat/completions"))

    def test_lmstudio_skips_json_object_mode(self):
        payload = self.payload({"provider": "lmstudio", "model": "qwen3.5-4b"}, json_mode=True)["payload"]
        self.assertNotIn("response_format", payload)

    def test_rejected_options_downgrade_once_and_are_remembered(self):
        transport = FakeTransport([ProviderError("provider_http_error", "HTTP 400", 502, 400),
                                   completion("{}", model="m"), completion("{}", model="m")])
        p = provider({"provider": "custom", "base_url": "http://127.0.0.1:9/v1", "model": "m",
                      "extra_body": {"top_k": 20}}, transport)
        p.complete(TEXT_MESSAGES, json_mode=True)
        p.complete(TEXT_MESSAGES, json_mode=True)
        first, second, third = (c["payload"] for c in transport.calls)
        self.assertIn("response_format", first); self.assertEqual(first["top_k"], 20)
        self.assertEqual(set(second), {"model", "messages", "stream"})
        self.assertEqual(set(third), {"model", "messages", "stream"})

    def test_other_errors_do_not_downgrade(self):
        for error in (ProviderError("provider_auth_error", "HTTP 401", 502, 401),
                      ProviderError("provider_offline", "offline", 503)):
            transport = FakeTransport([error])
            p = provider({"provider": "custom", "base_url": "http://127.0.0.1:9/v1", "model": "m"}, transport)
            with self.subTest(code=error.code), self.assertRaises(ProviderError):
                p.complete(TEXT_MESSAGES)
            self.assertEqual(len(transport.calls), 1)

    def test_message_content_variants(self):
        self.assertEqual(message_content(completion("hi")), "hi")
        parts = completion("x"); parts["choices"][0]["message"]["content"] = [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]
        self.assertEqual(message_content(parts), "ab")
        for broken, code in ((completion("x", finish="length"), "model_output_truncated"),
                             ({"choices": []}, "invalid_model_response"),
                             ({"choices": [{"message": {"role": "assistant", "content": None, "refusal": "no"}}]}, "model_refused"),
                             ({"choices": [{"message": {"tool_calls": [{}], "content": ""}}]}, "invalid_model_response")):
            with self.subTest(code=code), self.assertRaises(ProviderError) as caught:
                message_content(broken)
            self.assertEqual(caught.exception.code, code)


class HealthTests(unittest.TestCase):
    def test_ollama_tags_and_missing_model(self):
        transport = FakeTransport([{"models": [{"name": "qwen3.5:4b"}, {"name": "gemma4:latest"}]}])
        status = provider({"provider": "ollama", "model": "qwen3.5:4b"}, transport).health()
        self.assertTrue(status["ready"]); self.assertTrue(status["modelAvailable"])
        self.assertEqual(transport.calls[0]["url"], "http://127.0.0.1:11434/api/tags")
        transport = FakeTransport([{"models": [{"name": "gemma4:latest"}]}])
        status = provider({"provider": "ollama", "model": "gemma4"}, transport).health()
        self.assertTrue(status["ready"])
        transport = FakeTransport([{"models": []}])
        status = provider({"provider": "ollama", "model": "qwen3-vl:2b-instruct"}, transport).health()
        self.assertFalse(status["ready"]); self.assertEqual(status["error"], "model_not_pulled")
        self.assertIn("ollama pull qwen3-vl:2b-instruct", status["hint"])

    def test_openai_compatible_models_list(self):
        env = {"GEMINI_API_KEY": "AIzaTestKey1"}
        transport = FakeTransport([{"data": [{"id": "models/gemini-3.8-flash"}]}])
        status = provider({"provider": "gemini"}, transport, env=env).health()
        self.assertTrue(status["ready"]); self.assertTrue(status["modelListed"])
        self.assertTrue(transport.calls[0]["url"].endswith("/v1beta/openai/models"))
        transport = FakeTransport([ProviderError("provider_auth_error", "HTTP 401", 502, 401)])
        status = provider({"provider": "gemini"}, transport, env=env).health()
        self.assertFalse(status["ready"]); self.assertTrue(status["reachable"]); self.assertEqual(status["error"], "provider_auth_error")
        transport = FakeTransport([ProviderError("provider_not_found", "HTTP 404", 502, 404)])
        status = provider({"provider": "custom", "base_url": "http://127.0.0.1:9/v1", "model": "m"}, transport).health()
        self.assertTrue(status["ready"]); self.assertIsNone(status["modelListed"])
        transport = FakeTransport([ProviderError("provider_offline", "offline", 503)])
        status = provider({"provider": "custom", "base_url": "http://127.0.0.1:9/v1", "model": "m"}, transport).health()
        self.assertFalse(status["reachable"]); self.assertFalse(status["ready"])


class RealHttpTests(unittest.TestCase):
    """Real urllib transport against an HTTP mock on loopback."""

    def test_round_trip_redirect_size_limit_and_errors(self):
        with MockProvider(models=["mock-model"]) as mock:
            cfg = role("brain", {"provider": "custom", "base_url": mock.base_url, "model": "mock-model", "api_key_env": "K"},
                       env={"K": SECRET})
            p = OpenAICompatibleProvider(cfg, HttpTransport())
            mock.replies.append((200, completion('{"reply": "hi"}', model="mock-model")))
            self.assertEqual(message_content(p.complete(TEXT_MESSAGES, json_mode=True)), '{"reply": "hi"}')
            sent = mock.posts[0]
            self.assertEqual(sent["path"], "/v1/chat/completions")
            self.assertEqual(sent["headers"].get("Authorization"), "Bearer " + SECRET)
            self.assertEqual(sent["body"]["model"], "mock-model")
            self.assertTrue(p.health()["ready"])
            # Redirects are never followed (the key would travel with them).
            mock.replies.append((302, {"moved": True}, {"Location": "http://127.0.0.1:1/steal"}))
            with self.assertRaises(ProviderError) as caught:
                p.complete(TEXT_MESSAGES)
            self.assertEqual(caught.exception.http_status, 302)
            # Oversized bodies are cut off before parsing.
            mock.replies.append((200, b"{" + b" " * (2 * 1024 * 1024) + b"}"))
            with self.assertRaises(ProviderError) as caught:
                p.complete(TEXT_MESSAGES, limit=64 * 1024)
            self.assertEqual(caught.exception.code, "invalid_model_response")
            # Provider error bodies are never echoed.
            mock.replies.append((500, {"error": "internal secret detail " + SECRET}))
            with self.assertRaises(ProviderError) as caught:
                p.complete(TEXT_MESSAGES)
            self.assertNotIn("secret detail", str(caught.exception))
            self.assertNotIn(SECRET, str(caught.exception))
            mock.replies.append((401, {"error": "bad key"}))
            with self.assertRaises(ProviderError) as caught:
                p.complete(TEXT_MESSAGES)
            self.assertEqual(caught.exception.code, "provider_auth_error")

    def test_connection_refused_is_offline(self):
        cfg = role("brain", {"provider": "custom", "base_url": "http://127.0.0.1:9/v1", "model": "m"})
        p = OpenAICompatibleProvider(cfg, HttpTransport())
        with self.assertRaises(ProviderError) as caught:
            p.complete(TEXT_MESSAGES, timeout=2)
        self.assertEqual(caught.exception.code, "provider_offline")


if __name__ == "__main__":
    unittest.main()
