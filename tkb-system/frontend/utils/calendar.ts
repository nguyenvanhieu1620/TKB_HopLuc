// Các hàm tiện ích cho hiển thị lịch dạng tháng/tuần (tuần bắt đầu từ Thứ 2)

export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Trả về Thứ 2 của tuần chứa ngày d
export function startOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay(); // 0=CN, 1=T2, ...6=T7
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function addDays(d: Date, n: number): Date {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}

export function addMonths(d: Date, n: number): Date {
  const date = new Date(d);
  date.setMonth(date.getMonth() + n);
  return date;
}

// Ma trận các tuần (mỗi tuần 7 ngày) phủ kín tháng chứa ngày d, tuần bắt đầu Thứ 2
export function getMonthMatrix(d: Date): Date[][] {
  const firstOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  const gridStart = startOfWeek(firstOfMonth);

  const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const gridEndBase = startOfWeek(lastOfMonth);
  const gridEnd = addDays(gridEndBase, 6);

  const weeks: Date[][] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export const WEEKDAY_LABELS = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật"];

export const MONTH_LABEL = (d: Date): string => `Tháng ${d.getMonth() + 1}, ${d.getFullYear()}`;

// Bảng màu tuần hoàn để tô cho từng môn học (giữ tinh thần từ ứng dụng Excel cũ)
const PALETTE = [
  { bg: "#e8f5d8", text: "#3a6b1f" },
  { bg: "#d8eaf8", text: "#1f5f8b" },
  { bg: "#fdf2ee", text: "#a34a2f" },
  { bg: "#fffae6", text: "#8a6d00" },
  { bg: "#ececff", text: "#4b3fa0" },
  { bg: "#eaeff9", text: "#33507a" },
  { bg: "#e2f6e8", text: "#2f7a4a" },
  { bg: "#fdeee4", text: "#a35a2f" },
];

export function colorForId(id: number): { bg: string; text: string } {
  return PALETTE[id % PALETTE.length];
}