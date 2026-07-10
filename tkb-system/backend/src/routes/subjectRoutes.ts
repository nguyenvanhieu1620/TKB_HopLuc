import { Router } from "express";
import * as ctrl from "../controllers/subjectController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.post("/", authenticate, requireRole("Admin"), ctrl.create);
router.post("/bulk", authenticate, requireRole("Admin"), ctrl.bulkCreate);
router.put("/:id", authenticate, requireRole("Admin"), ctrl.update);
router.delete("/:id", authenticate, requireRole("Admin"), ctrl.remove);

export default router;
