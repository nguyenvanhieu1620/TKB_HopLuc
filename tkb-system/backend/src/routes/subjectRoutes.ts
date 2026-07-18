import { Router } from "express";
import * as ctrl from "../controllers/subjectController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.post("/bulk", authenticate, requireRole("Admin"), ctrl.bulkCreate);
// Việc BR: Phòng Thực hành/Lâm sàng cụ thể phù hợp với môn học.
router.get("/:id/rooms", authenticate, ctrl.getRooms);
router.put("/:id/rooms", authenticate, requireRole("Admin"), ctrl.updateRooms);
router.put("/:id", authenticate, requireRole("Admin"), ctrl.update);
router.delete("/:id", authenticate, requireRole("Admin"), ctrl.remove);

export default router;
