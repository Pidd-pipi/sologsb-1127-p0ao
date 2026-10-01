/**
 * 浏览器容量（IndexedDB / StorageManager）相关工具。
 *
 * 需求约束：浏览器容量不足时拒绝写入、原样保留两边回传包，
 * 待容量恢复后再继续处理。因此所有合并写入都先做容量预检，
 * 落库时再兜底捕获 QuotaExceededError。
 */

/** 估算任意可结构化克隆对象占用的字节数（与 Dexie 落库前的 toPlain 口径一致） */
export function estimateBytes(value: unknown): number {
  let bytes = 0;
  const walk = (v: unknown) => {
    if (v === null || v === undefined) {
      bytes += 4;
    } else if (typeof v === 'string') {
      // UTF-16 存储近似按每字符 2 字节计
      bytes += v.length * 2 + 2;
    } else if (typeof v === 'number') {
      bytes += 8;
    } else if (typeof v === 'boolean') {
      bytes += 2;
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === 'object') {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        bytes += key.length * 2 + 2;
        walk((v as Record<string, unknown>)[key]);
      }
    }
  };
  walk(value);
  return bytes;
}

export interface StorageQuota {
  /** 配额（字节），拿不到时为 null */
  quota: number | null;
  /** 已用（字节） */
  usage: number | null;
  /** 剩余（字节），拿不到配额时为 null */
  free: number | null;
}

/** 读取浏览器存储配额；隐私模式 / 不支持 / 非浏览器环境时返回 null 字段 */
export async function getStorageQuota(): Promise<StorageQuota> {
  const nav = globalThis.navigator as
    | (Navigator & {
        storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
      })
    | undefined;
  if (!nav?.storage?.estimate) return { quota: null, usage: null, free: null };
  try {
    const est = await nav.storage.estimate();
    const quota = typeof est.quota === 'number' ? est.quota : null;
    const usage = typeof est.usage === 'number' ? est.usage : null;
    return { quota, usage, free: quota !== null && usage !== null ? Math.max(0, quota - usage) : null };
  } catch {
    return { quota: null, usage: null, free: null };
  }
}

/** 判断错误是否为容量不足（不同浏览器错误名略有差异） */
export function isQuotaError(e: unknown): boolean {
  if (!e) return false;
  const err = e as { name?: string; code?: number; message?: string };
  if (err.name === 'QuotaExceededError' || err.name === 'StorageFullError') return true;
  // IndexedDB 在部分内核下以 code 22 / 1014 表示配额不足
  if (err.code === 22 || err.code === 1014) return true;
  return typeof err.message === 'string' && /quota|容量|空间不足/i.test(err.message);
}

/** 容量不足时抛出的统一错误，UI 据此提示「已拒绝写入、回传包保留」 */
export class StorageFullError extends Error {
  constructor(requiredBytes: number, freeBytes: number | null) {
    super(
      freeBytes === null
        ? `浏览器存储容量不足，本次需要约 ${Math.ceil(requiredBytes / 1024)}KB，已拒绝写入`
        : `浏览器存储容量不足：需要约 ${Math.ceil(requiredBytes / 1024)}KB，仅剩 ${Math.ceil(
            freeBytes / 1024,
          )}KB，已拒绝写入`,
    );
    this.name = 'StorageFullError';
    this.requiredBytes = requiredBytes;
    this.freeBytes = freeBytes;
  }

  requiredBytes: number;
  freeBytes: number | null;
}

/**
 * 写入前容量预检：估算待写入对象大小，与剩余配额比较。
 * 留 25% 安全余量，避免估算偏差导致真实写入时打爆配额。
 * 拿不到配额信息（旧浏览器/隐私模式）时跳过预检，交由落库兜底。
 *
 * @param forceFull 容量不足演练开关：打开时一律按容量不足拒绝写入，
 *                  便于在配额充裕的开发机上验证「拒绝写入、回传包保留」流程。
 */
export async function ensureCapacity(values: unknown[], forceFull = false): Promise<void> {
  if (forceFull) {
    throw new StorageFullError(values.reduce<number>((sum, v) => sum + estimateBytes(v), 0), 0);
  }
  const required = values.reduce<number>((sum, v) => sum + estimateBytes(v), 0);
  const { free } = await getStorageQuota();
  if (free === null) return;
  const safeFree = Math.floor(free * 0.75);
  if (required > safeFree) throw new StorageFullError(required, free);
}
