/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Loss 增加 charNo 与复合索引，并按行号顺序重建历史字位记录
 *   v2 → v3：新增修复室工位与送修单；旧工位补默认每日件数，并回填在修拓本的工位与排期
 * - 七张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Stele } from '@/types/stele';
import type { Rubbing } from '@/types/rubbing';
import type { Loss } from '@/types/loss';
import type { Seal } from '@/types/seal';
import type { Compare } from '@/types/compare';
import type { Workbench } from '@/types/workbench';
import type { RepairOrder } from '@/types/repair';
import { DEFAULT_DAILY_CAPACITY, createDefaultWorkbench } from '@/types/workbench';
import { sortLosses } from './collate';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbrubbing';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbrubbing:db-version',
  lastBackupAt: 'gbrubbing:last-backup-at',
  uiPrefs: 'gbrubbing:ui-prefs',
} as const;

export interface UiPrefs {
  lastSteleId: string | null;
  lastRubbingId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastSteleId: null, lastRubbingId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      lastSteleId: typeof parsed.lastSteleId === 'string' ? parsed.lastSteleId : null,
      lastRubbingId: typeof parsed.lastRubbingId === 'string' ? parsed.lastRubbingId : null,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class RubbingDatabase extends Dexie {
  steles!: Table<Stele, string>;
  rubbings!: Table<Rubbing, string>;
  losses!: Table<Loss, string>;
  seals!: Table<Seal, string>;
  compares!: Table<Compare, string>;
  workbenches!: Table<Workbench, string>;
  repairs!: Table<RepairOrder, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史字位记录仅有 lineNo）
    this.version(1).stores({
      steles: 'id, title, era, form, updatedAt',
      rubbings: 'id, steleId, versionNo, method, state, updatedAt',
      losses: 'id, rubbingId, lineNo, type, severity, updatedAt',
      seals: 'id, rubbingId, sealType, updatedAt',
      compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, updatedAt',
    });

    // v2：Loss 增加 charNo 与 [rubbingId+lineNo+charNo] 复合索引，并按行号顺序重建历史字位记录
    this.version(2)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const table = tx.table<Loss>('losses');
        const all = await table.toArray();
        const byRubbing = new Map<string, Loss[]>();
        all.forEach((loss) => {
          byRubbing.set(loss.rubbingId, [...(byRubbing.get(loss.rubbingId) ?? []), loss]);
        });
        const rebuilt: Loss[] = [];
        byRubbing.forEach((list) => {
          // 按行号排序后，为缺失 charNo 的历史记录在行内顺序补位
          const sorted = [...list].sort((a, b) => a.lineNo - b.lineNo);
          const counter = new Map<number, number>();
          sorted.forEach((loss) => {
            const used = counter.get(loss.lineNo) ?? 0;
            const charNo = typeof loss.charNo === 'number' && loss.charNo > 0 ? loss.charNo : used + 1;
            counter.set(loss.lineNo, Math.max(used, charNo));
            rebuilt.push({ ...loss, charNo, updatedAt: Date.now() });
          });
        });
        await table.bulkPut(sortLosses(rebuilt));
      });

    // v3：修复室工位 + 送修 / 修复单（待排 → 在修 → 完成 / 退回 / 撤回）
    this.version(DB_SCHEMA_VERSION)
      .stores({
        steles: 'id, title, era, form, location, updatedAt',
        rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
        losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
        seals: 'id, rubbingId, sealType, position, updatedAt',
        compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
        workbenches: 'id, name, active, dailyCapacity, updatedAt',
        repairs:
          'id, rubbingId, steleId, status, workbenchId, scheduleDate, queueNo, batchNo, lossWeight, versionNo, updatedAt',
      })
      .upgrade(async (tx) => {
        const stamp = Date.now();

        // —— 工位：旧数据没写每日件数，按现有工位逐个编出默认件数并回填 ——
        const benchTable = tx.table<Workbench>('workbenches');
        const legacyBenches = await salvageBeforeOpen.workbenches;
        if (legacyBenches.length > 0) {
          const repairedBenches = legacyBenches.map((bench) => {
            const valid =
              typeof bench.dailyCapacity === 'number' && Number.isFinite(bench.dailyCapacity) && bench.dailyCapacity > 0;
            return valid
              ? bench
              : {
                  ...bench,
                  dailyCapacity: DEFAULT_DAILY_CAPACITY,
                  active: (bench as Partial<Workbench>).active ?? true,
                  updatedAt: stamp,
                };
          });
          await benchTable.bulkPut(repairedBenches);
        } else {
          // 旧库里没有工位：按修复室现有工位编出默认工位（默认每日件数），当天即可排期
          await benchTable.bulkPut([
            createDefaultWorkbench(1, stamp),
            createDefaultWorkbench(2, stamp),
            createDefaultWorkbench(3, stamp),
          ]);
        }

        // —— 修复单：回填旧记录里缺失的排期字段（在修拓本挂到现有工位上）——
        const repairTable = tx.table<RepairOrder>('repairs');
        const legacyRepairs = await salvageBeforeOpen.repairs;
        const existingBenches = await benchTable.toArray();
        const sortedBenches = [...existingBenches].sort((a, b) => a.createdAt - b.createdAt);
        // 每工位当日已占用数，回填在修单时同样不能超过默认件数
        const used = new Map<string, number>();
        const fixed: RepairOrder[] = [];
        legacyRepairs
          .filter((row) => typeof (row as Partial<RepairOrder>).status === 'string')
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .forEach((row) => {
            const next: RepairOrder = { ...row };
            if (typeof next.lossCount !== 'number') next.lossCount = 0;
            if (typeof next.lossWeight !== 'number') next.lossWeight = 0;
            if (typeof next.versionNo !== 'number') next.versionNo = 1;
            if (typeof next.queueNo !== 'number') next.queueNo = 0;
            if (typeof next.batchNo !== 'number') next.batchNo = 0;
            next.workbenchId = next.workbenchId ?? '';
            next.scheduleDate = next.scheduleDate ?? '';
            next.restorer = next.restorer ?? '';
            next.repairNote = next.repairNote ?? '';
            next.submitter = next.submitter ?? '';
            next.submitDate = next.submitDate ?? '';
            if (next.status === 'scheduled') {
              // 在修拓本回填工位：优先沿用原工位，否则按现有工位顺序找当天还没到顶的
              let target = sortedBenches.find((bench) => bench.id === next.workbenchId && bench.active !== false);
              if (!target) {
                target = sortedBenches.find((bench) => {
                  if (bench.active === false) return false;
                  return (used.get(bench.id) ?? 0) < bench.dailyCapacity;
                });
              }
              if (target) {
                next.workbenchId = target.id;
                used.set(target.id, (used.get(target.id) ?? 0) + 1);
                if (!next.scheduleDate) next.scheduleDate = new Date().toISOString().slice(0, 10);
              }
            }
            fixed.push(next);
          });
        if (fixed.length > 0) await repairTable.bulkPut(fixed);
      });
  }
}

export const db = new RubbingDatabase();

/**
 * 打开主库前的「另记账本」抢救缓存。
 * 修复室的工位、修复单可能早已存在于 IndexedDB 中，却从未登记进 Dexie schema；
 * Dexie 升级时会清空本版本才声明的表，因此必须在 db.open() 之前用独立连接先读出来，
 * 再在 v3 .upgrade() 中回填。升级只发生一次，缓存读取后即清空。
 */
const salvageBeforeOpen: { workbenches: Promise<Workbench[]>; repairs: Promise<RepairOrder[]> } = {
  workbenches: Promise.resolve([]),
  repairs: Promise.resolve([]),
};

/** 用独立（非 Dexie 升级）连接读取物理存在但未登记的旧表 */
function readOrphanStore<T>(storeName: string): Promise<T[]> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (rows: T[]): void => {
      if (settled) return;
      settled = true;
      resolve(rows);
    };
    try {
      const req = indexedDB.open(DB_NAME);
      req.onerror = () => finish([]);
      req.onupgradeneeded = () => {
        // 库或版本尚不存在：没有旧数据可抢救
        try {
          req.result.close();
        } catch {
          /* ignore */
        }
        finish([]);
      };
      req.onsuccess = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(storeName)) {
          idb.close();
          finish([]);
          return;
        }
        try {
          const tx = idb.transaction(storeName, 'readonly');
          const getAll = tx.objectStore(storeName).getAll();
          getAll.onsuccess = () => {
            idb.close();
            finish((getAll.result as T[]) ?? []);
          };
          getAll.onerror = () => {
            idb.close();
            finish([]);
          };
        } catch {
          idb.close();
          finish([]);
        }
      };
    } catch {
      finish([]);
    }
  });
}

/** 在打开 / 升级主库前抢救修复室旧台账（幂等：无旧表时得到空数组） */
export function salvageLegacyRepairTables(): void {
  salvageBeforeOpen.workbenches = readOrphanStore<Workbench>('workbenches');
  salvageBeforeOpen.repairs = readOrphanStore<RepairOrder>('repairs');
}

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  salvageLegacyRepairTables();
  // 必须先等「另记账本」抢救完成再打开：Dexie 升级会清空本版本才声明的表
  await Promise.all([salvageBeforeOpen.workbenches, salvageBeforeOpen.repairs]);
  await db.open();
  stampDbVersion();
  if ((await db.steles.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Stele → Rubbing →（Loss / Seal）＋ Stele → Compare */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const day = 86400000;

  const steles: Stele[] = [
    {
      id: 'stele_01',
      title: '礼器碑',
      era: '东汉永寿二年',
      location: '山东曲阜孔庙',
      form: 'stele',
      sizeCm: '227×93',
      calligrapher: '佚名（隶书）',
      createdAt: now - day * 60,
      updatedAt: now - day * 3,
    },
    {
      id: 'stele_02',
      title: '石门颂',
      era: '东汉建和二年',
      location: '陕西汉中石门',
      form: 'cliff',
      sizeCm: '261×205',
      calligrapher: '王升（隶书）',
      createdAt: now - day * 48,
      updatedAt: now - day * 2,
    },
    {
      id: 'stele_03',
      title: '颜勤礼碑',
      era: '唐大历十四年',
      location: '陕西西安碑林',
      form: 'stele',
      sizeCm: '268×92',
      calligrapher: '颜真卿（楷书）',
      createdAt: now - day * 36,
      updatedAt: now - day,
    },
  ];

  const rubbings: Rubbing[] = [
    { id: 'rub_0101', steleId: 'stele_01', versionNo: 1, method: 'rub', paperType: '宣纸', inkTone: 'thick', sizeCm: '210×88', collectionNo: 'TB-0101', dateGuess: '明拓', state: 'cataloged', createdAt: now - day * 50, updatedAt: now - day * 10 },
    { id: 'rub_0102', steleId: 'stele_01', versionNo: 2, method: 'cicada', paperType: '棉连纸', inkTone: 'light', sizeCm: '208×86', collectionNo: 'TB-0102', dateGuess: '清拓', state: 'toCompare', createdAt: now - day * 44, updatedAt: now - day * 6 },
    { id: 'rub_0201', steleId: 'stele_02', versionNo: 1, method: 'pat', paperType: '皮纸', inkTone: 'thick', sizeCm: '250×196', collectionNo: 'TB-0201', dateGuess: '清中期拓', state: 'cataloged', createdAt: now - day * 40, updatedAt: now - day * 5 },
    { id: 'rub_0202', steleId: 'stele_02', versionNo: 2, method: 'rub', paperType: '棉连纸', inkTone: 'light', sizeCm: '248×194', collectionNo: 'TB-0202', dateGuess: '清晚期拓', state: 'toCatalog', createdAt: now - day * 34, updatedAt: now - day * 4 },
    { id: 'rub_0301', steleId: 'stele_03', versionNo: 1, method: 'rub', paperType: '净皮宣', inkTone: 'thick', sizeCm: '260×90', collectionNo: 'TB-0301', dateGuess: '民国拓', state: 'toCatalog', createdAt: now - day * 20, updatedAt: now - day * 2 },
    { id: 'rub_0103', steleId: 'stele_01', versionNo: 3, method: 'pat', paperType: '罗纹纸', inkTone: 'thick', sizeCm: '206×85', collectionNo: 'TB-0103', dateGuess: '清末拓', state: 'cataloged', createdAt: now - day * 12, updatedAt: now - day * 1 },
  ];

  const losses: Loss[] = [
    { id: 'loss_010101', rubbingId: 'rub_0101', lineNo: 3, charNo: 7, type: 'blur', severity: 'light', note: '「壽」字右下漫漶', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'loss_010102', rubbingId: 'rub_0101', lineNo: 5, charNo: 2, type: 'stoneFlower', severity: 'medium', note: '石花漫及「年」字', createdAt: now - day * 30, updatedAt: now - day * 29 },
    { id: 'loss_010103', rubbingId: 'rub_0101', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字缺末笔', createdAt: now - day * 28, updatedAt: now - day * 28 },
    { id: 'loss_010201', rubbingId: 'rub_0102', lineNo: 3, charNo: 7, type: 'blur', severity: 'medium', note: '晚拓，「壽」字已损', createdAt: now - day * 24, updatedAt: now - day * 24 },
    { id: 'loss_010202', rubbingId: 'rub_0102', lineNo: 9, charNo: 11, type: 'missing', severity: 'heavy', note: '「禮」字全缺', createdAt: now - day * 24, updatedAt: now - day * 22 },
    { id: 'loss_010203', rubbingId: 'rub_0102', lineNo: 12, charNo: 4, type: 'crack', severity: 'medium', note: '碑面斜裂一道', createdAt: now - day * 22, updatedAt: now - day * 22 },
    { id: 'loss_020101', rubbingId: 'rub_0201', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_020201', rubbingId: 'rub_0202', lineNo: 2, charNo: 5, type: 'crack', severity: 'light', note: '崖面细裂（同前）', createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'loss_020202', rubbingId: 'rub_0202', lineNo: 6, charNo: 3, type: 'blur', severity: 'medium', note: '晚拓，「頌」字已漫漶', createdAt: now - day * 18, updatedAt: now - day * 18 },
    { id: 'loss_030101', rubbingId: 'rub_0301', lineNo: 4, charNo: 3, type: 'blur', severity: 'heavy', note: '民国拓，字口已平', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'loss_010301', rubbingId: 'rub_0103', lineNo: 9, charNo: 11, type: 'missing', severity: 'medium', note: '晚拓「禮」字半损', createdAt: now - day * 9, updatedAt: now - day * 9 },
    { id: 'loss_010302', rubbingId: 'rub_0103', lineNo: 14, charNo: 2, type: 'stoneFlower', severity: 'light', note: '石花一点', createdAt: now - day * 9, updatedAt: now - day * 9 },
  ];

  const seals: Seal[] = [
    { id: 'seal_0101', rubbingId: 'rub_0101', sealText: '端方藏碑', position: '右下角', transcription: '端方（匋斋）收藏印', sealType: 'collection', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0102', rubbingId: 'rub_0101', sealText: '匋斋鉴赏', position: '左下角', transcription: '端方鉴赏印', sealType: 'appraisal', createdAt: now - day * 40, updatedAt: now - day * 40 },
    { id: 'seal_0103', rubbingId: 'rub_0102', sealText: '艺风堂', position: '卷尾', transcription: '缪荃孙艺风堂藏书印', sealType: 'collection', createdAt: now - day * 30, updatedAt: now - day * 30 },
    { id: 'seal_0201', rubbingId: 'rub_0201', sealText: '石门旧拓', position: '左上角', transcription: '藏家自钤印', sealType: 'author', createdAt: now - day * 26, updatedAt: now - day * 26 },
  ];

  const compares: Compare[] = [
    { id: 'cmp_0101', steleId: 'stele_01', rubbingIdA: 'rub_0101', rubbingIdB: 'rub_0102', diffCount: 3, conclusion: 'early', operator: '傅砚', date: '2026-03-06', createdAt: now - day * 5, updatedAt: now - day * 5 },
    { id: 'cmp_0201', steleId: 'stele_02', rubbingIdA: 'rub_0201', rubbingIdB: 'rub_0202', diffCount: 1, conclusion: 'late', operator: '傅砚', date: '2026-03-08', createdAt: now - day * 3, updatedAt: now - day * 3 },
  ];

  /* 修复室工位：每日件数即当日容量上限（在修单占位，满了只能排队） */
  const workbenches: Workbench[] = [
    { id: 'bench_01', name: '修复工位 1 号', keeper: '苏裱', dailyCapacity: 1, active: true, createdAt: now - day * 60, updatedAt: now - day * 30 },
    { id: 'bench_02', name: '修复工位 2 号', keeper: '常补', dailyCapacity: 1, active: true, createdAt: now - day * 60, updatedAt: now - day * 30 },
    { id: 'bench_03', name: '修复工位 3 号', keeper: '钱托', dailyCapacity: 2, active: true, createdAt: now - day * 60, updatedAt: now - day * 30 },
  ];

  const dateBefore = (days: number): string => new Date(now - day * days).toISOString().slice(0, 10);
  const today = dateBefore(0);

  /* 送修 / 修复单：损泐重的已排在前，当日容量被在修单占住，新送的只能排队 */
  const repairs: RepairOrder[] = [
    {
      id: 'rep_0301', rubbingId: 'rub_0301', steleId: 'stele_03', lossCount: 1, lossWeight: 3, versionNo: 1,
      submitter: '傅砚', submitDate: dateBefore(2), status: 'scheduled', workbenchId: 'bench_01',
      scheduleDate: today, queueNo: 1, restorer: '苏裱', repairNote: '字口补全，托纸待干', batchNo: 1,
      createdAt: now - day * 2, updatedAt: now - day * 1,
    },
    {
      id: 'rep_0102', rubbingId: 'rub_0102', steleId: 'stele_01', lossCount: 3, lossWeight: 7, versionNo: 2,
      submitter: '傅砚', submitDate: dateBefore(2), status: 'scheduled', workbenchId: 'bench_02',
      scheduleDate: today, queueNo: 2, restorer: '常补', repairNote: '斜裂加固', batchNo: 1,
      createdAt: now - day * 2, updatedAt: now - day * 1,
    },
    {
      id: 'rep_0101', rubbingId: 'rub_0101', steleId: 'stele_01', lossCount: 3, lossWeight: 6, versionNo: 1,
      submitter: '傅砚', submitDate: dateBefore(1), status: 'scheduled', workbenchId: 'bench_03',
      scheduleDate: today, queueNo: 3, restorer: '钱托', repairNote: '缺笔补墨', batchNo: 1,
      createdAt: now - day * 1, updatedAt: now - day * 1,
    },
    {
      id: 'rep_0103', rubbingId: 'rub_0103', steleId: 'stele_01', lossCount: 2, lossWeight: 3, versionNo: 3,
      submitter: '傅砚', submitDate: dateBefore(1), status: 'pending', workbenchId: '',
      scheduleDate: '', queueNo: 0, restorer: '', repairNote: '', batchNo: 0,
      createdAt: now - day * 1, updatedAt: now - day * 1,
    },
    {
      id: 'rep_0201', rubbingId: 'rub_0201', steleId: 'stele_02', lossCount: 1, lossWeight: 1, versionNo: 1,
      submitter: '傅砚', submitDate: dateBefore(1), status: 'pending', workbenchId: '',
      scheduleDate: '', queueNo: 0, restorer: '', repairNote: '', batchNo: 0,
      createdAt: now - day * 1, updatedAt: now - day * 1,
    },
    {
      id: 'rep_0202', rubbingId: 'rub_0202', steleId: 'stele_02', lossCount: 2, lossWeight: 3, versionNo: 2,
      submitter: '傅砚', submitDate: dateBefore(12), status: 'withdrawn', workbenchId: '',
      scheduleDate: '', queueNo: 0, restorer: '', repairNote: '编目复核后暂缓送修', batchNo: 0,
      createdAt: now - day * 12, updatedAt: now - day * 11,
    },
  ];

  await db.transaction('rw', [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.workbenches, db.repairs], async () => {
    await db.steles.bulkPut(steles);
    await db.rubbings.bulkPut(rubbings);
    await db.losses.bulkPut(losses);
    await db.seals.bulkPut(seals);
    await db.compares.bulkPut(compares);
    // 工位 / 修复单只在空表时播种：旧库升级时若已从「另记」台账抢救回数据，则保留不覆盖
    if ((await db.workbenches.count()) === 0) await db.workbenches.bulkPut(workbenches);
    if ((await db.repairs.count()) === 0) await db.repairs.bulkPut(repairs);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RubbingSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  steles: Stele[];
  rubbings: Rubbing[];
  losses: Loss[];
  seals: Seal[];
  compares: Compare[];
  workbenches: Workbench[];
  repairs: RepairOrder[];
}

export async function exportSnapshot(): Promise<RubbingSnapshot> {
  const [steles, rubbings, losses, seals, compares, workbenches, repairs] = await Promise.all([
    db.steles.toArray(),
    db.rubbings.toArray(),
    db.losses.toArray(),
    db.seals.toArray(),
    db.compares.toArray(),
    db.workbenches.toArray(),
    db.repairs.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    steles,
    rubbings,
    losses,
    seals,
    compares,
    workbenches,
    repairs,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<RubbingSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof RubbingSnapshot> = ['steles', 'rubbings', 'losses', 'seals', 'compares', 'workbenches', 'repairs'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.workbenches, db.repairs],
    async () => {
      await Promise.all([
        db.steles.clear(),
        db.rubbings.clear(),
        db.losses.clear(),
        db.seals.clear(),
        db.compares.clear(),
        db.workbenches.clear(),
        db.repairs.clear(),
      ]);
    },
  );
}

export async function importSnapshot(snapshot: RubbingSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.workbenches, db.repairs],
    async () => {
      await db.steles.bulkPut(snapshot.steles);
      await db.rubbings.bulkPut(snapshot.rubbings);
      await db.losses.bulkPut(snapshot.losses);
      await db.seals.bulkPut(snapshot.seals);
      await db.compares.bulkPut(snapshot.compares);
      await db.workbenches.bulkPut(snapshot.workbenches);
      await db.repairs.bulkPut(snapshot.repairs);
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [steles, rubbings, losses, seals, compares, workbenches, repairs] = await Promise.all([
    db.steles.count(),
    db.rubbings.count(),
    db.losses.count(),
    db.seals.count(),
    db.compares.count(),
    db.workbenches.count(),
    db.repairs.count(),
  ]);
  return { steles, rubbings, losses, seals, compares, workbenches, repairs };
}

/** 级联删除碑刻 → 拓本 → 损泐 / 钤印 / 比对 / 送修单 */
export async function removeSteleCascade(steleId: string): Promise<void> {
  const rubbingIds = (await db.rubbings.where('steleId').equals(steleId).toArray()).map((row) => row.id);
  await db.transaction(
    'rw',
    [db.steles, db.rubbings, db.losses, db.seals, db.compares, db.repairs],
    async () => {
      if (rubbingIds.length > 0) {
        await db.losses.where('rubbingId').anyOf(rubbingIds).delete();
        await db.seals.where('rubbingId').anyOf(rubbingIds).delete();
        await db.repairs.where('rubbingId').anyOf(rubbingIds).delete();
      }
      await db.rubbings.where('steleId').equals(steleId).delete();
      await db.compares.where('steleId').equals(steleId).delete();
      await db.repairs.where('steleId').equals(steleId).delete();
      await db.steles.delete(steleId);
    },
  );
}

/** 级联删除拓本 → 损泐 / 钤印 / 涉及的比对记录 / 送修单 */
export async function removeRubbingCascade(rubbingId: string): Promise<void> {
  await db.transaction('rw', [db.rubbings, db.losses, db.seals, db.compares, db.repairs], async () => {
    await db.losses.where('rubbingId').equals(rubbingId).delete();
    await db.seals.where('rubbingId').equals(rubbingId).delete();
    await db.repairs.where('rubbingId').equals(rubbingId).delete();
    const compares = await db.compares.toArray();
    const affected = compares.filter((row) => row.rubbingIdA === rubbingId || row.rubbingIdB === rubbingId);
    if (affected.length > 0) await db.compares.bulkDelete(affected.map((row) => row.id));
    await db.rubbings.delete(rubbingId);
  });
}

/** 重排某碑刻下拓本的版本序号，保证连续 */
export async function renumberRubbings(steleId: string): Promise<void> {
  const rows = await db.rubbings.where('steleId').equals(steleId).toArray();
  const sorted = [...rows].sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  await db.rubbings.bulkPut(sorted.map((row, index) => ({ ...row, versionNo: index + 1, updatedAt: Date.now() })));
}
