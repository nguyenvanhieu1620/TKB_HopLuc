import { Router } from "express";
import * as ctrl from "../controllers/teacherUnavailabilityController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.delete("/:id", authenticate, requireRole("Admin"), ctrl.remove);

export default router;
