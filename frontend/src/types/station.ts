/**
 * 修复工位（RepairStation）数据模型
 * 修复室侧的工位台账：每个工位每天最多修复几件（dailyCapacity）。
 * 旧数据的工位没有每日件数字段，v3 升级时按 DEFAULT_STATION_DAILY_CAPACITY 回填。
 */

/** 旧工位数据缺每日件数时升级回填的默认值 */
export const DEFAULT_STATION_DAILY_CAPACITY = 2;

export interface RepairStation {
  id: string;
  /** 工位编号，如「修字一号」 */
  name: string;
  /** 负责人 / 修复师 */
  keeper: string;
  /** 备注（擅长纸绢、装裱方向等） */
  note: string;
  /** 每日能修几件：工位当天容量上限，在修拓本不腾位 */
  dailyCapacity: number;
  /** 是否停用（停用工位不参与新排期，已在修的单子不受影响） */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RepairStationDraft = Omit<RepairStation, 'id' | 'createdAt' | 'updatedAt'>;

/** 规范化每日件数：正整数，非法值回落为默认件数 */
export function normalizeDailyCapacity(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 1) return DEFAULT_STATION_DAILY_CAPACITY;
  return Math.max(1, Math.trunc(num));
}

export function createEmptyStationDraft(): RepairStationDraft {
  return {
    name: '',
    keeper: '',
    note: '',
    dailyCapacity: DEFAULT_STATION_DAILY_CAPACITY,
    enabled: true,
  };
}
