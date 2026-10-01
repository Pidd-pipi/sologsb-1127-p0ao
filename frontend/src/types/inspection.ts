/** 核验结论 */
export type InspectionConclusion = '合格' | '限期整改' | '不合格';

export const CONCLUSIONS: InspectionConclusion[] = ['合格', '限期整改', '不合格'];

/** 被占用情况 */
export type OccupiedLevel = '无' | '临时占用' | '长期占用';

export const OCCUPIED_LEVELS: OccupiedLevel[] = ['无', '临时占用', '长期占用'];

/** 核验记录 */
export interface Inspection {
  id: string;
  pointId: string;
  /** 核验日期 YYYY-MM-DD */
  date: string;
  inspector: string;
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
  conclusion: InspectionConclusion;
  problem: string;
  createdAt: string;
  /** 采集时间（精确到分，ISO 字符串）；双边补录时为主采集方时间 */
  collectedAt?: string;
  /**
   * 双边/多边补录的全部测量方（含主口径）。
   * 同一点位同一时段两边补录时，坡度、净宽都留下，督导员与采集时间分别标清。
   * 仅合并生成的记录有此字段；单条录入的记录为 undefined。
   */
  sides?: InspectionSide[];
  /** 来源回传包 id 列表（合并记录） */
  packageIds?: string[];
}

/** 双边补录的一方测量摘要 */
export interface InspectionSide {
  /** 来源回传包 id */
  packageId: string;
  /** 采集方标识 */
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

export type InspectionDraft = Omit<Inspection, 'id' | 'createdAt'>;
