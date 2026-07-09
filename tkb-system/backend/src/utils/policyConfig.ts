import { sql, getPool } from "../config/db";

// Đọc quy chuẩn nghiệp vụ từ bảng SchedulingPolicy — mọi giới hạn số (sĩ số, số giờ, số phút...)
// phải lấy qua đây thay vì hard-code trong code, để Admin chỉnh được bằng cách sửa DB.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút, đủ tránh query lặp lại liên tục mà vẫn sớm nhận thay đổi

interface CacheEntry {
  value: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function getPolicyValue(key: string): Promise<number> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input("key", sql.NVarChar, key)
    .query<{ PolicyValue: string }>(`SELECT PolicyValue FROM SchedulingPolicy WHERE PolicyKey = @key`);

  const row = result.recordset[0];
  if (!row) {
    throw new Error(`Thiếu cấu hình quy chuẩn "${key}" trong SchedulingPolicy`);
  }
  const value = Number(row.PolicyValue);
  if (Number.isNaN(value)) {
    throw new Error(`Giá trị quy chuẩn "${key}" không hợp lệ: "${row.PolicyValue}"`);
  }

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// Dùng khi cần đọc nhiều key cùng lúc mà không muốn chờ tuần tự.
export async function getPolicyValues(keys: string[]): Promise<Record<string, number>> {
  const entries = await Promise.all(keys.map(async (key) => [key, await getPolicyValue(key)] as const));
  return Object.fromEntries(entries);
}

export function clearPolicyCache(): void {
  cache.clear();
}
