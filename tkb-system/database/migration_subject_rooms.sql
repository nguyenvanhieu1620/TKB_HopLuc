USE TKB_HopLuc;
GO

IF OBJECT_ID('dbo.SubjectRooms', 'U') IS NULL
BEGIN
    CREATE TABLE SubjectRooms (
        SubjectRoomId INT IDENTITY(1,1) PRIMARY KEY,
        SubjectId     INT NOT NULL,
        RoomId        INT NOT NULL,
        CONSTRAINT FK_SubjectRooms_Subject FOREIGN KEY (SubjectId) REFERENCES Subjects(SubjectId),
        CONSTRAINT FK_SubjectRooms_Room FOREIGN KEY (RoomId) REFERENCES Rooms(RoomId),
        CONSTRAINT UQ_SubjectRooms UNIQUE (SubjectId, RoomId)
    );
    PRINT N'Đã tạo bảng SubjectRooms.';
END
GO
