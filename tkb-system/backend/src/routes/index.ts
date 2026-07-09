import { Router } from "express";
import authRoutes from "./authRoutes";
import majorRoutes from "./majorRoutes";
import cohortRoutes from "./cohortRoutes";
import teacherRoutes from "./teacherRoutes";
import subjectRoutes from "./subjectRoutes";
import classRoutes from "./classRoutes";
import roomRoutes from "./roomRoutes";
import semesterRoutes from "./semesterRoutes";
import scheduleRoutes from "./scheduleRoutes";
import examRoutes from "./examRoutes";
import sessionRoutes from "./sessionRoutes";
import facultyRoutes from "./facultyRoutes";
import curriculumItemRoutes from "./curriculumItemRoutes";
import roomUnavailabilityRoutes from "./roomUnavailabilityRoutes";
import holidayRoutes from "./holidayRoutes";
import positionRoutes from "./positionRoutes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/majors", majorRoutes);
router.use("/cohorts", cohortRoutes);
router.use("/teachers", teacherRoutes);
router.use("/subjects", subjectRoutes);
router.use("/classes", classRoutes);
router.use("/rooms", roomRoutes);
router.use("/semesters", semesterRoutes);
router.use("/schedule", scheduleRoutes);
router.use("/exams", examRoutes);
router.use("/sessions", sessionRoutes);
router.use("/faculties", facultyRoutes);
router.use("/curriculum-items", curriculumItemRoutes);
router.use("/room-unavailability", roomUnavailabilityRoutes);
router.use("/holidays", holidayRoutes);
router.use("/positions", positionRoutes);

export default router;
