import { Response, NextFunction } from "express";
import { sql, getPool } from "../config/db";
import { AuthRequest, HttpError } from "../types";

export async function list(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT CohortId, CohortName, StartYear, DurationYears, IsActive
      FROM Cohorts ORDER BY StartYear DESC, CohortName
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { cohortName, startYear, durationYears } = req.body as {
      cohortName?: string; startYear?: number; durationYears?: number;
    };
    if (!cohortName || !startYear) {
      res.status(400).json({ message: "Thiếu tên khóa hoặc năm nhập học" });
      return;
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input("cohortName", sql.NVarChar, cohortName)
      .input("startYear", sql.Int, startYear)
      .input("durationYears", sql.Int, durationYears || 3)
      .query<{ CohortId: number }>(`
        INSERT INTO Cohorts (CohortName, StartYear, DurationYears)
        OUTPUT INSERTED.CohortId
        VALUES (@cohortName, @startYear, @durationYears)
      `);
    res.status(201).json({ cohortId: result.recordset[0].CohortId });
  } catch (err) {
    next(err);
  }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { cohortName, startYear, durationYears, isActive } = req.body as {
      cohortName?: string; startYear?: number; durationYears?: number; isActive?: boolean;
    };
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("cohortName", sql.NVarChar, cohortName)
      .input("startYear", sql.Int, startYear)
      .input("durationYears", sql.Int, durationYears || 3)
      .input("isActive", sql.Bit, isActive ?? true)
      .query(`
        UPDATE Cohorts SET CohortName=@cohortName, StartYear=@startYear,
          DurationYears=@durationYears, IsActive=@isActive
        WHERE CohortId = @id
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
    await pool.request().input("id", sql.Int, id).query(`DELETE FROM Cohorts WHERE CohortId = @id`);
    res.json({ message: "Đã xóa" });
  } catch (err) {
    const httpErr = err as HttpError;
    httpErr.status = 409;
    httpErr.message = "Không thể xóa: khóa học này đang có lớp trực thuộc";
    next(httpErr);
  }
}
