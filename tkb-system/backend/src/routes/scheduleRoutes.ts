import { Router } from "express";
import * as ctrl from "../controllers/scheduleController";
import * as autoCtrl from "../controllers/autoScheduleController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.get("/period-progress", authenticate, ctrl.periodProgressByClass);
// Đặt TRƯỚC router.delete("/:id", ...) để Express không khớp nhầm "auto-generate"/"week"/"semester"
// thành :id.
router.post("/auto-generate", authenticate, requireRole("Admin"), autoCtrl.generate);
router.delete("/auto-generate/:runId", authenticate, requireRole("Admin"), autoCtrl.cancel);
// Việc CO: xếp CẢ KỲ trong 1 lần gọi (lặp hết mọi Tuần + bước cứu vãn cuối Kỳ) — literal riêng, không
// đụng "/auto-generate/:runId" (khác hình dạng path, không có dấu "/" sau "auto-generate-full-term").
router.post("/auto-generate-full-term", authenticate, requireRole("Admin"), autoCtrl.generateFullTerm);
router.delete("/week", authenticate, requireRole("Admin"), ctrl.deleteWeek);
router.delete("/semester", authenticate, requireRole("Admin"), ctrl.deleteSemester);
router.get("/:id", authenticate, ctrl.getById);
router.post("/merged", authenticate, requireRole("Admin"), ctrl.mergedCreate);
router.post("/grouped", authenticate, requireRole("Admin"), ctrl.groupedCreate);
router.post("/copy-week", authenticate, requireRole("Admin"), ctrl.copyWeek);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.put("/:id", authenticate, requireRole("Admin"), ctrl.update);
router.delete("/:id", authenticate, requireRole("Admin"), ctrl.remove);

export default router;
