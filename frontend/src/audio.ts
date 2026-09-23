/** Convert a MediaRecorder blob into mono, little-endian PCM16 at 16 kHz. */
export async function recordedPcm16(blob: Blob): Promise<Uint8Array> {
  if (!blob.size) throw new Error('Запись пуста. Попробуйте ещё раз.')
  const decoder = new AudioContext()
  try {
    const decoded = await decoder.decodeAudioData(await blob.arrayBuffer())
    if (decoded.duration > 30) throw new Error('Реплика должна быть короче 30 секунд.')
    const frames = Math.max(1, Math.ceil(decoded.duration * 16000))
    const offline = new OfflineAudioContext(1, frames, 16000)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    const samples = rendered.getChannelData(0)
    const output = new Uint8Array(samples.length * 2)
    const view = new DataView(output.buffer)
    for (let index = 0; index < samples.length; index++) {
      const sample = Math.max(-1, Math.min(1, samples[index]))
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    }
    return output
  } finally {
    await decoder.close()
  }
}
