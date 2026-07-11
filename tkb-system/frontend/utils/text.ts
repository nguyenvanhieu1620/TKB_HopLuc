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
