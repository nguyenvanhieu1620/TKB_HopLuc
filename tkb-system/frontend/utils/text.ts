// Chuẩn hóa tên để so khớp linh hoạt (vd khi import Excel): trim, về chữ thường, gộp khoảng
// trắng thừa, và chuẩn hóa khoảng trắng quanh dấu gạch ngang — cả "-" (hyphen) lẫn "–"/"—"
// (en/em dash, hay gặp khi copy từ Word/Excel) — thành 1 dạng thống nhất. Tên thật (Khoa, Môn
// học...) thường có định dạng phức tạp nên so khớp tuyệt đối rất dễ trật.
export function normalizeText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*[-–—]\s*/g, " - ");
}

// Việc AR: nhãn hiển thị thống nhất cho Môn học ở mọi nơi chọn môn (dropdown/multi-select), để
// phân biệt các môn trùng tên giữa các Ngành khác nhau — vd "Toán cao cấp (D08 - Dược)". Bỏ phần
// mã/ngành nếu dữ liệu cũ chưa gán (không hiện dấu ngoặc rỗng).
export function subjectLabel(s: { SubjectName: string; SubjectCode?: string | null; MajorName?: string | null }): string {
  const parts = [s.SubjectCode?.trim(), s.MajorName?.trim()].filter((p): p is string => !!p);
  return parts.length > 0 ? `${s.SubjectName} (${parts.join(" - ")})` : s.SubjectName;
}
