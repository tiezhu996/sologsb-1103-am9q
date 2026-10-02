import type { CueTrigger } from '@/types/cue'

/** 现场状态：未开演 / 进行中 / 已结束（结束后待生效改动尚未带入下一场） */
export const RUN_STATUSES = ['idle', 'live', 'ended'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** 现场日志动作类型：GO 推进 / 跳演 / 回退 / 开演 / 结束 */
export const RUN_ACTIONS = ['start', 'go', 'jump', 'back', 'end'] as const
export type RunActionType = (typeof RUN_ACTIONS)[number]

/** 开演时刻固定下来的单通道电平快照 */
export interface RunChannelSnapshot {
  fixtureId: string
  channel: number
  intensity: number
  colorTempK: number
}

/** 开演时刻固定下来的单条 Cue：顺序、过渡参数与通道电平一并冻结 */
export interface RunCueSnapshot {
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  fadeOutSec: number
  holdSec: number
  note: string
  channels: RunChannelSnapshot[]
}

/** 现场日志条目，只记录运行动作，不回写编排数据 */
export interface RunLogEntry {
  /** 日志内自增序号（从 1 开始），同时作为幂等去重的位次依据 */
  seq: number
  action: RunActionType
  /** 动作发生时间戳（毫秒） */
  at: number
  /** 动作后当前提示在快照序列中的位次（0 基）；start 之前为 -1 */
  cueIndex: number
  cueId: string | null
  cueNo: string | null
  label: string | null
  /** 跳演目标 / 回退来源等说明 */
  detail: string
  /** 同一动作的确认令牌：重复提交相同令牌不重复记日志 */
  idempotencyKey: string
}

/** 现场冲突类型：当前提示在编排台被删，或其通道在灯位台失效 */
export type RunConflictKind = 'cue-deleted' | 'fixture-invalid'

/** 现场当前提示与编排台现状的一条冲突 */
export interface RunConflict {
  kind: RunConflictKind
  cueId: string
  cueNo: string
  /** 通道类冲突的灯位通道 id */
  fixtureId?: string
  channel?: number
  message: string
}

/**
 * 现场运行（LiveRun）：一次开演的完整现场状态。
 * 运行单与编排台分离：快照在开演时固定，运行动作只追加日志；
 * 编排台的改动经 pendingCueIds / pendingFixtureIds 标记为下一场待生效。
 */
export interface LiveRun {
  /** 主键，与所属场次 id 相同（一场同时至多一场运行） */
  id: string
  sessionId: string
  status: RunStatus
  /** 开演时间戳（毫秒） */
  startedAt: number
  /** 结束时间戳（毫秒）；未结束为 null */
  endedAt: number | null
  /** 开演时固定的本次顺序与电平 */
  cueSnapshots: RunCueSnapshot[]
  /** 已确认日志（检查点之后的状态以日志为准） */
  logs: RunLogEntry[]
  /** 最后一次确认动作后的当前提示位次（0 基），开演未 GO 时为 -1 */
  currentIndex: number
  /** 最后一条日志的确认令牌，用于重复 GO 去重 */
  lastIdempotencyKey: string | null
  /** 最后一次成功写入（检查点）的时间戳 */
  checkpointAt: number | null
  /** 最近一次写入失败的信息；恢复成功后清空 */
  lastWriteError: string | null
  /** 开演后编排台改动过的 Cue，下一场待生效 */
  pendingCueIds: string[]
  /** 开演后编排台改动过的灯位通道（删除 / 通道号变更等），下一场待生效 */
  pendingFixtureIds: string[]
  /** 结束现场时带入下一场的确认时间；未确认为 null */
  appliedAt: number | null
  updatedAt: number
}
