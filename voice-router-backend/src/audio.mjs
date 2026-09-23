import { AppError } from "./errors.mjs";
export function decodePcm(chunk, rate) {
  if (rate !== 16000 || typeof chunk !== "string" || chunk.length > 44000 || !chunk.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk)) throw new AppError("invalid_audio", "Ожидается base64 PCM16 mono 16 kHz.");
  const data = Buffer.from(chunk, "base64");
  if (!data.length || data.length % 2 || data.toString("base64") !== chunk) throw new AppError("invalid_audio", "Некорректный PCM16.");
  return data;
}
export function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export class AudioBuffer {
  chunks = []; bytes = 0; voiced = false; preRoll = Buffer.alloc(0);
  push(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i += 2) sum += (data.readInt16LE(i) / 32768) ** 2;
    const rms = Math.sqrt(sum / (data.length / 2));
    if (!this.voiced && rms < .008) { this.preRoll = Buffer.concat([this.preRoll, data]).subarray(-6400); return; }
    if (!this.voiced) { this.voiced = true; this.chunks.push(this.preRoll); this.bytes = this.preRoll.length; this.preRoll = Buffer.alloc(0); }
    this.chunks.push(data); this.bytes += data.length;
    if (this.bytes > 30 * 32000) { this.clear(); throw new AppError("audio_too_long", "Реплика длиннее 30 секунд. Сделайте паузу и повторите."); }
  }
  take() { const pcm = this.voiced ? Buffer.concat(this.chunks) : null; this.clear(); return pcm; }
  clear() { this.chunks = []; this.bytes = 0; this.voiced = false; this.preRoll = Buffer.alloc(0); }
}
