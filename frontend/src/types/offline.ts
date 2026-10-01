import type {
  InspectionConclusion,
  InspectionMeasure,
  OccupiedLevel,
  OfflineSide,
} from './inspection';

/**
 * 离线回传包处理状态：
 * - pending：已收包，等待与另一侧配对（单边回传先暂存）
 * - dispute：两侧已配对但同时段结论不一致，待裁定，处理前不写正式记录
 * - merged：结论一致或已完成裁定，正式核验记录已落库
 * - rejected：容量不足等原因拒绝写入，回传包原样保留，恢复后可继续处理
 */
export type OfflinePackStatus = 'pending' | 'dispute' | 'merged' | 'rejected';

export const OFFLINE_PACK_STATUSES: OfflinePackStatus[] = [
  'pending',
  'dispute',
  'merged',
  'rejected',
];

/** 一侧巡查队断网期间补录的离线核验回传包 */
export interface OfflineInspectionPack {
  id: string;
  pointId: string;
  /** 来源侧别：A 队 / B 队 */
  side: OfflineSide;
  /** 核验日期 YYYY-MM-DD（同一日期视为同一时段） */
  date: string;
  /** 时段标识：同一点位 + 同一时段的两边回传包才合并 */
  timeWindow: string;
  /** 督导员 */
  inspector: string;
  /** 采集时间 ISO（断网补录的实际时刻，恢复联网后回传） */
  collectedAt: string;
  /** 回传时间 ISO */
  uploadedAt: string;
  /** 坡度 % */
  slope: number;
  /** 净宽 cm */
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  /** 该侧按实测值给出的结论 */
  conclusion: InspectionConclusion;
  problem: string;
  status: OfflinePackStatus;
  /** 配对/合并后关联的另一侧包 id */
  pairedPackId?: string;
  /** 合并后生成的正式核验记录 id */
  mergedInspectionId?: string;
  /** 关联待裁定单 id（结论不一致时） */
  disputeId?: string;
  /** 最近一次处理说明（如容量不足拒绝写入的原因） */
  lastNote?: string;
}

export type OfflinePackDraft = Omit<
  OfflineInspectionPack,
  'id' | 'uploadedAt' | 'status' | 'timeWindow'
> &
  Partial<Pick<OfflineInspectionPack, 'timeWindow'>>;

/**
 * 待裁定单：同一时段点位两边结论不同时先生成，只记录两边数据，
 * 督导员裁定前不产生正式核验记录。
 */
export interface MergeDispute {
  id: string;
  pointId: string;
  date: string;
  timeWindow: string;
  /** 两边补录的完整实测值，坡度/净宽与督导员、采集时间各自留档 */
  measures: InspectionMeasure[];
  /** 两边结论（不一致） */
  conclusions: InspectionConclusion[];
  status: '待裁定' | '已裁定';
  /** 裁定采用的一侧 */
  resolvedSide?: OfflineSide;
  /** 裁定人 */
  resolvedBy?: string;
  /** 裁定说明 */
  resolvedNote?: string;
  resolvedAt?: string;
  /** 两个来源回传包 id */
  packIds: [string, string];
  /** 裁定后生成的正式核验记录 id */
  mergedInspectionId?: string;
  createdAt: string;
}

/** 回传包补录数据的录入结构（页面新增 / 模拟用） */
export interface PackInput {
  pointId: string;
  side: OfflineSide;
  date: string;
  inspector: string;
  collectedAt: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  problem: string;
}
