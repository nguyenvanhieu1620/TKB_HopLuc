import { Response, NextFunction } from "express";
import { AuthRequest } from "../types";
import { runAutoScheduleExams, cancelAutoExamScheduleRun } from "../utils/autoExamScheduler";

interface AutoGenerateExamBody {
  classId?: number;
  semesterId?: number;
}

export async function generate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { classId, semesterId } = req.body as AutoGenerateExamBody;
    if (!classId || !semesterId) {
      res.status(400).json({ message: "Thiếu classId hoặc semesterId" });
      return;
    }
    const report = await runAutoScheduleExams(classId, semesterId, req.user!.userId);
    res.status(201).json(report);
  } catch (err) {
    next(err);
  }
}

export async function cancel(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { runId } = req.params;
    const deletedCount = await cancelAutoExamScheduleRun(runId, req.user!.userId);
    res.json({ deletedCount });
  } catch (err) {
    next(err);
  }
}
