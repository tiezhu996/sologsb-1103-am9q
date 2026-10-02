import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { LiveConflict, LiveCueSnapshot, LiveEditPayload, LiveLogEntry, LiveRun } from '@/types/live'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'

/** 现场动作（会推动光标的日志类型） */
type LiveActionType = 'go' | 'skip' | 'back'

/** 现场运行单统计（历史场次卡片展示用） */
export interface LiveRunStat {
  goCount: number
  skipCount: number
  backCount: number
  editCount: number
  conflictCount: number
}

/**
 * 现场运行仓库：与 Cue 编排台分离的现场执行层。
 * - 开演时把顺序与电平冻结进运行单快照，之后编排台改动不影响本场；
 * - GO / 跳演 / 回退只追加现场日志并推进检查点，不写编排数据；
 * - 日志是唯一事实来源，写入失败后按检查点回放恢复；
 * - 编排台改动记为待生效标记，结束现场时确认一次带入下一场。
 */
export const useLiveStore = defineStore('live', () => {
  // 运行单含嵌套快照（cues/levels），日志含嵌套改动说明：
  // 用 shallowRef 保持对象为纯数据，避免 Vue 深响应式代理无法被 IndexedDB 结构化克隆；
  // 所有更新都走整体替换（不可变更新），触发依赖不成问题。
  const runs = shallowRef<LiveRun[]>([])
  const logs = shallowRef<LiveLogEntry[]>([])
  const hydrated = ref(false)
  /** 动作串行标记：上一次 GO / 跳演 / 回退未落库前忽略新动作，重复 GO 不会重复记录 */
  const acting = ref(false)

  /** 写队列：所有日志追加串行执行，保证 seq 单调递增 */
  let writeQueue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /* ---------------- 查询 ---------------- */

  function runById(id: string): LiveRun | null {
    return runs.value.find((run) => run.id === id) ?? null
  }

  function runsOfSession(sessionId: string): LiveRun[] {
    return runs.value
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => b.runSeq - a.runSeq)
  }

  /** 某场次进行中的现场（同时最多一场） */
  function activeRunOf(sessionId: string): LiveRun | null {
    return runs.value.find((run) => run.sessionId === sessionId && run.status === 'running') ?? null
  }

  function logsOfRun(runId: string): LiveLogEntry[] {
    return logs.value.filter((entry) => entry.runId === runId).sort((a, b) => a.seq - b.seq)
  }

  /** 当前提示快照；尚未 GO 时返回 null */
  function currentCueOf(run: LiveRun): LiveCueSnapshot | null {
    if (run.cursor < 0 || run.cursor >= run.cues.length) return null
    return run.cues[run.cursor]
  }

  /** 待生效改动：最近一次「带入下一场」之后的编排台改动 */
  function pendingOf(runId: string): LiveLogEntry[] {
    const entries = logsOfRun(runId)
    let lastCarrySeq = 0
    entries.forEach((entry) => {
      if (entry.type === 'carryover') lastCarrySeq = entry.seq
    })
    return entries.filter((entry) => entry.type === 'edit' && entry.seq > lastCarrySeq)
  }

  function statOf(runId: string): LiveRunStat {
    const stat: LiveRunStat = { goCount: 0, skipCount: 0, backCount: 0, editCount: 0, conflictCount: 0 }
    logsOfRun(runId).forEach((entry) => {
      if (entry.type === 'go') stat.goCount += 1
      else if (entry.type === 'skip') stat.skipCount += 1
      else if (entry.type === 'back') stat.backCount += 1
      else if (entry.type === 'edit') stat.editCount += 1
      else if (entry.type === 'conflict') stat.conflictCount += 1
    })
    return stat
  }

  /**
   * 当前提示的现场冲突：提示被删或通道失效时保留快照状态，仅列出冲突。
   * 响应式读取编排台数据，编排台一改即刷新。
   */
  function conflictsOf(runId: string): LiveConflict[] {
    const run = runById(runId)
    if (!run || run.status !== 'running') return []
    const current = currentCueOf(run)
    if (!current) return []
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const conflicts: LiveConflict[] = []

    if (!cueStore.cueById(current.cueId)) {
      conflicts.push({
        key: `cue-removed:${current.cueId}`,
        kind: 'cue-removed',
        message: `当前提示 ${current.cueNo} 已在编排台删除，现场仍按开演快照执行`
      })
    }
    current.levels.forEach((level) => {
      const fixture = fixtureStore.fixtureById(level.fixtureId)
      if (!fixture) {
        conflicts.push({
          key: `channel-missing:${level.fixtureId}`,
          kind: 'channel-missing',
          message: `CH${level.channel} 通道已失效（灯位通道被删除），现场电平保留 ${level.intensity}%`
        })
      } else if (fixture.channel !== level.channel) {
        conflicts.push({
          key: `channel-renumbered:${level.fixtureId}`,
          kind: 'channel-renumbered',
          message: `CH${level.channel} 在编排台已改号为 CH${fixture.channel}，现场仍按快照 CH${level.channel} 执行`
        })
      }
    })
    return conflicts
  }

  /* ---------------- 日志追加（内部） ---------------- */

  /** 把一条日志与运行单检查点落库，成功后同步内存；失败时按检查点回放恢复 */
  async function appendEntry(
    runId: string,
    input: Pick<LiveLogEntry, 'type' | 'note'> &
      Partial<Pick<LiveLogEntry, 'actionId' | 'cursorAfter' | 'cursorBefore' | 'targetIndex' | 'targetCueNo' | 'edit' | 'conflictKey'>>
  ): Promise<LiveLogEntry | null> {
    const run = runById(runId)
    if (!run) return null

    const actionId = input.actionId ?? createId('act')
    // 幂等：同一 actionId 已落库（重试 / 重复 GO）时直接返回已有条目
    const duplicated = logs.value.find((entry) => entry.runId === runId && entry.actionId === actionId)
    if (duplicated) return duplicated

    const entry: LiveLogEntry = {
      id: createId('log'),
      runId,
      seq: run.lastSeq + 1,
      type: input.type,
      actionId,
      cursorAfter: input.cursorAfter ?? null,
      cursorBefore: input.cursorBefore ?? null,
      targetIndex: input.targetIndex ?? null,
      targetCueNo: input.targetCueNo ?? '',
      edit: input.edit ?? null,
      conflictKey: input.conflictKey ?? '',
      note: input.note,
      at: Date.now()
    }
    const nextRun: LiveRun = {
      ...run,
      cursor: entry.cursorAfter ?? run.cursor,
      lastSeq: entry.seq,
      checkpointSeq: entry.seq
    }

    try {
      // 先写日志（事实来源），再推进运行单检查点
      await db.liveLogs.put(entry)
      await db.liveRuns.put(nextRun)
    } catch (error) {
      // 写入失败：以库内检查点为准回放恢复，内存回到最后一次确认动作
      await recoverRun(runId).catch((recoverError) => {
        console.warn('[gbcuesheet] 现场恢复未能完成，将在下次启动时重试：', recoverError)
      })
      throw error
    }

    logs.value = [...logs.value, entry]
    runs.value = runs.value.map((item) => (item.id === runId ? nextRun : item))
    return entry
  }

  /** 新出现的冲突补记一条日志（同一冲突键只记一次） */
  async function syncConflicts(runId: string): Promise<void> {
    const logged = new Set(
      logsOfRun(runId)
        .filter((entry) => entry.type === 'conflict')
        .map((entry) => entry.conflictKey)
    )
    for (const conflict of conflictsOf(runId)) {
      if (logged.has(conflict.key)) continue
      await enqueue(() =>
        appendEntry(runId, {
          type: 'conflict',
          conflictKey: conflict.key,
          note: conflict.message
        })
      )
    }
  }

  /* ---------------- 开演 / 结束 ---------------- */

  /** 开演：把当前 Cue 顺序与通道电平冻结进运行单快照 */
  async function openRun(sessionId: string): Promise<LiveRun | null> {
    if (activeRunOf(sessionId)) return null
    const cueStore = useCueStore()
    const levelStore = useLevelStore()
    const fixtureStore = useFixtureStore()
    const fixtures = fixtureStore.fixturesOfSession(sessionId)

    const cues: LiveCueSnapshot[] = cueStore.sortedCuesOfSession(sessionId).map((cue) => ({
      cueId: cue.id,
      cueNo: cue.cueNo,
      label: cue.label,
      trigger: cue.trigger,
      fadeInSec: cue.fadeInSec,
      fadeOutSec: cue.fadeOutSec,
      holdSec: cue.holdSec,
      note: cue.note,
      levels: levelStore
        .levelsOfCue(cue.id)
        .map((level) => {
          const fixture = fixtures.find((item) => item.id === level.fixtureId)
          if (!fixture) return null
          return {
            fixtureId: fixture.id,
            channel: fixture.channel,
            position: fixture.position,
            intensity: level.intensity,
            colorTempK: level.colorTempK
          }
        })
        .filter((level): level is NonNullable<typeof level> => level !== null)
        .sort((a, b) => a.channel - b.channel)
    }))

    const now = Date.now()
    const run: LiveRun = {
      id: createId('run'),
      sessionId,
      runSeq: runsOfSession(sessionId).length + 1,
      status: 'running',
      cues,
      cursor: -1,
      lastSeq: 0,
      checkpointSeq: 0,
      startedAt: now,
      endedAt: null
    }
    await db.liveRuns.put(run)
    runs.value = [...runs.value, run]
    await enqueue(() =>
      appendEntry(run.id, {
        type: 'open',
        note: `开演：固定 ${cues.length} 条 Cue 的顺序与电平，之后编排台改动标记为下一场待生效`
      })
    )
    return runById(run.id)
  }

  /**
   * 结束现场：确认后把待生效改动一次带入下一场（下一场开演快照即含这些改动）。
   * 旧排演表快照不受影响。
   */
  async function endRun(runId: string, carryPending: boolean): Promise<void> {
    const run = runById(runId)
    if (!run || run.status !== 'running') return
    if (carryPending) {
      const pending = pendingOf(runId)
      if (pending.length > 0) {
        await enqueue(() =>
          appendEntry(runId, {
            type: 'carryover',
            note: `确认将 ${pending.length} 条待生效改动一次带入下一场`
          })
        )
      }
    }
    await enqueue(() => appendEntry(runId, { type: 'end', note: '结束现场' }))
    const latest = runById(runId)
    if (!latest) return
    const ended: LiveRun = { ...latest, status: 'ended', endedAt: Date.now() }
    await db.liveRuns.put(ended)
    runs.value = runs.value.map((item) => (item.id === runId ? ended : item))
  }

  /* ---------------- 现场动作：GO / 跳演 / 回退 ---------------- */

  /** 执行现场动作：只记现场日志并推进检查点，不写编排数据 */
  async function execute(runId: string, type: LiveActionType, targetIndex: number): Promise<LiveLogEntry | null> {
    if (acting.value) return null
    const run = runById(runId)
    if (!run || run.status !== 'running') return null
    if (targetIndex < 0 || targetIndex >= run.cues.length || targetIndex === run.cursor) return null

    acting.value = true
    const actionId = createId('act')
    try {
      const target = run.cues[targetIndex]
      const note =
        type === 'go'
          ? `GO → ${target.cueNo}${target.label ? `「${target.label}」` : ''}`
          : type === 'skip'
            ? `跳演：${run.cursor >= 0 ? run.cues[run.cursor].cueNo : '开场'} → ${target.cueNo}（跳过 ${targetIndex - run.cursor - 1} 条）`
            : `回退 → ${target.cueNo}`
      return await enqueue(() =>
        appendEntry(runId, {
          type,
          actionId,
          cursorAfter: targetIndex,
          cursorBefore: run.cursor,
          targetIndex,
          targetCueNo: target.cueNo,
          note
        })
      ).then(async (entry) => {
        // 光标移动后重估当前提示的冲突并补记
        await syncConflicts(runId)
        return entry
      })
    } finally {
      acting.value = false
    }
  }

  /** GO：执行下一条 */
  async function go(runId: string): Promise<LiveLogEntry | null> {
    const run = runById(runId)
    if (!run) return null
    return execute(runId, 'go', run.cursor + 1)
  }

  /** 跳演：跳到更靠后的某条，中间条目保持未执行 */
  async function skipTo(runId: string, targetIndex: number): Promise<LiveLogEntry | null> {
    const run = runById(runId)
    if (!run || targetIndex <= run.cursor) return null
    return execute(runId, 'skip', targetIndex)
  }

  /** 回退：回到上一条 */
  async function back(runId: string): Promise<LiveLogEntry | null> {
    const run = runById(runId)
    if (!run || run.cursor <= 0) return null
    return execute(runId, 'back', run.cursor - 1)
  }

  /* ---------------- 编排台改动标记 ---------------- */

  /** 生成改动说明文本（落库后不再变化） */
  function describeEdit(payload: LiveEditPayload): string {
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const cueNo = payload.cueNo ?? (payload.cueId ? cueStore.cueById(payload.cueId)?.cueNo : undefined) ?? '未知 Cue'
    const channel =
      payload.channel ?? (payload.fixtureId ? fixtureStore.fixtureById(payload.fixtureId)?.channel : undefined)
    const channelText = channel !== undefined ? `CH${channel}` : '未知通道'
    switch (payload.kind) {
      case 'cue-add':
        return `插入 ${cueNo}`
      case 'cue-update':
        return payload.detail ? `更新 ${cueNo}（${payload.detail}）` : `更新 ${cueNo}`
      case 'cue-remove':
        return `删除 ${cueNo}`
      case 'cue-reorder':
        return payload.detail ?? '调整 Cue 顺序'
      case 'level-upsert':
        return `调整 ${cueNo} 的 ${channelText} 电平`
      case 'level-remove':
        return `移除 ${cueNo} 的 ${channelText} 电平`
      case 'fixture-add':
        return `配接 ${channelText}`
      case 'fixture-update':
        return `更新 ${channelText} 配接`
      case 'fixture-remove':
        return `删除 ${channelText} 配接`
    }
  }

  /**
   * 编排台改动入口：有进行中现场时只记一条待生效标记，不动运行单快照；
   * 无现场时改动直接生效，无需标记。
   */
  async function noteConsoleEdit(sessionId: string, payload: LiveEditPayload): Promise<void> {
    const run = activeRunOf(sessionId)
    if (!run) return
    const note = describeEdit(payload)
    await enqueue(() =>
      appendEntry(run.id, {
        type: 'edit',
        edit: payload,
        note: `编排台改动（下一场待生效）：${note}`
      })
    )
    await syncConflicts(run.id)
  }

  /* ---------------- 恢复 ---------------- */

  /**
   * 按日志检查点恢复：以库内运行单为检查点，回放其后的日志折入光标，
   * 修复后把新的检查点落库。用于启动载入与写入失败后的自愈。
   */
  async function recoverRun(runId: string): Promise<void> {
    const persistedRun = await db.liveRuns.get(runId)
    if (!persistedRun) return
    const persistedLogs = (await db.liveLogs.where('runId').equals(runId).toArray()).sort((a, b) => a.seq - b.seq)

    let cursor = persistedRun.cursor
    let lastSeq = persistedRun.lastSeq
    persistedLogs.forEach((entry) => {
      if (entry.seq <= persistedRun.checkpointSeq) return
      if ((entry.type === 'go' || entry.type === 'skip' || entry.type === 'back') && entry.cursorAfter !== null) {
        cursor = entry.cursorAfter
      }
      lastSeq = Math.max(lastSeq, entry.seq)
    })

    const repaired: LiveRun = { ...persistedRun, cursor, lastSeq, checkpointSeq: lastSeq }
    if (
      repaired.cursor !== persistedRun.cursor ||
      repaired.lastSeq !== persistedRun.lastSeq ||
      repaired.checkpointSeq !== persistedRun.checkpointSeq
    ) {
      // 库仍不可写时先修复内存状态，下次启动会再次回放自愈
      await db.liveRuns.put(repaired).catch((error) => {
        console.warn('[gbcuesheet] 检查点修复落库失败，已仅恢复内存状态：', error)
      })
    }
    runs.value = runs.value.some((run) => run.id === runId)
      ? runs.value.map((run) => (run.id === runId ? repaired : run))
      : [...runs.value, repaired]
    logs.value = [...logs.value.filter((entry) => entry.runId !== runId), ...persistedLogs]
  }

  /** 启动载入：读入运行单与日志，进行中的现场按检查点回放到最后一次确认动作 */
  async function hydrate(): Promise<void> {
    runs.value = await db.liveRuns.toArray()
    logs.value = await db.liveLogs.toArray()
    const active = runs.value.filter((run) => run.status === 'running')
    for (const run of active) {
      await recoverRun(run.id)
    }
    hydrated.value = true
  }

  /** 删除场次时级联清理其运行单与日志 */
  async function removeBySession(sessionId: string): Promise<void> {
    const runIds = runs.value.filter((run) => run.sessionId === sessionId).map((run) => run.id)
    if (runIds.length === 0) return
    const removing = new Set(runIds)
    await db.liveRuns.bulkDelete(runIds)
    await db.liveLogs.bulkDelete(logs.value.filter((entry) => removing.has(entry.runId)).map((entry) => entry.id))
    runs.value = runs.value.filter((run) => run.sessionId !== sessionId)
    logs.value = logs.value.filter((entry) => !removing.has(entry.runId))
  }

  const activeRuns = computed(() => runs.value.filter((run) => run.status === 'running'))

  return {
    runs,
    logs,
    hydrated,
    acting,
    activeRuns,
    runById,
    runsOfSession,
    activeRunOf,
    logsOfRun,
    currentCueOf,
    pendingOf,
    statOf,
    conflictsOf,
    openRun,
    endRun,
    go,
    skipTo,
    back,
    noteConsoleEdit,
    recoverRun,
    hydrate,
    removeBySession
  }
})
