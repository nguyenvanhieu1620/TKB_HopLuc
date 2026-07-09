import { Router } from "express";
import * as authController from "../controllers/authController";
import { authenticate } from "../middleware/auth";

const router = Router();

router.post("/login", authController.login);
router.get("/me", authenticate, authController.me);

export default router;
