import { Router } from "express";
import * as ctrl from "../controllers/reportController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/teaching-hours", authenticate, requireRole("Admin"), ctrl.teachingHours);

export default router;
