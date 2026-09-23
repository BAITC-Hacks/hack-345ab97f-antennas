"""
router.py — LLM-роутер: реплика клиента + состояние диалога -> решение (RouterDecision).

Запуск из терминала:
  python router.py --show-prompt "Хочу продлить страховку"   # без API-ключа: просто покажет промпт
  python router.py "Хочу продлить страховку"                 # настоящий вызов LLM

Работает с любым OpenAI-совместимым провайдером (OpenAI, Groq, OpenRouter, Gemini).
Провайдер и модель задаются в .env — код менять не нужно (это и есть adapter pattern).
"""
import argparse
import json
import os
import re
import time
from pathlib import Path

from dotenv import load_dotenv

from prompt import build_messages, build_system_prompt, load_catalog
from schema import RouterDecision, build_json_schema

HERE = Path(__file__).parent


class LLMRouter:
    def __init__(self, catalog_path: str | Path = HERE / "catalog.json"):
        load_dotenv(HERE / ".env")
        self.catalog = load_catalog(catalog_path)
        self.ids = [s["id"] for s in self.catalog["scenarios"]]
        # Системный промпт и схему собираем ОДИН раз при старте, а не на каждую реплику
        self.system_prompt = build_system_prompt(self.catalog)
        self.json_schema = build_json_schema(self.ids)
        self.model = os.getenv("LLM_MODEL", "")
        self.response_format = os.getenv("LLM_RESPONSE_FORMAT", "json_schema")
        self._client = None  # создаём лениво, чтобы --show-prompt работал без ключа

    @property
    def client(self):
        if self._client is None:
            from openai import OpenAI

            api_key = os.getenv("LLM_API_KEY")
            if not api_key or not self.model:
                raise RuntimeError("Заполни LLM_API_KEY и LLM_MODEL в файле .env (пример — .env.example)")
            self._client = OpenAI(api_key=api_key, base_url=os.getenv("LLM_BASE_URL") or None)
        return self._client

    def route(self, utterance: str, state: dict | None = None) -> tuple[RouterDecision, float]:
        """Главный метод. Возвращает (решение, задержка в миллисекундах)."""
        messages = build_messages(self.system_prompt, utterance, state)
        t0 = time.perf_counter()  # perf_counter — самые точные часы для замера интервалов
        raw = self._call_llm(messages)
        latency_ms = (time.perf_counter() - t0) * 1000
        return parse_decision(raw, set(self.ids)), latency_ms

    def _call_llm(self, messages: list[dict]) -> str:
        from openai import BadRequestError

        if self.response_format == "json_schema":
            response_format = {"type": "json_schema", "json_schema": self.json_schema}
        else:
            response_format = {"type": "json_object"}

        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0,      # 0 = модель отвечает максимально предсказуемо
                max_tokens=500,     # ответ короткий: чем меньше токенов, тем быстрее
                response_format=response_format,
            )
        except BadRequestError as e:
            # Не все модели умеют json_schema. Тогда один раз переключаемся на json_object
            # и дальше полагаемся на проверку через Pydantic.
            if self.response_format == "json_schema":
                print(f"[router] json_schema не поддерживается ({e.__class__.__name__}), перехожу на json_object")
                self.response_format = "json_object"
                return self._call_llm(messages)
            raise
        return resp.choices[0].message.content


def parse_decision(raw: str, valid_ids: set[str]) -> RouterDecision:
    """Сырой текст модели -> проверенный RouterDecision (или понятная ошибка)."""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)  # если модель обернула ответ в ```json
    decision = RouterDecision.model_validate(json.loads(text))
    bad = decision.unknown_ids(valid_ids)
    if bad:
        raise ValueError(f"Модель вернула несуществующие сценарии: {bad}")
    return decision


def main():
    parser = argparse.ArgumentParser(description="Проверить роутер на одной фразе")
    parser.add_argument("utterance", help="Фраза клиента")
    parser.add_argument("--state", help='Состояние диалога в JSON, например \'{"active_scenario": "renew_policy"}\'')
    parser.add_argument("--show-prompt", action="store_true", help="Только показать промпт, без вызова LLM")
    args = parser.parse_args()

    router = LLMRouter()
    state = json.loads(args.state) if args.state else None

    if args.show_prompt:
        for m in build_messages(router.system_prompt, args.utterance, state):
            print(f"===== {m['role'].upper()} =====\n{m['content']}\n")
        print(f"Длина system-промпта: ~{len(router.system_prompt) // 4} токенов (грубая оценка)")
        return

    decision, ms = router.route(args.utterance, state)
    print(json.dumps(decision.model_dump(), ensure_ascii=False, indent=2))
    print(f"\nЗадержка роутера: {ms:.0f} мс")


if __name__ == "__main__":
    main()
