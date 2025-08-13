/**
 * Vue Audio Player
 * 
 * Основные возможности:
 * - Воспроизведение аудио файлов из плейлиста (mp3, m4a, wav и др.)
 * - Добавление треков через drag&drop или выбор файлов вручную
 * - Получение метаданных трека (название, артист, обложка) через music-metadata-browser
 * - Управление воспроизведением: play, pause, stop, следующий/предыдущий трек, loop
 * - Отображение прогресса, времени, громкости, скорости воспроизведения
 * - Сохранение состояния (плейлист, позиция, громкость и др.) в localStorage
 * - Восстановление состояния при перезагрузке страницы (кроме локальных файлов)
 * - Поддержка Media Session API для интеграции с системными контроллерами
 * - Управление с клавиатуры (пробел, стрелки, S)
 * 
 * Основные переменные:
 * - playlist: массив треков с метаданными
 * - index: индекс текущего трека
 * - current: вычисляемый текущий трек
 * - audioEl: ссылка на элемент audio
 * - isPlaying: состояние воспроизведения
 * - progress, volume, rate, loop, duration, currentTime: параметры аудио
 * - coverUrl: URL обложки текущего трека
 * - dragging: состояние перетаскивания файлов
 * 
 * Основные функции:
 * - play/pause/toggle/stop: управление воспроизведением
 * - next/prev/selectTrack: переключение треков
 * - onTimeUpdate/onSeek/onEnded/onLoadedMeta: обработка событий аудио
 * - handleFiles: обработка добавленных файлов, получение метаданных
 * - saveState/loadState: сохранение и восстановление состояния
 * - applyMediaSession: обновление Media Session API
 * - formatTime: форматирование времени в ММ:СС
 * 
 * Жизненный цикл:
 * - onMounted: загрузка состояния, установка слушателей, интеграция с Media Session
 * - onBeforeUnmount: очистка слушателей
 * 
 * UI:
 * - drag&drop зона для добавления файлов
 * - карточка текущего трека с обложкой и информацией
 * - элементы управления аудио (play/pause, громкость, скорость, loop)
 * - плейлист с выбором трека
 */
<script setup>
import { ref, computed, onMounted, watch, onBeforeUnmount, nextTick } from 'vue'
import { parseBlob } from 'music-metadata-browser'

const LS_KEY = 'vue-audio-state-v1' // ключ для localStorage

const playlist = ref([
  { title: 'Lo‑fi Beat', src: '/audio/track1.mp3', artist: 'You' },
  { title: 'Ambient Pad', src: '/audio/track2.mp3', artist: 'You' },
]) // плейлист с треками

const index = ref(0) // индекс текущего трека
const current = computed(() => playlist.value[index.value]) // текущий трек из плейлиста

const audioEl = ref(null) // ссылка на элемент audio
const isPlaying = ref(false) // состояние воспроизведения
const progress = ref(0)         // прогресс воспроизведения 0..1
const volume = ref(0.9)         // громкость 0..1
const rate = ref(1)             // скорость воспроизведения 0.5..2
const loop = ref(false)         // режим повтора
const duration = ref(0)         // длительность трека
const currentTime = ref(0)      // текущее время воспроизведения

const coverUrl = ref('') // URL обложки трека
const displayTitle = computed(() => current.value?.title ?? '—') // отображаемое название трека
const displayArtist = computed(() => current.value?.artist ?? '') // отображаемый артист

function formatTime(s) {
  if (!Number.isFinite(s)) return '0:00' // если некорректное время
  const m = Math.floor(s / 60) // минуты
  const sec = Math.floor(s % 60).toString().padStart(2, '0') // секунды с ведущим нулём
  return `${m}:${sec}` // формат ММ:СС
}
function play()  { audioEl.value?.play() } // начать воспроизведение
function pause() { audioEl.value?.pause() } // пауза
function toggle() { isPlaying.value ? pause() : play() } // переключить воспроизведение

// стоп: пауза и сброс в начало
function stop() { // стоп: пауза и сброс в начало
  const a = audioEl.value
  if (!a) return
  a.pause()
  a.currentTime = 0
  isPlaying.value = false
  currentTime.value = 0
  progress.value = 0
  saveStateDebounced()
}

function next() { index.value = (index.value + 1) % playlist.value.length } // следующий трек
function prev() { index.value = (index.value - 1 + playlist.value.length) % playlist.value.length } // предыдущий трек

function onTimeUpdate() {
  currentTime.value = audioEl.value.currentTime || 0 // обновить текущее время
  duration.value = audioEl.value.duration || 0 // обновить длительность
  progress.value = duration.value ? currentTime.value / duration.value : 0 // обновить прогресс
  saveStateThrottled() // сохранить состояние с троттлингом
}

function onSeek(e) {
  const p = Number(e.target.value) // получить позицию из input
  progress.value = p // обновить прогресс
  if (duration.value) audioEl.value.currentTime = duration.value * p // установить время в audio
  saveStateDebounced() // сохранить состояние с дебаунсом
}

function onEnded() {
  if (!loop.value) next() // при окончании трека перейти к следующему, если не в режиме повтора
}

function selectTrack(i) { index.value = i } // выбрать трек по индексу

const dragging = ref(false) // состояние перетаскивания файлов
async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('audio/')) // отфильтровать аудио файлы
  for (const file of files) {
    const url = URL.createObjectURL(file) // создать URL для локального файла
    let metaTitle = file.name.replace(/\.[^.]+$/, '') // название из имени файла
    let metaArtist = '' // исполнитель по умолчанию пустой
    let coverDataUrl = '' // обложка в base64
    try {
      const mm = await parseBlob(file) // получить метаданные из файла
      if (mm.common?.title) metaTitle = mm.common.title // взять название из метаданных
      if (mm.common?.artist) metaArtist = mm.common.artist // взять артиста из метаданных
      if (mm.common?.picture?.length) {
        const pic = mm.common.picture[0]
        coverDataUrl = `data:${pic.format};base64,${arrayBufferToBase64(pic.data)}` // получить обложку
      }
    } catch (_) {}
    playlist.value.push({
      title: metaTitle,
      artist: metaArtist,
      src: url,
      _localObjectUrl: url, // пометка, что это локальный объект
      cover: coverDataUrl || ''
    })
  }
  if (!isPlaying.value && files.length) {
    index.value = playlist.value.length - files.length // переключиться на первый добавленный трек
    await nextTickPlay() // начать воспроизведение
  }
  saveState() // сохранить состояние
}

function onDrop(e) {
  dragging.value = false // сброс состояния перетаскивания
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files) // обработать файлы при drop
}
function onDragOver(e) {
  e.preventDefault() // разрешить drop
  dragging.value = true // включить состояние перетаскивания
}
function onDragLeave() { dragging.value = false } // выход курсора из зоны перетаскивания

function onFilePick(e) {
  if (e.target?.files?.length) handleFiles(e.target.files) // обработать выбранные файлы
}

function arrayBufferToBase64(buffer) {
  let binary = '' // строка для base64
  const bytes = new Uint8Array(buffer) // байты из буфера
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]) // конвертация в бинарную строку
  return btoa(binary) // base64 из бинарной строки
}

function applyMediaSession() {
  if (!('mediaSession' in navigator)) return // если нет поддержки mediaSession
  navigator.mediaSession.metadata = new window.MediaMetadata({
    title: displayTitle.value, // название трека
    artist: displayArtist.value, // артист
    album: 'Vue Player', // альбом (статично)
    artwork: coverUrl.value ? [{ src: coverUrl.value, sizes: '512x512', type: 'image/png' }] : undefined // обложка
  })
}

function refreshCover() { coverUrl.value = current.value?.cover || '' } // обновить URL обложки

let lastSave = 0 // время последнего сохранения
function saveStateThrottled() {
  const now = performance.now()
  if (now - lastSave > 800) { lastSave = now; saveState() } // сохранить не чаще чем раз в 800 мс
}
let saveTimer // таймер для дебаунса
function saveStateDebounced() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 300) } // отложенное сохранение
function serializePlaylist(pl) {
  return pl.map(t => ({
    title: t.title, artist: t.artist, src: t._localObjectUrl ? null : t.src, cover: t.cover || '' // сериализация плейлиста для localStorage
  }))
}
function saveState() {
  try {
    const data = {
      index: index.value, // текущий индекс
      time: currentTime.value, // текущее время
      volume: volume.value, // громкость
      rate: rate.value, // скорость
      loop: loop.value, // повтор
      playlist: serializePlaylist(playlist.value), // сериализованный плейлист
      hasLocal: playlist.value.some(t => t._localObjectUrl) // есть локальные треки
    }
    localStorage.setItem(LS_KEY, JSON.stringify(data)) // сохранить в localStorage
  } catch {}
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY) // получить из localStorage
    if (!raw) return
    const s = JSON.parse(raw)
    if (Array.isArray(s.playlist) && s.playlist.length) {
      const restored = s.playlist.filter(t => t.src).map(t => ({
        title: t.title, artist: t.artist, src: t.src, cover: t.cover || '' // восстановить плейлист из localStorage (только с URL)
      }))
      if (restored.length) { playlist.value = restored }
    }
    if (Number.isFinite(s.index)) index.value = Math.min(Math.max(0, s.index), Math.max(0, playlist.value.length - 1)) // восстановить индекс
    if (Number.isFinite(s.volume)) volume.value = Math.min(Math.max(0, s.volume), 1) // восстановить громкость
    if (Number.isFinite(s.rate)) rate.value = Math.min(Math.max(0.5, s.rate), 2) // восстановить скорость
    if (typeof s.loop === 'boolean') loop.value = s.loop // восстановить режим повтора
    if (Number.isFinite(s.time)) pendingResumeTime = s.time // сохранить время для возобновления
  } catch {}
}
let pendingResumeTime = 0 // время для возобновления воспроизведения

// наблюдатель за громкостью, обновляет audio и сохраняет состояние
watch(volume, v => { if (audioEl.value) audioEl.value.volume = v; saveStateDebounced() })
// наблюдатель за скоростью, обновляет audio и сохраняет состояние
watch(rate,   r => { if (audioEl.value) audioEl.value.playbackRate = r; saveStateDebounced() })
// наблюдатель за режимом повтора, обновляет audio и сохраняет состояние
watch(loop,   l => { if (audioEl.value) audioEl.value.loop = l; saveStateDebounced() })

// наблюдатель за индексом текущего трека: воспроизведение, обновление обложки, mediaSession, сохранение
watch(index, async () => {
  await nextTickPlay()
  refreshCover()
  applyMediaSession()
  saveState()
})

// воспроизведение после следующего обновления DOM
async function nextTickPlay() {
  await nextTick()
  if (!audioEl.value) return
  try { await audioEl.value.play() } catch {}
}

// обработка загрузки метаданных аудио
function onLoadedMeta() {
  duration.value = audioEl.value.duration || 0 // обновить длительность
  audioEl.value.volume = volume.value // установить громкость
  audioEl.value.playbackRate = rate.value // установить скорость
  audioEl.value.loop = loop.value // установить режим повтора
  if (pendingResumeTime && pendingResumeTime < (audioEl.value.duration || Infinity)) {
    audioEl.value.currentTime = pendingResumeTime // возобновить с сохранённого времени
  }
  pendingResumeTime = 0 // сбросить время возобновления
  refreshCover() // обновить обложку
  applyMediaSession() // обновить mediaSession
}

// хук монтирования компонента
onMounted(() => {
  loadState() // загрузить состояние из localStorage

  const a = audioEl.value
  a?.addEventListener('play', () => (isPlaying.value = true)) // слушатель play
  a?.addEventListener('pause', () => (isPlaying.value = false)) // слушатель pause

  const onKey = (e) => {
    if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return // игнор при вводе текста
    if (e.code === 'Space') { e.preventDefault(); toggle() } // пробел - play/pause
    if (e.code === 'ArrowRight') { a.currentTime = Math.min((a.currentTime||0) + 5, a.duration||Infinity) } // стрелка вправо - вперед на 5 секунд
    if (e.code === 'ArrowLeft')  { a.currentTime = Math.max((a.currentTime||0) - 5, 0) } // стрелка влево - назад на 5 секунд
    if (e.code === 'ArrowUp')    { volume.value = Math.min(volume.value + 0.05, 1) } // стрелка вверх - увеличить громкость
    if (e.code === 'ArrowDown')  { volume.value = Math.max(volume.value - 0.05, 0) } // стрелка вниз - уменьшить громкость
    if (e.code === 'KeyS')       { stop() } // S — стоп
  }
  window.addEventListener('keydown', onKey) // слушатель клавиатуры
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey)) // очистка слушателя при размонтировании

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', play) // mediaSession play
    navigator.mediaSession.setActionHandler('pause', pause) // mediaSession pause
    navigator.mediaSession.setActionHandler('previoustrack', prev) // mediaSession предыдущий трек
    navigator.mediaSession.setActionHandler('nexttrack', next) // mediaSession следующий трек
    navigator.mediaSession.setActionHandler('seekbackward', () => a.currentTime = Math.max((a.currentTime||0)-10, 0)) // перемотка назад
    navigator.mediaSession.setActionHandler('seekforward', () => a.currentTime = Math.min((a.currentTime||0)+10, a.duration||Infinity)) // перемотка вперед
    navigator.mediaSession.setActionHandler('stop', stop)
  }
})
</script>


<template>
  <div class="app">
    <h1>🎧 Vue Audio Player</h1>

    <div
      class="dropzone"
      :class="{drag: dragging}"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
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
        
        <button @click="next" title="Next">⏭</button>

        <div class="time" style="margin-left:auto">
          {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
        </div>
      </div>

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

      <div class="playlist">
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
  </div>
</template>