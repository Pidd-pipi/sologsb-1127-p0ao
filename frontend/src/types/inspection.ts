/** 核验结论 */
export type InspectionConclusion = '合格' | '限期整改' | '不合格';

export const CONCLUSIONS: InspectionConclusion[] = ['合格', '限期整改', '不合格'];

/** 被占用情况 */
export type OccupiedLevel = '无' | '临时占用' | '长期占用';

export const OCCUPIED_LEVELS: OccupiedLevel[] = ['无', '临时占用', '长期占用'];

/** 离线回传来源：两队断网核验，分别为 A / B 侧 */
export type OfflineSide = 'A' | 'B';

/** 同一点位两边补录的一组实测值（坡度、净宽各自留档） */
export interface InspectionMeasure {
  /** 来源侧别 */
  side: OfflineSide;
  /** 该侧督导员 */
  inspector: string;
  /** 采集时间（ISO，精确到时分秒，用于区分同一核验日期内的补录） */
  collectedAt: string;
  /** 坡度 % */
  slope: number;
  /** 净宽 cm */
  clearWidth: number;
  /** 扶手有无 */
  hasHandrail: boolean;
  /** 盲道连续性 */
  tactileContinuous: boolean;
  /** 被占用情况 */
  occupied: OccupiedLevel;
  /** 该侧结论 */
  conclusion: InspectionConclusion;
  /** 问题描述 */
  problem: string;
}

/** 核验记录 */
export interface Inspection {
  id: string;
  pointId: string;
  /** 核验日期 YYYY-MM-DD */
  date: string;
  inspector: string;
  /** 坡度 %（正式记录取裁定/较晚一侧的值，两边补录见 measures） */
  slope: number;
  /** 净宽 cm */
  clearWidth: number;
  /** 扶手有无 */
  hasHandrail: boolean;
  /** 盲道连续性 */
  tactileContinuous: boolean;
  /** 被占用情况 */
  occupied: OccupiedLevel;
  conclusion: InspectionConclusion;
  problem: string;
  createdAt: string;
  /**
   * 离线合并产生的正式记录：两边补录的坡度、净宽等实测值全部留档，
   * 督导员与采集时间分别标清。未走离线合并的记录无此字段。
   */
  measures?: InspectionMeasure[];
  /** 合并时两侧结论是否一致（一致直接落正式记录；不一致经裁定后落记录） */
  mergedFromDispute?: boolean;
  /** 关联的待裁定单 id（如有） */
  disputeId?: string;
}

export type InspectionDraft = Omit<Inspection, 'id' | 'createdAt'>;
