import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CueLevel } from '@/types/level'
import { INTENSITY_MAX, INTENSITY_MIN } from '@/types/level'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { useCueStore } from '@/stores/cueStore'
import { useLiveStore } from '@/stores/liveStore'

/** 通道电平补丁 */
export interface CueLevelPatch {
  intensity?: number
  colorTempK?: number
  focusNote?: string
}

function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(INTENSITY_MAX, Math.max(INTENSITY_MIN, Math.round(value)))
}

/**
 * CueLevel 通道电平仓库：按 (cueId, fixtureId) 唯一，跨页共享电平设定。
 */
export const useLevelStore = defineStore('level', () => {
  const levels = ref<CueLevel[]>([])
  const hydrated = ref(false)

  const levelsByCue = computed<Record<string, CueLevel[]>>(() => {
    const grouped: Record<string, CueLevel[]> = {}
    levels.value.forEach((level) => {
      if (!grouped[level.cueId]) grouped[level.cueId] = []
      grouped[level.cueId].push(level)
    })
    return grouped
  })

  function levelsOfCue(cueId: string): CueLevel[] {
    return levelsByCue.value[cueId] ?? []
  }

  function levelOf(cueId: string, fixtureId: string): CueLevel | null {
    return levels.value.find((level) => level.cueId === cueId && level.fixtureId === fixtureId) ?? null
  }

  /** 通道平均亮度，用于灯位配置台展示通道芯片的亮度 */
  function averageIntensityOfFixture(fixtureId: string): number | null {
    const matched = levels.value.filter((level) => level.fixtureId === fixtureId)
    if (matched.length === 0) return null
    const total = matched.reduce((sum, level) => sum + level.intensity, 0)
    return Math.round(total / matched.length)
  }

  function countOfCue(cueId: string): number {
    return levelsOfCue(cueId).length
  }

  async function hydrate(): Promise<void> {
    levels.value = await db.levels.toArray()
    hydrated.value = true
  }

  /** 电平改动经 Cue 反查场次，有进行中现场时记一条待生效标记 */
  async function notifyLiveEdit(cueId: string, fixtureId: string, kind: 'level-upsert' | 'level-remove'): Promise<void> {
    const sessionId = useCueStore().cueById(cueId)?.sessionId
    if (!sessionId) return
    await useLiveStore().noteConsoleEdit(sessionId, { kind, cueId, fixtureId })
  }

  async function upsertLevel(cueId: string, fixtureId: string, patch: CueLevelPatch): Promise<CueLevel> {
    const existing = levelOf(cueId, fixtureId)
    const now = Date.now()
    if (existing) {
      const next: CueLevel = {
        ...existing,
        intensity: patch.intensity === undefined ? existing.intensity : clampIntensity(patch.intensity),
        colorTempK: patch.colorTempK === undefined ? existing.colorTempK : Math.round(patch.colorTempK),
        focusNote: patch.focusNote === undefined ? existing.focusNote : patch.focusNote,
        updatedAt: now
      }
      await db.levels.put(next)
      levels.value = levels.value.map((level) => (level.id === next.id ? next : level))
      await notifyLiveEdit(cueId, fixtureId, 'level-upsert')
      return next
    }
    const created: CueLevel = {
      id: createId('lvl'),
      cueId,
      fixtureId,
      intensity: clampIntensity(patch.intensity ?? 0),
      colorTempK: Math.round(patch.colorTempK ?? 3200),
      focusNote: patch.focusNote ?? '',
      updatedAt: now
    }
    await db.levels.put(created)
    levels.value = [...levels.value, created]
    await notifyLiveEdit(cueId, fixtureId, 'level-upsert')
    return created
  }

  async function removeLevel(cueId: string, fixtureId: string): Promise<void> {
    const target = levelOf(cueId, fixtureId)
    if (!target) return
    await db.levels.delete(target.id)
    levels.value = levels.value.filter((level) => level.id !== target.id)
    await notifyLiveEdit(cueId, fixtureId, 'level-remove')
  }

  async function removeByCue(cueId: string): Promise<void> {
    const ids = levelsOfCue(cueId).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => level.cueId !== cueId)
  }

  async function removeByFixture(fixtureId: string): Promise<void> {
    const ids = levels.value.filter((level) => level.fixtureId === fixtureId).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => level.fixtureId !== fixtureId)
  }

  async function removeByCues(cueIds: readonly string[]): Promise<void> {
    const removing = new Set(cueIds)
    const ids = levels.value.filter((level) => removing.has(level.cueId)).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => !removing.has(level.cueId))
  }

  return {
    levels,
    hydrated,
    levelsByCue,
    levelsOfCue,
    levelOf,
    averageIntensityOfFixture,
    countOfCue,
    hydrate,
    upsertLevel,
    removeLevel,
    removeByCue,
    removeByFixture,
    removeByCues
  }
})
