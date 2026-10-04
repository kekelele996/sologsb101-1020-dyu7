/**
 * 修复排期 slice（Redux Toolkit）
 * 对接编目室台账与修复室工位 / 修复单：
 * - 编目员送修（落 pending 修复单，快照损泐条数与版次）
 * - 修复室按工位每日件数排期（损泐重的先排，逐单落库，在修单不腾位）
 * - 编目员撤回待排单；修复室点头退回在修单
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createId, db } from '@/utils/db';
import {
  canReturn,
  canWithdraw,
  compareRepairPriority,
  damageByRubbing,
  planSchedule,
} from '@/utils/repair';
import { normalizeDailyCapacity, type RepairStation, type RepairStationDraft } from '@/types/station';
import { todayText, type RepairOrder, type RepairOrderStatus } from '@/types/repair';
import type { RootState } from './store';

export interface RepairFilters {
  keyword: string;
  statuses: RepairOrderStatus[];
  steleId: string | null;
}

export interface ScheduleSummary {
  scheduleDate: string;
  /** 本次排上的修复单 id */
  assigned: string[];
  /** 仍在排队的待排单 id（容量到顶或中途失败） */
  waiting: string[];
  /** 中途失败时停留的修复单 id（已排的留存，等重试） */
  failedId: string | null;
}

export interface RepairState {
  stations: RepairStation[];
  orders: RepairOrder[];
  loading: boolean;
  ready: boolean;
  error: string;
  filters: RepairFilters;
}

const initialState: RepairState = {
  stations: [],
  orders: [],
  loading: false,
  ready: false,
  error: '',
  filters: { keyword: '', statuses: [], steleId: null },
};

export const loadRepairs = createAsyncThunk('repair/load', async () => {
  const [stations, orders] = await Promise.all([db.repairStations.toArray(), db.repairOrders.toArray()]);
  stations.sort((a, b) => a.createdAt - b.createdAt);
  orders.sort((a, b) => {
    if (a.status === b.status) return compareRepairPriority(a, b);
    // 在修 → 待排 → 已退回
    const weight: Record<RepairOrderStatus, number> = { active: 0, pending: 1, returned: 2 };
    return weight[a.status] - weight[b.status];
  });
  return { stations, orders };
});

/* ------------------------------ 工位 ------------------------------ */

export const createStation = createAsyncThunk(
  'station/create',
  async (draft: RepairStationDraft, { dispatch }) => {
    const now = Date.now();
    const row: RepairStation = {
      ...draft,
      dailyCapacity: normalizeDailyCapacity(draft.dailyCapacity),
      id: createId('station'),
      createdAt: now,
      updatedAt: now,
    };
    await db.repairStations.put(row);
    await dispatch(loadRepairs());
    return row;
  },
);

export const updateStation = createAsyncThunk(
  'station/update',
  async (payload: { id: string; patch: Partial<RepairStationDraft> }, { dispatch }) => {
    const patch = { ...payload.patch };
    if (patch.dailyCapacity !== undefined) patch.dailyCapacity = normalizeDailyCapacity(patch.dailyCapacity);
    await db.repairStations.update(payload.id, { ...patch, updatedAt: Date.now() } as never);
    await dispatch(loadRepairs());
  },
);

/** 工位上还有在修单时不能删（在修拓本不能被挤下去），只能停用 */
export const removeStation = createAsyncThunk<string, string, { rejectValue: Error }>(
  'station/remove',
  async (id, { rejectWithValue, dispatch }) => {
    const activeCount = await db.repairOrders
      .where('stationId')
      .equals(id)
      .filter((row) => row.status === 'active')
      .count();
    if (activeCount > 0) return rejectWithValue(new Error(`该工位还有 ${activeCount} 件在修拓本，不能删除，可改为停用`));
    await db.repairStations.delete(id);
    await dispatch(loadRepairs());
    return id;
  },
);

/* ------------------------------ 修复单 ------------------------------ */

export interface SendRepairPayload {
  rubbingIds: string[];
  requester: string;
  reason: string;
}

/** 编目员送修：损泐字位多、版次早的拓本落待排单（带损泐快照） */
export const sendRepair = createAsyncThunk<
  { created: string[]; skipped: number },
  SendRepairPayload,
  { rejectValue: Error }
>('repair/send', async (payload, { rejectWithValue, dispatch }) => {
    if (payload.rubbingIds.length === 0) return rejectWithValue(new Error('请先勾选要送修的拓本'));
    const [rubbings, losses, existOrders] = await Promise.all([
      db.rubbings.where('id').anyOf(payload.rubbingIds).toArray(),
      db.losses.toArray(),
      db.repairOrders.toArray(),
    ]);
    const damageMap = damageByRubbing(losses);
    const occupied = new Set(
      existOrders.filter((order) => order.status === 'pending' || order.status === 'active').map((order) => order.rubbingId),
    );
    const nextSeq = existOrders.reduce((max, order) => Math.max(max, order.queueSeq), 0);
    const now = Date.now();
    const rows: RepairOrder[] = rubbings
      .filter((rubbing) => !occupied.has(rubbing.id))
      .map((rubbing, index) => {
        const damage = damageMap.get(rubbing.id) ?? { lossCount: 0, severityScore: 0 };
        return {
          id: createId('ro'),
          rubbingId: rubbing.id,
          steleId: rubbing.steleId,
          scheduleDate: '',
          lossCount: damage.lossCount,
          versionNo: rubbing.versionNo,
          severityScore: damage.severityScore,
          requester: payload.requester.trim() || '编目员',
          reason: payload.reason.trim(),
          queueSeq: nextSeq + index + 1,
          status: 'pending' as RepairOrderStatus,
          stationId: '',
          repairer: '',
          returnNote: '',
          lastScheduledAt: 0,
          createdAt: now + index,
          updatedAt: now + index,
        };
      });
    if (rows.length === 0) return rejectWithValue(new Error('所选拓本都已有待排或在修的修复单'));
    await db.repairOrders.bulkPut(rows);
    await dispatch(loadRepairs());
    return { created: rows.map((row) => row.id), skipped: payload.rubbingIds.length - rows.length };
  },
);

export interface ScheduleFailure {
  summary: ScheduleSummary;
  message: string;
}

/**
 * 执行排期：按「损泐条数 → 严重度 → 版次」贪心填工位当日剩余容量。
 * 每排上一单单独落库：中途失败时已排的留着、未排的继续待排，重试从库内现状重算。
 */
export const runRepairSchedule = createAsyncThunk<
  ScheduleSummary,
  { scheduleDate?: string },
  { rejectValue: ScheduleFailure }
>('repair/schedule', async (payload, { dispatch, rejectWithValue }) => {
  const scheduleDate = payload.scheduleDate || todayText();
  const [stations, orders] = await Promise.all([db.repairStations.toArray(), db.repairOrders.toArray()]);
  const pending = orders.filter((order) => order.status === 'pending');
  const active = orders.filter((order) => order.status === 'active');
  const plan = planSchedule(pending, active, stations, scheduleDate);

  const assigned: string[] = [];
  let failedId: string | null = null;
  let failureMessage = '';
  for (const [id, stationId] of plan.assignments) {
    try {
      // 逐单事务：一单失败不回滚已排上的单子
      await db.transaction('rw', db.repairOrders, async () => {
        const fresh = await db.repairOrders.get(id);
        if (!fresh) throw new Error('修复单不存在或已被撤回');
        if (fresh.status !== 'pending') throw new Error('修复单状态已变化');
        const now = Date.now();
        await db.repairOrders.put({
          ...fresh,
          status: 'active',
          stationId,
          scheduleDate,
          lastScheduledAt: now,
          updatedAt: now,
        });
      });
      assigned.push(id);
    } catch (error) {
      failedId = id;
      failureMessage = error instanceof Error ? error.message : '排期落单失败';
      break;
    }
  }

  await dispatch(loadRepairs());
  const waiting = (await db.repairOrders.where('status').equals('pending').toArray()).map((row) => row.id);
  const summary: ScheduleSummary = { scheduleDate, assigned, waiting, failedId };
  if (failedId) return rejectWithValue({ summary, message: failureMessage });
  return summary;
});

/** 编目员撤回：仅待排单可撤（直接收回，不留单） */
export const withdrawRepairOrder = createAsyncThunk<string, string, { rejectValue: Error }>(
  'repair/withdraw',
  async (id, { rejectWithValue, dispatch }) => {
    const order = await db.repairOrders.get(id);
    if (!order) return rejectWithValue(new Error('修复单不存在'));
    if (!canWithdraw(order)) return rejectWithValue(new Error('只有待排的修复单能由编目员撤回'));
    await db.repairOrders.delete(id);
    await dispatch(loadRepairs());
    return id;
  },
);

export interface ReturnOrderPayload {
  id: string;
  repairer: string;
  returnNote: string;
}

/** 修复室点头退回：仅在修单可退，回填修复师与退回意见 */
export const returnRepairOrder = createAsyncThunk<
  string,
  ReturnOrderPayload,
  { rejectValue: Error }
>('repair/return', async (payload, { rejectWithValue, dispatch }) => {
  const order = await db.repairOrders.get(payload.id);
  if (!order) return rejectWithValue(new Error('修复单不存在'));
  if (!canReturn(order)) return rejectWithValue(new Error('只有在修的修复单能由修复室退回'));
  const now = Date.now();
  await db.repairOrders.put({
    ...order,
    status: 'returned',
    repairer: payload.repairer.trim(),
    returnNote: payload.returnNote.trim(),
    updatedAt: now,
  });
  await dispatch(loadRepairs());
  return payload.id;
});

const repairSlice = createSlice({
  name: 'repair',
  initialState,
  reducers: {
    setRepairKeyword(state, action: PayloadAction<string>) {
      state.filters.keyword = action.payload;
    },
    setRepairStatuses(state, action: PayloadAction<RepairOrderStatus[]>) {
      state.filters.statuses = action.payload;
    },
    setRepairSteleFilter(state, action: PayloadAction<string | null>) {
      state.filters.steleId = action.payload;
    },
    resetRepairFilters(state) {
      state.filters = { keyword: '', statuses: [], steleId: null };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadRepairs.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadRepairs.fulfilled, (state, action) => {
        state.stations = action.payload.stations;
        state.orders = action.payload.orders;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadRepairs.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '修复排期读取失败';
      });
  },
});

export const { setRepairKeyword, setRepairStatuses, setRepairSteleFilter, resetRepairFilters } = repairSlice.actions;

export const selectRepairState = (state: RootState): RepairState => state.repair;
export const selectRepairStations = (state: RootState): RepairStation[] => state.repair.stations;
export const selectRepairOrders = (state: RootState): RepairOrder[] => state.repair.orders;

/** 待排队列：严格按排期优先级 */
export function selectPendingQueue(state: RootState): RepairOrder[] {
  return state.repair.orders.filter((order) => order.status === 'pending').sort(compareRepairPriority);
}

/** 某拓本是否已有未完结修复单（待排 / 在修） */
export function selectOccupiedRubbingIds(state: RootState): Set<string> {
  return new Set(
    state.repair.orders
      .filter((order) => order.status === 'pending' || order.status === 'active')
      .map((order) => order.rubbingId),
  );
}

/** 各工位在某日的占用 / 剩余名额 */
export function selectStationUsage(
  state: RootState,
  scheduleDate: string,
): Array<{ station: RepairStation; used: number; remaining: number }> {
  const usedMap = new Map<string, number>();
  state.repair.orders
    .filter((order) => order.status === 'active' && order.scheduleDate === scheduleDate)
    .forEach((order) => {
      if (order.stationId) usedMap.set(order.stationId, (usedMap.get(order.stationId) ?? 0) + 1);
    });
  return [...state.repair.stations]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((station) => {
      const used = usedMap.get(station.id) ?? 0;
      return { station, used, remaining: station.enabled ? Math.max(0, station.dailyCapacity - used) : 0 };
    });
}

/** 派生选择器：关键字 + 状态 + 碑刻过滤 */
export function selectFilteredRepairOrders(state: RootState): RepairOrder[] {
  const { orders, filters } = state.repair;
  const keyword = filters.keyword.trim();
  return orders.filter((order) => {
    if (filters.steleId !== null && order.steleId !== filters.steleId) return false;
    if (filters.statuses.length > 0 && !filters.statuses.includes(order.status)) return false;
    if (keyword.length > 0) {
      const haystack = `${order.requester}${order.reason}${order.repairer}${order.returnNote}${order.scheduleDate}`;
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

export default repairSlice.reducer;
