// Tiện ích dùng chung cho các màn hình Nhập/Xuất Excel (NXDL)
import * as XLSX from "xlsx";

export async function readWorkbook(file: File): Promise<XLSX.WorkBook> {
  const buffer = await file.arrayBuffer();
  return XLSX.read(buffer, { type: "array" });
}

// Đọc 1 sheet thành mảng object theo tên cột ở dòng tiêu đề. defval: "" để các ô trống không bị thiếu field.
export function sheetToRows<T>(sheet: XLSX.WorkSheet): T[] {
  return XLSX.utils.sheet_to_json<T>(sheet, { defval: "" });
}

export interface SheetSpec {
  name: string;
  rows: Record<string, unknown>[];
}

// Excel không cho tên sheet chứa \ / ? * [ ] : và giới hạn 31 ký tự.
export function safeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, "-").slice(0, 31) || "Sheet1";
}

export function buildWorkbook(sheets: SheetSpec[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.json_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sheet.name));
  }
  return wb;
}

export function downloadWorkbook(wb: XLSX.WorkBook, filename: string): void {
  XLSX.writeFile(wb, filename);
}
