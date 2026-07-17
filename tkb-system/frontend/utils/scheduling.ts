// Việc BH: bảng mốc số nhóm CỐ ĐỊNH theo sĩ số lớp, do nhà trường quyết định — thay hoàn toàn công
// thức chia trần Math.ceil(sĩ số / MaxStudentsPerPracticeGroup(10)|MaxStudentsPerClinicalGroup(15))
// dùng trước đây. Nhà trường CHẤP NHẬN số người/nhóm thực tế có thể vượt nhẹ mức 10/15 cũ để giảm số
// nhóm cần thiết, đỡ tốn phòng/giảng viên. Bản sao ĐÚNG bảng mốc ở backend (policyRules.ts) — nếu
// nhà trường điều chỉnh mốc sau này, sửa cả 2 nơi (mốc cao hơn 35 nối tiếp đúng bước của bảng gốc —
// 10 người/nhóm với Thực hành, 20 người/nhóm với Lâm sàng — vì thực tế hiện chưa có lớp nào vượt 35).
export function getRequiredGroupCount(classSize: number, sessionType: "Practice" | "Clinical"): number {
  if (sessionType === "Practice") {
    if (classSize <= 15) return 1;
    if (classSize <= 25) return 2;
    if (classSize <= 35) return 3;
    return 3 + Math.ceil((classSize - 35) / 10);
  }
  if (classSize <= 15) return 1;
  if (classSize <= 35) return 2;
  return 2 + Math.ceil((classSize - 35) / 20);
}
