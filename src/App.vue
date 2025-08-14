<script setup>
/**
 * Полный Vue Audio Player с Web Audio FX-цепочкой и DnD редактором
 * Зависимости: vuedraggable@next, music-metadata-browser
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Draggable from 'vuedraggable'
import { parseBlob } from 'music-metadata-browser'

/* ==========================
   БАЗОВОЕ СОСТОЯНИЕ ПЛЕЕРА
   ========================== */
const LS_KEY = 'vue-audio-state-v3'

const playlist = ref([
  { title: 'Lo‑fi Beat', src: '/audio/track1.mp3', artist: 'You' },
  { title: 'Ambient Pad', src: '/audio/track2.mp3', artist: 'You' },
])
const index = ref(0)
const current = computed(() => playlist.value[index.value])

const audioEl = ref(null)
const isPlaying = ref(false)
const progress = ref(0)      // 0..1
const volume = ref(0.9)      // 0..1
const rate = ref(1)          // 0.5..2
const loop = ref(false)
const duration = ref(0)
const currentTime = ref(0)

const coverUrl = ref('')
const displayTitle = computed(() => current.value?.title ?? '—')
const displayArtist = computed(() => current.value?.artist ?? '')

/* =============
   WEB AUDIO
   ============= */
const audioCtx = ref(null)
let sourceNode = null
let gainNode = null
let analyser = null
const visCanvas = ref(null)
let rafId = 0

// FX узлы
let eqLow = null, eqMid = null, eqHigh = null
let waveShaper = null
let chorusDelay = null, chorusDepthGain = null, chorusLFO = null, chorusWet = null
let delayNode = null, delayFeedback = null, delayWet = null
let convolver = null, reverbWet = null
let panner = null
let compressor = null

function makeGain(v = 1) {
  const g = audioCtx.value.createGain()
  g.gain.value = v
  return g
}

const fx = ref({
  // EQ
  eqOn: false, lowGain: 0, midGain: 0, highGain: 0,
  // Distortion
  distOn: false, distAmount: 50, // 0..100
  // Chorus
  chorusOn: false, chorusRate: 1.5, chorusDepth: 0.002, chorusWet: 0.5,
  // Delay
  delayOn: false, delayTime: 0.3, delayFeedback: 0.4, delayWet: 0.5,
  // Reverb
  reverbOn: false, reverbWet: 0.5, reverbIR: '',
  // Pan
  panOn: false, pan: 0,
  // Compressor
  compOn: false, compThreshold: -24, compKnee: 30, compRatio: 12, compAttack: 0.003, compRelease: 0.25,
})

/* ==========================
   РЕДАКТОР ЦЕПОЧКИ ЭФФЕКТОВ
   ========================== */
// enabled — вкл/выкл; mode — "serial" | "parallel"
const fxChain = ref([
  { id: 'eq',     title: 'EQ',          enabled: false, mode: 'serial'   },
  { id: 'dist',   title: 'Distortion',  enabled: false, mode: 'serial'   },
  { id: 'chorus', title: 'Chorus',      enabled: false, mode: 'parallel' },
  { id: 'delay',  title: 'Delay',       enabled: false, mode: 'parallel' },
  { id: 'reverb', title: 'Reverb',      enabled: false, mode: 'parallel' },
  { id: 'pan',    title: 'Pan',         enabled: false, mode: 'serial'   },
  { id: 'comp',   title: 'Compressor',  enabled: false, mode: 'serial'   },
])

// Синхронизация старых флагов fx.*On с цепочкой
watch(fxChain, chain => {
  const map = Object.fromEntries(chain.map(x => [x.id, x.enabled]))
  fx.value.eqOn     = !!map.eq
  fx.value.distOn   = !!map.dist
  fx.value.chorusOn = !!map.chorus
  fx.value.delayOn  = !!map.delay
  fx.value.reverbOn = !!map.reverb
  fx.value.panOn    = !!map.pan
  fx.value.compOn   = !!map.comp
  rebuildGraph()
}, { deep: true })

// DnD события (в Draggable они не обязательны, но пригодятся)
function onChainChange() {
  rebuildGraph()
}

/* =========
   ВСПОМОГАТЕЛЬНОЕ
   ========= */
function formatTime(s) {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60).toString().padStart(2, '0')
  return `${m}:${sec}`
}

function makeDistortionCurve(amount = 50) {
  const k = +amount
  const n = 44100
  const curve = new Float32Array(n)
  const deg = Math.PI / 180
  for (let i = 0; i < n; ++i) {
    const x = i * 2 / n - 1
    curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x))
  }
  return curve
}

async function ensureAudioGraph() {
  if (audioCtx.value || !audioEl.value) return
  const Ctx = window.AudioContext || window.webkitAudioContext
  audioCtx.value = new Ctx()
  sourceNode = audioCtx.value.createMediaElementSource(audioEl.value)
  gainNode = makeGain(volume.value)
  analyser = audioCtx.value.createAnalyser()
  analyser.fftSize = 2048
  audioEl.value.volume = 1
  startVisualizer()
  rebuildGraph()
}

function updateGain(v) {
  if (gainNode) gainNode.gain.value = v
  else if (audioEl.value) audioEl.value.volume = v
}

function startVisualizer() {
  if (!visCanvas.value || !analyser) return
  const canvas = visCanvas.value
  const ctx2d = canvas.getContext('2d')
  const bufferLen = analyser.frequencyBinCount
  const data = new Uint8Array(bufferLen)

  const render = () => {
    rafId = requestAnimationFrame(render)
    analyser.getByteFrequencyData(data)
    const w = canvas.width = canvas.clientWidth
    const h = canvas.height = 120
    ctx2d.clearRect(0, 0, w, h)
    const barW = Math.max(1, (w / bufferLen) * 2.2)
    let x = 0
    for (let i = 0; i < bufferLen; i += 2) {
      const v = data[i] / 255
      const barH = v * h
      ctx2d.fillStyle = 'rgba(122,162,255,0.85)'
      ctx2d.fillRect(x, h - barH, barW, barH)
      x += barW + 1
    }
  }
  cancelAnimationFrame(rafId)
  render()
}

/* ==========================
   СБОРКА ГРАФА ПО ЦЕПОЧКЕ
   ========================== */
function rebuildGraph() {
  if (!audioCtx.value || !sourceNode) return

  // чистые подключения
  try { sourceNode.disconnect() } catch {}
  gainNode?.disconnect()
  analyser?.disconnect()

  // вход в граф
  sourceNode.connect(gainNode)
  let head = gainNode

  // вспом. функция для параллельного блока: sum(dry, wet)
  const makeParallel = (headIn, wetNode, wetGainValue = 1) => {
    const dry = makeGain(1)
    const wetGain = makeGain(wetGainValue)
    const sum = makeGain(1)
    headIn.connect(dry)
    headIn.connect(wetNode)
    wetNode.connect(wetGain)
    dry.connect(sum)
    wetGain.connect(sum)
    return sum
  }

  // подготовить узлы
  if (fx.value.eqOn) {
    eqLow  ||= audioCtx.value.createBiquadFilter()
    eqMid  ||= audioCtx.value.createBiquadFilter()
    eqHigh ||= audioCtx.value.createBiquadFilter()
    eqLow.type='lowshelf'; eqLow.frequency.value=120;  eqLow.gain.value=fx.value.lowGain
    eqMid.type='peaking';  eqMid.frequency.value=1000; eqMid.Q.value=0.8; eqMid.gain.value=fx.value.midGain
    eqHigh.type='highshelf';eqHigh.frequency.value=6500; eqHigh.gain.value=fx.value.highGain
  }
  if (fx.value.distOn) {
    waveShaper ||= audioCtx.value.createWaveShaper()
    waveShaper.curve = makeDistortionCurve(fx.value.distAmount)
    waveShaper.oversample = '4x'
  }
  if (fx.value.chorusOn) {
    chorusDelay     ||= audioCtx.value.createDelay(0.05) // до 50ms
    chorusDepthGain ||= makeGain(fx.value.chorusDepth)
    chorusLFO       ||= audioCtx.value.createOscillator()
    chorusLFO.type = 'sine'
    chorusLFO.frequency.value = fx.value.chorusRate
    try { chorusLFO.start() } catch {}
    chorusWet ||= makeGain(fx.value.chorusWet)
    chorusLFO.disconnect(); chorusLFO.connect(chorusDepthGain)
    chorusDepthGain.disconnect(); chorusDepthGain.connect(chorusDelay.delayTime)
  }
  if (fx.value.delayOn) {
    delayNode     ||= audioCtx.value.createDelay(2.0)
    delayFeedback ||= makeGain(fx.value.delayFeedback)
    delayWet      ||= makeGain(fx.value.delayWet)
    delayNode.delayTime.value = fx.value.delayTime
  }
  if (fx.value.reverbOn) {
    convolver ||= audioCtx.value.createConvolver()
    reverbWet ||= makeGain(fx.value.reverbWet)
  }
  if (fx.value.panOn) {
    panner ||= audioCtx.value.createStereoPanner()
    panner.pan.value = fx.value.pan
  }
  if (fx.value.compOn) {
    compressor ||= audioCtx.value.createDynamicsCompressor()
    compressor.threshold.value = fx.value.compThreshold
    compressor.knee.value      = fx.value.compKnee
    compressor.ratio.value     = fx.value.compRatio
    compressor.attack.value    = fx.value.compAttack
    compressor.release.value   = fx.value.compRelease
  }

  // пройти по цепочке
  for (const block of fxChain.value) {
    if (!block.enabled) continue
    const serial = block.mode === 'serial'

    if (block.id === 'eq' && fx.value.eqOn) {
      if (serial) { head.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh); head = eqHigh }
      continue
    }

    if (block.id === 'dist' && fx.value.distOn) {
      if (serial) { head.connect(waveShaper); head = waveShaper }
      else { head = makeParallel(head, waveShaper, 1) }
      continue
    }

    if (block.id === 'chorus' && fx.value.chorusOn) {
      if (serial) { head.connect(chorusDelay); head = chorusDelay }
      else { head = makeParallel(head, chorusDelay, fx.value.chorusWet) }
      continue
    }

    if (block.id === 'delay' && fx.value.delayOn) {
      // feedback: delay -> feedback -> delay
      try { delayNode.disconnect() } catch {}
      try { delayFeedback.disconnect() } catch {}
      delayNode.connect(delayFeedback)
      delayFeedback.connect(delayNode)

      if (serial) { head.connect(delayNode); head = delayNode }
      else {
        try { delayFeedback.disconnect() } catch {}
        delayFeedback.connect(delayWet)
        head = makeParallel(head, delayNode, fx.value.delayWet)
      }
      continue
    }

    if (block.id === 'reverb' && fx.value.reverbOn && convolver?.buffer) {
      if (serial) { head.connect(convolver); head = convolver }
      else { convolver.disconnect(); convolver.connect(reverbWet); head = makeParallel(head, convolver, fx.value.reverbWet) }
      continue
    }

    if (block.id === 'pan' && fx.value.panOn) {
      head.connect(panner); head = panner; continue
    }

    if (block.id === 'comp' && fx.value.compOn) {
      if (serial) { head.connect(compressor); head = compressor }
      else { head = makeParallel(head, compressor, 0.6) }
      continue
    }
  }

  // хвост → в анализатор → destination
  head.connect(analyser)
  analyser.connect(audioCtx.value.destination)
}

/* ==========================
   КОНТРОЛЛЕРЫ ВОСПРОИЗВЕДЕНИЯ
   ========================== */
async function play() {
  if (!audioEl.value) return
  await ensureAudioGraph()
  if (audioCtx.value?.state === 'suspended') await audioCtx.value.resume()
  await audioEl.value.play()
}
function pause() { audioEl.value?.pause() }
function toggle() { isPlaying.value ? pause() : play() }
function stop() {
  const a = audioEl.value; if (!a) return
  a.pause(); a.currentTime = 0
  isPlaying.value = false; currentTime.value = 0; progress.value = 0
  saveStateDebounced()
}
function next() { index.value = (index.value + 1) % playlist.value.length }
function prev() { index.value = (index.value - 1 + playlist.value.length) % playlist.value.length }

function onTimeUpdate() {
  currentTime.value = audioEl.value.currentTime || 0
  duration.value = audioEl.value.duration || 0
  progress.value = duration.value ? currentTime.value / duration.value : 0
  saveStateThrottled()
}
function onSeek(e) {
  const p = Number(e.target.value)
  progress.value = p
  if (duration.value) audioEl.value.currentTime = duration.value * p
  saveStateDebounced()
}
function onEnded() { if (!loop.value) next() }
function selectTrack(i) { index.value = i }

/* =========
   ФАЙЛЫ
   ========= */
const dragging = ref(false)

function arrayBufferToBase64(buffer) {
  let binary = ''; const bytes = new Uint8Array(buffer); const len = bytes.byteLength
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('audio/'))
  for (const file of files) {
    const url = URL.createObjectURL(file)
    let metaTitle = file.name.replace(/\.[^.]+$/, '')
    let metaArtist = ''
    let coverDataUrl = ''
    try {
      const mm = await parseBlob(file)
      if (mm.common?.title)  metaTitle  = mm.common.title
      if (mm.common?.artist) metaArtist = mm.common.artist
      if (mm.common?.picture?.length) {
        const pic = mm.common.picture[0]
        coverDataUrl = `data:${pic.format};base64,${arrayBufferToBase64(pic.data)}`
      }
    } catch {}
    playlist.value.push({ title: metaTitle, artist: metaArtist, src: url, _localObjectUrl: url, cover: coverDataUrl || '' })
  }
  if (!isPlaying.value && files.length) {
    index.value = playlist.value.length - files.length
    await nextTick(); play().catch(()=>{})
  }
  saveState()
}

function onDrop(e) { dragging.value = false; if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files) }
function onDragOver(e) { e.preventDefault(); dragging.value = true }
function onDragLeave() { dragging.value = false }
function onFilePick(e) { if (e.target?.files?.length) handleFiles(e.target.files) }

/* =========
   REVERB IR
   ========= */
async function loadReverbIR() {
  if (!audioCtx.value) await ensureAudioGraph()
  convolver ||= audioCtx.value.createConvolver()
  if (!fx.value.reverbIR) { convolver.buffer = null; rebuildGraph(); return }
  try {
    const res = await fetch(fx.value.reverbIR)
    const ab = await res.arrayBuffer()
    const buf = await audioCtx.value.decodeAudioData(ab)
    convolver.buffer = buf
    rebuildGraph()
  } catch (e) { console.warn('IR load failed', e) }
}

/* =========
   STATE
   ========= */
let lastSave = 0
function saveStateThrottled() { const now = performance.now(); if (now - lastSave > 800) { lastSave = now; saveState() } }
let saveTimer = 0
function saveStateDebounced() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 300) }
function serializePlaylist(pl) { return pl.map(t => ({ title: t.title, artist: t.artist, src: t._localObjectUrl ? null : t.src, cover: t.cover || '' })) }
function saveState() {
  try {
    const data = {
      index: index.value, time: currentTime.value,
      volume: volume.value, rate: rate.value, loop: loop.value,
      playlist: serializePlaylist(playlist.value),
      fx: fx.value, fxChain: fxChain.value,
    }
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch {}
}
let pendingResumeTime = 0
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY); if (!raw) return
    const s = JSON.parse(raw)
    if (Array.isArray(s.playlist) && s.playlist.length) {
      const restored = s.playlist.filter(t => t.src).map(t => ({ title: t.title, artist: t.artist, src: t.src, cover: t.cover || '' }))
      if (restored.length) playlist.value = restored
    }
    if (s.fx) Object.assign(fx.value, s.fx)
    if (Array.isArray(s.fxChain)) fxChain.value = s.fxChain
    if (Number.isFinite(s.index)) index.value = Math.min(Math.max(0, s.index), Math.max(0, playlist.value.length - 1))
    if (Number.isFinite(s.volume)) volume.value = Math.min(Math.max(0, s.volume), 1)
    if (Number.isFinite(s.rate)) rate.value = Math.min(Math.max(0.5, s.rate), 2)
    if (typeof s.loop === 'boolean') loop.value = s.loop
    if (Number.isFinite(s.time)) pendingResumeTime = s.time
  } catch {}
}

/* =========
   WATCHERS
   ========= */
watch(volume, v => { updateGain(v); saveStateDebounced() })
watch(rate,   r => { if (audioEl.value) audioEl.value.playbackRate = r; saveStateDebounced() })
watch(loop,   l => { if (audioEl.value) audioEl.value.loop = l; saveStateDebounced() })
watch(index, async () => { await nextTick(); try { await audioEl.value.play() } catch {}; refreshCover(); applyMediaSession(); saveState() })

// FX param live updates
watch(() => fx.value.lowGain,  v => { if (eqLow)  eqLow.gain.value = v })
watch(() => fx.value.midGain,  v => { if (eqMid)  eqMid.gain.value = v })
watch(() => fx.value.highGain, v => { if (eqHigh) eqHigh.gain.value = v })
watch(() => fx.value.distAmount, v => { if (waveShaper) waveShaper.curve = makeDistortionCurve(v) })
watch(() => fx.value.chorusRate, v => { if (chorusLFO) chorusLFO.frequency.value = v })
watch(() => fx.value.chorusDepth, v => { if (chorusDepthGain) chorusDepthGain.gain.value = v })
watch(() => fx.value.chorusWet,   () => rebuildGraph())
watch(() => fx.value.delayTime,     v => { if (delayNode) delayNode.delayTime.value = v })
watch(() => fx.value.delayFeedback, v => { if (delayFeedback) delayFeedback.gain.value = v })
watch(() => fx.value.delayWet,      () => rebuildGraph())
watch(() => fx.value.reverbWet,     () => rebuildGraph())
watch(() => fx.value.pan,           v => { if (panner) panner.pan.value = v })
watch(() => fx.value.compThreshold, v => { if (compressor) compressor.threshold.value = v })
watch(() => fx.value.compKnee,      v => { if (compressor) compressor.knee.value = v })
watch(() => fx.value.compRatio,     v => { if (compressor) compressor.ratio.value = v })
watch(() => fx.value.compAttack,    v => { if (compressor) compressor.attack.value = v })
watch(() => fx.value.compRelease,   v => { if (compressor) compressor.release.value = v })

/* =========
   MEDIA SESSION + MOUNT
   ========= */
function refreshCover() { coverUrl.value = current.value?.cover || '' }
function applyMediaSession() {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new window.MediaMetadata({
    title: displayTitle.value, artist: displayArtist.value, album: 'Vue Player',
    artwork: coverUrl.value ? [{ src: coverUrl.value, sizes: '512x512', type: 'image/png' }] : undefined
  })
}

function onLoadedMeta() {
  duration.value = audioEl.value.duration || 0
  audioEl.value.volume = 1
  updateGain(volume.value)
  audioEl.value.playbackRate = rate.value
  audioEl.value.loop = loop.value
  if (pendingResumeTime && pendingResumeTime < (audioEl.value.duration || Infinity)) audioEl.value.currentTime = pendingResumeTime
  pendingResumeTime = 0
  refreshCover()
  applyMediaSession()
}

onMounted(() => {
  loadState()

  const a = audioEl.value
  a?.addEventListener('play', () => (isPlaying.value = true))
  a?.addEventListener('pause', () => (isPlaying.value = false))

  const onKey = (e) => {
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return
    if (e.code === 'Space') { e.preventDefault(); toggle() }
    if (e.code === 'ArrowRight') { a.currentTime = Math.min((a.currentTime||0) + 5, a.duration||Infinity) }
    if (e.code === 'ArrowLeft')  { a.currentTime = Math.max((a.currentTime||0) - 5, 0) }
    if (e.code === 'ArrowUp')    { volume.value = Math.min(volume.value + 0.05, 1) }
    if (e.code === 'ArrowDown')  { volume.value = Math.max(volume.value - 0.05, 0) }
    if (e.code === 'KeyS')       { stop() }
  }
  window.addEventListener('keydown', onKey)
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', play)
    navigator.mediaSession.setActionHandler('pause', () => pause())
    navigator.mediaSession.setActionHandler('previoustrack', prev)
    navigator.mediaSession.setActionHandler('nexttrack', next)
    navigator.mediaSession.setActionHandler('seekbackward', () => a.currentTime = Math.max((a.currentTime||0)-10, 0))
    navigator.mediaSession.setActionHandler('seekforward', () => a.currentTime = Math.min((a.currentTime||0)+10, a.duration||Infinity))
    navigator.mediaSession.setActionHandler('stop', stop)
  }
})

onBeforeUnmount(() => cancelAnimationFrame(rafId))
</script>

<template>
  <div class="app">
    <h1>🎧 Vue Audio Player</h1>

    <!-- Dropzone -->
    <div
      class="dropzone"
      :class="{drag: dragging}"
      @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop"
    >
      Перетащи сюда аудио‑файлы (mp3, m4a, wav и т.п.) или выбери вручную.
      <div class="file-btn">
        <input type="file" multiple accept="audio/*" @change="onFilePick" />
      </div>
    </div>

    <div class="card">
      <div class="header">
        <img v-if="coverUrl" :src="coverUrl" class="cover" alt="cover">
        <div style="min-width:0">
          <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ displayTitle }}</div>
          <div class="time" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ displayArtist }}</div>
        </div>
      </div>

      <audio
        ref="audioEl"
        :src="current?.src"
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onLoadedMeta"
        @ended="onEnded"
      />

      <div class="row controls" style="margin-bottom:10px">
        <button @click="prev" title="Previous">⏮</button>
        <button @click="toggle" :class="{active:isPlaying}" title="Play/Pause">
          {{ isPlaying ? '⏸ Пауза' : '▶️ Пуск' }}
        </button>
        <button @click="stop" title="Stop">⏹ Стоп</button>
        <button @click="next" title="Next">⏭</button>

        <div class="time" style="margin-left:auto">
          {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
        </div>
      </div>

      <canvas ref="visCanvas" class="visualizer"></canvas>

      <input
        class="range"
        type="range"
        min="0" max="1" step="0.001"
        :value="progress"
        @input="onSeek"
        aria-label="Seek"
      />

      <div class="row" style="margin-top:10px">
        <label>Громкость
          <input type="range" min="0" max="1" step="0.01" v-model.number="volume" />
        </label>

        <label>Скорость
          <select v-model.number="rate">
            <option :value="0.75">0.75×</option>
            <option :value="1">1×</option>
            <option :value="1.25">1.25×</option>
            <option :value="1.5">1.5×</option>
            <option :value="2">2×</option>
          </select>
        </label>

        <button @click="loop = !loop" :class="{active:loop}" title="Повтор">
          🔁 Loop {{ loop ? 'On' : 'Off' }}
        </button>
      </div>
    </div>

    <!-- Редактор цепочки эффектов -->
    <div class="card" style="margin-top:12px">
      <h3>Цепочка эффектов (перетаскивай, меняй режим)</h3>
      <Draggable
        v-model="fxChain"
        item-key="id"
        handle=".grab"
        class="playlist"
        @change="onChainChange"
      >
        <template #item="{ element, index }">
          <div class="track" :class="{active: element.enabled}" style="align-items:center">
            <span class="grab" style="cursor:grab">⠿</span>
            <span class="title">{{ index+1 }}. {{ element.title }}</span>
            <span class="row" style="gap:10px">
              <label style="display:flex;align-items:center;gap:6px">
                <input type="checkbox" v-model="element.enabled" />
                Вкл
              </label>
              <label style="display:flex;align-items:center;gap:6px">
                Режим
                <select v-model="element.mode">
                  <option value="serial">Последовательно</option>
                  <option value="parallel" :disabled="element.id==='eq' || element.id==='pan'">Параллельно</option>
                </select>
              </label>
            </span>
          </div>
        </template>
      </Draggable>
    </div>

    <!-- Панель параметров эффектов -->
    <div class="card" style="margin-top:12px">
      <h3>Эффекты</h3>

      <div class="row" style="margin-bottom:8px">
        <label><input type="checkbox" v-model="fx.eqOn" /> EQ</label>
        <label>Низкие
          <input type="range" min="-12" max="12" step="0.5" v-model.number="fx.lowGain" />
        </label>
        <label>Средние
          <input type="range" min="-12" max="12" step="0.5" v-model.number="fx.midGain" />
        </label>
        <label>Высокие
          <input type="range" min="-12" max="12" step="0.5" v-model.number="fx.highGain" />
        </label>
      </div>

      <div class="row" style="margin-bottom:8px">
        <label><input type="checkbox" v-model="fx.distOn" /> Distortion</label>
        <label>Amount
          <input type="range" min="0" max="100" step="1" v-model.number="fx.distAmount" />
        </label>
      </div>

      <div class="row" style="margin-bottom:8px">
        <label><input type="checkbox" v-model="fx.chorusOn" /> Chorus</label>
        <label>Rate
          <input type="range" min="0.1" max="5" step="0.1" v-model.number="fx.chorusRate" />
        </label>
        <label>Depth
          <input type="range" min="0.001" max="0.02" step="0.001" v-model.number="fx.chorusDepth" />
        </label>
        <label>Wet
          <input type="range" min="0" max="1" step="0.01" v-model.number="fx.chorusWet" />
        </label>
      </div>

      <div class="row" style="margin-bottom:8px">
        <label><input type="checkbox" v-model="fx.delayOn" /> Delay</label>
        <label>Time
          <input type="range" min="0" max="1.5" step="0.01" v-model.number="fx.delayTime" />
        </label>
        <label>Feedback
          <input type="range" min="0" max="0.95" step="0.01" v-model.number="fx.delayFeedback" />
        </label>
        <label>Wet
          <input type="range" min="0" max="1" step="0.01" v-model.number="fx.delayWet" />
        </label>
      </div>

      <div class="row" style="margin-bottom:8px">
        <label><input type="checkbox" v-model="fx.reverbOn" /> Reverb</label>
        <label>Wet
          <input type="range" min="0" max="1" step="0.01" v-model.number="fx.reverbWet" />
        </label>
        <input style="flex:1" placeholder="URL импульса .wav (IR)" v-model="fx.reverbIR" />
        <button @click="loadReverbIR">Загрузить ИР</button>
      </div>

      <div class="row" style="margin-bottom:8px">
        <label><input type="checkbox" v-model="fx.panOn" /> Pan</label>
        <label>Pan
          <input type="range" min="-1" max="1" step="0.01" v-model.number="fx.pan" />
        </label>
      </div>

      <div class="row" style="margin-bottom:8px">
        <label><input type="checkbox" v-model="fx.compOn" /> Compressor</label>
        <label>Threshold
          <input type="range" min="-60" max="0" step="1" v-model.number="fx.compThreshold" />
        </label>
        <label>Knee
          <input type="range" min="0" max="40" step="1" v-model.number="fx.compKnee" />
        </label>
        <label>Ratio
          <input type="range" min="1" max="20" step="1" v-model.number="fx.compRatio" />
        </label>
        <label>Attack
          <input type="range" min="0.001" max="0.2" step="0.001" v-model.number="fx.compAttack" />
        </label>
        <label>Release
          <input type="range" min="0.05" max="1" step="0.01" v-model.number="fx.compRelease" />
        </label>
      </div>
    </div>

    <!-- Плейлист -->
    <div class="card" style="margin-top:12px">
      <h3>Плейлист</h3>
      <div
        v-for="(t,i) in playlist"
        :key="t.src ?? t.title + i"
        class="track"
        :class="{active: i===index}"
        @click="selectTrack(i)"
        title="Клик — выбрать трек"
      >
        <span class="title">
          {{ t.title }}<span v-if="t.artist"> — {{ t.artist }}</span>
          <span v-if="!t.src" class="time"> (локальный — восстанови вручную)</span>
        </span>
        <span class="time">{{ i===index ? '▶︎ сейчас' : '' }}</span>
      </div>
    </div>
  </div>
</template>