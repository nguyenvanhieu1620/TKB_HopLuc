import { Router } from "express";
import * as ctrl from "../controllers/accountController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, requireRole("Admin"), ctrl.list);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.put("/:id/toggle-active", authenticate, requireRole("Admin"), ctrl.toggleActive);
router.put("/:id/reset-password", authenticate, requireRole("Admin"), ctrl.resetPassword);

export default router;
