USE TKB_HopLuc;
GO

-- 1. Ngành đào tạo do 1 Khoa quản lý
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Majors') AND name = 'FacultyId')
BEGIN
    ALTER TABLE Majors ADD FacultyId INT NULL;
    ALTER TABLE Majors ADD CONSTRAINT FK_Majors_Faculty FOREIGN KEY (FacultyId) REFERENCES Faculties(FacultyId);
END
GO

-- 2. Phòng thực hành gắn với 1 Khoa (phòng lý thuyết có thể để trống)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Rooms') AND name = 'FacultyId')
BEGIN
    ALTER TABLE Rooms ADD FacultyId INT NULL;
    ALTER TABLE Rooms ADD CONSTRAINT FK_Rooms_Faculty FOREIGN KEY (FacultyId) REFERENCES Faculties(FacultyId);
END
GO

-- 3. Lịch nghỉ phân biệt theo hệ đào tạo (LT không nghỉ hè, CQ có nghỉ hè)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Holidays') AND name = 'AppliesTo')
BEGIN
    ALTER TABLE Holidays ADD AppliesTo NVARCHAR(10) NOT NULL DEFAULT N'ALL';
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Holidays_AppliesTo')
BEGIN
    ALTER TABLE Holidays ADD CONSTRAINT CK_Holidays_AppliesTo CHECK (AppliesTo IN (N'CQ', N'LT', N'ALL'));
END
GO

-- 4. Cấu hình thời lượng chương trình theo hệ đào tạo (đã xác nhận chính xác)
--    Chính quy: TỔNG 3 năm (36 tháng), TỔNG 6 kỳ, mỗi kỳ 20-22 tuần, 2 kỳ/năm
--    Liên thông: TỔNG 18 tháng, TỔNG 4 kỳ, mỗi kỳ 19-20 tuần (không nghỉ hè)
IF EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'MinWeeksPerSemester')
BEGIN
    UPDATE SchedulingPolicy SET PolicyKey = 'MinWeeksPerSemesterCQ', PolicyValue = '20', Description = N'Số tuần tối thiểu/học kỳ hệ Chính quy' WHERE PolicyKey = 'MinWeeksPerSemester';
    UPDATE SchedulingPolicy SET PolicyKey = 'MaxWeeksPerSemesterCQ', PolicyValue = '22', Description = N'Số tuần tối đa/học kỳ hệ Chính quy' WHERE PolicyKey = 'MaxWeeksPerSemester';
END
GO

IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'MinWeeksPerSemesterCQ')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('MinWeeksPerSemesterCQ', '20', N'Số tuần tối thiểu/học kỳ hệ Chính quy');
IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'MaxWeeksPerSemesterCQ')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('MaxWeeksPerSemesterCQ', '22', N'Số tuần tối đa/học kỳ hệ Chính quy');
IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'MinWeeksPerSemesterLT')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('MinWeeksPerSemesterLT', '19', N'Số tuần tối thiểu/học kỳ hệ Liên thông');
IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'MaxWeeksPerSemesterLT')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('MaxWeeksPerSemesterLT', '20', N'Số tuần tối đa/học kỳ hệ Liên thông');
IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'ProgramDurationMonthsCQ')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('ProgramDurationMonthsCQ', '36', N'Tổng thời gian đào tạo hệ Chính quy (tháng)');
IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'ProgramDurationMonthsLT')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('ProgramDurationMonthsLT', '18', N'Tổng thời gian đào tạo hệ Liên thông (tháng)');
IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'TotalTermsCQ')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('TotalTermsCQ', '6', N'Tổng số kỳ học cả chương trình hệ Chính quy');
IF NOT EXISTS (SELECT 1 FROM SchedulingPolicy WHERE PolicyKey = 'TotalTermsLT')
    INSERT INTO SchedulingPolicy (PolicyKey, PolicyValue, Description) VALUES ('TotalTermsLT', '4', N'Tổng số kỳ học cả chương trình hệ Liên thông');
GO

PRINT N'=== Hoàn tất migration Khoa quản lý Ngành/Phòng, Lịch nghỉ theo hệ, và cấu hình thời lượng chương trình. ===';
