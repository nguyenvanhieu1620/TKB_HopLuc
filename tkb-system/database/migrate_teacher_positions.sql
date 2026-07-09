/* ============================================================
   MIGRATION: Chức vụ giảng viên (Teachers.Position text) -> Positions (danh mục, FK)
   Cho phép quản lý/chọn Chức vụ từ danh mục thay vì nhập tay tự do.
   ============================================================ */

USE TKB_HopLuc;
GO

IF OBJECT_ID('dbo.Positions', 'U') IS NULL
BEGIN
    CREATE TABLE Positions (
        PositionId    INT IDENTITY(1,1) PRIMARY KEY,
        PositionName  NVARCHAR(100)   NOT NULL,
        IsActive      BIT             NOT NULL DEFAULT 1,
        CONSTRAINT UQ_Positions_Name UNIQUE (PositionName)
    );

    INSERT INTO Positions (PositionName) VALUES
    (N'Trưởng khoa'), (N'Phó trưởng khoa'), (N'Giảng viên'), (N'Giáo vụ');
END
GO

-- Đưa các giá trị Position (text) hiện có của Teachers vào danh mục Positions nếu chưa có,
-- để không mất dữ liệu chức vụ đã nhập tay trước đây.
INSERT INTO Positions (PositionName)
SELECT DISTINCT t.Position
FROM Teachers t
WHERE t.Position IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM Positions p WHERE p.PositionName = t.Position);
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Teachers') AND name = 'PositionId')
BEGIN
    ALTER TABLE Teachers ADD PositionId INT NULL;
END
GO

UPDATE t SET t.PositionId = p.PositionId
FROM Teachers t
INNER JOIN Positions p ON p.PositionName = t.Position
WHERE t.Position IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Teachers_Position')
BEGIN
    ALTER TABLE Teachers ADD CONSTRAINT FK_Teachers_Position FOREIGN KEY (PositionId) REFERENCES Positions(PositionId);
END
GO

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Teachers') AND name = 'Position')
BEGIN
    ALTER TABLE Teachers DROP COLUMN Position;
END
GO
