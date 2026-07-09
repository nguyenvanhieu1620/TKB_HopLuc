import { Router } from "express";
import * as ctrl from "../controllers/classController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.put("/:id", authenticate, requireRole("Admin"), ctrl.update);
router.delete("/:id", authenticate, requireRole("Admin"), ctrl.remove);
router.post("/:id/generate-terms", authenticate, requireRole("Admin"), ctrl.generateTerms);

export default router;
