import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest } from "../types";

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const notificationsResult = await pool
      .request()
      .input("userId", sql.Int, req.user!.userId)
      .query(`
        SELECT TOP 20 NotificationId, Content, RelatedType, RelatedId, IsRead, CreatedAt
        FROM Notifications
        WHERE UserId = @userId
        ORDER BY CreatedAt DESC
      `);
    const unreadResult = await pool
      .request()
      .input("userId", sql.Int, req.user!.userId)
      .query<{ UnreadCount: number }>(`
        SELECT COUNT(*) AS UnreadCount FROM Notifications WHERE UserId = @userId AND IsRead = 0
      `);
    res.json({
      notifications: notificationsResult.recordset,
      unreadCount: unreadResult.recordset[0].UnreadCount,
    });
  } catch (err) {
    next(err);
  }
}

export async function markRead(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("userId", sql.Int, req.user!.userId)
      .query(`UPDATE Notifications SET IsRead = 1 WHERE NotificationId = @id AND UserId = @userId`);
    res.json({ message: "Đã đánh dấu đã đọc" });
  } catch (err) {
    next(err);
  }
}

export async function markAllRead(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input("userId", sql.Int, req.user!.userId)
      .query(`UPDATE Notifications SET IsRead = 1 WHERE UserId = @userId AND IsRead = 0`);
    res.json({ message: "Đã đánh dấu tất cả đã đọc" });
  } catch (err) {
    next(err);
  }
}
