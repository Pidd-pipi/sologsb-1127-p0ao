import type { InspectionConclusion, OccupiedLevel } from './inspection';

/** 回传包状态 */
export type PackageStatus = '待合并' | '已合并';

/**
 * 离线回传包：断网核验后按点位回传的采集包。
 * 同一个点位可能由两边（两位督导员/两支队伍）分别补录，合并时按点位归并。
 */
export interface OfflinePackage {
  id: string;
  /** 包编号，例：PKG-20250601-A */
  code: string;
  /** 采集方标识（哪边督导员/队伍） */
  side: string;
  /** 采集时间（包的采集时间，ISO 字符串） */
  collectedAt: string;
  /** 回传（上传）时间，ISO 字符串 */
  uploadedAt: string;
  /** 包状态 */
  status: PackageStatus;
  /** 备注 */
  note: string;
}

/** 回传包条目：单点位单次补录的核验实测值 */
export interface OfflinePackageItem {
  id: string;
  packageId: string;
  pointId: string;
  /** 核验日期（时段）YYYY-MM-DD */
  date: string;
  inspector: string;
  /** 采集时间（精确到分，ISO 字符串） */
  collectedAt: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  conclusion: InspectionConclusion;
  problem: string;
}

/** 待裁定状态 */
export type AdjudicationStatus = '待裁定' | '已裁定';

/** 待裁定条目的一方测量摘要 */
export interface AdjudicationSide {
  itemId: string;
  packageId: string;
  side: string;
  inspector: string;
  collectedAt: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  conclusion: InspectionConclusion;
  problem: string;
}

/**
 * 待裁定条目：同一时段（同一点位同一核验日期）两边结论不一致时，
 * 先挂起待裁定，处理前不写正式核验记录。
 */
export interface PendingAdjudication {
  id: string;
  pointId: string;
  date: string;
  /** 甲方（先采集方）结论 */
  conclusionA: InspectionConclusion;
  /** 乙方结论 */
  conclusionB: InspectionConclusion;
  /** 甲方测量摘要 */
  sideA: AdjudicationSide;
  /** 乙方测量摘要 */
  sideB: AdjudicationSide;
  status: AdjudicationStatus;
  /** 裁定采纳的结论 */
  resolvedConclusion?: InspectionConclusion;
  /** 裁定采纳的坡度 */
  resolvedSlope?: number;
  /** 裁定采纳的净宽 */
  resolvedClearWidth?: number;
  /** 裁定采纳的扶手 */
  resolvedHasHandrail?: boolean;
  /** 裁定采纳的盲道连续性 */
  resolvedTactileContinuous?: boolean;
  /** 裁定采纳的占用情况 */
  resolvedOccupied?: OccupiedLevel;
  /** 裁定采纳的问题描述 */
  resolvedProblem?: string;
  /** 裁定时间，ISO 字符串 */
  resolvedAt?: string;
  createdAt: string;
}

export type OfflinePackageDraft = Omit<OfflinePackage, 'id' | 'uploadedAt' | 'status'>;
export type OfflinePackageItemDraft = Omit<OfflinePackageItem, 'id' | 'packageId'>;
