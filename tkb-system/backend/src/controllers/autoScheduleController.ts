import { Response, NextFunction } from "express";
import { AuthRequest } from "../types";
import { runAutoSchedule, cancelAutoScheduleRun } from "../utils/autoScheduler";

interface AutoGenerateBody {
  classId?: number;
  semesterId?: number;
  weekNumber?: number;
}

// Chạy thuật toán tự động xếp TKB cho đúng 1 Lớp + 1 Kỳ + 1 TUẦN cụ thể (Tuần 1..N, khớp cách đánh
// số Tuần đã có ở chế độ xem "Theo kỳ") — toàn bộ logic nằm ở autoScheduler.ts, controller chỉ gọi
// hàm chính rồi trả kết quả.
export async function generate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { classId, semesterId, weekNumber } = req.body as AutoGenerateBody;
    if (!classId || !semesterId || !weekNumber) {
      res.status(400).json({ message: "Thiếu classId, semesterId hoặc weekNumber" });
      return;
    }
    const report = await runAutoSchedule(classId, semesterId, weekNumber, req.user!.userId);
    res.status(201).json(report);
  } catch (err) {
    next(err);
  }
}

// Hủy toàn bộ Schedule do 1 lần chạy tự động xếp lịch tạo ra (nút "Hủy toàn bộ lần xếp này").
export async function cancel(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { runId } = req.params;
    const deletedCount = await cancelAutoScheduleRun(runId, req.user!.userId);
    res.json({ deletedCount });
  } catch (err) {
    next(err);
  }
}
