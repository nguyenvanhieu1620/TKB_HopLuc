import { Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sql, getPool } from "../config/db";
import { AuthRequest, JwtPayload, UserRole } from "../types";

interface UserRow {
  UserId: number;
  Username: string;
  PasswordHash: string;
  Role: UserRole;
  TeacherId: number | null;
  IsActive: boolean;
}

export async function login(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ message: "Vui lòng nhập tên đăng nhập và mật khẩu" });
      return;
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("username", sql.NVarChar, username)
      .query<UserRow>(`
        SELECT UserId, Username, PasswordHash, Role, TeacherId, IsActive
        FROM Users WHERE Username = @username
      `);

    const user = result.recordset[0];
    if (!user || !user.IsActive) {
      res.status(401).json({ message: "Tài khoản không tồn tại hoặc đã bị khóa" });
      return;
    }

    const valid = await bcrypt.compare(password, user.PasswordHash);
    if (!valid) {
      res.status(401).json({ message: "Sai tên đăng nhập hoặc mật khẩu" });
      return;
    }

    const payload: JwtPayload = {
      userId: user.UserId,
      username: user.Username,
      role: user.Role,
      teacherId: user.TeacherId,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET as string, {
      expiresIn: process.env.JWT_EXPIRES_IN || "8h",
    } as jwt.SignOptions);

    await pool
      .request()
      .input("userId", sql.Int, user.UserId)
      .query(`UPDATE Users SET LastLoginAt = SYSDATETIME() WHERE UserId = @userId`);

    res.json({ token, user: payload });
  } catch (err) {
    next(err);
  }
}

export async function me(req: AuthRequest, res: Response): Promise<void> {
  res.json({ user: req.user });
}
