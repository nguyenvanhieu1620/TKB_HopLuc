import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest } from "../types";

interface HolidayBody {
  dateFrom?: string;
  dateTo?: string;
  description?: string;
  appliesTo?: string;
}

function isValidAppliesTo(value: unknown): value is "CQ" | "LT" | "ALL" {
  return value === "CQ" || value === "LT" || value === "ALL";
}

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT HolidayId, DateFrom, DateTo, Description, AppliesTo
      FROM Holidays ORDER BY DateFrom DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { dateFrom, dateTo, description, appliesTo } = req.body as HolidayBody;
    if (!dateFrom || !dateTo || !description) {
      res.status(400).json({ message: "Thiếu ngày bắt đầu, ngày kết thúc hoặc mô tả ngày nghỉ" });
      return;
    }
    if (dateTo < dateFrom) {
      res.status(400).json({ message: "Ngày kết thúc phải sau ngày bắt đầu" });
      return;
    }
    const resolvedAppliesTo = isValidAppliesTo(appliesTo) ? appliesTo : "ALL";
    const pool = await getPool();
    const result = await pool
      .request()
      .input("dateFrom", sql.Date, dateFrom)
      .input("dateTo", sql.Date, dateTo)
      .input("description", sql.NVarChar, description)
      .input("appliesTo", sql.NVarChar, resolvedAppliesTo)
      .query<{ HolidayId: number }>(`
        INSERT INTO Holidays (DateFrom, DateTo, Description, AppliesTo)
        OUTPUT INSERTED.HolidayId
        VALUES (@dateFrom, @dateTo, @description, @appliesTo)
      `);
    res.status(201).json({ holidayId: result.recordset[0].HolidayId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { dateFrom, dateTo, description, appliesTo } = req.body as HolidayBody;
    if (dateFrom && dateTo && dateTo < dateFrom) {
      res.status(400).json({ message: "Ngày kết thúc phải sau ngày bắt đầu" });
      return;
    }
    const resolvedAppliesTo = isValidAppliesTo(appliesTo) ? appliesTo : "ALL";
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("dateFrom", sql.Date, dateFrom)
      .input("dateTo", sql.Date, dateTo)
      .input("description", sql.NVarChar, description)
      .input("appliesTo", sql.NVarChar, resolvedAppliesTo)
      .query(`
        UPDATE Holidays SET DateFrom=@dateFrom, DateTo=@dateTo, Description=@description, AppliesTo=@appliesTo
        WHERE HolidayId = @id
      `);
    res.json({ message: "Đã cập nhật" });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const pool = await getPool();
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Holidays WHERE HolidayId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    next(err);
  }
}
