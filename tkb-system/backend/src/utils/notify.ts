import { sql, getPool } from "../config/db";

// Việc Y (TBAO-01): tạo thông báo trong hệ thống cho các GV liên quan khi lịch dạy/lịch thi
// thay đổi. GV nào chưa có tài khoản (không có dòng Users.TeacherId tương ứng) thì bỏ qua êm —
// không phải lỗi nghiệp vụ, không được làm hỏng luồng chính đang gọi hàm này (cùng triết lý với
// writeAuditLog: tự bắt lỗi, chỉ log ra console, không throw).
export async function notifyTeachers(
  teacherIds: number[],
  content: string,
  relatedType: "Schedule" | "Exam",
  relatedId: number | null
): Promise<void> {
  if (teacherIds.length === 0) return;
  try {
    const pool = await getPool();

    const userReq = pool.request();
    const inClause = teacherIds
      .map((id, idx) => {
        userReq.input(`t${idx}`, sql.Int, id);
        return `@t${idx}`;
      })
      .join(", ");
    const userResult = await userReq.query<{ UserId: number }>(`
      SELECT UserId FROM Users WHERE TeacherId IN (${inClause})
    `);

    for (const row of userResult.recordset) {
      await pool
        .request()
        .input("userId", sql.Int, row.UserId)
        .input("content", sql.NVarChar, content)
        .input("relatedType", sql.NVarChar, relatedType)
        .input("relatedId", sql.Int, relatedId)
        .query(`
          INSERT INTO Notifications (UserId, Content, RelatedType, RelatedId)
          VALUES (@userId, @content, @relatedType, @relatedId)
        `);
    }
  } catch (err) {
    console.error("Tạo thông báo thất bại:", (err as Error).message);
  }
}
