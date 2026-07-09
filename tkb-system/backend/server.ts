import "dotenv/config";
import express, { Application } from "express";
import cors from "cors";
import routes from "./src/routes";
import { errorHandler } from "./src/middleware/errorHandler";

const app: Application = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date() }));
app.use("/api", routes);

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend TKB (TypeScript) đang chạy tại http://localhost:${PORT}`);
});
