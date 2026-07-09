import { Request, Response, NextFunction } from "express";
import { HttpError } from "../types";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: HttpError, req: Request, res: Response, next: NextFunction): void {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    message: err.message || "Đã xảy ra lỗi hệ thống",
  });
}
