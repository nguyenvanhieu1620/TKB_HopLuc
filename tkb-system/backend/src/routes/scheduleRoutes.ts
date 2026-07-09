import { Router } from "express";
import * as ctrl from "../controllers/scheduleController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.post("/merged", authenticate, requireRole("Admin"), ctrl.mergedCreate);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.put("/:id", authenticate, requireRole("Admin"), ctrl.update);
router.delete("/:id", authenticate, requireRole("Admin"), ctrl.remove);

export default router;
