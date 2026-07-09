import { Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

interface AccountBody {
  teacherId?: number;
  username?: string;
  password?: string;
  role?: "Admin" | "Teacher";
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT u.UserId, u.Username, u.Role, u.TeacherId, t.FullName AS TeacherName,
             u.IsActive, u.LastLoginAt, u.CreatedAt
      FROM Users u
      LEFT JOIN Teachers t ON t.TeacherId = u.TeacherId
      ORDER BY u.Username
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { teacherId, username, password, role } = req.body as AccountBody;
    if (!teacherId || !username || !password) {
      res.status(400).json({ message: "Thiếu giảng viên, tên đăng nhập hoặc mật khẩu" });
      return;
    }

    const pool = await getPool();

    // 1 giảng viên chỉ có 1 tài khoản — Users.TeacherId không có ràng buộc UNIQUE ở DB
    // nên phải tự kiểm tra trước khi tạo.
    const existing = await pool
      .request()
      .input("teacherId", sql.Int, teacherId)
      .query<{ UserId: number }>(`SELECT UserId FROM Users WHERE TeacherId = @teacherId`);
    if (existing.recordset[0]) {
      res.status(400).json({ message: "Giảng viên này đã có tài khoản" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool
      .request()
      .input("username", sql.NVarChar, username)
      .input("passwordHash", sql.NVarChar, passwordHash)
      .input("role", sql.NVarChar, role || "Teacher")
      .input("teacherId", sql.Int, teacherId)
      .query<{ UserId: number }>(`
        INSERT INTO Users (Username, PasswordHash, Role, TeacherId)
        OUTPUT INSERTED.UserId
        VALUES (@username, @passwordHash, @role, @teacherId)
      `);
    res.status(201).json({ userId: result.recordset[0].UserId });
  } catch (err) {
    const mssqlErr = err as { number?: number };
    if (mssqlErr.number === 2627) {
      const httpErr = err as HttpError;
      httpErr.status = 409;
      httpErr.message = "Tên đăng nhập đã tồn tại";
      next(httpErr);
      return;
    }
    next(err);
  }
}

export async function toggleActive(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    const current = await pool
      .request()
      .input("id", sql.Int, id)
      .query<{ IsActive: boolean }>(`SELECT IsActive FROM Users WHERE UserId = @id`);
    const row = current.recordset[0];
    if (!row) {
      res.status(404).json({ message: "Không tìm thấy tài khoản" });
      return;
    }
    const newActive = !row.IsActive;
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("isActive", sql.Bit, newActive)
      .query(`UPDATE Users SET IsActive = @isActive WHERE UserId = @id`);
    res.json({ message: newActive ? "Đã mở khóa tài khoản" : "Đã khóa tài khoản" });
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { newPassword } = req.body as { newPassword?: string };
    if (!newPassword || newPassword.length < 6) {
      res.status(400).json({ message: "Mật khẩu mới cần tối thiểu 6 ký tự" });
      return;
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("passwordHash", sql.NVarChar, passwordHash)
      .query(`UPDATE Users SET PasswordHash = @passwordHash WHERE UserId = @id`);
    res.json({ message: "Đã đặt lại mật khẩu" });
  } catch (err) {
    next(err);
  }
}
