"""Speech providers. PCM16 input is wrapped in a 16 kHz mono WAV file."""
from __future__ import annotations

import io
import wave
from typing import Protocol


class STT(Protocol):
    async def transcribe(self, wav: bytes) -> str: ...


class TTS(Protocol):
    async def synthesize(self, text: str) -> bytes: ...


def pcm16_to_wav(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(pcm)
    return output.getvalue()


class OpenAISTT:
    def __init__(self, api_key: str, model: str) -> None:
        from openai import AsyncOpenAI
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model

    async def transcribe(self, wav: bytes) -> str:
        result = await self.client.audio.transcriptions.create(
            model=self.model, file=("speech.wav", wav, "audio/wav")
        )
        return result.text.strip()


class OpenAITTS:
    def __init__(self, api_key: str, model: str, voice: str) -> None:
        from openai import AsyncOpenAI
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model
        self.voice = voice

    async def synthesize(self, text: str) -> bytes:
        response = await self.client.audio.speech.create(
            model=self.model, voice=self.voice, input=text, response_format="wav"
        )
        return response.content
