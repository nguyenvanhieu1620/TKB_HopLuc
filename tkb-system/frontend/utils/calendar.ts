// Các hàm tiện ích cho hiển thị lịch dạng tuần theo học kỳ (tuần bắt đầu từ Thứ 2)

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

export const WEEKDAY_LABELS = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật"];

// Cộng thêm N phút vào 1 mốc giờ "HH:MM", trả về "HH:MM" (zero-pad, so sánh được bằng string).
export function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export interface SemesterWeek {
  weekNumber: number;
  start: Date;
  end: Date;
}

// Chia 1 học kỳ thành các tuần Thứ 2 -> CN. Tuần 1 bắt đầu từ Thứ 2 của tuần chứa StartDate,
// tuần cuối là tuần chứa (hoặc vừa vượt qua) EndDate.
export function getWeeksInSemester(startDate: string, endDate: string): SemesterWeek[] {
  const end = parseDateKey(endDate);
  const weeks: SemesterWeek[] = [];
  let cursor = startOfWeek(parseDateKey(startDate));
  let weekNumber = 1;
  while (cursor <= end) {
    weeks.push({ weekNumber, start: cursor, end: addDays(cursor, 6) });
    cursor = addDays(cursor, 7);
    weekNumber++;
  }
  return weeks;
}

// Tìm tuần chứa ngày hôm nay trong danh sách tuần của 1 kỳ; -1 nếu hôm nay ngoài phạm vi kỳ.
export function findTodayWeekIndex(weeks: SemesterWeek[]): number {
  const todayKey = toDateKey(new Date());
  return weeks.findIndex((w) => todayKey >= toDateKey(w.start) && todayKey <= toDateKey(w.end));
}

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