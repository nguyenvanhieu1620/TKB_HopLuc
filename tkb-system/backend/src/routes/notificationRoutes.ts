import { Router } from "express";
import * as ctrl from "../controllers/notificationController";
import { authenticate } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);
router.put("/read-all", authenticate, ctrl.markAllRead);
router.put("/:id/read", authenticate, ctrl.markRead);

export default router;
