USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Classes') AND name = 'StartDate')
BEGIN
    ALTER TABLE Classes ADD StartDate DATE NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Semesters') AND name = 'ClassId')
BEGIN
    ALTER TABLE Semesters ADD ClassId INT NULL;
    ALTER TABLE Semesters ADD CONSTRAINT FK_Semesters_Class FOREIGN KEY (ClassId) REFERENCES Classes(ClassId);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Semesters') AND name = 'TermNumber')
BEGIN
    ALTER TABLE Semesters ADD TermNumber INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Semesters_Class' AND object_id = OBJECT_ID('dbo.Semesters'))
BEGIN
    CREATE INDEX IX_Semesters_Class ON Semesters (ClassId);
END
GO

PRINT N'Đã thêm Classes.StartDate và Semesters.ClassId/TermNumber.';
