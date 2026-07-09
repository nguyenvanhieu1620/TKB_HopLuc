import { Router } from "express";
import * as ctrl from "../controllers/examController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.get("/eligible", authenticate, requireRole("Admin"), ctrl.eligible);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.put("/:id", authenticate, requireRole("Admin"), ctrl.update);
router.delete("/:id", authenticate, requireRole("Admin"), ctrl.remove);

export default router;
