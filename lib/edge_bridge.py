"""
Pont persistant vers le service de lecture à voix haute de Microsoft Edge (bibliothèque edge-tts).

Protocole : une requête JSON par ligne sur stdin, une réponse JSON par ligne sur stdout.
  -> {"id": 1, "op": "voices"}
  <- {"id": 1, "ok": true, "voices": [...]}
  -> {"id": 2, "op": "synth", "text": "...", "voice": "fr-FR-HenriNeural", "rate": "+0%", "pitch": "+0Hz", "volume": "+0%"}
  <- {"id": 2, "ok": true, "audio": "<mp3 base64>"}
  <- {"id": 2, "ok": false, "error": "..."}
Les requêtes sont traitées en parallèle (asyncio).
"""

import asyncio
import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".python"))

import edge_tts  # noqa: E402


def reply(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


async def handle(req):
    rid = req.get("id")
    try:
        if req["op"] == "voices":
            reply({"id": rid, "ok": True, "voices": await edge_tts.list_voices()})
        elif req["op"] == "synth":
            communicate = edge_tts.Communicate(
                req["text"],
                req["voice"],
                rate=req.get("rate", "+0%"),
                pitch=req.get("pitch", "+0Hz"),
                volume=req.get("volume", "+0%"),
            )
            audio = bytearray()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio += chunk["data"]
            if not audio:
                raise RuntimeError("audio vide")
            reply({"id": rid, "ok": True, "audio": base64.b64encode(audio).decode("ascii")})
        else:
            raise ValueError(f"op inconnue : {req['op']}")
    except Exception as exc:  # renvoyé tel quel au process Node
        reply({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


async def main():
    loop = asyncio.get_running_loop()
    tasks = set()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        task = asyncio.create_task(handle(json.loads(line)))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks)


if __name__ == "__main__":
    reply({"ready": True, "version": getattr(edge_tts, "__version__", "?")})
    asyncio.run(main())
