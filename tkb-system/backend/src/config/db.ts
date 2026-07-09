import sql from "mssql";

const config: sql.config = {
  server: process.env.DB_SERVER as string,
  port: Number(process.env.DB_PORT) || 1433,
  database: process.env.DB_DATABASE as string,
  user: process.env.DB_USER as string,
  password: process.env.DB_PASSWORD as string,
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === "true",
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let poolPromise: Promise<sql.ConnectionPool> | null = null;

export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        console.log("✅ Đã kết nối SQL Server:", process.env.DB_DATABASE);
        return pool;
      })
      .catch((err) => {
        console.error("❌ Lỗi kết nối SQL Server:", err.message);
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

export { sql };
