"""Usage: python -m app.router.cli 'текст' [--lang kk]."""
from __future__ import annotations

import argparse
import asyncio
import json

from .llm_router import LLMRouter
from .schema import DialogState, Utterance


async def _main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("text")
    parser.add_argument("--lang", choices=["ru", "kk", "mixed"])
    args = parser.parse_args()
    router = LLMRouter()
    await router.warm_up()
    result = await router.route(DialogState(), Utterance(text=args.text, lang=args.lang))
    print(json.dumps(result.model_dump(mode="json"), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())
