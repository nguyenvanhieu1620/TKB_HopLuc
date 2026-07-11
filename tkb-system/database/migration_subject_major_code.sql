USE TKB_HopLuc;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Subjects') AND name = 'MajorId')
BEGIN
    ALTER TABLE Subjects ADD MajorId INT NULL;
    ALTER TABLE Subjects ADD CONSTRAINT FK_Subjects_Major FOREIGN KEY (MajorId) REFERENCES Majors(MajorId);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_Subjects_SubjectCode')
BEGIN
    CREATE UNIQUE INDEX UQ_Subjects_SubjectCode ON Subjects(SubjectCode) WHERE SubjectCode IS NOT NULL;
END
GO

PRINT N'Đã thêm Subjects.MajorId và ràng buộc duy nhất cho SubjectCode.';
