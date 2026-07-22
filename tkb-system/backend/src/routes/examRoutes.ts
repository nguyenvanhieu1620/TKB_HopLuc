import { Router } from "express";
import * as ctrl from "../controllers/examController";
import * as autoCtrl from "../controllers/autoExamScheduleController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.get("/eligible", authenticate, requireRole("Admin"), ctrl.eligible);
// Việc CC: route literal PHẢI đặt TRƯỚC "/:id" — nếu không Express sẽ khớp nhầm "auto-generate" thành
// tham số :id (cùng lỗi đã gặp và sửa ở scheduleRoutes.ts).
router.post("/auto-generate", authenticate, requireRole("Admin"), autoCtrl.generate);
router.delete("/auto-generate/:runId", authenticate, requireRole("Admin"), autoCtrl.cancel);
router.get("/:id", authenticate, ctrl.getById);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.put("/:id", authenticate, requireRole("Admin"), ctrl.update);
router.delete("/:id", authenticate, requireRole("Admin"), ctrl.remove);

export default router;
