/**
 * 送修排期算法（纯函数，不触碰 IndexedDB）
 *
 * 规则：
 * 1. 编目员送修优先级：损泐字位多者先 → 损泐重者先 → 版次早者先（versionNo 小）→ 排队序号 / 送修时间先。
 * 2. 修复室按「工位 × 当天」容量排：每个工位当天已在修的单子占位不退，
 *    剩余名额 = dailyCapacity − 当天在修单数；按优先级把待排单子依次塞进有余量的工位。
 * 3. 已经在修的拓本不会被新来的挤下去（active 单只读重算，不参与再分配）。
 * 4. 容量到顶排不上的继续待排，等腾位 / 重试。
 */
import type { Loss } from '@/types/loss';
import type { RepairOrder } from '@/types/repair';
import type { RepairStation } from '@/types/station';
import { severityWeight } from './collate';

/** 拓本维度的损泐汇总：条数 + 严重度权重和 */
export interface RubbingDamage {
  lossCount: number;
  severityScore: number;
}

/** 汇总某拓本的损泐条数与严重度权重 */
export function summarizeDamage(losses: Loss[]): RubbingDamage {
  return losses.reduce<RubbingDamage>(
    (acc, loss) => ({ lossCount: acc.lossCount + 1, severityScore: acc.severityScore + severityWeight(loss.severity) }),
    { lossCount: 0, severityScore: 0 },
  );
}

/** 按拓本 id 汇总损泐，供送修落单时快照 */
export function damageByRubbing(losses: Loss[]): Map<string, RubbingDamage> {
  const map = new Map<string, RubbingDamage>();
  losses.forEach((loss) => {
    const prev = map.get(loss.rubbingId) ?? { lossCount: 0, severityScore: 0 };
    map.set(loss.rubbingId, {
      lossCount: prev.lossCount + 1,
      severityScore: prev.severityScore + severityWeight(loss.severity),
    });
  });
  return map;
}

/**
 * 送修 / 排期先后比较：
 * 损泐条数多 → 严重度权重高 → 版次早 → 排队序号小 → 送修时间早 → id 兜底。
 * 返回负数表示 a 排在 b 前面。
 */
export function compareRepairPriority(a: RepairOrder, b: RepairOrder): number {
  if (a.lossCount !== b.lossCount) return b.lossCount - a.lossCount;
  if (a.severityScore !== b.severityScore) return b.severityScore - a.severityScore;
  if (a.versionNo !== b.versionNo) return a.versionNo - b.versionNo;
  if (a.queueSeq !== b.queueSeq) return a.queueSeq - b.queueSeq;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export interface StationRemaining {
  station: RepairStation;
  /** 当天剩余名额（不会为负） */
  remaining: number;
}

/**
 * 计算各工位在某天的剩余名额。
 * active 单按 stationId + scheduleDate 占位；停用工位与无容量工位不参与。
 */
export function stationRemaining(
  stations: RepairStation[],
  activeOrders: RepairOrder[],
  scheduleDate: string,
): StationRemaining[] {
  const used = new Map<string, number>();
  activeOrders
    .filter((order) => order.status === 'active' && order.scheduleDate === scheduleDate)
    .forEach((order) => {
      if (!order.stationId) return;
      used.set(order.stationId, (used.get(order.stationId) ?? 0) + 1);
    });
  return stations
    .filter((station) => station.enabled)
    .map((station) => ({
      station,
      remaining: Math.max(0, station.dailyCapacity - (used.get(station.id) ?? 0)),
    }))
    // 名额多的工位优先填，便于集中排期；名额相同按工位创建先后
    .sort((a, b) => (b.remaining === a.remaining ? a.station.createdAt - b.station.createdAt : b.remaining - a.remaining));
}

export interface SchedulePlan {
  /** 排上的修复单 id → 工位 id */
  assignments: Map<string, string>;
  /** 工位满了仍排不上的待排单 id（保持优先级顺序） */
  unassigned: string[];
  /** 各工位剩余名额（分配后） */
  capacity: StationRemaining[];
}

/**
 * 纯排期：给定待排单、在修单与工位，算出哪些待排单能排上、落到哪个工位。
 * 不修改入参；调用方据此逐单落库（中途失败时已排的留存、未排的继续待排）。
 */
export function planSchedule(
  pendingOrders: RepairOrder[],
  activeOrders: RepairOrder[],
  stations: RepairStation[],
  scheduleDate: string,
): SchedulePlan {
  const capacity = stationRemaining(stations, activeOrders, scheduleDate);
  const assignments = new Map<string, string>();
  const unassigned: string[] = [];

  const ordered = [...pendingOrders]
    .filter((order) => order.status === 'pending')
    .sort(compareRepairPriority);

  ordered.forEach((order) => {
    // 已在修的拓本不能被挤下去：同一拓本已有 active 单时不再新派
    const alreadyActive = activeOrders.some(
      (active) => active.status === 'active' && active.rubbingId === order.rubbingId,
    );
    if (alreadyActive) {
      unassigned.push(order.id);
      return;
    }
    const target = capacity.find((slot) => slot.remaining > 0);
    if (!target) {
      unassigned.push(order.id);
      return;
    }
    assignments.set(order.id, target.station.id);
    target.remaining -= 1;
  });

  return { assignments, unassigned, capacity };
}

/** 编目员可撤回：只有还没排上（待排）的单子能撤 */
export function canWithdraw(order: RepairOrder): boolean {
  return order.status === 'pending';
}

/** 修复室可退回：只有已上修复单（在修）的单子，且必须修复室点头 */
export function canReturn(order: RepairOrder): boolean {
  return order.status === 'active';
}
