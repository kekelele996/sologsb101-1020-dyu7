/**
 * 修复单（RepairOrder）数据模型
 * 编目室把损泐重、版次早的拓本送修，修复室按工位每日容量排期；
 * 排上即落一份修复单（active），容量到顶则排队待排（pending）。
 *
 * 权限约定：
 * - pending（待排）：还没排上，编目员可自行撤回（withdraw）。
 * - active（在修）：已上修复单，必须修复室点头才能退回（return）。
 * - returned（已退回）：终态留痕。
 */

/** 修复单状态：待排 / 在修 / 已退回 */
export type RepairOrderStatus = 'pending' | 'active' | 'returned';

export interface RepairOrder {
  id: string;
  /** 送修拓本 id */
  rubbingId: string;
  /** 所属碑刻 id（拓本删除时便于清理） */
  steleId: string;
  /** 排期日期 yyyy-MM-dd（排上工位的当天） */
  scheduleDate: string;
  /** 损泐字位条数：排期优先级依据之一，落单时快照 */
  lossCount: number;
  /** 拓本版次：版次早的优先（versionNo 小者先） */
  versionNo: number;
  /** 损泐严重度合计权重：条数相同时重损多者先 */
  severityScore: number;
  /** 送修人（编目员） */
  requester: string;
  /** 送修说明 */
  reason: string;
  /** 待排排队序号：同一次送修 / 重试中保持先后，小者先 */
  queueSeq: number;
  /** 单据状态 */
  status: RepairOrderStatus;
  /** 排上后的工位 id；pending 时为空串 */
  stationId: string;
  /** 修复师（接收人，可在排上后补登） */
  repairer: string;
  /** 退回备注（修复室点头退回时填写） */
  returnNote: string;
  /** 最近一次排期尝试时间；中途失败时已排的留着、未排的留 pending 等重试 */
  lastScheduledAt: number;
  createdAt: number;
  updatedAt: number;
}

export type RepairOrderDraft = Omit<
  RepairOrder,
  'id' | 'createdAt' | 'updatedAt' | 'status' | 'stationId' | 'repairer' | 'returnNote' | 'lastScheduledAt' | 'queueSeq'
>;

export const REPAIR_ORDER_STATUS_LABEL: Record<RepairOrderStatus, string> = {
  pending: '待排',
  active: '在修',
  returned: '已退回',
};

export const REPAIR_ORDER_STATUS_COLOR: Record<RepairOrderStatus, string> = {
  pending: '#c9963c',
  active: '#2f6f4f',
  returned: '#8c8c8c',
};

export const REPAIR_ORDER_STATUS_OPTIONS: ReadonlyArray<{ value: RepairOrderStatus; label: string }> = [
  { value: 'pending', label: '待排' },
  { value: 'active', label: '在修' },
  { value: 'returned', label: '已退回' },
];

export function todayText(): string {
  return new Date().toISOString().slice(0, 10);
}
