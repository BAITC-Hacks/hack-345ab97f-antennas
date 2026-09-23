"""Прототип: переход на json_object только при ошибке формата ответа (HTTP 400).

Запуск из router_prototype/:  python -m pytest test_fallback.py -q
"""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from openai import APIConnectionError, APIStatusError, BadRequestError

try:
    import httpx2 as httpx  # OpenAI SDK 3.x
except ImportError:
    import httpx  # OpenAI SDK 1.x/2.x

from router import LLMRouter


def configured_router(error):
    router = LLMRouter.__new__(LLMRouter)
    router.model = "fake"
    router.response_format = "json_schema"
    router.json_schema = {}
    response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="{}"))])
    create = Mock(side_effect=[error, response])
    router._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    return router, create


def bad_request(message, status=400):
    return BadRequestError(message, response=httpx.Response(status, request=httpx.Request("POST", "https://example.test")), body=None)


@pytest.mark.parametrize("message", ["Unsupported response_format", "Unsupported JSON_SCHEMA"])
def test_format_error_retries_once_with_json_object(message):
    router, create = configured_router(bad_request(message))
    assert router._call_llm([]) == "{}"
    assert create.call_count == 2
    assert create.call_args_list[0].kwargs["response_format"]["type"] == "json_schema"
    assert create.call_args_list[1].kwargs["response_format"]["type"] == "json_object"


@pytest.mark.parametrize("error", [
    bad_request("Invalid max_tokens"),
    bad_request("response_format", status=429),
    APIStatusError("response_format", response=httpx.Response(500, request=httpx.Request("POST", "https://example.test")), body=None),
    APIConnectionError(request=httpx.Request("POST", "https://example.test")),
])
def test_other_errors_propagate_unchanged_without_fallback(error):
    router, create = configured_router(error)
    with pytest.raises(type(error)) as caught:
        router._call_llm([])
    assert caught.value is error
    assert create.call_count == 1
    assert router.response_format == "json_schema"


def test_no_fallback_loop_in_json_object_mode():
    error = bad_request("response_format is invalid")
    router, create = configured_router(error)
    router.response_format = "json_object"
    with pytest.raises(BadRequestError):
        router._call_llm([])
    assert create.call_count == 1
