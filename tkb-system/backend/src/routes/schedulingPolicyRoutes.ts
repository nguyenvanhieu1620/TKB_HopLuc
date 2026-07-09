import { Router } from "express";
import * as ctrl from "../controllers/schedulingPolicyController";
import { authenticate } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, ctrl.list);

export default router;
